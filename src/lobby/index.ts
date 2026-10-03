import { randomUUID } from 'node:crypto';
import type { Config } from '../config.js';
import type { ClientMessage } from '../protocol/index.js';
import { ProtocolError, errorMessage } from '../protocol/index.js';
import type { Game, GameProvider, Peer, Player, RoomStore, Session, StoredRoom } from '../types.js';
import { hashPassword, verifyPassword } from '../security/password.js';
import { log } from '../log/index.js';

interface Room extends StoredRoom {
  players: Map<string, Session>;
  reservations: Set<Session>;
  emptySince: number | null;
}

export class RoomManager {
  private readonly rooms = new Map<string, Room>();
  private readonly sessions = new Map<string, Session>();
  private readonly players = new Map<string, Session>();
  private readonly passwordFailures = new Map<string, { count: number; startedAt: number }>();
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly config: Config, private readonly store: RoomStore, private readonly games: GameProvider) {
    for (const room of store.load()) this.rooms.set(room.id, { ...room, players: new Map(), reservations: new Set(), emptySince: Date.now() });
  }

  connect(peer: Peer): void {
    this.sessions.set(peer.id, { peer, active: true });
  }

  private serialized<T>(operation: () => T | Promise<T>): Promise<T> {
    const result = this.queue.then(operation);
    this.queue = result.then(() => undefined, () => undefined);
    return result;
  }

  private persist(operation: () => void): void {
    try { operation(); }
    catch { log('error', 'storage_write_failed'); throw new ProtocolError('storage_error'); }
  }

  async authenticate(peer: Peer, player: Player): Promise<boolean> {
    return this.serialized(() => {
      const session = this.sessions.get(peer.id);
      if (!session?.active || peer.closed) return false;
      if (session.player) throw new ProtocolError('bad_request');
      const previous = this.players.get(player.id);
      if (previous && previous !== session) {
        this.leave(previous);
        previous.active = false;
        previous.peer.send(errorMessage('session_replaced'));
        previous.peer.close(4001, 'Session replaced');
      }
      session.player = player;
      this.players.set(player.id, session);
      return true;
    });
  }

  disconnect(peer: Peer): void {
    const session = this.sessions.get(peer.id);
    if (!session) return;
    // Cancellation is immediate, even while scrypt or a queued operation is running.
    session.active = false;
    this.passwordFailures.delete(peer.id);
    for (const room of this.rooms.values()) room.reservations.delete(session);
    void this.serialized(() => this.removeDisconnected(session)).catch(() => {
      // Retain the failed transfer for maintenance retry rather than invent a new host.
      log('error', 'disconnect_cleanup_deferred');
    });
  }

  private removeDisconnected(session: Session): void {
    this.leave(session);
    if (session.player && this.players.get(session.player.id) === session) this.players.delete(session.player.id);
    this.sessions.delete(session.peer.id);
  }

  private requireSession(peer: Peer): Session & { player: Player } {
    const session = this.sessions.get(peer.id);
    if (!session?.active || peer.closed || !session.player) throw new ProtocolError('auth_required');
    if (session.player.expiresAt !== undefined && session.player.expiresAt <= Date.now()) throw new ProtocolError('auth_expired');
    return session as Session & { player: Player };
  }

  private requireGame(session: Session): string {
    if (!session.gameId) throw new ProtocolError('not_in_lobby');
    return session.gameId;
  }

  private roomSummary(room: Room): Record<string, unknown> {
    return { id: room.id, name: room.name, playerCount: this.memberCount(room), maxPlayers: room.maxPlayers, hasPassword: room.passwordHash !== null, state: room.state };
  }

  private memberCount(room: Room): number {
    let count = 0;
    for (const session of room.players.values()) if (session.active && !session.peer.closed) count++;
    return count;
  }

  private members(room: Room): Record<string, unknown>[] {
    const members: Record<string, unknown>[] = [];
    for (const session of room.players.values()) {
      if (session.active && !session.peer.closed && session.player) members.push({ id: session.player.id, displayName: session.player.displayName, isHost: room.hostId === session.player.id });
    }
    return members;
  }

  private broadcastLobby(room: Room, change: 'add' | 'update' | 'remove'): void {
    const message = { type: 'lobby_update', change, room: this.roomSummary(room) };
    for (const session of this.sessions.values()) if (session.active && session.gameId === room.gameId && !session.roomId) session.peer.send(message);
  }

  private sendMembers(peer: Peer, base: Record<string, unknown>, members: Record<string, unknown>[]): void {
    const whole = { ...base, members };
    if (Buffer.byteLength(JSON.stringify(whole)) <= this.config.limits.outboundBytes) { peer.send(whole); return; }
    const chunks: Record<string, unknown>[][] = [];
    let chunk: Record<string, unknown>[] = [];
    // Chunk metadata uses a conservative upper bound so final frames always fit.
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, chunkIndex: members.length, chunkCount: members.length, members: [] }));
    let bytes = overhead;
    for (const member of members) {
      const memberBytes = Buffer.byteLength(JSON.stringify(member));
      if (bytes + memberBytes + (chunk.length ? 1 : 0) > this.config.limits.outboundBytes) {
        if (!chunk.length) throw new ProtocolError('server_error');
        chunks.push(chunk); chunk = []; bytes = overhead;
      }
      if (overhead + memberBytes > this.config.limits.outboundBytes) throw new ProtocolError('server_error');
      bytes += memberBytes + (chunk.length ? 1 : 0);
      chunk.push(member);
    }
    if (chunk.length) chunks.push(chunk);
    chunks.forEach((part, chunkIndex) => peer.send({ ...base, chunkIndex, chunkCount: chunks.length, members: part }));
  }

  private broadcastRoom(room: Room, change: 'join' | 'leave'): void {
    const members = this.members(room);
    for (const session of room.players.values()) if (session.active) this.sendMembers(session.peer, { type: 'room_state', roomId: room.id, playerCount: members.length, change }, members);
  }

  private async selectedGame(gameId: string): Promise<Game> {
    const game = (await this.games.list()).find(item => item.gameId === gameId && item.enabled);
    if (!game) throw new ProtocolError('game_not_found');
    return game;
  }

  private snapshot(session: Session, game: Game, page = 1, pageSize = this.config.limits.defaultPageSize): void {
    const rooms: Record<string, unknown>[] = [];
    for (const room of this.rooms.values()) if (room.gameId === game.gameId && room.state === 'open') rooms.push(this.roomSummary(room));
    const publicGame: Record<string, unknown> = { gameId: game.gameId, name: game.name, maxPlayersPerRoom: game.maxPlayersPerRoom };
    if (game.serverHint !== undefined) publicGame.serverHint = game.serverHint;
    const base = { type: 'lobby_state', game: publicGame, total: rooms.length };
    const pages: Record<string, unknown>[][] = [];
    let part: Record<string, unknown>[] = [];
    const overhead = Buffer.byteLength(JSON.stringify({ ...base, nextPage: rooms.length + 1, rooms: [] }));
    let bytes = overhead;
    for (const room of rooms) {
      const roomBytes = Buffer.byteLength(JSON.stringify(room));
      if (part.length >= pageSize || bytes + roomBytes + (part.length ? 1 : 0) > this.config.limits.outboundBytes) {
        if (!part.length) throw new ProtocolError('server_error');
        pages.push(part); part = []; bytes = overhead;
      }
      if (overhead + roomBytes > this.config.limits.outboundBytes) throw new ProtocolError('server_error');
      bytes += roomBytes + (part.length ? 1 : 0);
      part.push(room);
    }
    if (part.length || !pages.length) pages.push(part);
    const message: Record<string, unknown> = { ...base, rooms: pages[page - 1] ?? [] };
    if (page < pages.length) message.nextPage = page + 1;
    session.peer.send(message);
  }

  private leave(session: Session): void {
    if (!session.roomId || !session.player) return;
    const room = this.rooms.get(session.roomId);
    if (!room) { delete session.roomId; return; }
    let nextHost: Session | undefined;
    if (room.hostId === session.player.id) for (const member of room.players.values()) {
      if (member !== session && member.active && !member.peer.closed) { nextHost = member; break; }
    }
    if (nextHost?.player) {
      const now = Date.now();
      this.persist(() => this.store.setHost(room.id, nextHost.player!.id, now));
      room.hostId = nextHost.player.id; room.updatedAt = now;
    }
    room.players.delete(session.player.id);
    delete session.roomId;
    if (this.memberCount(room) === 0) room.emptySince = Date.now();
    this.broadcastRoom(room, 'leave');
    this.broadcastLobby(room, 'update');
  }

  private closeRoom(room: Room, reason: 'deleted' | 'expired'): void {
    this.persist(() => this.store.delete(room.id));
    this.rooms.delete(room.id);
    for (const session of room.players.values()) {
      delete session.roomId;
      session.peer.send({ type: 'room_closed', roomId: room.id, reason });
    }
    room.reservations.clear();
    this.broadcastLobby(room, 'remove');
  }

  async handle(peer: Peer, message: Exclude<ClientMessage, { type: 'auth' }>): Promise<void> {
    const session = this.requireSession(peer);
    if (message.type === 'ping') { peer.send({ type: 'pong' }); return; }
    if (message.type === 'select_game' || message.type === 'switch_game') {
      const game = await this.selectedGame(message.gameId);
      await this.serialized(() => {
        this.requireSession(peer);
        if (message.type === 'select_game' && session.roomId) throw new ProtocolError('already_in_room');
        this.leave(session);
        session.gameId = game.gameId;
        this.snapshot(session, game);
      });
      return;
    }
    const gameId = this.requireGame(session);
    if (message.type === 'list_rooms') {
      const game = await this.selectedGame(gameId);
      await this.serialized(() => { this.requireSession(peer); this.snapshot(session, game, message.page, message.pageSize); });
      return;
    }
    if (message.type === 'create_room') {
      const game = await this.selectedGame(gameId);
      const passwordHash = message.password === undefined ? null : await hashPassword(message.password);
      await this.serialized(() => {
        this.requireSession(peer);
        if (session.roomId) throw new ProtocolError('already_in_room');
        const maxPlayers = message.maxPlayers ?? game.maxPlayersPerRoom;
        if (maxPlayers > game.maxPlayersPerRoom) throw new ProtocolError('bad_request');
        if ([...this.rooms.values()].filter(room => room.gameId === gameId).length >= this.config.limits.maxRoomsPerGame) throw new ProtocolError('rate_limited');
        const now = Date.now();
        const room: Room = { id: randomUUID(), gameId, name: message.name, hostId: session.player.id, passwordHash, maxPlayers, state: 'open', createdAt: now, updatedAt: now, players: new Map(), reservations: new Set(), emptySince: null };
        this.persist(() => this.store.insert(room));
        room.players.set(session.player.id, session);
        session.roomId = room.id;
        this.rooms.set(room.id, room);
        this.sendMembers(peer, { type: 'room_joined', room: this.roomSummary(room), ...(game.serverHint === undefined ? {} : { serverHint: game.serverHint }) }, this.members(room));
        this.broadcastLobby(room, 'add');
      });
      return;
    }
    if (message.type === 'join_room') {
      const game = await this.selectedGame(gameId);
      const room = await this.serialized(() => {
        this.requireSession(peer);
        if (session.roomId) throw new ProtocolError('already_in_room');
        const target = this.rooms.get(message.roomId);
        if (!target || target.state !== 'open') throw new ProtocolError('room_not_found');
        if (target.gameId !== gameId) throw new ProtocolError('wrong_game');
        if (this.memberCount(target) + target.reservations.size >= target.maxPlayers) throw new ProtocolError('room_full');
        if (target.passwordHash !== null) {
          if (message.password === undefined) throw new ProtocolError('room_password_required');
          const failure = this.passwordFailures.get(peer.id);
          if (failure && Date.now() - failure.startedAt < this.config.limits.passwordWindowMs && failure.count >= this.config.limits.passwordFailures) throw new ProtocolError('rate_limited');
        }
        target.reservations.add(session);
        return target;
      });
      try {
        const verified = room.passwordHash === null || await verifyPassword(message.password!, room.passwordHash);
        await this.serialized(() => {
          this.requireSession(peer);
          if (this.rooms.get(room.id) !== room || !room.reservations.has(session)) throw new ProtocolError('room_not_found');
          if (!verified) {
            let failure = this.passwordFailures.get(peer.id);
            if (!failure || Date.now() - failure.startedAt >= this.config.limits.passwordWindowMs) { failure = { count: 0, startedAt: Date.now() }; this.passwordFailures.set(peer.id, failure); }
            failure.count++;
            throw new ProtocolError('room_password_incorrect');
          }
          if (this.memberCount(room) >= room.maxPlayers) throw new ProtocolError('room_full');
          if (this.memberCount(room) === 0) {
            const now = Date.now();
            this.persist(() => this.store.setHost(room.id, session.player.id, now));
            room.hostId = session.player.id; room.updatedAt = now;
          }
          room.reservations.delete(session);
          room.players.set(session.player.id, session);
          room.emptySince = null;
          session.roomId = room.id;
          this.sendMembers(peer, { type: 'room_joined', room: this.roomSummary(room), ...(game.serverHint === undefined ? {} : { serverHint: game.serverHint }) }, this.members(room));
          this.broadcastRoom(room, 'join');
          this.broadcastLobby(room, 'update');
        });
      } finally {
        await this.serialized(() => { room.reservations.delete(session); });
      }
      return;
    }
    if (message.type === 'leave_room') {
      const game = await this.selectedGame(gameId);
      await this.serialized(() => { this.requireSession(peer); this.leave(session); this.snapshot(session, game); });
      return;
    }
    if (message.type === 'delete_room') {
      await this.serialized(() => {
        this.requireSession(peer);
        const room = session.roomId ? this.rooms.get(session.roomId) : undefined;
        if (!room) throw new ProtocolError('room_not_found');
        if (room.hostId !== session.player.id) throw new ProtocolError('host_only');
        this.closeRoom(room, 'deleted');
      });
    }
  }

  async maintain(now = Date.now()): Promise<void> {
    await this.serialized(() => {
      for (const session of this.sessions.values()) if (!session.active || session.peer.closed) {
        try { this.removeDisconnected(session); } catch { log('error', 'disconnect_cleanup_deferred'); }
      }
      if (this.config.room.emptyTtlSec === 0) return;
      for (const room of this.rooms.values()) if (this.memberCount(room) === 0 && room.reservations.size === 0 && room.emptySince !== null && now - room.emptySince >= this.config.room.emptyTtlSec * 1000) {
        try { this.closeRoom(room, 'expired'); } catch { log('error', 'room_expiry_deferred'); }
      }
    });
  }

  async settle(): Promise<void> { await this.queue; }
}
