import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { ClientMessage } from '../protocol/index.js';
import { ProtocolError, errorMessage } from '../protocol/index.js';
import type { Admission, MatchAllocation, MatchRequest, Game, GameProvider, GameSessionProvider, Peer, Player, RoomStore, Session, StoredRoom, Moderation, SocialLink, Rules, ReconnectSeat, StoredInvitation, DurableDomain, ChatMessage } from '../types.js';
import type { TrustedProfile } from '../games/profiles.js';
import { parseProfiles, TrustedProfileError } from '../games/profiles.js';
import { validateGameSettings, projectGame } from '../games/capabilities.js';
import { selectMatch, MatchSearchLimitError } from './matchmaking.js';
import type { MatchSelection } from './matchmaking.js';
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
}
interface Room extends StoredRoom {
  players: Map<string, Session>;
  reservations: Map<Session, 'player' | 'spectator'>;
  held: Map<string, HeldSeat>;
  emptySince: number | null;
  operation?: string;
  /** Serialized listing-visible fields at the last lobby broadcast; lets publish() skip no-op pushes. */
  lobbyKey?: string;
  recentMatchId?: string;
}
type Invitation = StoredInvitation;
interface Party { id: string; leaderId: string; members: Set<string> }
interface QueueEntry { id: string; members: string[]; partyId?: string; gameId: string; compatibility: Compatibility; min: number; max: number; at: number; matching: 'basic' | 'advanced'; profiles?: readonly TrustedProfile[]; rolePreferences?: Readonly<Record<string, readonly string[]>> }
interface Proposal { id: string; entries: QueueEntry[]; game: Game; deadline: number; accepted: Set<string>; players: MatchRequest['players'] }
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
  private domain: DurableDomain;
  private readonly proposals = new Map<string, Proposal>();
  private readonly chatBuckets = new Map<string, { tokens: number; at: number }>();
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly cursors = new Map<string, { snapshotId: string; page: number }>();
  private readonly recovering = new Set<string>();
  private readonly external = new Set<Promise<unknown>>();
  private readonly provider: GameSessionProvider;
  private queue: Promise<void> = Promise.resolve();
  private effects?: (() => void)[];
  private lobbyRevision = 1;
  private maintenance = false;
  private stopped = false;
  private storageHealthy = true;

  constructor(private readonly config: Config, private readonly store: RoomStore, private readonly games: GameProvider, sessions?: GameSessionProvider) {
    this.provider = sessions ?? new HttpGameSessions(config.games);
    this.domain = store.loadDomain();
    this.waiting.push(...(this.domain.queue ?? []));
    for (const proposal of this.domain.proposals ?? []) this.proposals.set(proposal.id, { ...proposal, accepted: new Set(proposal.accepted) });
    for (const room of store.load()) this.rooms.set(room.id, { ...room, players: new Map(), reservations: new Map(), held: new Map(), emptySince: Date.now() });
    for (const record of store.listModeration()) this.moderation.set(record.playerId, record);
    for (const link of store.listSocial()) this.social.set(this.socialKey(link.a, link.b), link);
    for (const block of store.listBlocks()) this.blocks.add(JSON.stringify([block.playerId, block.targetId]));
    for (const party of store.listParties()) { this.parties.set(party.id, { id: party.id, leaderId: party.leaderId, members: new Set(party.members) }); for (const id of party.members) this.partyOf.set(id, party.id); }
    for (const invitation of store.listInvitations()) this.invitations.set(invitation.token, invitation);
    this.restoreSeats();
  }

  connect(peer: Peer): void { this.sessions.set(peer.id, { peer, active: true, ready: false, role: 'player', compatibility: { version: '', mode: '', region: '' } }); }
  private serialized<T>(operation: () => T, readonly = false): Promise<T> {
    const result = this.queue.then(() => {
      if (readonly) return operation();
      const roomState = [...this.rooms].map(([id, room]) => [id, room, { ...room, players: new Map(room.players), reservations: new Map(room.reservations), held: new Map([...room.held].map(([key, value]) => [key, { ...value }])) }] as const);
      const sessionState = [...this.sessions].map(([id, session]) => [id, session, { ...session }] as const);
      const playerState = new Map(this.players); const domain = this.domain; const revision = this.lobbyRevision;
      const social = new Map(this.social); const invitations = new Map(this.invitations); const blocks = new Set(this.blocks);
      const parties = [...this.parties].map(([id, party]) => [id, party, { ...party, members: new Set(party.members) }] as const);
      const partyOf = new Map(this.partyOf); const waiting = [...this.waiting]; const proposals = [...this.proposals].map(([id, proposal]) => [id, proposal, { ...proposal, accepted: new Set(proposal.accepted) }] as const);
      const moderation = new Map(this.moderation);
      const passwordFailures = new Map([...this.passwordFailures].map(([id, item]) => [id, { ...item }]));
      const chatBuckets = new Map([...this.chatBuckets].map(([id, item]) => [id, { ...item }]));
      const recovering = new Set(this.recovering);
      const output: (() => void)[] = [];
      this.effects = output;
      const peers = [...new Set([...this.sessions.values()].map(session => session.peer))].map(peer => {
        const send = peer.send; const direct = peer.reply; const close = peer.close;
        peer.send = message => { output.push(() => send.call(peer, message)); };
        if (direct) peer.reply = message => { output.push(() => direct.call(peer, message)); };
        peer.close = (code, reason) => { output.push(() => close.call(peer, code, reason)); };
        return { peer, send, direct, close };
      });
      let value: T;
      try { value = undefined as T; this.store.transaction(() => { value = operation(); }); }
      catch (error) {
        this.rooms.clear(); for (const [id, room, state] of roomState) { for (const key of Object.keys(room)) if (!(key in state)) Reflect.deleteProperty(room, key); Object.assign(room, state); this.rooms.set(id, room); }
        this.sessions.clear(); for (const [id, session, state] of sessionState) { for (const key of Object.keys(session)) if (!(key in state)) Reflect.deleteProperty(session, key); Object.assign(session, state); this.sessions.set(id, session); }
        this.players.clear(); for (const [id, session] of playerState) this.players.set(id, session);
        this.domain = domain; this.lobbyRevision = revision;
        this.social.clear(); for (const [key, item] of social) this.social.set(key, item); this.invitations.clear(); for (const [key, item] of invitations) this.invitations.set(key, item);
        this.blocks.clear(); for (const item of blocks) this.blocks.add(item); this.parties.clear(); for (const [id, party, state] of parties) { Object.assign(party, state); this.parties.set(id, party); }
        this.partyOf.clear(); for (const [id, party] of partyOf) this.partyOf.set(id, party); this.waiting.splice(0, this.waiting.length, ...waiting); this.proposals.clear(); for (const [id, proposal, state] of proposals) { Object.assign(proposal, state); this.proposals.set(id, proposal); }
        this.moderation.clear(); for (const [id, record] of moderation) this.moderation.set(id, record);
        this.passwordFailures.clear(); for (const [id, item] of passwordFailures) this.passwordFailures.set(id, item);
        this.chatBuckets.clear(); for (const [id, item] of chatBuckets) this.chatBuckets.set(id, item);
        this.recovering.clear(); for (const id of recovering) this.recovering.add(id);
        if (error instanceof ProtocolError) throw error;
        this.storageHealthy = false; throw new ProtocolError('storage_error');
      } finally { delete this.effects; for (const { peer, send, direct, close } of peers) { peer.send = send; if (direct) peer.reply = direct; peer.close = close; } }
      for (const send of output) send();
      return value;
    });
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }
  private defer(effect: () => void): void { if (this.effects) this.effects.push(effect); else effect(); }
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
    if (this.stopped) return;
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
      seats.push({ playerId, role: session.role ?? 'player', ready: session.ready ?? false, gameId: session.gameId ?? room.gameId, version: compatibility.version, mode: compatibility.mode, region: compatibility.region, displayName: session.player.displayName, expiresAt: this.connected(session) ? 0 : (session.disconnectedAt ?? now) + grace });
    }
    for (const seat of room.held.values()) if (!room.players.has(seat.playerId)) seats.push({ playerId: seat.playerId, role: seat.role, ready: seat.ready, gameId: seat.gameId, version: seat.compatibility.version, mode: seat.compatibility.mode, region: seat.compatibility.region, displayName: seat.displayName, expiresAt: seat.expiresAt });
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
        room.held.set(seat.playerId, { playerId: seat.playerId, displayName: seat.displayName, role: seat.role, ready: seat.ready, gameId: seat.gameId, compatibility: { version: seat.version, mode: seat.mode, region: seat.region }, expiresAt });
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
    let domain = this.domain;
    if (next.matchId && !domain.matches.some(match => match.matchId === next.matchId)) domain = { ...domain, matches: [...domain.matches, { matchId: next.matchId, roomId: room.id, gameId: room.gameId, roster: room.matchRequest?.players.map(player => player.id) ?? [...room.players.keys(), ...room.held.keys()], createdAt: Date.now(), state: next.state === 'starting' ? 'starting' : 'in_game' }] };
    this.persist(() => this.store.transaction(() => { this.store.update(next); if (domain !== this.domain) this.store.saveDomain(domain); })); this.domain = domain;
    Object.assign(room, patch, { revision: next.revision, updatedAt: next.updatedAt });
    if (!next.matchRequest) delete room.matchRequest;
    if (seats.length) room.seats = seats; else delete room.seats;
    this.lobbyRevision++;
  }
  private recoverAdmissions(room: Room, matchId: string): void {
    for (const member of room.players.values()) if (this.connected(member) && member.player) {
      this.defer(() => { void this.track(Promise.resolve().then(() => this.provider.admit(matchId, member.player!.id, member.role ?? 'player')).then(admission => this.serialized(() => {
        if (this.stopped || !this.connected(member) || this.rooms.get(room.id) !== room || room.matchId !== matchId || room.state !== 'in_game' || member.roomId !== room.id) return;
        this.checkPlayer(member.player!);
        this.sendPacket(member.peer, { type: 'game_admission', roomId: room.id, matchId, ...admission }, false);
      }))).catch(() => log('error', 'match_admission_unavailable')); });
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
  private sendMembers(peer: Peer, base: Record<string, unknown>, members: Record<string, unknown>[], direct = true, field: 'members' | 'friends' | 'games' | 'partyMembers' | 'rooms' = 'members'): void {
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
    for (const result of this.domain.results) if (result.playerId === session.player!.id && result.acknowledgedAt === undefined) this.sendPacket(session.peer, { type: 'match_result', ...result }, false);
    this.sendInvitations(session, 'incoming', false);
    const proposal = [...this.proposals.values()].find(item => item.entries.some(entry => entry.members.includes(session.player!.id)));
    if (proposal) this.sendProposal(proposal, session.peer);
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
    room.players.delete(playerId); delete session.roomId; session.ready = false; session.role = 'player';
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
  private cancelMatch(matchId: string): void {
    const cancel = () => { void this.track(Promise.resolve().then(() => this.provider.cancel(matchId))).catch(() => log('error', 'match_cancel_failed')); };
    if (this.effects) this.effects.push(cancel); else cancel();
  }
  private cancelPending(request: MatchRequest): void {
    const cancel = () => { void this.track(Promise.resolve().then(() => this.provider.create(request)).then(allocation => this.provider.cancel(allocation.matchId))).catch(() => log('error', 'pending_match_cancel_failed')); };
    if (this.effects) this.effects.push(cancel); else cancel();
  }
  private closeRoom(room: Room, reason: string, requester?: Peer): void {
    const revoked = [...this.invitations.values()].filter(item => item.roomId === room.id && item.status === 'pending').map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
    this.persist(() => this.store.transaction(() => { this.store.delete(room.id); for (const item of revoked) this.store.saveInvitation(item); }));
    for (const item of revoked) this.invitations.set(item.token, item);
    this.rooms.delete(room.id); this.lobbyRevision++;
    if (room.matchId) this.cancelMatch(room.matchId);
    else if (room.matchRequest && !room.operation && !this.recovering.has(room.id)) this.cancelPending(room.matchRequest);
    delete room.operation;
    let replied = false;
    for (const session of room.players.values()) {
      delete session.roomId; session.ready = false;
      const message = { type: 'room_closed', roomId: room.id, reason };
      if (requester?.id === session.peer.id) { reply(requester, message); replied = true; } else if (this.connected(session)) session.peer.send(message);
    }
    if (requester && !replied && !requester.closed) reply(requester, { type: 'room_closed', roomId: room.id, reason });
    room.reservations.clear(); this.revokeInvites(room.id); this.broadcastLobby(room, 'remove');
  }
  private revokeInvites(roomId: string): void {
    for (const [token, invitation] of this.invitations) if (invitation.roomId === roomId && invitation.status === 'pending') this.resolveInvitation(token, 'revoked');
  }
  private newRoom(session: Session & { player: Player }, game: Game, name: string, options: Partial<StoredRoom> = {}, announce = true): Room {
    this.available();
    if (session.roomId) throw new ProtocolError('already_in_room');
    if ([...this.rooms.values()].filter(room => room.ownerId === session.player.id).length >= this.config.lobby.maxRoomsPerPlayer || [...this.rooms.values()].filter(room => room.gameId === game.gameId).length >= this.config.limits.maxRoomsPerGame) throw new ProtocolError('rate_limited');
    const compatibility = { ...this.compatibility(session), ...options };
    this.validateCompatibility(game, compatibility);
    const now = Date.now();
    const room: Room = { id: randomUUID(), gameId: game.gameId, name, ownerId: session.player.id, hostId: session.player.id, passwordHash: null, maxPlayers: game.maxPlayersPerRoom, state: 'open', createdAt: now, updatedAt: now, visibility: 'public', locked: false, ...this.compatibility(session), joinPolicy: 'closed', maxSpectators: this.config.lobby.maxSpectators, revision: 1, bannedIds: [], invitedIds: [], matchId: null, ...options, players: new Map([[session.player.id, session]]), reservations: new Map(), held: new Map(), emptySince: null };
    if (room.maxPlayers > game.maxPlayersPerRoom || room.maxSpectators > this.config.lobby.maxSpectators) throw new ProtocolError('bad_request');
    try { const rules = validateGameSettings(game, { maxPlayers: room.maxPlayers, joinPolicy: room.joinPolicy, ...(room.rules ? { rules: room.rules } : {}) }); if (rules && Object.keys(rules).length) room.rules = rules; } catch { throw new ProtocolError('bad_request'); }
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
    if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= Date.now()) throw new ProtocolError('invitation_expired');
    if (invitation.target !== target || invitation.roomId !== room.id || this.blocked(target, invitation.sender)) throw new ProtocolError('forbidden');
    return true;
  }
  private async join(peer: Peer, roomId: string, password?: string, role: 'player' | 'spectator' = 'player', invitationToken?: string): Promise<void> {
    const session = this.requireSession(peer);
    const game = await this.selectedGame(this.requireGame(session));
    const prepared = await this.serialized(() => {
      this.available(); this.requireSession(peer);
      if (session.roomId || [...this.rooms.values()].some(room => room.reservations.has(session))) throw new ProtocolError('already_in_room');
      const room = this.rooms.get(roomId);
      if (!room) throw new ProtocolError('room_not_found');
      if (room.gameId !== this.requireGame(session)) throw new ProtocolError('wrong_game');
      if (!this.compatible(room, this.compatibility(session))) throw new ProtocolError('incompatible_version');
      try { validateGameSettings(game, { maxPlayers: room.maxPlayers, joinPolicy: room.joinPolicy, ...(room.rules ? { rules: room.rules } : {}) }); } catch { throw new ProtocolError('bad_request'); }
      if ([...room.players.keys(), ...room.held.keys()].some(id => this.blocked(id, session.player.id))) throw new ProtocolError('forbidden');
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
        if ([...room.players.keys(), ...room.held.keys()].some(id => this.blocked(id, session.player.id))) throw new ProtocolError('forbidden');
        if (invitationToken) this.validInvitation(invitationToken, session.player.id, room);
        const hostId = role === 'player' && this.count(room) === 0 ? session.player.id : room.hostId;
        room.reservations.delete(session); room.players.set(session.player.id, session); session.roomId = room.id; session.role = role; session.ready = false; room.emptySince = null;
        const invitation = invitationToken ? this.invitations.get(invitationToken) : undefined;
        const accepted = invitation ? { ...invitation, status: 'accepted' as const, resolvedAt: Date.now() } : undefined;
        try {
          const stored = { ...room, hostId, revision: room.revision + 1, updatedAt: Date.now(), seats: this.seatSnapshot(room) };
          this.persist(() => this.store.transaction(() => { this.store.update(stored); if (accepted) this.store.saveInvitation(accepted); }));
          Object.assign(room, { hostId, revision: stored.revision, updatedAt: stored.updatedAt }); if (accepted) this.invitations.set(accepted.token, accepted);
        } catch (error) { room.players.delete(session.player.id); delete session.roomId; room.reservations.set(session, role); throw error; }
        this.cancelQueue(session.player.id); this.joined(session, room); this.publish(room, 'join');
        if (admission) this.sendPacket(peer, { type: 'game_admission', roomId: room.id, matchId: room.matchId, ...admission });
      });
    } finally { await this.serialized(() => { prepared.room.reservations.delete(session); if (prepared.hash) prepared.failure.pending--; }); }
  }
  private async start(peer: Peer): Promise<void> {
    const operationId = randomUUID();
    const game = await this.selectedGame(this.requireGame(this.requireSession(peer)));
    const prepared = await this.serialized(() => {
      this.available(); const session = this.requireSession(peer); const room = this.requireRoom(session); this.host(session, room);
      if (room.state !== 'open' || room.reservations.size) throw new ProtocolError('invalid_state');
      const members = [...room.players.values()];
      if (!members.some(member => member.role !== 'spectator') || members.some(member => member.role !== 'spectator' && (!member.ready || !this.connected(member)))) throw new ProtocolError('not_ready');
      let roster: MatchRequest['players'] = members.map(member => ({ id: member.player!.id, role: member.role ?? 'player', ...room.assignments?.find(player => player.id === member.player!.id) }));
      if (game.capabilities?.teams && !room.assignments) {
        let selection: MatchSelection | undefined;
        try { selection = selectMatch(members.filter(member => member.role !== 'spectator').map(member => ({ id: member.player!.id, playerIds: [member.player!.id], queuedAt: 0 })), { mode: 'basic', game, now: Date.now(), playerCount: members.filter(member => member.role !== 'spectator').length, region: room.region, blocked: (a, b) => this.blocked(a, b), policy: this.config.matching, searchLimit: this.config.matching.searchLimit, profileMaxAgeMs: this.config.games.profileMaxAgeMs }); }
        catch (error) { if (error instanceof MatchSearchLimitError) throw new ProtocolError('matchmaking_search_exhausted'); throw new ProtocolError('bad_request'); }
        if (!selection) throw new ProtocolError('not_ready'); roster = [...selection.players, ...roster.filter(player => player.role === 'spectator')];
      }
      try { validateGameSettings(game, { ...room, players: roster }); } catch { throw new ProtocolError('bad_request'); }
      const request: MatchRequest = { operationId, roomId: room.id, gameId: room.gameId, players: roster, version: room.version, mode: room.mode, region: room.region, joinPolicy: room.joinPolicy, ...(room.rules && Object.keys(room.rules).length ? { rules: room.rules } : {}) };
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
        const next = { ...this.domain, matches: [...this.domain.matches] };
        next.matches.push({ matchId: allocation.matchId, roomId: room.id, gameId: room.gameId, roster: prepared.request.players.map(player => player.id), createdAt: Date.now(), state: 'in_game' });
        this.persist(() => this.store.transaction(() => { this.store.update({ ...room, state: 'in_game', matchId: allocation.matchId, revision: room.revision + 1, updatedAt: Date.now(), seats: this.seatSnapshot(room) }); this.store.saveDomain(next); }));
        Object.assign(room, { state: 'in_game', matchId: allocation.matchId, revision: room.revision + 1, updatedAt: Date.now() }); delete room.matchRequest; this.domain = next; delete room.operation; this.publish(room, 'started');
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
  private async joinParty(peer: Peer, message: Extract<ClientMessage, { type: 'party_join_room' }>): Promise<void> {
    const game = await this.selectedGame(this.requireGame(this.requireSession(peer)));
    const prepared = await this.serialized(() => {
      this.available(); const session = this.requireSession(peer); const party = this.party(session.player.id);
      if (!party) throw new ProtocolError('not_in_party'); if (party.leaderId !== session.player.id) throw new ProtocolError('forbidden');
      const room = this.rooms.get(message.roomId); if (!room) throw new ProtocolError('room_not_found');
      const members = [...party.members].map(id => this.players.get(id));
      if (members.some(member => !member || !this.connected(member) || member.roomId || [...this.rooms.values()].some(item => item.reservations.has(member)))) throw new ProtocolError('invalid_state');
      const roster = members as (Session & { player: Player })[];
      const invited = this.validInvitation(message.invitationToken, session.player.id, room); const owner = room.ownerId === session.player.id;
      if ((room.visibility === 'invite' || room.locked) && !invited && !owner) throw new ProtocolError('invitation_required');
      if (room.state !== 'open' && !(room.state === 'in_game' && room.joinPolicy === 'fill')) throw new ProtocolError('invalid_state');
      if (this.count(room, 'player', true) + roster.length > room.maxPlayers) throw new ProtocolError('room_full');
      for (const member of roster) {
        this.checkPlayer(member.player);
        if (member.gameId !== room.gameId || !this.compatible(room, this.compatibility(member))) throw new ProtocolError('incompatible_version');
        if (room.bannedIds.includes(member.player.id) || [...room.players.keys(), ...room.held.keys(), ...party.members].some(id => this.blocked(id, member.player.id))) throw new ProtocolError('forbidden');
      }
      try { validateGameSettings(game, { maxPlayers: room.maxPlayers, joinPolicy: room.joinPolicy, ...(room.rules ? { rules: room.rules } : {}) }); } catch { throw new ProtocolError('bad_request'); }
      const hash = invited || owner ? null : room.passwordHash; if (hash && message.password === undefined) throw new ProtocolError('room_password_required');
      const failure = this.passwordFailures.get(session.player.id) ?? { count: 0, startedAt: Date.now(), pending: 0 };
      if (Date.now() - failure.startedAt >= this.config.limits.passwordWindowMs && !failure.pending) { failure.count = 0; failure.startedAt = Date.now(); }
      if (hash && failure.count + failure.pending >= this.config.limits.passwordFailures) throw new ProtocolError('rate_limited');
      if (hash) failure.pending++; this.passwordFailures.set(session.player.id, failure);
      for (const member of roster) room.reservations.set(member, 'player');
      return { room, party, roster, memberIds: [...party.members], leaderId: party.leaderId, hash, failure, revision: room.revision, matchId: room.matchId };
    });
    try {
      if (prepared.hash && !await verifyPassword(message.password!, prepared.hash)) { await this.serialized(() => { prepared.failure.count++; }); throw new ProtocolError('room_password_incorrect'); }
      const admissions = prepared.matchId ? await this.track(Promise.all(prepared.roster.map(member => this.provider.admit(prepared.matchId!, member.player.id, 'player')))).catch(() => { throw new ProtocolError('game_service_unavailable'); }) : [];
      await this.serialized(() => {
        this.available(); this.requireSession(peer);
        const { room, party, roster } = prepared;
        if (this.rooms.get(room.id) !== room || room.revision !== prepared.revision || this.parties.get(party.id) !== party || party.leaderId !== prepared.leaderId || JSON.stringify([...party.members]) !== JSON.stringify(prepared.memberIds) || roster.some(member => !this.connected(member) || member.roomId || !room.reservations.has(member) || member.gameId !== room.gameId || !this.compatible(room, this.compatibility(member)))) throw new ProtocolError('invalid_state');
        for (const member of roster) { this.checkPlayer(member.player); if ([...room.players.keys(), ...room.held.keys(), ...party.members].some(id => this.blocked(id, member.player.id))) throw new ProtocolError('forbidden'); }
        if (message.invitationToken) this.validInvitation(message.invitationToken, prepared.leaderId, room);
        const shadow: Room = { ...room, players: new Map(room.players) }; for (const member of roster) shadow.players.set(member.player.id, member);
        const stored: StoredRoom = { ...room, seats: this.seatSnapshot(shadow), hostId: this.count(room) ? room.hostId : prepared.leaderId, revision: room.revision + 1, updatedAt: Date.now() };
        const invitation = message.invitationToken ? this.invitations.get(message.invitationToken) : undefined;
        const accepted = invitation ? { ...invitation, status: 'accepted' as const, resolvedAt: Date.now() } : undefined;
        this.persist(() => this.store.transaction(() => { this.store.update(stored); if (accepted) this.store.saveInvitation(accepted); }));
        Object.assign(room, { revision: stored.revision, updatedAt: stored.updatedAt, hostId: stored.hostId, emptySince: null });
        if (accepted) this.invitations.set(accepted.token, accepted);
        this.cancelQueue(prepared.leaderId);
        roster.forEach((member, index) => { room.reservations.delete(member); room.players.set(member.player.id, member); member.roomId = room.id; member.role = 'player'; member.ready = false; if (member.peer === peer) this.joined(member, room); else this.sendMembers(member.peer, { type: 'room_joined', room: this.summary(room), revision: room.revision, lobbyRevision: this.lobbyRevision }, this.members(room), false); const admission = admissions[index]; if (admission) this.sendPacket(member.peer, { type: 'game_admission', roomId: room.id, matchId: room.matchId, ...admission }, false); });
        this.publish(room, 'party_join');
      });
    } finally { await this.serialized(() => { for (const member of prepared.roster) prepared.room.reservations.delete(member); if (prepared.hash) prepared.failure.pending--; }); }
  }
  async handle(peer: Peer, message: Exclude<ClientMessage, { type: 'auth' }>): Promise<void> {
    const session = this.requireSession(peer);
    if (message.type === 'party_join_room') { await this.joinParty(peer, message); return; }
    if (message.type.startsWith('chat_') || message.type.startsWith('match_') || message.type === 'list_match_results' || message.type === 'ack_match_result' || message.type === 'list_invitations' || message.type === 'decline_invitation' || message.type === 'revoke_invitation') { await this.serialized(() => { this.requireSession(peer); this.domainCommand(session, message); }, message.type === 'chat_history' || message.type === 'list_match_results' || message.type === 'list_invitations'); return; }
    if (message.type === 'ping') { reply(peer, { type: 'pong' }); return; }
    if (message.type === 'list_games') { const games = await this.games.list(); await this.serialized(() => { this.requireSession(peer); this.sendMembers(peer, { type: 'games', revision: this.lobbyRevision }, games.filter(game => game.enabled).map(game => ({ ...projectGame(game) })), true, 'games'); }, true); return; }
    if (message.type === 'sync_state') {
      const target = await this.serialized(() => { this.requireSession(peer); this.sync(session); const room = session.roomId ? this.rooms.get(session.roomId) : undefined; return room?.state === 'in_game' && room.matchId ? { room, matchId: room.matchId, role: session.role ?? 'player' } : undefined; }, true);
      if (target) {
        let admission: Admission;
        try { admission = await this.track(this.provider.admit(target.matchId, session.player.id, target.role)); } catch { throw new ProtocolError('game_service_unavailable'); }
        await this.serialized(() => { this.requireSession(peer); if (session.roomId !== target.room.id || this.rooms.get(target.room.id) !== target.room || target.room.matchId !== target.matchId) throw new ProtocolError('invalid_state'); this.sendPacket(peer, { type: 'game_admission', roomId: target.room.id, matchId: target.matchId, ...admission }); }, true);
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
    if (message.type === 'list_owned_rooms' || message.type === 'list_blocks' || message.type === 'block_player' || message.type === 'unblock_player' || message.type.startsWith('friend_') || message.type === 'list_friends' || message.type.startsWith('party_') || message.type === 'queue_leave') {
      await this.serialized(() => { this.requireSession(peer); this.socialCommand(session, message); }, message.type === 'list_owned_rooms' || message.type === 'list_blocks' || message.type === 'list_friends'); return;
    }
    if (message.type === 'delete_room' && message.roomId && message.roomId !== session.roomId) {
      await this.serialized(() => { this.requireSession(peer); this.deleteOwnedEmpty(session, message.roomId!); }); return;
    }
    if (message.type === 'start_game') { await this.start(peer); return; }
    const gameId = this.requireGame(session);
    if (message.type === 'join_room') { await this.join(peer, message.roomId, message.password, message.role, message.invitationToken); return; }
    if (message.type === 'quick_join') {
      const roomId = await this.serialized(() => { this.requireSession(peer); this.available(); const room = this.filtered(session, { ...message, availableOnly: true }).find(item => ![...item.players.keys(), ...item.held.keys()].some(id => this.blocked(session.player.id, id)) && (item.passwordHash === null || message.password !== undefined)); if (!room) throw new ProtocolError('room_not_found'); return room.id; }, true);
      await this.join(peer, roomId, message.password); return;
    }
    if (message.type === 'list_rooms') { const game = await this.selectedGame(gameId); await this.serialized(() => { this.requireSession(peer); this.snapshot(session, game, message); }, true); return; }
    if (message.type === 'create_room') {
      const game = await this.selectedGame(gameId); const passwordHash = message.password === undefined ? null : await hashPassword(message.password);
      await this.serialized(() => {
        this.requireSession(peer); this.cancelQueue(session.player.id);
        this.newRoom(session, game, message.name, { passwordHash, ...(message.maxPlayers === undefined ? {} : { maxPlayers: message.maxPlayers }), ...(message.visibility === undefined ? {} : { visibility: message.visibility }), ...(message.locked === undefined ? {} : { locked: message.locked }), ...(message.version === undefined ? {} : { version: message.version }), ...(message.mode === undefined ? {} : { mode: message.mode }), ...(message.region === undefined ? {} : { region: message.region }), ...(message.joinPolicy === undefined ? {} : { joinPolicy: message.joinPolicy }), ...(message.maxSpectators === undefined ? {} : { maxSpectators: message.maxSpectators }), ...(message.rules && Object.keys(message.rules).length ? { rules: message.rules } : {}) });
      }); return;
    }
    if (message.type === 'leave_room') { const game = await this.selectedGame(gameId); await this.serialized(() => { this.requireSession(peer); this.leave(session); this.snapshot(session, game); }); return; }
    if (message.type === 'queue_join') {
      let game = await this.selectedGame(gameId);
      let profiles: readonly TrustedProfile[] | undefined;
      const prepared = await this.serialized(() => { this.requireSession(peer); const party = this.party(session.player.id); return { party, roster: party ? [...party.members] : [session.player.id] }; }, true);
      const { roster } = prepared;
      if (message.matching === 'advanced') { if (!this.games.profiles) throw new ProtocolError('profile_unavailable'); try { profiles = await this.track(this.games.profiles(gameId, roster)); } catch { throw new ProtocolError('profile_unavailable'); } }
      game = await this.selectedGame(gameId);
      await this.serialized(() => {
        this.requireSession(peer); const party = this.party(session.player.id); const current = party ? [...party.members] : [session.player.id];
        if (session.gameId !== gameId || party !== prepared.party || JSON.stringify(current) !== JSON.stringify(roster)) throw new ProtocolError('invalid_state');
        this.enqueue(session, game, message, profiles); this.matchQueue(game);
      }); return;
    }
    if (message.type === 'update_room') {
      const game = await this.selectedGame(gameId); const passwordHash = message.password === undefined ? undefined : message.password === '' ? null : await hashPassword(message.password);
      await this.serialized(() => {
        this.requireSession(peer); const room = this.requireRoom(session); this.host(session, room);
        if (room.state !== 'open') throw new ProtocolError('invalid_state');
        try { const rules = message.rules ?? room.rules; validateGameSettings(game, { maxPlayers: message.maxPlayers ?? room.maxPlayers, joinPolicy: message.joinPolicy ?? room.joinPolicy, ...(rules ? { rules } : {}) }); } catch { throw new ProtocolError('bad_request'); }
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
        const record: Invitation = { token, sender: session.player.id, target: message.playerId, status: 'pending', createdAt: Date.now(), expiresAt, roomId: room.id };
        const revoked = [...this.invitations.values()].filter(item => item.roomId === room.id && item.target === message.playerId && item.status === 'pending').map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
        this.persist(() => this.store.transaction(() => { this.store.saveInvitation(record); for (const item of revoked) this.store.saveInvitation(item); }));
        for (const item of revoked) this.invitations.set(item.token, item); this.invitations.set(token, record);
        const invitation = { type: 'room_invitation', roomId: room.id, playerId: message.playerId, invitationToken: token, expiresAt };
        reply(peer, invitation); const target = this.players.get(message.playerId); if (target && this.connected(target)) target.peer.send(invitation); return;
      }
      throw new ProtocolError('bad_request');
    });
  }

  private resolveInvitation(token: string, status: 'accepted' | 'declined' | 'revoked' | 'expired'): void {
    const invitation = this.invitations.get(token);
    if (!invitation || invitation.status !== 'pending') throw new ProtocolError('invitation_expired');
    const next = { ...invitation, status, resolvedAt: Date.now() };
    this.persist(() => this.store.saveInvitation(next)); this.invitations.set(token, next);
  }
  private sendInvitations(session: Session, direction: 'incoming' | 'outgoing', direct = true): void {
    const id = session.player!.id;
    const invitations = [...this.invitations.values()].filter(item => direction === 'incoming' ? item.target === id : item.sender === id).map(({ token, ...item }) => ({ ...item, invitationToken: token, status: item.status === 'pending' && item.expiresAt <= Date.now() ? 'expired' : item.status }));
    this.sendPacket(session.peer, { type: 'invitations', invitations }, direct);
  }
  private scope(session: Session & { player: Player }, scope: 'room' | 'party'): { id: string; members: string[]; leaderId: string } {
    if (scope === 'room') { const room = this.requireRoom(session); return { id: room.id, members: [...room.players.keys()], leaderId: room.hostId }; }
    const party = this.party(session.player.id); if (!party) throw new ProtocolError('not_in_party');
    return { id: party.id, members: [...party.members], leaderId: party.leaderId };
  }
  private domainCommand(session: Session & { player: Player }, message: Exclude<ClientMessage, { type: 'auth' }>): void {
    const id = session.player.id;
    if (message.type === 'list_invitations') { this.sendInvitations(session, message.direction ?? 'incoming'); return; }
    if (message.type === 'decline_invitation' || message.type === 'revoke_invitation') {
      const invitation = this.invitations.get(message.invitationToken);
      if (!invitation || (message.type === 'decline_invitation' ? invitation.target : invitation.sender) !== id) throw new ProtocolError('forbidden');
      if (invitation.expiresAt <= Date.now()) throw new ProtocolError('invitation_expired');
      const status = message.type === 'decline_invitation' ? 'declined' : 'revoked'; this.resolveInvitation(invitation.token, status);
      reply(session.peer, { type: 'invitation_resolved', invitationToken: invitation.token, status }); return;
    }
    if (message.type === 'list_match_results') {
      const records = this.domain.results.filter(item => item.playerId === id);
      const offset = message.cursor ? records.findIndex(item => item.resultId === message.cursor) + 1 : 0;
      if (message.cursor && offset === 0) throw new ProtocolError('snapshot_expired');
      const results = records.slice(offset, offset + (message.limit ?? this.config.limits.defaultPageSize));
      this.sendPacket(session.peer, { type: 'match_results', results, ...(offset + results.length < records.length ? { nextCursor: results.at(-1)!.resultId } : {}) }); return;
    }
    if (message.type === 'ack_match_result') {
      const result = this.domain.results.find(item => item.resultId === message.resultId && item.playerId === id);
      if (!result) throw new ProtocolError('forbidden');
      const next = { ...this.domain, results: this.domain.results.map(item => item === result ? { ...item, acknowledgedAt: item.acknowledgedAt ?? Date.now() } : item) }; this.persist(() => this.store.saveDomain(next)); this.domain = next;
      reply(session.peer, { type: 'match_result_acked', resultId: result.resultId }); return;
    }
    if (message.type === 'match_accept' || message.type === 'match_decline') {
      const proposal = this.proposals.get(message.proposalId);
      if (!proposal || proposal.deadline <= Date.now()) throw new ProtocolError('invalid_state');
      const entry = proposal.entries.find(item => item.members.includes(id)); if (!entry) throw new ProtocolError('forbidden');
      if (message.type === 'match_decline') { this.cancelProposal(proposal, new Set([entry.id]), 'declined'); reply(session.peer, { type: 'match_proposal_resolved', proposalId: proposal.id, reason: 'declined' }); return; }
      if (proposal.entries.some(item => !this.queueEligible(item)) || proposal.players.some(left => proposal.players.some(right => this.blocked(left.id, right.id)))) throw new ProtocolError('invalid_state');
      for (const item of proposal.entries) if (item.matching === 'advanced') this.trustedProfiles(item.gameId, item.members, item.profiles, Date.now());
      const accepted = new Set(proposal.accepted); accepted.add(id);
      if (accepted.size === proposal.players.length) this.confirmProposal(proposal);
      else { this.persistQueue(this.waiting, [...this.proposals.values()].map(item => item === proposal ? { ...item, accepted } : item)); proposal.accepted = accepted; for (const player of proposal.players) this.sendProposal(proposal, this.players.get(player.id)!.peer); }
      reply(session.peer, { type: 'match_proposal_resolved', proposalId: proposal.id, reason: accepted.size === proposal.players.length ? 'matched' : 'accepted' }); return;
    }
    if (message.type === 'chat_report') {
      const evidence = this.domain.chat.find(item => item.id === message.messageId && item.recipients.includes(id) && !this.blocked(id, item.senderId));
      if (!evidence) throw new ProtocolError('forbidden');
      if (this.domain.reports.length >= this.config.chat.maxReports) throw new ProtocolError('rate_limited');
      const next = { ...this.domain, reports: [...this.domain.reports] }; const reportId = randomUUID();
      next.reports.push({ id: reportId, reporterId: id, message: structuredClone(evidence), reason: message.reason, createdAt: Date.now(), status: 'pending' });
      this.persist(() => this.store.saveDomain(next)); this.domain = next; reply(session.peer, { type: 'chat_reported', reportId }); return;
    }
    if (message.type === 'chat_send' || message.type === 'chat_history' || message.type === 'chat_mute') {
      const scope = this.scope(session, message.scope);
      if (message.type === 'chat_history') {
        const records = this.domain.chat.filter(item => item.scope === message.scope && item.scopeId === scope.id && item.recipients.includes(id) && !this.blocked(id, item.senderId));
        const offset = message.cursor ? records.findIndex(item => item.id === message.cursor) + 1 : 0; if (message.cursor && offset === 0) throw new ProtocolError('snapshot_expired');
        const messages = records.slice(offset, offset + (message.limit ?? this.config.limits.defaultPageSize)).map(({ recipients: _recipients, ...item }) => item);
        this.sendPacket(session.peer, { type: 'chat_history', messages, ...(offset + messages.length < records.length ? { nextCursor: messages.at(-1)!.id } : {}) }); return;
      }
      if (message.type === 'chat_mute') {
        if (scope.leaderId !== id || !scope.members.includes(message.playerId) || message.playerId === id || message.until > Date.now() + this.config.chat.maxMuteMs) throw new ProtocolError('forbidden');
        const next = { ...this.domain }; next.mutes = next.mutes.filter(item => !(item.scope === message.scope && item.scopeId === scope.id && item.playerId === message.playerId));
        if (message.until > Date.now()) next.mutes.push({ scope: message.scope, scopeId: scope.id, playerId: message.playerId, until: message.until });
        this.persist(() => this.store.saveDomain(next)); this.domain = next; reply(session.peer, { type: 'chat_muted', scope: message.scope, playerId: message.playerId, until: message.until }); return;
      }
      if ([...message.text].length > this.config.chat.maxTextLength || !message.text.trim() || /[\p{Cc}\p{Cs}]/u.test(message.text)) throw new ProtocolError('bad_request');
      if (this.domain.mutes.some(item => item.scope === message.scope && item.scopeId === scope.id && item.playerId === id && item.until > Date.now())) throw new ProtocolError('chat_muted');
      const now = Date.now(); const bucket = { ...(this.chatBuckets.get(id) ?? { tokens: this.config.chat.burst, at: now }) };
      bucket.tokens = Math.min(this.config.chat.burst, bucket.tokens + (now - bucket.at) * this.config.chat.burst / this.config.chat.windowMs); bucket.at = now;
      if (bucket.tokens < 1) throw new ProtocolError('rate_limited');
      const item: ChatMessage = { id: randomUUID(), scope: message.scope, scopeId: scope.id, senderId: id, text: message.text, createdAt: now, recipients: scope.members.filter(member => !this.blocked(id, member)) };
      const next = { ...this.domain, chat: [...this.domain.chat] }; next.chat.push(item); next.chat = next.chat.slice(-this.config.chat.maxMessages);
      this.persist(() => this.store.saveDomain(next)); this.domain = next; bucket.tokens--; this.chatBuckets.set(id, bucket);
      const { recipients: _recipients, ...visible } = item;
      reply(session.peer, { type: 'chat_message', message: visible });
      for (const member of item.recipients) { const target = this.players.get(member); if (member !== id && target && this.connected(target)) target.peer.send({ type: 'chat_message', message: visible }); }
      return;
    }
    throw new ProtocolError('bad_request');
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
    const members = [...party.members].filter(member => member !== id);
    const leaderId = party.leaderId === id ? [...members].sort()[0]! : party.leaderId;
    const revoked = [...this.invitations.values()].filter(item => item.partyId === party.id && item.status === 'pending').map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
    this.persist(() => this.store.transaction(() => {
      if (members.length) this.store.saveParty({ id: party.id, leaderId, members }); else this.store.deleteParty(party.id);
      for (const item of revoked) this.store.saveInvitation(item);
    }));
    this.cancelQueue(id); party.members = new Set(members); party.leaderId = leaderId; this.partyOf.delete(id);
    for (const item of revoked) this.invitations.set(item.token, item);
    if (!members.length) this.parties.delete(party.id); else this.publishParty(party);
    this.sendParty(id);
  }
  private socialCommand(session: Session & { player: Player }, message: Exclude<ClientMessage, { type: 'auth' }>): void {
    const id = session.player.id;
    if (message.type === 'list_friends') { this.sendFriends(session); return; }
    if (message.type === 'list_owned_rooms') { this.sendMembers(session.peer, { type: 'owned_rooms', revision: this.lobbyRevision }, [...this.rooms.values()].filter(room => room.ownerId === id).map(room => this.summary(room)), true, 'rooms'); return; }
    if (message.type === 'list_blocks') { reply(session.peer, { type: 'blocks', playerIds: [...this.blocks].flatMap(value => { const pair = JSON.parse(value) as [string, string]; return pair[0] === id ? [pair[1]] : []; }).slice(0, 100) }); return; }
    if (message.type === 'block_player' || message.type === 'unblock_player') {
      if (message.playerId === id) throw new ProtocolError('bad_request');
      const key = JSON.stringify([id, message.playerId]);
      const listed = () => [...this.blocks].flatMap(value => { const pair = JSON.parse(value) as [string, string]; return pair[0] === id ? [pair[1]] : []; }).slice(0, 100);
      if (message.type === 'block_player') {
        if (listed().length >= 100 && !this.blocks.has(key)) throw new ProtocolError('rate_limited');
        const socialKey = this.socialKey(id, message.playerId);
        const party = this.party(id); const coexist = party?.members.has(message.playerId) ? party : undefined;
        const remaining = coexist ? [...coexist.members].filter(member => member !== message.playerId) : [];
        const leaderId = coexist?.leaderId === message.playerId ? [...remaining].sort()[0]! : coexist?.leaderId;
        const revoked = [...this.invitations.values()].filter(item => item.status === 'pending' && ((item.sender === id && item.target === message.playerId) || (item.sender === message.playerId && item.target === id) || (coexist && item.partyId === coexist.id))).map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
        this.persist(() => this.store.transaction(() => {
          this.store.saveBlock({ playerId: id, targetId: message.playerId }); this.store.deleteSocial(id, message.playerId);
          for (const item of revoked) this.store.saveInvitation(item);
          if (coexist) this.store.saveParty({ id: coexist.id, leaderId: leaderId!, members: remaining });
        }));
        this.blocks.add(key); this.social.delete(socialKey); for (const item of revoked) this.invitations.set(item.token, item);
        this.cancelQueue(id, 'blocked'); this.cancelQueue(message.playerId, 'blocked');
        if (coexist) { coexist.members = new Set(remaining); coexist.leaderId = leaderId!; this.partyOf.delete(message.playerId); this.publishParty(coexist); this.sendParty(message.playerId); }
        const other = this.players.get(message.playerId); if (other && this.connected(other)) this.sendFriends(other, false);
        this.sendFriends(session, false);
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
        if (!existing || existing.status !== 'pending' || existing.requestedBy === id || this.blocked(id, message.playerId)) throw new ProtocolError('forbidden');
        if (message.accept) { const link: SocialLink = { ...existing, status: 'accepted' }; this.persist(() => this.store.saveSocial(link)); this.social.set(key, link); }
        else { this.persist(() => this.store.deleteSocial(id, message.playerId)); this.social.delete(key); }
      } else { this.persist(() => this.store.deleteSocial(id, message.playerId)); this.social.delete(key); }
      this.sendFriends(session); const other = this.players.get(message.playerId); if (other && this.connected(other)) this.sendFriends(other, false); return;
    }
    if (message.type === 'party_create') { this.available(); if (this.party(id)) throw new ProtocolError('invalid_state'); this.cancelQueue(id); const party: Party = { id: randomUUID(), leaderId: id, members: new Set([id]) }; this.persist(() => this.store.saveParty({ id: party.id, leaderId: id, members: [id] })); this.parties.set(party.id, party); this.partyOf.set(id, party.id); this.sendParty(id, true); return; }
    if (message.type === 'party_leave') { if (!this.party(id)) throw new ProtocolError('not_in_party'); this.leaveParty(id); this.sendParty(id, true); return; }
    if (message.type === 'party_transfer_leader' || message.type === 'party_kick' || message.type === 'party_disband') {
      const party = this.party(id); if (!party) throw new ProtocolError('not_in_party'); if (party.leaderId !== id) throw new ProtocolError('forbidden');
      if (message.type === 'party_kick') { if (message.playerId === id || !party.members.has(message.playerId)) throw new ProtocolError('forbidden'); this.leaveParty(message.playerId); this.sendParty(id, true); return; }
      if (message.type === 'party_transfer_leader') {
        if (!party.members.has(message.playerId)) throw new ProtocolError('forbidden');
        this.persist(() => this.store.saveParty({ id: party.id, leaderId: message.playerId, members: [...party.members] }));
        this.cancelQueue(id); party.leaderId = message.playerId; this.publishParty(party); this.sendParty(id, true); return;
      }
      const revoked = [...this.invitations.values()].filter(item => item.partyId === party.id && item.status === 'pending').map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
      this.persist(() => this.store.transaction(() => { this.store.deleteParty(party.id); for (const item of revoked) this.store.saveInvitation(item); }));
      this.cancelQueue(id); this.parties.delete(party.id); for (const member of party.members) this.partyOf.delete(member);
      for (const item of revoked) this.invitations.set(item.token, item);
      for (const member of party.members) this.sendParty(member); this.sendParty(id, true); return;
    }
    if (message.type === 'party_invite') {
      const party = this.party(id); if (!party) throw new ProtocolError('not_in_party'); if (party.leaderId !== id) throw new ProtocolError('forbidden'); if (party.members.size >= this.config.lobby.maxPartySize) throw new ProtocolError('party_full');
      if (this.blocked(id, message.playerId)) throw new ProtocolError('forbidden');
      if (this.invitations.size >= this.config.limits.maxConnections * 4) throw new ProtocolError('rate_limited');
      const token = randomUUID(); const expiresAt = Date.now() + this.config.lobby.inviteTtlMs;
      const record: Invitation = { token, sender: id, target: message.playerId, status: 'pending', createdAt: Date.now(), expiresAt, partyId: party.id };
      const revoked = [...this.invitations.values()].filter(item => item.partyId === party.id && item.target === message.playerId && item.status === 'pending').map(item => ({ ...item, status: 'revoked' as const, resolvedAt: Date.now() }));
      this.persist(() => this.store.transaction(() => { for (const item of revoked) this.store.saveInvitation(item); this.store.saveInvitation(record); }));
      for (const item of revoked) this.invitations.set(item.token, item); this.invitations.set(token, record);
      const invitation = { type: 'party_invitation', partyId: party.id, playerId: message.playerId, invitationToken: token, expiresAt }; reply(session.peer, invitation); const target = this.players.get(message.playerId); if (target && this.connected(target)) target.peer.send(invitation); return;
    }
    if (message.type === 'party_accept') {
      this.available(); const invitation = this.invitations.get(message.invitationToken);
      if (!invitation || invitation.status !== 'pending' || invitation.expiresAt <= Date.now()) throw new ProtocolError('invitation_expired'); if (invitation.target !== id || !invitation.partyId || this.blocked(id, invitation.sender)) throw new ProtocolError('forbidden');
      const party = this.parties.get(invitation.partyId); if (!party) throw new ProtocolError('not_in_party'); if (this.party(id) || session.roomId) throw new ProtocolError('invalid_state'); if (party.members.size >= this.config.lobby.maxPartySize) throw new ProtocolError('party_full');
      if ([...party.members].some(member => this.blocked(id, member))) throw new ProtocolError('forbidden');
      const members = [...party.members, id]; const accepted = { ...invitation, status: 'accepted' as const, resolvedAt: Date.now() };
      this.persist(() => this.store.transaction(() => { this.store.saveParty({ id: party.id, leaderId: party.leaderId, members }); this.store.saveInvitation(accepted); }));
      this.cancelQueue(id); this.cancelQueue(party.leaderId); party.members.add(id); this.partyOf.set(id, party.id); this.invitations.set(invitation.token, accepted); this.publishParty(party); this.sendParty(id, true); return;
    }
    if (message.type === 'queue_leave') { this.cancelQueue(id); reply(session.peer, { type: 'queue_state', queued: false, reason: 'cancelled' }); return; }
    throw new ProtocolError('bad_request');
  }
  private cancelQueue(id: string, reason = 'cancelled'): void {
    for (const proposal of [...this.proposals.values()]) { const entry = proposal.entries.find(item => item.members.includes(id)); if (entry) this.cancelProposal(proposal, new Set([entry.id]), reason); }
    const removed = this.waiting.filter(entry => entry.members.includes(id));
    if (removed.length) this.persistQueue(this.waiting.filter(entry => !entry.members.includes(id)));
    for (const entry of removed) { this.waiting.splice(this.waiting.indexOf(entry), 1); for (const member of entry.members) { const session = this.players.get(member); if (session && this.connected(session)) session.peer.send({ type: 'queue_state', queued: false, reason }); } }
  }
  private enqueue(session: Session & { player: Player }, game: Game, options: { minPlayers?: number; maxPlayers?: number; version?: string; mode?: string; region?: string; matching?: 'basic' | 'advanced'; rolePreferences?: string[] }, profiles?: readonly TrustedProfile[]): void {
    this.available(); const party = this.party(session.player.id); if (party && party.leaderId !== session.player.id) throw new ProtocolError('forbidden');
    const members = party ? [...party.members] : [session.player.id];
    const compatibility = { version: options.version ?? this.compatibility(session).version, mode: options.mode ?? this.compatibility(session).mode, region: options.region ?? this.compatibility(session).region }; this.validateCompatibility(game, compatibility);
    const min = options.minPlayers ?? 2; const max = options.maxPlayers ?? game.maxPlayersPerRoom;
    if (min > max || max > game.maxPlayersPerRoom || members.length > max) throw new ProtocolError('bad_request');
    for (const id of members) { const member = this.players.get(id); if (!member || !this.connected(member) || member.roomId || member.gameId !== game.gameId || !this.compatible(this.compatibility(member), compatibility) || this.waiting.some(entry => entry.members.includes(id)) || [...this.proposals.values()].some(proposal => proposal.players.some(player => player.id === id))) throw new ProtocolError('invalid_state'); this.checkPlayer(member.player!); }
    if (members.some((left, index) => members.slice(index + 1).some(right => this.blocked(left, right)))) throw new ProtocolError('forbidden');
    if (options.rolePreferences && (!options.rolePreferences.length || new Set(options.rolePreferences).size !== options.rolePreferences.length || options.rolePreferences.some(role => !game.capabilities?.roles?.includes(role)))) throw new ProtocolError('bad_request');
    if (options.matching === 'advanced') profiles = this.trustedProfiles(game.gameId, members, profiles, Date.now());
    const entry: QueueEntry = { id: randomUUID(), members, ...(party ? { partyId: party.id } : {}), gameId: game.gameId, compatibility, min, max, at: Date.now(), matching: options.matching ?? 'basic', ...(profiles ? { profiles } : {}), ...(options.rolePreferences ? { rolePreferences: Object.fromEntries(members.map(id => [id, options.rolePreferences!])) } : {}) };
    this.persistQueue([...this.waiting, entry]); this.waiting.push(entry);
    for (const id of members) { const member = this.players.get(id)!; const state = { type: 'queue_state', queued: true, queueId: entry.id, expiresAt: entry.at + this.config.lobby.matchmakingWaitMs }; if (id === session.player.id) reply(member.peer, state); else member.peer.send(state); }
  }
  private matchQueue(game: Game): void {
    for (const first of [...this.waiting]) {
      if (!this.waiting.includes(first) || first.gameId !== game.gameId || !this.queueEligible(first) || (first.matching === 'advanced' && !this.profilesFresh(first, Date.now()))) continue;
      const candidates = this.waiting.filter(item => item.gameId === game.gameId && item.matching === first.matching && this.compatible(item.compatibility, first.compatibility) && this.queueEligible(item) && (item.matching !== 'advanced' || this.profilesFresh(item, Date.now())));
      let selection: MatchSelection | undefined;
      for (let count = first.min; count <= first.max; count++) {
        if (count < (game.capabilities?.minPlayers ?? 1) || (game.capabilities?.teams && count !== game.capabilities.teams.count * game.capabilities.teams.size)) continue;
        try {
          selection = selectMatch(candidates.map(item => ({ id: item.id, playerIds: item.members, queuedAt: item.at, ...(item.profiles ? { profiles: item.profiles } : {}), ...(item.rolePreferences ? { rolePreferences: item.rolePreferences } : {}) })), { mode: first.matching, game, now: Date.now(), playerCount: count, region: first.compatibility.region, blocked: (a, b) => this.blocked(a, b), policy: this.config.matching, searchLimit: this.config.matching.searchLimit, profileMaxAgeMs: this.config.games.profileMaxAgeMs });
        } catch (error) {
          if (!(error instanceof MatchSearchLimitError) && !(error instanceof TrustedProfileError)) throw error;
          for (const entry of candidates) for (const id of entry.members) this.players.get(id)?.peer.send(errorMessage(error instanceof MatchSearchLimitError ? 'matchmaking_search_exhausted' : 'profile_unavailable'));
          return;
        }
        if (selection && candidates.filter(item => selection!.partyIds.includes(item.id)).every(item => count >= item.min && count <= item.max)) break;
        selection = undefined;
      }
      if (!selection) continue;
      const entries = candidates.filter(item => selection!.partyIds.includes(item.id));
      const proposal: Proposal = { id: randomUUID(), entries, game, deadline: Date.now() + this.config.lobby.matchConfirmMs, accepted: new Set(), players: selection.players };
      this.persistQueue(this.waiting.filter(item => !entries.includes(item)), [...this.proposals.values(), proposal]);
      for (const entry of entries) this.waiting.splice(this.waiting.indexOf(entry), 1);
      this.proposals.set(proposal.id, proposal); for (const player of proposal.players) this.sendProposal(proposal, this.players.get(player.id)!.peer);
    }
  }
  private sendProposal(proposal: Proposal, peer: Peer): void { this.sendPacket(peer, { type: 'match_proposal', proposalId: proposal.id, deadline: proposal.deadline, members: proposal.players.map(player => player.id), accepted: [...proposal.accepted] }, false); }
  private cancelProposal(proposal: Proposal, dropped: Set<string>, reason: string): void {
    const requeued = proposal.entries.filter(entry => !dropped.has(entry.id) && this.queueEligible(entry));
    const waiting = [...this.waiting, ...requeued].sort((a, b) => a.at - b.at);
    this.persistQueue(waiting, [...this.proposals.values()].filter(item => item !== proposal));
    this.proposals.delete(proposal.id); this.waiting.splice(0, this.waiting.length, ...waiting);
    for (const entry of proposal.entries) for (const id of entry.members) {
      const session = this.players.get(id); if (session && this.connected(session)) { session.peer.send({ type: 'match_proposal_resolved', proposalId: proposal.id, reason }); session.peer.send({ type: 'queue_state', queued: requeued.includes(entry), ...(requeued.includes(entry) ? { queueId: entry.id, expiresAt: entry.at + this.config.lobby.matchmakingWaitMs } : { reason }) }); }
    }
  }
  private confirmProposal(proposal: Proposal): void {
    this.available();
    const members = proposal.players.map(player => this.players.get(player.id)!);
    const leader = members[0]!; const first = proposal.entries[0]!; const now = Date.now();
    if (proposal.deadline <= now || proposal.entries.some(entry => !this.queueEligible(entry)) || proposal.players.some(left => proposal.players.some(right => this.blocked(left.id, right.id)))) throw new ProtocolError('invalid_state');
    for (const entry of proposal.entries) if (entry.matching === 'advanced') this.trustedProfiles(entry.gameId, entry.members, entry.profiles, now);
    for (const member of members) this.checkPlayer(member.player!);
    const room: Room = { id: randomUUID(), gameId: proposal.game.gameId, name: 'Matchmaking', ownerId: leader.player!.id, hostId: leader.player!.id, passwordHash: null, maxPlayers: Math.min(...proposal.entries.map(entry => entry.max)), state: 'open', visibility: 'public', locked: false, ...first.compatibility, joinPolicy: 'closed', maxSpectators: this.config.lobby.maxSpectators, revision: 1, bannedIds: [], invitedIds: [], matchId: null, createdAt: now, updatedAt: now, players: new Map(members.map(member => [member.player!.id, member])), held: new Map(), reservations: new Map(), emptySince: null, assignments: proposal.players };
    room.seats = this.seatSnapshot(room);
    try { validateGameSettings(proposal.game, { ...room, players: proposal.players }); } catch { throw new ProtocolError('bad_request'); }
    const next = { ...this.domain }; next.proposals = (next.proposals ?? []).filter(item => item.id !== proposal.id);
    this.persist(() => this.store.transaction(() => { this.store.insert(room); this.store.saveDomain(next); })); this.domain = next;
    this.rooms.set(room.id, room); this.proposals.delete(proposal.id); this.lobbyRevision++;
    for (const member of members) { member.roomId = room.id; member.ready = false; member.role = 'player'; this.sendMembers(member.peer, { type: 'room_joined', room: this.summary(room), revision: room.revision, lobbyRevision: this.lobbyRevision }, this.members(room), false); member.peer.send({ type: 'queue_state', queued: false, reason: 'matched' }); member.peer.send({ type: 'match_found', room: this.summary(room) }); }
    this.publish(room, 'matched');
  }

  private persistQueue(waiting = this.waiting, proposals = [...this.proposals.values()]): void {
    const previous = new Map((this.domain.proposals ?? []).map(item => [item.id, item]));
    const next = { ...this.domain, queue: [...waiting], proposals: proposals.map(proposal => {
      const old = previous.get(proposal.id);
      return old && old.accepted.length === proposal.accepted.size && old.accepted.every(id => proposal.accepted.has(id)) && old.entries === proposal.entries ? old : { ...proposal, accepted: [...proposal.accepted] };
    }) };
    this.persist(() => this.store.saveDomain(next)); this.domain = next;
  }
  private trustedProfiles(gameId: string, members: readonly string[], profiles: readonly TrustedProfile[] | undefined, now: number): readonly TrustedProfile[] {
    try { return parseProfiles({ gameId, profiles }, gameId, members, now, this.config.games.profileMaxAgeMs); } catch { throw new ProtocolError('profile_unavailable'); }
  }
  private profilesFresh(entry: QueueEntry, now: number): boolean {
    try { this.trustedProfiles(entry.gameId, entry.members, entry.profiles, now); return true; } catch { return false; }
  }
  private queueEligible(entry: QueueEntry): boolean {
    const party = entry.partyId ? this.parties.get(entry.partyId) : undefined;
    if (entry.partyId && (!party || party.members.size !== entry.members.length || entry.members.some(id => !party.members.has(id)))) return false;
    if (!entry.partyId && entry.members.some(id => this.partyOf.has(id))) return false;
    return entry.members.every(id => { const session = this.players.get(id); if (!session || !this.connected(session) || session.roomId || session.gameId !== entry.gameId || !this.compatible(this.compatibility(session), entry.compatibility)) return false; try { this.checkPlayer(session.player!); return true; } catch { return false; } }) && !entry.members.some((left, index) => entry.members.slice(index + 1).some(right => this.blocked(left, right)));
  }
  private async refreshMatching(now: number): Promise<void> {
    const entries = await this.serialized(() => this.stopped || this.maintenance ? [] : this.waiting.filter(entry => this.queueEligible(entry)).map(entry => ({ entry, party: entry.partyId ? this.parties.get(entry.partyId) : undefined })), true);
    if (!entries.length) return;
    const refreshed = await Promise.all(entries.filter(({ entry }) => entry.matching === 'advanced' && !this.profilesFresh(entry, now)).map(async ({ entry, party }) => {
      try {
        if (!this.games.profiles) throw new ProtocolError('profile_unavailable');
        const profiles = this.trustedProfiles(entry.gameId, entry.members, await this.track(this.games.profiles(entry.gameId, entry.members)), Date.now());
        return { entry, party, profiles };
      } catch { return { entry, party, profiles: undefined }; }
    }));
    const games = await this.games.list();
    await this.serialized(() => {
      if (this.stopped || this.maintenance) return;
      let changed = false;
      for (const { entry, party, profiles } of refreshed) {
        const index = this.waiting.indexOf(entry);
        if (index < 0 || (entry.partyId && this.parties.get(entry.partyId) !== party) || !this.queueEligible(entry) || !games.some(game => game.enabled && game.gameId === entry.gameId)) continue;
        if (profiles) { this.waiting[index] = { ...entry, profiles }; changed = true; }
        else for (const id of entry.members) this.players.get(id)?.peer.send(errorMessage('profile_unavailable'));
      }
      if (changed) this.persistQueue();
      for (const game of games) if (game.enabled && this.waiting.some(entry => entry.gameId === game.gameId)) this.matchQueue(game);
    });
  }
  private page(items: unknown[], cursor: string | undefined, limit: number): { items: unknown[]; nextCursor?: string } {
    const offset = cursor === undefined ? 0 : Number(cursor);
    if (!Number.isSafeInteger(offset) || offset < 0 || offset > 1e9 || !Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new ProtocolError('bad_request');
    return { items: items.slice(offset, offset + limit), ...(offset + limit < items.length ? { nextCursor: String(offset + limit) } : {}) };
  }
  listRooms(cursor: string | undefined, limit: number) { return this.page([...this.rooms.values()].map(room => ({ ...this.summary(room), members: this.members(room) })), cursor, limit); }
  roomDetails(roomId: string) { const room = this.rooms.get(roomId); return room ? { ...this.summary(room), members: this.members(room) } : undefined; }
  listMatches(cursor: string | undefined, limit: number) { return this.page(this.domain.matches.map(item => ({ ...item })), cursor, limit); }
  matchDetails(matchId: string) { const match = this.domain.matches.find(item => item.matchId === matchId); return match ? structuredClone(match) : undefined; }
  queueDiagnostics() { return { entries: this.waiting.map(item => ({ queueId: item.id, gameId: item.gameId, members: item.members, createdAt: item.at, waitMs: Date.now() - item.at })), proposal: [...this.proposals.values()].map(item => ({ proposalId: item.id, deadline: item.deadline, members: item.players.map(player => player.id), acceptedCount: item.accepted.size })) }; }
  integrations() { return { authentication: { configured: this.config.auth.mode !== 'mock' }, gameSessions: { configured: !!this.config.games.sessionApiUrl }, profiles: { configured: !!this.config.games.profileApiUrl }, persistence: { healthy: this.storageHealthy } }; }
  async reconcileMatch(matchId: string) {
    const identity = await this.serialized(() => { const match = this.domain.matches.find(item => item.matchId === matchId); if (!match) throw new ProtocolError('room_not_found'); return structuredClone(match); }, true);
    let state: 'starting' | 'in_game' | 'ended' | 'failed';
    try { state = await this.track(this.provider.status(matchId)); } catch { throw new ProtocolError('game_service_unavailable'); }
    return this.serialized(() => {
      const next = { ...this.domain, matches: this.domain.matches.map(item => item.matchId === matchId ? { ...item } : item) }; const match = next.matches.find(item => item.matchId === matchId);
      if (!match || JSON.stringify(match) !== JSON.stringify(identity)) throw new ProtocolError('invalid_state');
      const room = [...this.rooms.values()].find(item => item.matchId === matchId);
      match.state = state; if (state === 'ended' || state === 'failed') match.finishedAt ??= Date.now();
      this.persist(() => this.store.transaction(() => { this.store.saveDomain(next); if (room) this.store.update({ ...room, state: state === 'ended' || state === 'failed' ? 'open' : state, matchId: state === 'ended' || state === 'failed' ? null : matchId, revision: room.revision + 1, updatedAt: Date.now() }); this.store.audit({ at: Date.now(), actor: 'operator', action: 'reconcile_match', target: matchId }); }));
      this.domain = next;
      if (room) { Object.assign(room, { state: state === 'ended' || state === 'failed' ? 'open' : state, matchId: state === 'ended' || state === 'failed' ? null : matchId, revision: room.revision + 1 }); for (const member of room.players.values()) member.ready = false; this.publish(room, 'reconciled'); }
      return structuredClone(match);
    });
  }
  chatReports(cursor: string | undefined, limit: number) { return this.page(this.domain.reports.map(({ message, ...item }) => ({ ...item, senderId: message.senderId, scope: message.scope, scopeId: message.scopeId })), cursor, limit); }
  chatReport(reportId: string) { const report = this.domain.reports.find(item => item.id === reportId); return report ? structuredClone(report) : undefined; }
  async reviewChatReport(reportId: string, action: 'dismiss' | 'mute' | 'ban', until: number, reason: string): Promise<void> {
    await this.serialized(() => {
      const next = { ...this.domain, reports: this.domain.reports.map(item => item.id === reportId ? { ...item } : item), mutes: [...this.domain.mutes] }; const report = next.reports.find(item => item.id === reportId);
      if (!report || report.status !== 'pending') throw new ProtocolError('invalid_state');
      if (action !== 'dismiss' && until <= Date.now()) throw new ProtocolError('bad_request');
      report.status = action; report.reviewedAt = Date.now();
      const record: Moderation = { playerId: report.message.senderId, bannedUntil: until, revokedBefore: 0, reason };
      if (action === 'mute') next.mutes.push({ scope: report.message.scope, scopeId: report.message.scopeId, playerId: report.message.senderId, until });
      this.persist(() => this.store.transaction(() => { this.store.saveDomain(next); if (action === 'ban') this.store.saveModeration(record); this.store.audit({ at: Date.now(), actor: 'operator', action: `chat_report_${action}`, target: reportId }); }));
      this.domain = next; if (action === 'ban') { this.moderation.set(record.playerId, record); this.expel(record.playerId, 'player_banned'); }
    });
  }
  setMaintenance(enabled: boolean): void {
    this.maintenance = enabled;
    if (enabled) void this.serialized(() => { for (const proposal of [...this.proposals.values()]) this.cancelProposal(proposal, new Set(proposal.entries.map(entry => entry.id)), 'maintenance'); for (const entry of [...this.waiting]) this.cancelQueue(entry.members[0]!, 'maintenance'); }).catch(() => log('error', 'maintenance_cleanup_failed'));
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
  private deleteOwnedEmpty(session: Session & { player: Player }, roomId: string): void {
    const room = this.rooms.get(roomId);
    if (!room) throw new ProtocolError('room_not_found');
    if (room.ownerId !== session.player.id) throw new ProtocolError('forbidden');
    if ([...room.players.keys(), ...room.held.keys()].some(id => id !== session.player.id) || room.reservations.size) throw new ProtocolError('invalid_state');
    room.held.delete(session.player.id);
    this.closeRoom(room, 'deleted', session.peer);
  }
  private releaseHeld(room: Room, playerId: string): void {
    const seat = room.held.get(playerId); if (!seat) return;
    room.held.delete(playerId);
    const next = [...room.players.values()].find(member => member.role !== 'spectator' && member.player);
    const heldHost = [...room.held.values()].find(item => item.role !== 'spectator');
    const hostId = room.hostId === playerId ? next?.player?.id ?? heldHost?.playerId ?? room.ownerId : room.hostId;
    if (!room.players.size && !room.held.size && !room.reservations.size && room.emptySince === null) room.emptySince = Date.now();
    try { this.commit(room, hostId === room.hostId ? {} : { hostId }); }
    catch (error) { room.held.set(playerId, seat); throw error; }
    this.publish(room, 'leave');
  }
  private finishMatch(room: Room, state: 'ended' | 'failed'): void {
    const matchId = room.matchId; const next = { ...this.domain, matches: this.domain.matches.map(item => item.matchId === room.matchId ? { ...item } : item) };
    if (matchId) {
      const identity = next.matches.find(match => match.matchId === matchId);
      if (identity) { identity.state = state; identity.finishedAt = Date.now(); }
      else next.matches.push({ matchId, roomId: room.id, gameId: room.gameId, roster: [...room.players.keys(), ...room.held.keys()], createdAt: Date.now(), finishedAt: Date.now(), state });
    }
    const seats = this.seatSnapshot(room).map(seat => ({ ...seat, ready: false }));
    this.persist(() => this.store.transaction(() => { this.store.update({ ...room, state: 'open', matchId: null, revision: room.revision + 1, updatedAt: Date.now(), seats }); this.store.saveDomain(next); if (matchId) this.store.audit({ at: Date.now(), actor: 'game', action: 'match_finish', target: matchId }); }));
    this.domain = next; Object.assign(room, { state: 'open', matchId: null, revision: room.revision + 1, updatedAt: Date.now() }); delete room.matchRequest;
    for (const member of room.players.values()) member.ready = false; for (const seat of room.held.values()) seat.ready = false;
    this.publish(room, state);
  }
  async reportMatch(matchId: string, state: 'ended' | 'failed'): Promise<void> {
    await this.serialized(() => {
      if (this.domain.matches.some(match => match.matchId === matchId && match.finishedAt !== undefined)) return;
      const room = [...this.rooms.values()].find(item => item.matchId === matchId && (item.state === 'in_game' || item.state === 'starting') && !item.operation);
      const next = { ...this.domain, matches: this.domain.matches.map(item => item.matchId === matchId ? { ...item } : item) }; const identity = next.matches.find(match => match.matchId === matchId);
      if (!room && !identity) throw new ProtocolError('room_not_found');
      if (room) { this.finishMatch(room, state); return; }
      identity!.state = state; identity!.finishedAt = Date.now();
      this.persist(() => this.store.transaction(() => { this.store.saveDomain(next); this.store.audit({ at: Date.now(), actor: 'game', action: 'match_finish', target: matchId }); }));
      this.domain = next;
    });
  }
  async reportPlayerResult(matchId: string, playerId: string, result: Rules): Promise<void> {
    await this.serialized(() => {
      const identity = this.domain.matches.find(match => match.matchId === matchId);
      if (!identity || !identity.roster.includes(playerId)) throw new ProtocolError('room_not_found');
      const previous = this.domain.results.find(item => item.matchId === matchId && item.playerId === playerId);
      if (previous) {
        const canonical = (rules: Rules) => JSON.stringify(Object.entries(rules).sort(([a], [b]) => a.localeCompare(b)));
        if (canonical(previous.result) !== canonical(result)) throw new ProtocolError('request_conflict');
        return;
      }
      const record = { resultId: randomUUID(), matchId, playerId, roomId: identity.roomId, result: { ...result }, createdAt: Date.now() };
      const next = { ...this.domain, results: [...this.domain.results] }; next.results.push(record);
      if (next.results.length > this.config.lobby.maxResults) throw new ProtocolError('rate_limited');
      this.persist(() => this.store.transaction(() => { this.store.saveDomain(next); this.store.audit({ at: Date.now(), actor: 'game', action: 'match_player_result', target: matchId }); }));
      this.domain = next;
      const member = this.players.get(playerId); if (member && this.connected(member)) this.sendPacket(member.peer, { type: 'match_result', ...record }, false);
    });
  }
  async maintain(now = Date.now()): Promise<void> {
    await this.serialized(() => {
      if (this.stopped) return;
      const next = { ...this.domain };
      next.results = next.results.filter(item => now - item.createdAt < this.config.lobby.resultRetentionMs);
      next.matches = next.matches.filter(item => item.finishedAt === undefined || now - item.finishedAt < this.config.lobby.resultRetentionMs);
      next.chat = next.chat.filter(item => now - item.createdAt < this.config.chat.retentionMs);
      next.reports = next.reports.filter(item => now - item.createdAt < this.config.chat.reportRetentionMs);
      next.mutes = next.mutes.filter(item => item.until > now);
      if (next.results.length !== this.domain.results.length || next.matches.length !== this.domain.matches.length || next.chat.length !== this.domain.chat.length || next.reports.length !== this.domain.reports.length || next.mutes.length !== this.domain.mutes.length) { this.persist(() => this.store.saveDomain(next)); this.domain = next; }
      for (const proposal of [...this.proposals.values()]) if (proposal.deadline <= now) this.cancelProposal(proposal, new Set(proposal.entries.filter(entry => entry.members.some(id => !proposal.accepted.has(id))).map(entry => entry.id)), 'timeout');
      for (const session of this.sessions.values()) if ((!this.connected(session)) && session.disconnectedAt !== undefined && now - session.disconnectedAt >= this.config.lobby.reconnectGraceMs) this.removeDisconnected(session);
      for (const [token, invitation] of this.invitations) {
        if (invitation.status === 'pending' && invitation.expiresAt <= now) this.resolveInvitation(token, 'expired');
        else if (invitation.resolvedAt !== undefined && now - invitation.resolvedAt >= this.config.lobby.invitationRetentionMs) { this.persist(() => this.store.deleteInvitation(token)); this.invitations.delete(token); }
      }
      for (const [id, snapshot] of this.snapshots) if (snapshot.expiresAt <= now) this.snapshots.delete(id);
      for (const [cursor, record] of this.cursors) if (!this.snapshots.has(record.snapshotId)) this.cursors.delete(cursor);
      for (const [id, failure] of this.passwordFailures) if (!failure.pending && now - failure.startedAt >= this.config.limits.passwordWindowMs) this.passwordFailures.delete(id);
      for (const entry of [...this.waiting]) if (now - entry.at >= this.config.lobby.matchmakingWaitMs) { for (const id of entry.members) this.players.get(id)?.peer.send(errorMessage('queue_timeout')); this.cancelQueue(entry.members[0]!, 'timeout'); }
      for (const room of [...this.rooms.values()]) {
        for (const [id, seat] of [...room.held]) if (seat.expiresAt <= now) this.releaseHeld(room, id);
        if (!room.players.size && !room.reservations.size && !room.held.size && room.emptySince !== null && this.config.room.emptyTtlSec > 0 && now - room.emptySince >= this.config.room.emptyTtlSec * 1000 && room.state === 'open') this.closeRoom(room, 'expired');
        if ((room.state === 'starting' || room.state === 'in_game') && !room.operation && !this.recovering.has(room.id)) {
          if (!room.matchId) {
            const request = room.matchRequest;
            if (!request) { log('error', 'match_recovery_missing_request'); continue; }
            this.recovering.add(room.id);
            this.defer(() => { void this.track(Promise.resolve().then(() => this.provider.create(request)).then(async allocation => {
              try {
                const state = await this.provider.status(allocation.matchId);
                await this.serialized(() => {
                  if (this.stopped || this.rooms.get(room.id) !== room || room.matchRequest?.operationId !== request.operationId || room.state !== 'starting') throw new ProtocolError('invalid_state');
                  if (state === 'ended' || state === 'failed') { this.commit(room, { state: 'starting', matchId: allocation.matchId }); this.finishMatch(room, state); }
                  else {
                    this.commit(room, { state, matchId: allocation.matchId }); this.publish(room, 'recovered');
                    if (state === 'in_game') this.recoverAdmissions(room, allocation.matchId);
                  }
                });
              } catch (error) {
                if (this.stopped || this.rooms.get(room.id) !== room || room.matchRequest?.operationId !== request.operationId || room.state !== 'starting') this.cancelMatch(allocation.matchId);
                throw error;
              }
            })).catch(() => log('error', 'match_recovery_unavailable')).finally(() => this.recovering.delete(room.id)); });
            continue;
          }
          const matchId = room.matchId; this.recovering.add(room.id);
          this.defer(() => { void this.track(Promise.resolve().then(() => this.provider.status(matchId)).then(state => this.serialized(() => {
            if (this.stopped || this.rooms.get(room.id) !== room || room.matchId !== matchId) return;
            if (state === 'ended' || state === 'failed') this.finishMatch(room, state);
            else if (room.state !== state) { this.commit(room, { state }); this.publish(room, 'recovered'); if (state === 'in_game') this.recoverAdmissions(room, matchId); }
          }))).catch(() => log('error', 'match_status_unavailable')).finally(() => this.recovering.delete(room.id)); });
        }
      }
    });
    if (!this.stopped && !this.maintenance) await this.refreshMatching(now);
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
          this.commit(room);
        }
      }
      this.parties.clear(); this.partyOf.clear(); this.invitations.clear(); this.snapshots.clear(); this.cursors.clear();
    });
    do { await Promise.allSettled([...this.external]); await this.queue; } while (this.external.size);
  }
  async settle(): Promise<void> { await this.queue; }
}
