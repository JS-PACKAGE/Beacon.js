import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { ClientMessage } from '../protocol/index.js';
import { ProtocolError, errorMessage } from '../protocol/index.js';
import type { Admission, MatchAllocation, MatchRequest, Game, GameProvider, GameSessionProvider, Peer, Player, RoomStore, Session, StoredRoom, Moderation, SocialLink, Rules, ReconnectSeat } from '../types.js';
import { HttpGameSessions } from '../games/sessions.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { log } from '../log/index.js';

function reply(peer: Peer, message: Record<string, unknown>): void { (peer.reply ?? peer.send).call(peer, message); }
type Compatibility = { version: string; mode: string; region: string };
type Filters = { query?: string; availableOnly?: boolean; sort?: 'created' | 'name' | 'players'; version?: string; mode?: string; region?: string };
interface HeldSeat {
  playerId: string;
  displayName: string;
  role: 'player' | 'spectator';
  ready: boolean;
  gameId: string;
  compatibility: Compatibility;
  expiresAt: number;
  pendingResult?: { matchId: string; result: Rules };
}
interface Room extends StoredRoom {
  players: Map<string, Session>;
  reservations: Map<Session, 'player' | 'spectator'>;
  held: Map<string, HeldSeat>;
  pendingResults: Map<string, { matchId: string; result: Rules }>;
  emptySince: number | null;
  operation?: string;
  /** Serialized listing-visible fields at the last lobby broadcast; lets publish() skip no-op pushes. */
  lobbyKey?: string;
  recentMatchId?: string;
}
interface Invitation { target: string; expiresAt: number; roomId?: string; partyId?: string }
interface Party { id: string; leaderId: string; members: Set<string> }
interface QueueEntry { id: string; members: string[]; partyId?: string; gameId: string; compatibility: Compatibility; min: number; max: number; at: number }
interface Snapshot { playerId: string; gameId: string; scope: string; expiresAt: number; revision: number; pages: Record<string, unknown>[][]; total: number; game: Game }

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly players = new Map<string, Session>();
  private readonly passwordFailures = new Map<string, { count: number; startedAt: number; pending: number }>();
  private readonly moderation = new Map<string, Moderation>();
  private readonly social = new Map<string, SocialLink>();
  private readonly invitations = new Map<string, Invitation>();
  private readonly parties = new Map<string, Party>();
  private readonly partyOf = new Map<string, string>();
  private readonly waiting: QueueEntry[] = [];
  private readonly blocks = new Set<string>();
  private readonly finishedMatches = new Map<string, number>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cursors = new Map<string, { snapshotId: string; page: number }>();
  private readonly recovering = new Set<string>();
  private readonly external = new Set<Promise<unknown>>();
  private readonly provider: GameSessionProvider;
  private queue: Promise<void> = Promise.resolve();
  private lobbyRevision = 1;
  private maintenance = false;
  private stopped = false;
  private storageHealthy = true;

  constructor(private readonly config: Config, private readonly store: RoomStore, private readonly games: GameProvider, sessions?: GameSessionProvider) {
    this.provider = sessions ?? new HttpGameSessions(config.games);
    for (const room of store.load()) this.rooms.set(room.id, { ...room, players: new Map(), reservations: new Map(), held: new Map(), pendingResults: new Map(), emptySince: Date.now() });
    for (const record of store.listModeration()) this.moderation.set(record.playerId, record);
    for (const link of store.listSocial()) this.social.set(this.socialKey(link.a, link.b), link);
    for (const block of store.listBlocks()) this.blocks.add(JSON.stringify([block.playerId, block.targetId]));
    for (const party of store.listParties()) { this.parties.set(party.id, { id: party.id, leaderId: party.leaderId, members: new Set(party.members) }); for (const id of party.members) this.partyOf.set(id, party.id); }
    for (const invitation of store.listInvitations()) if (invitation.expiresAt > Date.now()) this.invitations.set(invitation.token, invitation); else { try { store.deleteInvitation(invitation.token); } catch { log('error', 'invitation_cleanup_failed'); } }
    this.restoreSeats();
  }

  connect(peer: Peer): void { this.sessions.set(peer.id, { peer, active: true, ready: false, role: 'player', compatibility: { version: '', mode: '', region: '' } }); }
  private serialized<T>(operation: () => T): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private persist(operation: () => void): void {
    try { operation(); this.storageHealthy = true; } catch { this.storageHealthy = false; log('error', 'storage_write_failed'); throw new ProtocolError('storage_error'); }
  }
  private track<T>(promise: Promise<T>): Promise<T> {
    this.external.add(promise);
    void promise.then(() => this.external.delete(promise), () => this.external.delete(promise));
    return promise;
  }
  private connected(session: Session): boolean { return session.active && !session.peer.closed; }
  private checkPlayer(player: Player): void {
    const record = this.moderation.get(player.id);
    if (record && record.bannedUntil > Date.now()) throw new ProtocolError('player_banned');
    if (record && record.revokedBefore > 0 && (player.issuedAt === undefined || player.issuedAt <= record.revokedBefore)) throw new ProtocolError('token_revoked');
    if (player.expiresAt !== undefined && player.expiresAt <= Date.now()) throw new ProtocolError('auth_expired');
  }
  async authenticate(peer: Peer, player: Player): Promise<boolean> {
    return this.serialized(() => {
      if (this.maintenance || this.stopped) throw new ProtocolError('maintenance');
      this.checkPlayer(player);
      const session = this.sessions.get(peer.id);
      if (!session || !this.connected(session)) return false;
      if (session.player) throw new ProtocolError('bad_request');
      const previous = this.players.get(player.id);
      if (previous && previous !== session) {
        if (previous.disconnectedAt !== undefined && Date.now() - previous.disconnectedAt >= this.config.lobby.reconnectGraceMs) this.removeDisconnected(previous);
        else {
          if (previous.gameId) session.gameId = previous.gameId;
          session.compatibility = previous.compatibility ?? { version: '', mode: '', region: '' };
          session.ready = previous.ready ?? false; session.role = previous.role ?? 'player';
          if (previous.roomId) {
            const room = this.rooms.get(previous.roomId);
            if (room) { room.players.set(player.id, session); session.roomId = room.id; this.commit(room); }
          }
          delete previous.roomId;
          previous.active = false;
          previous.peer.send(errorMessage('session_replaced'));
          previous.peer.close(4001, 'Session replaced');
          this.sessions.delete(previous.peer.id);
        }
      }
      session.player = player;
      this.players.set(player.id, session);
      if (!session.roomId) {
        const heldRoom = [...this.rooms.values()].find(item => item.held.has(player.id));
        const held = heldRoom?.held.get(player.id);
        if (heldRoom && held && held.expiresAt > Date.now()) {
          if (held.gameId) session.gameId = held.gameId;
          session.compatibility = held.compatibility;
          session.ready = held.ready; session.role = held.role;
          heldRoom.held.delete(player.id); heldRoom.players.set(player.id, session); session.roomId = heldRoom.id; heldRoom.emptySince = null;
          if (held.pendingResult) heldRoom.pendingResults.set(player.id, held.pendingResult);
          this.commit(heldRoom);
        }
      }
      const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
      if (room) this.publish(room, 'reconnect');
      this.presence(player.id);
      return true;
    });
  }
  async refreshAuthentication(peer: Peer, player: Player): Promise<void> {
    await this.serialized(() => { const session = this.requireSession(peer, false); if (session.player.id !== player.id) throw new ProtocolError('forbidden'); this.checkPlayer(player); session.player = player; });
  }
  disconnect(peer: Peer): void {
    const session = this.sessions.get(peer.id);
    if (!session) return;
    session.active = false; session.disconnectedAt = Date.now();
    for (const room of this.rooms.values()) room.reservations.delete(session);
    void this.serialized(() => {
      if (session.player && this.players.get(session.player.id) === session) {
        this.cancelQueue(session.player.id);
        const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
        if (room) { this.commit(room); this.publish(room, 'disconnect'); }
        this.presence(session.player.id);
      } else this.sessions.delete(peer.id);
    }).catch(() => log('error', 'disconnect_cleanup_deferred'));
  }
  private requireSession(peer: Peer, check = true): Session & { player: Player } {
    const session = this.sessions.get(peer.id);
    if (!session || !this.connected(session) || !session.player) throw new ProtocolError('auth_required');
    if (check) this.checkPlayer(session.player);
    return session as Session & { player: Player };
  }
  private requireGame(session: Session): string { if (!session.gameId) throw new ProtocolError('not_in_lobby'); return session.gameId; }
  private requireRoom(session: Session): Room { const room = session.roomId ? this.rooms.get(session.roomId) : undefined; if (!room) throw new ProtocolError('room_not_found'); return room; }
  private host(session: Session, room: Room): void { if (session.role === 'spectator' || room.hostId !== session.player?.id) throw new ProtocolError('host_only'); }
  private available(): void { if (this.maintenance || this.stopped) throw new ProtocolError('maintenance'); }
  private compatibility(session: Session): Compatibility { return session.compatibility ?? { version: '', mode: '', region: '' }; }
  private compatible(a: Compatibility, b: Compatibility): boolean { return a.version === b.version && a.mode === b.mode && a.region === b.region; }
  private validateCompatibility(game: Game, compatibility: Compatibility): void {
    if ((game.versions && !game.versions.includes(compatibility.version)) || (game.modes && !game.modes.includes(compatibility.mode)) || (game.regions && !game.regions.includes(compatibility.region))) throw new ProtocolError('incompatible_version');
  }
  private count(room: Room, role: 'player' | 'spectator' = 'player', reservations = false): number {
    let count = 0;
    for (const member of room.players.values()) if ((member.role ?? 'player') === role) count++;
    for (const seat of room.held.values()) if (seat.role === role) count++;
    if (reservations) for (const pending of room.reservations.values()) if (pending === role) count++;
    return count;
  }
  private summary(room: Room): Record<string, unknown> {
    return { id: room.id, gameId: room.gameId, name: room.name, ownerId: room.ownerId, hostId: room.hostId, playerCount: this.count(room), spectatorCount: this.count(room, 'spectator'), maxPlayers: room.maxPlayers, maxSpectators: room.maxSpectators, hasPassword: room.passwordHash !== null, state: room.state, visibility: room.visibility, locked: room.locked, version: room.version, mode: room.mode, region: room.region, joinPolicy: room.joinPolicy, revision: room.revision, createdAt: room.createdAt, ...(room.rules && Object.keys(room.rules).length ? { rules: room.rules } : {}) };
  }
  private members(room: Room): Record<string, unknown>[] {
    const live = [...room.players.values()].filter(member => member.player).map(member => ({ id: member.player!.id, displayName: member.player!.displayName, isHost: room.hostId === member.player!.id, ready: member.ready ?? false, role: member.role ?? 'player', connected: this.connected(member) }));
    const held = [...room.held.values()].filter(seat => !room.players.has(seat.playerId)).map(seat => ({ id: seat.playerId, displayName: seat.displayName, isHost: room.hostId === seat.playerId, ready: seat.ready, role: seat.role, connected: false }));
    return [...live, ...held];
  }
  private seatSnapshot(room: Room): ReconnectSeat[] {
    const grace = this.config.lobby.reconnectGraceMs;
    const now = Date.now();
    const seats: ReconnectSeat[] = [];
    for (const [playerId, session] of room.players) {
      if (!session.player) continue;
      const compatibility = session.compatibility ?? { version: room.version, mode: room.mode, region: room.region };
      const pending = room.pendingResults.get(playerId);
      seats.push({ playerId, role: session.role ?? 'player', ready: session.ready ?? false, gameId: session.gameId ?? room.gameId, version: compatibility.version, mode: compatibility.mode, region: compatibility.region, displayName: session.player.displayName, expiresAt: this.connected(session) ? 0 : (session.disconnectedAt ?? now) + grace, ...(pending ? { pendingResult: pending } : {}) });
    }
    for (const seat of room.held.values()) if (!room.players.has(seat.playerId)) seats.push({ playerId: seat.playerId, role: seat.role, ready: seat.ready, gameId: seat.gameId, version: seat.compatibility.version, mode: seat.compatibility.mode, region: seat.compatibility.region, displayName: seat.displayName, expiresAt: seat.expiresAt, ...(seat.pendingResult ? { pendingResult: seat.pendingResult } : {}) });
    return seats;
  }
  private restoreSeats(): void {
    const now = Date.now();
    const grace = this.config.lobby.reconnectGraceMs;
    for (const room of this.rooms.values()) {
      const loaded = room.seats ?? [];
      delete room.seats;
      for (const seat of loaded) {
        if (grace === 0) continue;
        const expiresAt = seat.expiresAt === 0 ? now + grace : seat.expiresAt;
        if (expiresAt <= now) continue;
        room.held.set(seat.playerId, { playerId: seat.playerId, displayName: seat.displayName, role: seat.role, ready: seat.ready, gameId: seat.gameId, compatibility: { version: seat.version, mode: seat.mode, region: seat.region }, expiresAt, ...(seat.pendingResult ? { pendingResult: seat.pendingResult } : {}) });
        if (seat.pendingResult) room.pendingResults.set(seat.playerId, seat.pendingResult);
      }
      room.emptySince = room.held.size ? null : now;
      if (JSON.stringify(loaded) !== JSON.stringify(this.seatSnapshot(room))) { try { this.commit(room); } catch { log('error', 'seat_restore_failed'); } }
    }
  }
  private blocked(a: string, b: string): boolean { return a !== b && (this.blocks.has(JSON.stringify([a, b])) || this.blocks.has(JSON.stringify([b, a]))); }
  private commit(room: Room, patch: Partial<StoredRoom> = {}): void {
    const seats = this.seatSnapshot(room);
    const next = { ...room, ...patch, revision: room.revision + 1, updatedAt: Date.now(), ...(seats.length ? { seats } : {}) };
    if (!seats.length) delete next.seats;
    if (next.state !== 'starting') delete next.matchRequest;
    this.persist(() => this.store.update(next));
    Object.assign(room, patch, { revision: next.revision, updatedAt: next.updatedAt });
    if (!next.matchRequest) delete room.matchRequest;
    if (seats.length) room.seats = seats; else delete room.seats;
    this.lobbyRevision++;
  }
  private recoverAdmissions(room: Room, matchId: string): void {
    for (const member of room.players.values()) if (this.connected(member) && member.player) {
      void this.track(Promise.resolve().then(() => this.provider.admit(matchId, member.player!.id, member.role ?? 'player')).then(admission => this.serialized(() => {
        if (this.stopped || !this.connected(member) || this.rooms.get(room.id) !== room || room.matchId !== matchId || room.state !== 'in_game' || member.roomId !== room.id) return;
        this.checkPlayer(member.player!);
        this.sendPacket(member.peer, { type: 'game_admission', roomId: room.id, matchId, ...admission }, false);
      }))).catch(() => log('error', 'match_admission_unavailable'));
    }
  }
  private sendPacket(peer: Peer, message: Record<string, unknown>, direct = true): void {
    const send = (packet: Record<string, unknown>) => direct ? reply(peer, packet) : peer.send(packet);
    const limit = this.config.limits.outboundBytes - (direct && peer.reply ? 160 : 0);
    const raw = JSON.stringify(message);
    if (Buffer.byteLength(raw) <= limit) { send(message); return; }
    const snapshotId = typeof message.snapshotId === 'string' ? message.snapshotId : randomUUID();
    const revision = typeof message.revision === 'number' ? message.revision : this.lobbyRevision;
    const base = { type: 'snapshot_chunk', snapshotType: message.type, snapshotId, revision };
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, chunkIndex: raw.length, chunkCount: raw.length, payload: '' }));
    const fragments: string[] = [];
    let payload = ''; let bytes = overhead;
    for (const character of raw) {
      const size = Buffer.byteLength(JSON.stringify(character)) - 2;
      if (bytes + size > limit) { if (!payload) throw new ProtocolError('server_error'); fragments.push(payload); payload = ''; bytes = overhead; }
      payload += character; bytes += size;
    }
    if (payload) fragments.push(payload);
    fragments.forEach((payload, chunkIndex) => send({ ...base, chunkIndex, chunkCount: fragments.length, payload }));
  }
  private sendMembers(peer: Peer, base: Record<string, unknown>, members: Record<string, unknown>[], direct = true, field: 'members' | 'friends' | 'games' | 'partyMembers' = 'members'): void {
    const send = (message: Record<string, unknown>) => this.sendPacket(peer, message, direct);
    const limit = this.config.limits.outboundBytes - (direct && peer.reply ? 160 : 0);
    const metadata = { ...base, snapshotId: randomUUID() };
    const encode = (metadata: Record<string, unknown>, items: Record<string, unknown>[]) => field === 'partyMembers'
      ? { ...metadata, party: { ...(base.party as Record<string, unknown>), members: items } }
      : { ...metadata, [field]: items };
    const whole = encode(metadata, members);
    if (Buffer.byteLength(JSON.stringify(whole)) <= limit) { send(whole); return; }
    const chunks: Record<string, unknown>[][] = [];
    let chunk: Record<string, unknown>[] = [];
    const overhead = Buffer.byteLength(JSON.stringify(encode({ ...metadata, chunkIndex: members.length, chunkCount: members.length }, [])));
    let bytes = overhead;
    for (const member of members) {
      const size = Buffer.byteLength(JSON.stringify(member));
      if (overhead + size > limit) { send(whole); return; }
      if (bytes + size + (chunk.length ? 1 : 0) > limit) { chunks.push(chunk); chunk = []; bytes = overhead; }
      bytes += size + (chunk.length ? 1 : 0); chunk.push(member);
    }
    if (chunk.length) chunks.push(chunk);
    chunks.forEach((members, chunkIndex) => send(encode({ ...metadata, chunkIndex, chunkCount: chunks.length }, members)));
  }
  /** Everything a lobby viewer can see except `revision`, which bumps on changes the list does not show (ready, reconnect). */
  private listing(room: Room): string {
    const { revision: _revision, ...visible } = this.summary(room);
    return JSON.stringify(visible);
  }
  private publish(room: Room, change: string): void {
    const members = this.members(room);
    for (const session of room.players.values()) if (this.connected(session)) this.sendMembers(session.peer, { type: 'room_state', roomId: room.id, room: this.summary(room), playerCount: this.count(room), revision: room.revision, lobbyRevision: this.lobbyRevision, change }, members, false);
    if (this.listing(room) !== room.lobbyKey) this.broadcastLobby(room, 'update');
  }
  private broadcastLobby(room: Room, change: string): void {
    if (room.visibility !== 'public') return;
    room.lobbyKey = this.listing(room);
    for (const session of this.sessions.values()) if (this.connected(session) && session.gameId === room.gameId && !session.roomId) session.peer.send({ type: 'lobby_update', change, room: this.summary(room), lobbyRevision: this.lobbyRevision });
  }
  private joined(session: Session, room: Room): void {
    this.sendMembers(session.peer, { type: 'room_joined', room: this.summary(room), revision: room.revision, lobbyRevision: this.lobbyRevision }, this.members(room));
  }
  private sync(session: Session): void {
    const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
    this.sendMembers(session.peer, { type: 'session_state', ...(session.gameId ? { gameId: session.gameId } : {}), room: room ? this.summary(room) : null, ready: session.ready ?? false, role: session.role ?? 'player', revision: room?.revision ?? 0, lobbyRevision: this.lobbyRevision }, room ? this.members(room) : []);
    if (room) this.sendMembers(session.peer, { type: 'room_state', roomId: room.id, room: this.summary(room), playerCount: this.count(room), revision: room.revision, lobbyRevision: this.lobbyRevision, change: 'sync' }, this.members(room));
    const pending = room && session.player ? room.pendingResults.get(session.player.id) : undefined;
    if (room && pending && session.player) {
      this.sendPacket(session.peer, { type: 'match_result', roomId: room.id, matchId: pending.matchId, result: pending.result }, false);
      room.pendingResults.delete(session.player.id);
      try { this.commit(room); } catch { room.pendingResults.set(session.player.id, pending); log('error', 'match_result_persist_failed'); }
    }
    this.sendFriends(session); this.sendParty(session.player!.id, true);
    reply(session.peer, { type: 'queue_state', queued: this.waiting.some(entry => entry.members.includes(session.player!.id)) });
  }
  private async selectedGame(gameId: string): Promise<Game> {
    const game = (await this.games.list()).find(item => item.gameId === gameId && item.enabled);
    if (!game) throw new ProtocolError('game_not_found'); return game;
  }
  private filtered(session: Session, filters: Filters): Room[] {
    const compatibility = { ...this.compatibility(session), ...Object.fromEntries(['version', 'mode', 'region'].flatMap(key => filters[key as keyof Filters] === undefined ? [] : [[key, filters[key as keyof Filters]]])) } as Compatibility;
    const rooms = [...this.rooms.values()].filter(room => room.gameId === session.gameId && room.visibility === 'public' && room.state !== 'closed' && this.compatible(room, compatibility) && (!filters.query || room.name.toLocaleLowerCase().includes(filters.query.toLocaleLowerCase())) && (!filters.availableOnly || (!room.locked && room.state === 'open' && this.count(room, 'player', true) < room.maxPlayers)));
    // Array.prototype.sort is stable and this.rooms iterates in creation order, so ties keep creation order.
    rooms.sort((a, b) => filters.sort === 'name' ? a.name.localeCompare(b.name) : filters.sort === 'players' ? this.count(b) - this.count(a) : a.createdAt - b.createdAt);
    return rooms;
  }
  private snapshot(session: Session & { player: Player }, game: Game, filters: Filters & { page?: number; pageSize?: number; cursor?: string } = {}): void {
    const scope = JSON.stringify({ query: filters.query ?? '', availableOnly: filters.availableOnly ?? false, sort: filters.sort ?? 'created', version: filters.version ?? this.compatibility(session).version, mode: filters.mode ?? this.compatibility(session).mode, region: filters.region ?? this.compatibility(session).region, pageSize: filters.pageSize ?? this.config.limits.defaultPageSize });
    let id: string; let snapshot: Snapshot; let page = filters.page ?? 1;
    if (filters.cursor) {
      const cursor = this.cursors.get(filters.cursor); const old = cursor ? this.snapshots.get(cursor.snapshotId) : undefined;
      if (!old || !cursor || old.expiresAt <= Date.now()) throw new ProtocolError('snapshot_expired');
      if (old.playerId !== session.player.id || old.gameId !== game.gameId || old.scope !== scope) throw new ProtocolError('bad_request');
      id = cursor.snapshotId; snapshot = old; page = cursor.page;
    } else {
      id = randomUUID();
      const summaries = this.filtered(session, filters).map(room => this.summary(room));
      const pages: Record<string, unknown>[][] = []; let part: Record<string, unknown>[] = [];
      const overhead = Buffer.byteLength(JSON.stringify({ type: 'lobby_state', game, total: summaries.length, snapshotId: id, revision: this.lobbyRevision, lobbyRevision: this.lobbyRevision, nextCursor: randomUUID(), nextPage: summaries.length + 1, live: filters.page !== undefined, rooms: [] }));
      const limit = this.config.limits.outboundBytes - (session.peer.reply ? 160 : 0);
      let bytes = overhead;
      for (const summary of summaries) {
        const size = Buffer.byteLength(JSON.stringify(summary));
        if (part.length && (part.length >= (filters.pageSize ?? this.config.limits.defaultPageSize) || (overhead < limit && bytes + size + 1 > limit))) { pages.push(part); part = []; bytes = overhead; }
        bytes += size + 1; part.push(summary);
      }
      if (part.length || !pages.length) pages.push(part);
      snapshot = { playerId: session.player.id, gameId: game.gameId, scope, expiresAt: Date.now() + this.config.lobby.snapshotTtlMs, revision: this.lobbyRevision, pages, total: summaries.length, game };
      this.snapshots.set(id, snapshot);
      // Snapshot count is bounded even when clients never use their cursors.
      while (this.snapshots.size > this.config.limits.maxConnections * 4) this.snapshots.delete(this.snapshots.keys().next().value!);
    }
    const message: Record<string, unknown> = { type: 'lobby_state', game: snapshot.game, total: snapshot.total, snapshotId: id, revision: snapshot.revision, lobbyRevision: snapshot.revision, live: filters.page !== undefined, rooms: snapshot.pages[page - 1] ?? [] };
    if (page < snapshot.pages.length) {
      let cursor = [...this.cursors].find(([, record]) => record.snapshotId === id && record.page === page + 1)?.[0];
      if (!cursor) { cursor = randomUUID(); this.cursors.set(cursor, { snapshotId: id, page: page + 1 }); }
      message.nextCursor = cursor; message.nextPage = page + 1;
    }
    this.sendPacket(session.peer, message);
  }
  private leave(session: Session, patch: Partial<StoredRoom> = {}): void {
    if (!session.roomId || !session.player) return;
    const room = this.rooms.get(session.roomId);
    if (!room) { delete session.roomId; return; }
    const playerId = session.player.id;
    const remaining = [...room.players.values()].filter(member => member !== session && member.role !== 'spectator');
    const nextHost = remaining.find(member => this.connected(member)) ?? remaining[0];
    const heldHost = [...room.held.values()].find(seat => seat.role !== 'spectator');
    const starting = room.state === 'starting';
    const startingMatchId = starting ? room.matchId : null;
    const pendingRequest = starting && !room.operation && !room.matchId && !this.recovering.has(room.id) ? room.matchRequest : undefined;
    const previous = { roomId: session.roomId, ready: session.ready, role: session.role, emptySince: room.emptySince };
    room.players.delete(playerId); room.pendingResults.delete(playerId); delete session.roomId; session.ready = false; session.role = 'player';
    if (!room.players.size && !room.held.size && !room.reservations.size) room.emptySince = Date.now();
    const hostId = room.hostId === playerId ? nextHost?.player?.id ?? heldHost?.playerId ?? room.ownerId : room.hostId;
    try { this.commit(room, { ...patch, ...(hostId === room.hostId ? {} : { hostId }), ...(starting ? { state: 'open', matchId: null } : {}) }); }
    catch (error) { room.players.set(playerId, session); session.roomId = previous.roomId; session.ready = previous.ready ?? false; session.role = previous.role ?? 'player'; room.emptySince = previous.emptySince; throw error; }
    if (starting) delete room.operation;
    if (startingMatchId) this.cancelMatch(startingMatchId);
    if (pendingRequest) this.cancelPending(pendingRequest);
    this.publish(room, 'leave');
  }
  private removeDisconnected(session: Session): void {
    this.leave(session);
    if (session.player && this.players.get(session.player.id) === session) { this.players.delete(session.player.id); this.leaveParty(session.player.id); this.presence(session.player.id); }
    this.sessions.delete(session.peer.id);
  }
  private cancelMatch(matchId: string): void { void this.track(Promise.resolve().then(() => this.provider.cancel(matchId))).catch(() => log('error', 'match_cancel_failed')); }
  private cancelPending(request: MatchRequest): void {
    void this.track(Promise.resolve().then(() => this.provider.create(request)).then(allocation => this.provider.cancel(allocation.matchId))).catch(() => log('error', 'pending_match_cancel_failed'));
  }
  private closeRoom(room: Room, reason: string, requester?: Peer): void {
    this.persist(() => this.store.delete(room.id));
    this.rooms.delete(room.id); this.lobbyRevision++;
    if (room.matchId) this.cancelMatch(room.matchId);
    else if (room.matchRequest && !room.operation && !this.recovering.has(room.id)) this.cancelPending(room.matchRequest);
    delete room.operation;
    for (const session of room.players.values()) {
      delete session.roomId; session.ready = false;
      const message = { type: 'room_closed', roomId: room.id, reason };
      if (requester?.id === session.peer.id) reply(requester, message); else if (this.connected(session)) session.peer.send(message);
    }
    room.reservations.clear(); this.revokeInvites(room.id); this.broadcastLobby(room, 'remove');
  }
  private revokeInvites(roomId: string): void {
    for (const [token, invitation] of this.invitations) if (invitation.roomId === roomId) { try { this.persist(() => this.store.deleteInvitation(token)); } catch { log('error', 'invitation_cleanup_failed'); } this.invitations.delete(token); }
  }
  private newRoom(session: Session & { player: Player }, game: Game, name: string, options: Partial<StoredRoom> = {}, announce = true): Room {
    this.available();
    if (session.roomId) throw new ProtocolError('already_in_room');
    if ([...this.rooms.values()].filter(room => room.ownerId === session.player.id).length >= this.config.lobby.maxRoomsPerPlayer || [...this.rooms.values()].filter(room => room.gameId === game.gameId).length >= this.config.limits.maxRoomsPerGame) throw new ProtocolError('rate_limited');
    const compatibility = { ...this.compatibility(session), ...options };
    this.validateCompatibility(game, compatibility);
    const now = Date.now();
    const room: Room = { id: randomUUID(), gameId: game.gameId, name, ownerId: session.player.id, hostId: session.player.id, passwordHash: null, maxPlayers: game.maxPlayersPerRoom, state: 'open', createdAt: now, updatedAt: now, visibility: 'public', locked: false, ...this.compatibility(session), joinPolicy: 'closed', maxSpectators: this.config.lobby.maxSpectators, revision: 1, bannedIds: [], invitedIds: [], matchId: null, ...options, players: new Map([[session.player.id, session]]), reservations: new Map(), held: new Map(), pendingResults: new Map(), emptySince: null };
    if (room.maxPlayers > game.maxPlayersPerRoom || room.maxSpectators > this.config.lobby.maxSpectators) throw new ProtocolError('bad_request');
    room.seats = this.seatSnapshot(room);
    this.persist(() => this.store.insert(room));
    session.roomId = room.id; session.ready = false; session.role = 'player'; session.compatibility = { version: room.version, mode: room.mode, region: room.region };
    this.rooms.set(room.id, room); this.lobbyRevision++;
    if (announce) { this.joined(session, room); this.broadcastLobby(room, 'add'); }
    return room;
  }
  private validInvitation(token: string | undefined, target: string, room: Room): boolean {
    if (!token) return false;
    const invitation = this.invitations.get(token);
    if (!invitation || invitation.expiresAt <= Date.now()) throw new ProtocolError('invitation_expired');
    if (invitation.target !== target || invitation.roomId !== room.id) throw new ProtocolError('forbidden');
    return true;
  }
  private async join(peer: Peer, roomId: string, password?: string, role: 'player' | 'spectator' = 'player', invitationToken?: string): Promise<void> {
    const session = this.requireSession(peer);
    const prepared = await this.serialized(() => {
      this.available(); this.requireSession(peer);
      if (session.roomId || [...this.rooms.values()].some(room => room.reservations.has(session))) throw new ProtocolError('already_in_room');
      const room = this.rooms.get(roomId);
      if (!room) throw new ProtocolError('room_not_found');
      if (room.gameId !== this.requireGame(session)) throw new ProtocolError('wrong_game');
      if (!this.compatible(room, this.compatibility(session))) throw new ProtocolError('incompatible_version');
      if (room.bannedIds.includes(session.player.id)) throw new ProtocolError('player_banned');
      const invited = this.validInvitation(invitationToken, session.player.id, room);
      const owner = room.ownerId === session.player.id;
      if (room.visibility === 'invite' && !invited && !owner) throw new ProtocolError('invitation_required');
      if (room.locked && !invited && !owner) throw new ProtocolError('forbidden');
      if (room.state !== 'open' && !(room.state === 'in_game' && (role === 'spectator' ? room.joinPolicy === 'spectate' || room.joinPolicy === 'fill' : room.joinPolicy === 'fill'))) throw new ProtocolError('invalid_state');
      if (this.count(room, role, true) >= (role === 'player' ? room.maxPlayers : room.maxSpectators)) throw new ProtocolError('room_full');
      const hash = invited || owner ? null : room.passwordHash;
      let failure = this.passwordFailures.get(session.player.id);
      if (!failure || (!failure.pending && Date.now() - failure.startedAt >= this.config.limits.passwordWindowMs)) {
        for (const [id, old] of this.passwordFailures) if (!old.pending && Date.now() - old.startedAt >= this.config.limits.passwordWindowMs) this.passwordFailures.delete(id);
        if (!this.passwordFailures.has(session.player.id) && this.passwordFailures.size >= this.config.limits.maxConnections * 4) throw new ProtocolError('rate_limited');
        failure = { count: 0, pending: 0, startedAt: Date.now() }; this.passwordFailures.set(session.player.id, failure);
      }
      if (hash) { if (failure.count + failure.pending >= this.config.limits.passwordFailures) throw new ProtocolError('rate_limited'); if (password === undefined) throw new ProtocolError('room_password_required'); failure.pending++; }
      room.reservations.set(session, role);
      return { room, hash, policy: JSON.stringify([room.passwordHash, room.locked, room.visibility, room.joinPolicy, room.state]), failure, matchId: room.matchId };
    });
    let admission: Admission | undefined;
    try {
      const verified = prepared.hash === null || await verifyPassword(password!, prepared.hash);
      if (!verified) { await this.serialized(() => { prepared.failure.count++; }); throw new ProtocolError('room_password_incorrect'); }
      if (prepared.matchId) {
        try { admission = await this.track(this.provider.admit(prepared.matchId, session.player.id, role)); } catch { throw new ProtocolError('game_service_unavailable'); }
      }
      await this.serialized(() => {
        this.available(); this.requireSession(peer);
        const room = prepared.room;
        if (this.rooms.get(room.id) !== room || !room.reservations.has(session)) throw new ProtocolError('room_not_found');
        if (session.roomId || JSON.stringify([room.passwordHash, room.locked, room.visibility, room.joinPolicy, room.state]) !== prepared.policy || room.matchId !== prepared.matchId || room.bannedIds.includes(session.player.id)) throw new ProtocolError('invalid_state');
        if (invitationToken) this.validInvitation(invitationToken, session.player.id, room);
        const hostId = role === 'player' && this.count(room) === 0 ? session.player.id : room.hostId;
        room.reservations.delete(session); room.players.set(session.player.id, session); session.roomId = room.id; session.role = role; session.ready = false; room.emptySince = null;
        try { this.commit(room, { hostId }); }
        catch (error) { room.players.delete(session.player.id); delete session.roomId; room.reservations.set(session, role); throw error; }
        if (invitationToken) { this.invitations.delete(invitationToken); try { this.persist(() => this.store.deleteInvitation(invitationToken)); } catch { log('error', 'invitation_cleanup_failed'); } }
        this.cancelQueue(session.player.id); this.joined(session, room); this.publish(room, 'join');
        if (admission) this.sendPacket(peer, { type: 'game_admission', roomId: room.id, matchId: room.matchId, ...admission });
      });
    } finally { await this.serialized(() => { prepared.room.reservations.delete(session); if (prepared.hash) prepared.failure.pending--; }); }
  }
  private async start(peer: Peer): Promise<void> {
    const operationId = randomUUID();
    const prepared = await this.serialized(() => {
      this.available(); const session = this.requireSession(peer); const room = this.requireRoom(session); this.host(session, room);
      if (room.state !== 'open' || room.reservations.size) throw new ProtocolError('invalid_state');
      const members = [...room.players.values()];
      if (!members.some(member => member.role !== 'spectator') || members.some(member => member.role !== 'spectator' && (!member.ready || !this.connected(member)))) throw new ProtocolError('not_ready');
      const request: MatchRequest = { operationId, roomId: room.id, gameId: room.gameId, players: members.map(member => ({ id: member.player!.id, role: member.role ?? 'player' })), version: room.version, mode: room.mode, region: room.region, ...(room.rules && Object.keys(room.rules).length ? { rules: room.rules } : {}) };
      this.commit(room, { state: 'starting', matchRequest: request }); room.operation = operationId; this.publish(room, 'starting');
      return { room, request, requesterId: session.player.id };
    });
    let allocation: MatchAllocation;
    try { allocation = await this.track(this.provider.create(prepared.request)); }
    catch {
      // An unavailable response may hide a committed allocation. Retain its durable
      // idempotency key for recovery rather than create a second match on retry.
      await this.serialized(() => { if (this.rooms.get(prepared.room.id) === prepared.room && prepared.room.operation === operationId) { delete prepared.room.operation; this.publish(prepared.room, 'start_deferred'); } });
      throw new ProtocolError('game_service_unavailable');
    }
    try {
      await this.serialized(() => {
        const room = prepared.room;
        if (this.stopped || this.rooms.get(room.id) !== room || room.operation !== operationId || room.state !== 'starting') throw new ProtocolError('invalid_state');
        if (prepared.request.players.some(member => !allocation.tickets[member.id]) || allocation.expiresAt <= Date.now()) throw new ProtocolError('game_service_unavailable');
        this.commit(room, { state: 'in_game', matchId: allocation.matchId }); delete room.operation; this.publish(room, 'started');
        for (const member of room.players.values()) {
          const message = { type: 'game_started', roomId: room.id, matchId: allocation.matchId, serverUrl: allocation.serverUrl, ticket: allocation.tickets[member.player!.id], expiresAt: allocation.expiresAt };
          if (member.player!.id === prepared.requesterId) {
            this.sendPacket(peer, message);
            if (member.peer !== peer && this.connected(member)) this.sendPacket(member.peer, message, false);
          } else if (this.connected(member)) this.sendPacket(member.peer, message, false);
        }
      });
    } catch (error) {
      this.cancelMatch(allocation.matchId);
      await this.serialized(() => { if (this.rooms.get(prepared.room.id) === prepared.room && prepared.room.operation === operationId) { delete prepared.room.operation; this.commit(prepared.room, { state: 'open', matchId: null }); this.publish(prepared.room, 'start_failed'); } });
      throw error;
    }
  }
  async handle(peer: Peer, message: Exclude<ClientMessage, { type: 'auth' }>): Promise<void> {
    const session = this.requireSession(peer);
    if (message.type === 'ping') { reply(peer, { type: 'pong' }); return; }
    if (message.type === 'list_games') { const games = await this.games.list(); await this.serialized(() => { this.requireSession(peer); this.sendMembers(peer, { type: 'games', revision: this.lobbyRevision }, games.filter(game => game.enabled).map(game => ({ ...game })), true, 'games'); }); return; }
    if (message.type === 'sync_state') {
      const target = await this.serialized(() => { this.requireSession(peer); this.sync(session); const room = session.roomId ? this.rooms.get(session.roomId) : undefined; return room?.state === 'in_game' && room.matchId ? { room, matchId: room.matchId, role: session.role ?? 'player' } : undefined; });
      if (target) {
        let admission: Admission;
        try { admission = await this.track(this.provider.admit(target.matchId, session.player.id, target.role)); } catch { throw new ProtocolError('game_service_unavailable'); }
        await this.serialized(() => { this.requireSession(peer); if (session.roomId !== target.room.id || this.rooms.get(target.room.id) !== target.room || target.room.matchId !== target.matchId) throw new ProtocolError('invalid_state'); this.sendPacket(peer, { type: 'game_admission', roomId: target.room.id, matchId: target.matchId, ...admission }); });
      }
      return;
    }
    if (message.type === 'select_game' || message.type === 'switch_game') {
      const game = await this.selectedGame(message.gameId);
      await this.serialized(() => {
        this.requireSession(peer);
        if (message.type === 'select_game' && session.roomId) { if (session.gameId === game.gameId) { this.sync(session); return; } throw new ProtocolError('already_in_room'); }
        const compatibility = { version: message.version ?? '', mode: message.mode ?? '', region: message.region ?? '' }; this.validateCompatibility(game, compatibility);
        this.leave(session); this.cancelQueue(session.player.id); session.gameId = game.gameId; session.compatibility = compatibility; this.snapshot(session, game); this.presence(session.player.id);
      }); return;
    }
    if (message.type === 'list_blocks' || message.type === 'block_player' || message.type === 'unblock_player' || message.type.startsWith('friend_') || message.type === 'list_friends' || message.type.startsWith('party_') || message.type === 'queue_leave') {
      await this.serialized(() => { this.requireSession(peer); this.socialCommand(session, message); }); return;
    }
    if (message.type === 'start_game') { await this.start(peer); return; }
    const gameId = this.requireGame(session);
    if (message.type === 'join_room') { await this.join(peer, message.roomId, message.password, message.role, message.invitationToken); return; }
    if (message.type === 'quick_join') {
      const roomId = await this.serialized(() => { this.requireSession(peer); this.available(); const room = this.filtered(session, { ...message, availableOnly: true }).find(item => ![...item.players.keys(), ...item.held.keys()].some(id => this.blocked(session.player.id, id)) && (item.passwordHash === null || message.password !== undefined)); if (!room) throw new ProtocolError('room_not_found'); return room.id; });
      await this.join(peer, roomId, message.password); return;
    }
    if (message.type === 'list_rooms') { const game = await this.selectedGame(gameId); await this.serialized(() => { this.requireSession(peer); this.snapshot(session, game, message); }); return; }
    if (message.type === 'create_room') {
      const game = await this.selectedGame(gameId); const passwordHash = message.password === undefined ? null : await hashPassword(message.password);
      await this.serialized(() => {
        this.requireSession(peer); this.cancelQueue(session.player.id);
        this.newRoom(session, game, message.name, { passwordHash, ...(message.maxPlayers === undefined ? {} : { maxPlayers: message.maxPlayers }), ...(message.visibility === undefined ? {} : { visibility: message.visibility }), ...(message.locked === undefined ? {} : { locked: message.locked }), ...(message.version === undefined ? {} : { version: message.version }), ...(message.mode === undefined ? {} : { mode: message.mode }), ...(message.region === undefined ? {} : { region: message.region }), ...(message.joinPolicy === undefined ? {} : { joinPolicy: message.joinPolicy }), ...(message.maxSpectators === undefined ? {} : { maxSpectators: message.maxSpectators }), ...(message.rules && Object.keys(message.rules).length ? { rules: message.rules } : {}) });
      }); return;
    }
    if (message.type === 'leave_room') { const game = await this.selectedGame(gameId); await this.serialized(() => { this.requireSession(peer); this.leave(session); this.snapshot(session, game); }); return; }
    if (message.type === 'queue_join') {
      const game = await this.selectedGame(gameId);
      await this.serialized(() => { this.requireSession(peer); this.enqueue(session, game, message); this.matchQueue(game); }); return;
    }
    if (message.type === 'update_room') {
      const game = await this.selectedGame(gameId); const passwordHash = message.password === undefined ? undefined : message.password === '' ? null : await hashPassword(message.password);
      await this.serialized(() => {
        this.requireSession(peer); const room = this.requireRoom(session); this.host(session, room);
        if (room.state !== 'open') throw new ProtocolError('invalid_state');
        if (message.maxPlayers !== undefined && (message.maxPlayers > game.maxPlayersPerRoom || message.maxPlayers < this.count(room, 'player', true))) throw new ProtocolError('bad_request');
        if (message.maxSpectators !== undefined && (message.maxSpectators > this.config.lobby.maxSpectators || message.maxSpectators < this.count(room, 'spectator', true))) throw new ProtocolError('bad_request');
        const wasPublic = room.visibility === 'public';
        const patch: Partial<StoredRoom> = {};
        if (message.name !== undefined) patch.name = message.name;
        if (passwordHash !== undefined) patch.passwordHash = passwordHash;
        if (message.maxPlayers !== undefined) patch.maxPlayers = message.maxPlayers;
        if (message.maxSpectators !== undefined) patch.maxSpectators = message.maxSpectators;
        if (message.visibility !== undefined) patch.visibility = message.visibility;
        if (message.locked !== undefined) patch.locked = message.locked;
        if (message.joinPolicy !== undefined) patch.joinPolicy = message.joinPolicy;
        if (message.rules !== undefined && Object.keys(message.rules).length) patch.rules = message.rules;
        const previousRules = room.rules;
        const clearRules = message.rules !== undefined && Object.keys(message.rules).length === 0;
        if (clearRules) delete room.rules;
        const oldSummary = this.summary(room);
        try { this.commit(room, { ...patch, invitedIds: [] }); }
        catch (error) { if (clearRules && previousRules) room.rules = previousRules; throw error; }
        this.revokeInvites(room.id);
        if (wasPublic && room.visibility !== 'public') for (const observer of this.sessions.values()) if (this.connected(observer) && observer.gameId === room.gameId && !observer.roomId) observer.peer.send({ type: 'lobby_update', change: 'remove', room: oldSummary, lobbyRevision: this.lobbyRevision });
        this.publish(room, 'updated');
        if (!wasPublic && room.visibility === 'public') this.broadcastLobby(room, 'add');
      }); return;
    }
    await this.serialized(() => {
      this.requireSession(peer); const room = this.requireRoom(session);
      if (message.type === 'ready') { if (session.role === 'spectator') throw new ProtocolError('forbidden'); if (room.state !== 'open') throw new ProtocolError('invalid_state'); const previous = session.ready ?? false; session.ready = message.ready; try { this.commit(room); } catch (error) { session.ready = previous; throw error; } this.publish(room, 'ready'); return; }
      this.host(session, room);
      if (message.type === 'delete_room') { this.closeRoom(room, 'deleted', peer); return; }
      if (message.type === 'transfer_host') { const target = room.players.get(message.playerId); if (!target || !this.connected(target) || target.role === 'spectator') throw new ProtocolError('forbidden'); this.commit(room, { hostId: message.playerId }); this.publish(room, 'host'); return; }
      if (message.type === 'kick_player') {
        if (message.playerId === session.player.id) throw new ProtocolError('forbidden');
        const target = room.players.get(message.playerId); if (!target) throw new ProtocolError('room_not_found');
        if (message.ban && !room.bannedIds.includes(message.playerId) && room.bannedIds.length >= 1000) throw new ProtocolError('rate_limited');
        this.leave(target, message.ban ? { bannedIds: [...new Set([...room.bannedIds, message.playerId])] } : {});
        if (this.connected(target)) target.peer.send({ type: 'room_closed', roomId: room.id, reason: 'kicked' }); return;
      }
      if (message.type === 'unban_player') { this.commit(room, { bannedIds: room.bannedIds.filter(id => id !== message.playerId) }); this.publish(room, 'unban'); return; }
      if (message.type === 'invite_player') {
        if (room.bannedIds.includes(message.playerId) || this.blocked(session.player.id, message.playerId)) throw new ProtocolError(room.bannedIds.includes(message.playerId) ? 'player_banned' : 'forbidden');
        if (!room.invitedIds.includes(message.playerId) && room.invitedIds.length >= 1000) throw new ProtocolError('rate_limited');
        if (this.invitations.size >= this.config.limits.maxConnections * 4) throw new ProtocolError('rate_limited');
        const token = randomUUID(); const expiresAt = Date.now() + this.config.lobby.inviteTtlMs;
        this.commit(room, { invitedIds: [...new Set([...room.invitedIds, message.playerId])] });
        for (const [oldToken, invitation] of this.invitations) if (invitation.roomId === room.id && invitation.target === message.playerId) { try { this.persist(() => this.store.deleteInvitation(oldToken)); } catch { log('error', 'invitation_cleanup_failed'); } this.invitations.delete(oldToken); }
        this.persist(() => this.store.saveInvitation({ token, target: message.playerId, expiresAt, roomId: room.id }));
        this.invitations.set(token, { target: message.playerId, expiresAt, roomId: room.id });
        const invitation = { type: 'room_invitation', roomId: room.id, playerId: message.playerId, invitationToken: token, expiresAt };
        reply(peer, invitation); const target = this.players.get(message.playerId); if (target && this.connected(target)) target.peer.send(invitation); return;
      }
      throw new ProtocolError('bad_request');
    });
  }

  private socialKey(a: string, b: string): string { return JSON.stringify([a, b].sort()); }
  private friendPresence(playerId: string, viewerId?: string): Record<string, unknown> {
    if (viewerId && this.blocked(viewerId, playerId)) return { playerId, online: false };
    const session = this.players.get(playerId);
    return { playerId, online: !!session && this.connected(session), ...(session && this.connected(session) && session.gameId ? { gameId: session.gameId } : {}) };
  }
  private sendFriends(session: Session, direct = true): void {
    const id = session.player!.id;
    const friends = [...this.social.values()].filter(link => link.a === id || link.b === id).slice(0, 100).map(link => ({ playerId: link.a === id ? link.b : link.a, status: link.status, requestedBy: link.requestedBy, ...(link.status === 'accepted' ? this.friendPresence(link.a === id ? link.b : link.a, id) : {}) }));
    this.sendMembers(session.peer, { type: 'friends', revision: this.lobbyRevision }, friends, direct, 'friends');
  }
  private presence(id: string): void {
    for (const link of this.social.values()) if (link.status === 'accepted' && (link.a === id || link.b === id)) { const other = link.a === id ? link.b : link.a; const friend = this.players.get(other); if (friend && this.connected(friend) && !this.blocked(id, other)) friend.peer.send({ type: 'friend_presence', ...this.friendPresence(id, other) }); }
  }
  private party(id: string): Party | undefined { const partyId = this.partyOf.get(id); return partyId ? this.parties.get(partyId) : undefined; }
  private sendParty(id: string, direct = false): void {
    const session = this.players.get(id); if (!session || !this.connected(session)) return;
    const party = this.party(id);
    if (party) this.sendMembers(session.peer, { type: 'party_state', party: { id: party.id, leaderId: party.leaderId }, revision: this.lobbyRevision }, [...party.members].map(playerId => this.friendPresence(playerId)), direct, 'partyMembers');
    else { const message = { type: 'party_state', party: null }; if (direct) reply(session.peer, message); else session.peer.send(message); }
  }
  private publishParty(party: Party): void { for (const id of party.members) this.sendParty(id); }
  private leaveParty(id: string): void {
    const party = this.party(id); if (!party) return;
    this.cancelQueue(id); party.members.delete(id); this.partyOf.delete(id);
    for (const [token, invitation] of this.invitations) if (invitation.partyId === party.id) { try { this.persist(() => this.store.deleteInvitation(token)); } catch { log('error', 'invitation_cleanup_failed'); } this.invitations.delete(token); }
    if (!party.members.size) { this.persist(() => this.store.deleteParty(party.id)); this.parties.delete(party.id); }
    else { if (party.leaderId === id) party.leaderId = party.members.values().next().value!; this.persist(() => this.store.saveParty({ id: party.id, leaderId: party.leaderId, members: [...party.members] })); this.publishParty(party); }
    this.sendParty(id);
  }
  private socialCommand(session: Session & { player: Player }, message: Exclude<ClientMessage, { type: 'auth' }>): void {
    const id = session.player.id;
    if (message.type === 'list_friends') { this.sendFriends(session); return; }
    if (message.type === 'list_blocks') { reply(session.peer, { type: 'blocks', playerIds: [...this.blocks].flatMap(value => { const pair = JSON.parse(value) as [string, string]; return pair[0] === id ? [pair[1]] : []; }).slice(0, 100) }); return; }
    if (message.type === 'block_player' || message.type === 'unblock_player') {
      if (message.playerId === id) throw new ProtocolError('bad_request');
      const key = JSON.stringify([id, message.playerId]);
      const listed = () => [...this.blocks].flatMap(value => { const pair = JSON.parse(value) as [string, string]; return pair[0] === id ? [pair[1]] : []; }).slice(0, 100);
      if (message.type === 'block_player') {
        if (listed().length >= 100 && !this.blocks.has(key)) throw new ProtocolError('rate_limited');
        this.persist(() => this.store.saveBlock({ playerId: id, targetId: message.playerId })); this.blocks.add(key);
      } else { this.persist(() => this.store.deleteBlock(id, message.playerId)); this.blocks.delete(key); }
      reply(session.peer, { type: 'blocks', playerIds: listed() }); return;
    }
    if (message.type === 'friend_request' || message.type === 'friend_respond' || message.type === 'friend_remove') {
      if (message.playerId === id) throw new ProtocolError('bad_request');
      const key = this.socialKey(id, message.playerId); const existing = this.social.get(key);
      if (message.type === 'friend_request') {
        if (existing || this.blocked(id, message.playerId)) throw new ProtocolError(existing ? 'invalid_state' : 'forbidden');
        if ([id, message.playerId].some(playerId => [...this.social.values()].filter(link => link.a === playerId || link.b === playerId).length >= 100)) throw new ProtocolError('rate_limited');
        const [a, b] = [id, message.playerId].sort() as [string, string]; const link: SocialLink = { a, b, status: 'pending', requestedBy: id };
        this.persist(() => this.store.saveSocial(link)); this.social.set(key, link);
      } else if (message.type === 'friend_respond') {
        if (!existing || existing.status !== 'pending' || existing.requestedBy === id) throw new ProtocolError('forbidden');
        if (message.accept) { const link: SocialLink = { ...existing, status: 'accepted' }; this.persist(() => this.store.saveSocial(link)); this.social.set(key, link); }
        else { this.persist(() => this.store.deleteSocial(id, message.playerId)); this.social.delete(key); }
      } else { this.persist(() => this.store.deleteSocial(id, message.playerId)); this.social.delete(key); }
      this.sendFriends(session); const other = this.players.get(message.playerId); if (other && this.connected(other)) this.sendFriends(other, false); return;
    }
    if (message.type === 'party_create') { this.available(); if (this.party(id)) throw new ProtocolError('invalid_state'); this.cancelQueue(id); const party: Party = { id: randomUUID(), leaderId: id, members: new Set([id]) }; this.persist(() => this.store.saveParty({ id: party.id, leaderId: id, members: [id] })); this.parties.set(party.id, party); this.partyOf.set(id, party.id); this.sendParty(id, true); return; }
    if (message.type === 'party_leave') { if (!this.party(id)) throw new ProtocolError('not_in_party'); this.leaveParty(id); this.sendParty(id, true); return; }
    if (message.type === 'party_invite') {
      const party = this.party(id); if (!party) throw new ProtocolError('not_in_party'); if (party.leaderId !== id) throw new ProtocolError('forbidden'); if (party.members.size >= this.config.lobby.maxPartySize) throw new ProtocolError('party_full');
      if (this.blocked(id, message.playerId)) throw new ProtocolError('forbidden');
      if (this.invitations.size >= this.config.limits.maxConnections * 4) throw new ProtocolError('rate_limited');
      for (const [token, invitation] of this.invitations) if (invitation.partyId === party.id && invitation.target === message.playerId) { try { this.persist(() => this.store.deleteInvitation(token)); } catch { log('error', 'invitation_cleanup_failed'); } this.invitations.delete(token); }
      const token = randomUUID(); const expiresAt = Date.now() + this.config.lobby.inviteTtlMs;
      this.persist(() => this.store.saveInvitation({ token, target: message.playerId, expiresAt, partyId: party.id }));
      this.invitations.set(token, { target: message.playerId, partyId: party.id, expiresAt });
      const invitation = { type: 'party_invitation', partyId: party.id, playerId: message.playerId, invitationToken: token, expiresAt }; reply(session.peer, invitation); const target = this.players.get(message.playerId); if (target && this.connected(target)) target.peer.send(invitation); return;
    }
    if (message.type === 'party_accept') {
      this.available(); const invitation = this.invitations.get(message.invitationToken);
      if (!invitation || invitation.expiresAt <= Date.now()) throw new ProtocolError('invitation_expired'); if (invitation.target !== id || !invitation.partyId) throw new ProtocolError('forbidden');
      const party = this.parties.get(invitation.partyId); if (!party) throw new ProtocolError('not_in_party'); if (this.party(id) || session.roomId) throw new ProtocolError('invalid_state'); if (party.members.size >= this.config.lobby.maxPartySize) throw new ProtocolError('party_full');
      if ([...party.members].some(member => this.blocked(id, member))) throw new ProtocolError('forbidden');
      this.cancelQueue(id); this.cancelQueue(party.leaderId); party.members.add(id);
      try { this.persist(() => this.store.saveParty({ id: party.id, leaderId: party.leaderId, members: [...party.members] })); this.persist(() => this.store.deleteInvitation(message.invitationToken)); }
      catch (error) { party.members.delete(id); throw error; }
      this.partyOf.set(id, party.id); this.invitations.delete(message.invitationToken); this.publishParty(party); this.sendParty(id, true); return;
    }
    if (message.type === 'queue_leave') { this.cancelQueue(id); reply(session.peer, { type: 'queue_state', queued: false, reason: 'cancelled' }); return; }
    throw new ProtocolError('bad_request');
  }
  private cancelQueue(id: string, reason = 'cancelled'): void {
    for (let i = this.waiting.length - 1; i >= 0; i--) { const entry = this.waiting[i]!; if (!entry.members.includes(id)) continue; this.waiting.splice(i, 1); for (const member of entry.members) { const session = this.players.get(member); if (session && this.connected(session)) session.peer.send({ type: 'queue_state', queued: false, reason }); } }
  }
  private enqueue(session: Session & { player: Player }, game: Game, options: { minPlayers?: number; maxPlayers?: number; version?: string; mode?: string; region?: string }): void {
    this.available(); const party = this.party(session.player.id); if (party && party.leaderId !== session.player.id) throw new ProtocolError('forbidden');
    const members = party ? [...party.members] : [session.player.id];
    const compatibility = { version: options.version ?? this.compatibility(session).version, mode: options.mode ?? this.compatibility(session).mode, region: options.region ?? this.compatibility(session).region }; this.validateCompatibility(game, compatibility);
    const min = options.minPlayers ?? 2; const max = options.maxPlayers ?? game.maxPlayersPerRoom;
    if (min > max || max > game.maxPlayersPerRoom || members.length > max) throw new ProtocolError('bad_request');
    for (const id of members) { const member = this.players.get(id); if (!member || !this.connected(member) || member.roomId || member.gameId !== game.gameId || !this.compatible(this.compatibility(member), compatibility) || this.waiting.some(entry => entry.members.includes(id))) throw new ProtocolError('invalid_state'); this.checkPlayer(member.player!); }
    if (members.some((left, index) => members.slice(index + 1).some(right => this.blocked(left, right)))) throw new ProtocolError('forbidden');
    const entry: QueueEntry = { id: randomUUID(), members, ...(party ? { partyId: party.id } : {}), gameId: game.gameId, compatibility, min, max, at: Date.now() };
    this.waiting.push(entry); for (const id of members) { const member = this.players.get(id)!; const state = { type: 'queue_state', queued: true, queueId: entry.id, expiresAt: entry.at + this.config.lobby.matchmakingWaitMs }; if (id === session.player.id) reply(member.peer, state); else member.peer.send(state); }
  }
  private matchQueue(game: Game): void {
    for (const first of [...this.waiting]) {
      if (!this.waiting.includes(first) || first.gameId !== game.gameId) continue;
      const batch = [first]; let size = first.members.length; let min = first.min; let max = first.max;
      for (const candidate of this.waiting) {
        if (size >= min) break;
        if (candidate === first || candidate.gameId !== first.gameId || !this.compatible(candidate.compatibility, first.compatibility)) continue;
        if (batch.some(entry => entry.members.some(left => candidate.members.some(right => this.blocked(left, right))))) continue;
        const nextMax = Math.min(max, candidate.max); if (size + candidate.members.length > nextMax) continue;
        batch.push(candidate); size += candidate.members.length; min = Math.max(min, candidate.min); max = nextMax;
        if (size >= min) break;
      }
      if (size < min || size > max) continue;
      const ids = batch.flatMap(entry => entry.members); const leader = this.players.get(ids[0]!);
      if (!leader?.player) continue;
      // Insert must succeed before queue removal or membership changes: the party cannot be split on disk failure.
      const room = this.newRoom(leader as Session & { player: Player }, game, 'Matchmaking', { ...first.compatibility, maxPlayers: max }, false);
      for (const id of ids.slice(1)) { const member = this.players.get(id)!; room.players.set(id, member); member.roomId = room.id; member.ready = false; member.role = 'player'; }
      this.commit(room);
      for (const id of ids) this.sendMembers(this.players.get(id)!.peer, { type: 'room_joined', room: this.summary(room), revision: room.revision, lobbyRevision: this.lobbyRevision }, this.members(room), false);
      this.broadcastLobby(room, 'add');
      for (const entry of batch) this.waiting.splice(this.waiting.indexOf(entry), 1);
      this.publish(room, 'matched');
      for (const id of ids) { const member = this.players.get(id)!; member.peer.send({ type: 'queue_state', queued: false, reason: 'matched' }); member.peer.send({ type: 'match_found', room: this.summary(room) }); }
    }
  }

  setMaintenance(enabled: boolean): void {
    this.maintenance = enabled;
    if (enabled) void this.serialized(() => { for (const entry of [...this.waiting]) this.cancelQueue(entry.members[0]!, 'maintenance'); }).catch(() => log('error', 'maintenance_cleanup_failed'));
  }
  stats(): Record<string, unknown> { return { connections: [...this.sessions.values()].filter(session => this.connected(session)).length, players: this.players.size, rooms: this.rooms.size, disconnectedReservations: [...this.players.values()].filter(session => !this.connected(session) && session.roomId).length + [...this.rooms.values()].reduce((sum, room) => sum + room.held.size, 0), storageHealthy: this.storageHealthy, lobbyRevision: this.lobbyRevision, queuedPlayers: this.waiting.reduce((sum, entry) => sum + entry.members.length, 0), parties: this.parties.size, maintenance: this.maintenance, matches: [...this.rooms.values()].filter(room => room.state === 'in_game').length }; }
  private adminRecord(playerId: string, patch: Partial<Moderation>, action: string): void {
    const record: Moderation = { playerId, bannedUntil: 0, revokedBefore: 0, reason: '', ...this.moderation.get(playerId), ...patch };
    this.persist(() => this.store.saveModeration(record)); this.moderation.set(playerId, record);
    this.persist(() => this.store.audit({ at: Date.now(), actor: 'operator', action, target: playerId }));
  }
  private expel(playerId: string, code: 'player_banned' | 'token_revoked'): void {
    const session = this.players.get(playerId); if (!session) return;
    this.leave(session); this.cancelQueue(playerId); this.leaveParty(playerId); session.active = false;
    session.peer.send(errorMessage(code)); session.peer.close(4003, code); this.players.delete(playerId); this.sessions.delete(session.peer.id); this.presence(playerId);
  }
  async banPlayer(playerId: string, until: number, reason: string): Promise<void> { await this.serialized(() => { this.adminRecord(playerId, { bannedUntil: until, reason }, 'ban'); if (until > Date.now()) this.expel(playerId, 'player_banned'); }); }
  async unbanPlayer(playerId: string): Promise<void> { await this.serialized(() => this.adminRecord(playerId, { bannedUntil: 0 }, 'unban')); }
  async revokePlayer(playerId: string, before: number): Promise<void> { await this.serialized(() => { const cutoff = Math.max(before, this.moderation.get(playerId)?.revokedBefore ?? 0); this.adminRecord(playerId, { revokedBefore: cutoff }, 'revoke'); const player = this.players.get(playerId)?.player; if (player && cutoff > 0 && (player.issuedAt === undefined || player.issuedAt <= cutoff)) this.expel(playerId, 'token_revoked'); }); }
  async closeRoomById(roomId: string): Promise<void> { await this.serialized(() => { const room = this.rooms.get(roomId); if (!room) throw new ProtocolError('room_not_found'); this.closeRoom(room, 'moderated'); this.persist(() => this.store.audit({ at: Date.now(), actor: 'operator', action: 'close_room', target: roomId })); }); }
  async enforceRevocations(records: readonly { playerId?: string; tokenId?: string; revokedBefore?: number }[]): Promise<void> {
    await this.serialized(() => { for (const record of records) {
      if (record.playerId && record.revokedBefore !== undefined) this.adminRecord(record.playerId, { revokedBefore: Math.max(record.revokedBefore, this.moderation.get(record.playerId)?.revokedBefore ?? 0) }, 'oauth_revoke');
      for (const session of [...this.players.values()]) { const player = session.player!; if ((record.tokenId && player.tokenId === record.tokenId) || (record.playerId === player.id && (record.revokedBefore === undefined || player.issuedAt === undefined || player.issuedAt <= record.revokedBefore))) this.expel(player.id, 'token_revoked'); }
    } });
  }
  private releaseHeld(room: Room, playerId: string): void {
    const seat = room.held.get(playerId); if (!seat) return;
    room.held.delete(playerId); room.pendingResults.delete(playerId);
    const next = [...room.players.values()].find(member => member.role !== 'spectator' && member.player);
    const heldHost = [...room.held.values()].find(item => item.role !== 'spectator');
    const hostId = room.hostId === playerId ? next?.player?.id ?? heldHost?.playerId ?? room.ownerId : room.hostId;
    if (!room.players.size && !room.held.size && !room.reservations.size && room.emptySince === null) room.emptySince = Date.now();
    try { this.commit(room, hostId === room.hostId ? {} : { hostId }); }
    catch (error) { room.held.set(playerId, seat); throw error; }
    this.publish(room, 'leave');
  }
  private finishMatch(room: Room, state: 'ended' | 'failed'): void {
    const matchId = room.matchId;
    if (matchId) room.recentMatchId = matchId;
    const previous = [...room.players.values()].map(member => [member, member.ready] as const);
    const heldReady = [...room.held.values()].map(seat => [seat, seat.ready] as const);
    for (const member of room.players.values()) member.ready = false;
    for (const seat of room.held.values()) seat.ready = false;
    try { this.commit(room, { state: 'open', matchId: null }); }
    catch (error) { for (const [member, ready] of previous) member.ready = ready ?? false; for (const [seat, ready] of heldReady) seat.ready = ready; throw error; }
    if (matchId) this.finishedMatches.set(matchId, Date.now());
    this.publish(room, state);
  }
  async reportMatch(matchId: string, state: 'ended' | 'failed'): Promise<void> {
    await this.serialized(() => {
      if (this.finishedMatches.has(matchId)) return;
      const room = [...this.rooms.values()].find(item => item.matchId === matchId && (item.state === 'in_game' || item.state === 'starting') && !item.operation);
      if (!room) throw new ProtocolError('room_not_found');
      this.finishMatch(room, state);
      this.persist(() => this.store.audit({ at: Date.now(), actor: 'game', action: 'match_result', target: matchId }));
    });
  }
  async reportPlayerResult(matchId: string, playerId: string, result: Rules): Promise<void> {
    await this.serialized(() => {
      const room = [...this.rooms.values()].find(item => item.matchId === matchId || item.recentMatchId === matchId);
      if (!room) throw new ProtocolError('room_not_found');
      const member = room.players.get(playerId); const held = room.held.get(playerId);
      if (!member && !held) throw new ProtocolError('room_not_found');
      if (member && this.connected(member)) member.peer.send({ type: 'match_result', roomId: room.id, matchId, result });
      else { room.pendingResults.set(playerId, { matchId, result }); if (held) held.pendingResult = { matchId, result }; this.commit(room); }
      this.persist(() => this.store.audit({ at: Date.now(), actor: 'game', action: 'match_player_result', target: matchId }));
    });
  }
  async maintain(now = Date.now()): Promise<void> {
    await this.serialized(() => {
      if (this.stopped) return;
      for (const [id, at] of this.finishedMatches) if (now - at > 3_600_000) this.finishedMatches.delete(id);
      for (const session of this.sessions.values()) if ((!this.connected(session)) && session.disconnectedAt !== undefined && now - session.disconnectedAt >= this.config.lobby.reconnectGraceMs) { try { this.removeDisconnected(session); } catch { log('error', 'disconnect_cleanup_deferred'); } }
      for (const [token, invitation] of this.invitations) if (invitation.expiresAt <= now) { try { this.persist(() => this.store.deleteInvitation(token)); } catch { log('error', 'invitation_cleanup_failed'); } this.invitations.delete(token); }
      for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
      for (const [cursor, record] of this.cursors) if (!this.snapshots.has(record.snapshotId)) this.cursors.delete(cursor);
      for (const [id, failure] of this.passwordFailures) if (!failure.pending && now - failure.startedAt >= this.config.limits.passwordWindowMs) this.passwordFailures.delete(id);
      for (const entry of [...this.waiting]) if (now - entry.at >= this.config.lobby.matchmakingWaitMs) { for (const id of entry.members) this.players.get(id)?.peer.send(errorMessage('queue_timeout')); this.cancelQueue(entry.members[0]!, 'timeout'); }
      for (const room of [...this.rooms.values()]) {
        for (const [id, seat] of [...room.held]) if (seat.expiresAt <= now) { try { this.releaseHeld(room, id); } catch { log('error', 'seat_expiry_deferred'); } }
        if (!room.players.size && !room.reservations.size && !room.held.size && room.emptySince !== null && this.config.room.emptyTtlSec > 0 && now - room.emptySince >= this.config.room.emptyTtlSec * 1000 && room.state === 'open') { try { this.closeRoom(room, 'expired'); } catch { log('error', 'room_expiry_deferred'); } }
        if ((room.state === 'starting' || room.state === 'in_game') && !room.operation && !this.recovering.has(room.id)) {
          if (!room.matchId) {
            const request = room.matchRequest;
            if (!request) { log('error', 'match_recovery_missing_request'); continue; }
            this.recovering.add(room.id);
            void this.track(Promise.resolve().then(() => this.provider.create(request)).then(async allocation => {
              try {
                const state = await this.provider.status(allocation.matchId);
                await this.serialized(() => {
                  if (this.stopped || this.rooms.get(room.id) !== room || room.matchRequest?.operationId !== request.operationId || room.state !== 'starting') throw new ProtocolError('invalid_state');
                  if (state === 'ended' || state === 'failed') this.finishMatch(room, state);
                  else {
                    this.commit(room, { state, matchId: allocation.matchId }); this.publish(room, 'recovered');
                    if (state === 'in_game') this.recoverAdmissions(room, allocation.matchId);
                  }
                });
              } catch (error) {
                if (this.stopped || this.rooms.get(room.id) !== room || room.matchRequest?.operationId !== request.operationId || room.state !== 'starting') this.cancelMatch(allocation.matchId);
                throw error;
              }
            })).catch(() => log('error', 'match_recovery_unavailable')).finally(() => this.recovering.delete(room.id));
            continue;
          }
          const matchId = room.matchId; this.recovering.add(room.id);
          void this.track(Promise.resolve().then(() => this.provider.status(matchId)).then(state => this.serialized(() => {
            if (this.stopped || this.rooms.get(room.id) !== room || room.matchId !== matchId) return;
            if (state === 'ended' || state === 'failed') this.finishMatch(room, state);
            else if (room.state !== state) { this.commit(room, { state }); this.publish(room, 'recovered'); if (state === 'in_game') this.recoverAdmissions(room, matchId); }
          }))).catch(() => log('error', 'match_status_unavailable')).finally(() => this.recovering.delete(room.id));
        }
      }
    });
  }
  async close(): Promise<void> {
    this.stopped = true;
    await this.serialized(() => {
      for (const entry of [...this.waiting]) this.cancelQueue(entry.members[0]!, 'shutdown');
      if (this.config.lobby.reconnectGraceMs > 0) {
        const now = Date.now();
        for (const room of this.rooms.values()) {
          if (!room.players.size && !room.held.size) continue;
          for (const session of room.players.values()) { session.active = false; session.disconnectedAt = session.disconnectedAt ?? now; }
          for (const seat of room.held.values()) seat.expiresAt = Math.max(seat.expiresAt, now + this.config.lobby.reconnectGraceMs);
          try { this.commit(room); } catch { log('error', 'seat_flush_failed'); }
        }
      }
      this.parties.clear(); this.partyOf.clear(); this.invitations.clear(); this.snapshots.clear(); this.cursors.clear();
    });
    do { await Promise.allSettled([...this.external]); await this.queue; } while (this.external.size);
  }
  async settle(): Promise<void> { await this.queue; }
}
