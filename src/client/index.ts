import type { ClientMessage, Compatibility, RoomSettings } from '../protocol/index.js';
export type { ClientMessage as BeaconCommand } from '../protocol/index.js';
export type BeaconRoomFilters = Omit<Extract<ClientMessage, { type: 'list_rooms' }>, 'type' | 'requestId'>;
export type BeaconRoomInput = RoomSettings & Compatibility & { name: string };

export interface BeaconPlayer { readonly id: string; readonly displayName: string }
export type BeaconMessage = Readonly<Record<string, unknown>> & { readonly type: string };
export interface BeaconSocket {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  addEventListener(type: string, listener: (event: { data?: unknown; code?: number }) => void): void;
}
export interface BeaconSocketConstructor { new(url: string): BeaconSocket }
export interface BeaconClientOptions {
  url: string;
  token: () => string | Promise<string>;
  WebSocket?: BeaconSocketConstructor;
  allowInsecure?: boolean;
  reconnect?: boolean;
  reconnectMinMs?: number;
  reconnectMaxMs?: number;
  requestTimeoutMs?: number;
  maxPending?: number;
  maxSnapshots?: number;
  maxMessageBytes?: number;
}
export interface RequestOptions {
  requestId?: string;
  timeoutMs?: number;
  /** Retain the exact request and ID until its deadline; the server deduplicates it. */
  retryOnReconnect?: boolean;
}
export interface BeaconResult { requestId: string; messages: readonly BeaconMessage[] }
export interface BeaconState {
  connection: 'disconnected' | 'connecting' | 'authenticating' | 'connected' | 'reconnecting';
  player: BeaconPlayer | null;
  session: BeaconMessage | null;
  lobby: BeaconMessage | null;
  room: BeaconMessage | null;
}
export class BeaconError extends Error {
  constructor(public readonly code: string, public readonly requestId?: string) {
    super(`Beacon request failed (${code})`);
    this.name = 'BeaconError';
  }
}
type Listener = (value: unknown) => void;
type Pending = {
  wire: string; command: string; retry: boolean; clearsRoom: boolean; messages: BeaconMessage[]; bytes: number;
  resynced?: boolean;
  resolve: (result: BeaconResult) => void; reject: (error: BeaconError) => void;
  timer: NodeJS.Timeout;
};
type Assembly = { base: BeaconMessage; field: 'members' | 'rooms' | 'friends' | 'games' | 'partyMembers' | 'payload'; parts: Map<number, unknown[]>; count: number; bytes: number; timer: NodeJS.Timeout };
function record(value: unknown): value is Record<string, unknown> { return typeof value === 'object' && value !== null && !Array.isArray(value); }
function positive(value: number, name: string): number {
  if (!Number.isSafeInteger(value) || value < 1) throw new BeaconError(`invalid_${name}`);
  return value;
}

/** Dependency-free protocol-v2 SDK. Inject a WebSocket constructor on older Node runtimes. */
export class BeaconClient {
  private readonly options: BeaconClientOptions;
  private readonly Socket: BeaconSocketConstructor;
  private socket: BeaconSocket | undefined;
  private stopped = true;
  private ready = false;
  private attempts = 0;
  private sequence = 0;
  private readonly prefix: string;
  private reconnectTimer: NodeJS.Timeout | undefined;
  private handshakeTimer: NodeJS.Timeout | undefined;
  private connectTimer: NodeJS.Timeout | undefined;
  private refreshTimer: NodeJS.Timeout | undefined;
  private readonly pending = new Map<string, Pending>();
  private readonly assemblies = new Map<string, Assembly>();
  private readonly revisions = new Map<string, number>();
  private readonly listeners = new Map<string, Set<Listener>>();
  private connecting: Promise<void> | undefined;
  private connectResolve: (() => void) | undefined;
  private connectReject: ((error: BeaconError) => void) | undefined;
  private current: BeaconState = { connection: 'disconnected', player: null, session: null, lobby: null, room: null };

  constructor(options: BeaconClientOptions) {
    const url = new URL(options.url);
    if (url.username || url.password || url.hash || (url.protocol !== 'wss:' && !(options.allowInsecure === true && url.protocol === 'ws:'))) throw new BeaconError('insecure_url');
    const globals = globalThis as unknown as { WebSocket?: BeaconSocketConstructor; crypto?: { randomUUID(): string } };
    const Socket = options.WebSocket ?? globals.WebSocket;
    if (!Socket) throw new BeaconError('websocket_unavailable');
    this.Socket = Socket;
    this.options = { ...options, url: url.href,
      requestTimeoutMs: positive(options.requestTimeoutMs ?? 15000, 'timeout'),
      maxPending: positive(options.maxPending ?? 128, 'pending_limit'),
      maxSnapshots: positive(options.maxSnapshots ?? 32, 'snapshot_limit'),
      maxMessageBytes: positive(options.maxMessageBytes ?? 1048576, 'message_limit'),
      reconnectMinMs: positive(options.reconnectMinMs ?? 250, 'reconnect_min'),
      reconnectMaxMs: positive(options.reconnectMaxMs ?? 30000, 'reconnect_max') };
    this.prefix = globals.crypto?.randomUUID() ?? `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  }
  get state(): Readonly<BeaconState> { return { ...this.current }; }
  on(event: string, listener: Listener): () => void {
    let listeners = this.listeners.get(event);
    if (!listeners) { listeners = new Set(); this.listeners.set(event, listeners); }
    listeners.add(listener);
    return () => { listeners.delete(listener); if (!listeners.size) this.listeners.delete(event); };
  }
  private emit(event: string, value: unknown): void {
    for (const listener of this.listeners.get(event) ?? []) {
      // Consumer callbacks must not interrupt correlation or transport cleanup.
      try { listener(value); } catch { /* The consumer owns its callback errors. */ }
    }
  }
  private connection(connection: BeaconState['connection']): void {
    this.current = { ...this.current, connection }; this.emit('state', this.state);
  }
  connect(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.connecting) return this.connecting;
    this.stopped = false;
    this.connecting = new Promise<void>((resolve, reject) => { this.connectResolve = resolve; this.connectReject = reject; });
    this.connectTimer = setTimeout(() => this.stop(new BeaconError('timeout')), this.options.requestTimeoutMs);
    const connecting = this.connecting;
    this.open();
    return connecting;
  }
  private open(): void {
    if (this.stopped) return;
    this.connection(this.attempts ? 'reconnecting' : 'connecting');
    let socket: BeaconSocket;
    try { socket = new this.Socket(this.options.url); } catch { this.disconnected(); return; }
    this.socket = socket;
    this.handshakeTimer = setTimeout(() => {
      if (this.socket === socket) this.stop(new BeaconError('timeout'));
    }, this.options.requestTimeoutMs);
    socket.addEventListener('open', () => {
      if (this.socket !== socket || this.stopped) return;
      this.connection('authenticating');
      void this.authenticate(socket);
    });
    socket.addEventListener('message', event => {
      if (this.socket !== socket || this.stopped) return;
      try {
        if (typeof event.data !== 'string' || new TextEncoder().encode(event.data).byteLength > this.options.maxMessageBytes!) throw new BeaconError('invalid_message');
        const message: unknown = JSON.parse(event.data);
        if (!record(message) || typeof message.type !== 'string') throw new BeaconError('invalid_message');
        this.receive(message as BeaconMessage);
      } catch { this.emit('error', new BeaconError('invalid_message')); socket.close(1002, 'Invalid protocol message'); }
    });
    socket.addEventListener('error', () => {
      if (this.socket !== socket) return;
      socket.close(); if (this.socket === socket) this.disconnected();
    });
    socket.addEventListener('close', event => {
      if (this.socket !== socket) return;
      if (event.code === 4001 || event.code === 4003 || event.code === 1008) {
        this.stop(new BeaconError(event.code === 4001 ? 'session_replaced' : 'authentication_failed'));
        this.emit('disconnected', this.state);
      } else this.disconnected();
    });
  }
  private async authenticate(socket: BeaconSocket): Promise<void> {
    try {
      const token = await this.getToken();
      if (this.socket !== socket || this.stopped) return;
      if (!token) throw new BeaconError('token_unavailable');
      await this.sendRequest({ type: 'auth', token, protocolVersion: 2 }, {}, true);
      if (this.socket !== socket || this.stopped) return;
      clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined;
      clearTimeout(this.connectTimer); this.connectTimer = undefined;
      this.ready = true; this.attempts = 0; this.connection('connected');
      for (const entry of this.pending.values()) if (entry.retry) socket.send(entry.wire);
      this.connectResolve?.(); this.connectResolve = undefined; this.connectReject = undefined; this.connecting = undefined;
      this.emit('connected', this.state);
    } catch (error) {
      if (this.socket !== socket || this.stopped) return;
      const safe = error instanceof BeaconError ? error : new BeaconError('token_unavailable');
      this.emit('error', safe);
      if (!['disconnected', 'timeout'].includes(safe.code)) { this.stop(safe); } else { socket.close(); this.disconnected(); }
    }
  }
  request(message: ClientMessage, options: RequestOptions = {}): Promise<BeaconResult> {
    return this.sendRequest(message, options, false);
  }
  private sendRequest(message: ClientMessage, options: RequestOptions, internal: boolean): Promise<BeaconResult> {
    const requestId = options.requestId ?? message.requestId ?? `${this.prefix}:${++this.sequence}`;
    if (!requestId || requestId.length > 128 || this.pending.has(requestId)) return Promise.reject(new BeaconError('invalid_request_id', requestId));
    if ((!this.ready && !internal) || this.socket?.readyState !== 1) return Promise.reject(new BeaconError('disconnected', requestId));
    if (this.pending.size >= this.options.maxPending! + (internal ? 2 : 0)) return Promise.reject(new BeaconError('pending_limit', requestId));
    const timeout = positive(options.timeoutMs ?? this.options.requestTimeoutMs!, 'timeout');
    let wire: string;
    try { wire = JSON.stringify({ ...message, requestId }); } catch { return Promise.reject(new BeaconError('invalid_request', requestId)); }
    if (new TextEncoder().encode(wire).byteLength > 4096) return Promise.reject(new BeaconError('request_too_large', requestId));
    return new Promise<BeaconResult>((resolve, reject) => {
      const timer = setTimeout(() => { this.pending.delete(requestId); reject(new BeaconError('timeout', requestId)); }, timeout);
      this.pending.set(requestId, { wire, command: message.type, retry: options.retryOnReconnect === true, clearsRoom: message.type === 'leave_room' || message.type === 'switch_game' || message.type === 'select_game' || (message.type === 'delete_room' && message.roomId === undefined), messages: [], bytes: 0, resolve, reject, timer });
      try { this.socket!.send(wire); } catch { this.finish(requestId, new BeaconError('disconnected', requestId)); }
    });
  }
  private snapshotRevision(message: BeaconMessage): number | undefined {
    if ((message.type === 'lobby_state' || message.type === 'lobby_update') && typeof message.lobbyRevision === 'number') return message.lobbyRevision;
    return typeof message.revision === 'number' ? message.revision : record(message.room) && typeof message.room.revision === 'number' ? message.room.revision : typeof message.lobbyRevision === 'number' ? message.lobbyRevision : undefined;
  }
  private finish(requestId: string, error?: BeaconError): void {
    const entry = this.pending.get(requestId); if (!entry) return;
    clearTimeout(entry.timer); this.pending.delete(requestId);
    if (!error && !entry.resynced && entry.clearsRoom) {
      this.current = { ...this.current, room: null }; this.emit('state', this.state);
    }
    if (error) entry.reject(error); else entry.resolve({ requestId, messages: entry.messages });
  }
  private receive(message: BeaconMessage): void {
    const requestId = typeof message.requestId === 'string' ? message.requestId : undefined;
    if (message.type === 'result') {
      if (requestId && message.ok === true && message.resyncRequired === true) {
        const original = this.pending.get(requestId);
        if (!original) return;
        if (original.command === 'sync_state') { this.finish(requestId, new BeaconError('invalid_snapshot', requestId)); return; }
        void this.sendRequest({ type: 'sync_state' }, {}, true).then(result => {
          if (this.pending.get(requestId) !== original) return;
          if (!original.messages.length) original.messages = [...result.messages];
          original.resynced = true;
          this.finish(requestId);
        }, () => this.finish(requestId, new BeaconError('resync_failed', requestId)));
        return;
      }
      if (requestId) {
        let incomplete = false;
        for (const [key, assembly] of this.assemblies) if (assembly.base.requestId === requestId) {
          incomplete = true; clearTimeout(assembly.timer); this.assemblies.delete(key);
        }
        this.finish(requestId, incomplete ? new BeaconError('incomplete_snapshot', requestId) : message.ok === true ? undefined : new BeaconError(typeof message.code === 'string' ? message.code : 'server_error', requestId));
      }
      return;
    }
    if (message.type === 'error' || message.type === 'auth_fail') {
      const error = new BeaconError(typeof message.code === 'string' ? message.code : 'authentication_failed', requestId);
      if (requestId) this.finish(requestId, error); else { this.emit('error', error); if (message.type === 'auth_fail') this.stop(error); }
      return;
    }
    const complete = this.assemble(message);
    if (!complete) return;
    if (requestId) {
      const pending = this.pending.get(requestId);
      if (pending) pending.bytes += new TextEncoder().encode(JSON.stringify(complete)).byteLength;
      if (pending && pending.bytes > this.options.maxMessageBytes! * 4) throw new BeaconError('response_limit');
      if (pending && pending.messages.length >= 1024) throw new BeaconError('response_limit');
      pending?.messages.push(complete);
    }
    if (complete.replayed !== true) this.update(complete);
    this.emit('message', complete);
    if (complete.replayed !== true) this.emit(complete.type, complete);
  }
  private scope(message: BeaconMessage): string {
    if (message.type === 'snapshot_chunk' && typeof message.snapshotType === 'string') return `snapshot:${message.snapshotType}`;
    if (message.type === 'lobby_state' || message.type === 'lobby_update') return 'lobby';
    if (record(message.party) && typeof message.party.id === 'string') return `party:${message.party.id}`;
    const room = record(message.room) ? message.room : undefined;
    return typeof room?.id === 'string' ? `room:${room.id}` : typeof message.roomId === 'string' ? `room:${message.roomId}` : message.type;
  }
  private assemble(message: BeaconMessage): BeaconMessage | undefined {
    const scope = this.scope(message);
    const revision = this.snapshotRevision(message);
    if (revision !== undefined && (!Number.isSafeInteger(revision) || revision < 0)) throw new BeaconError('invalid_snapshot');
    if (revision !== undefined && revision < (this.revisions.get(scope) ?? -1) && typeof message.requestId !== 'string') return undefined;
    if (!this.revisions.has(scope) && this.revisions.size >= 256) this.revisions.delete(this.revisions.keys().next().value!);
    if (message.chunkCount === undefined) {
      if (revision !== undefined) this.revisions.set(scope, Math.max(revision, this.revisions.get(scope) ?? -1));
      return message;
    }
    const { snapshotId, chunkCount, chunkIndex } = message;
    const field = message.type === 'snapshot_chunk' && typeof message.payload === 'string' && typeof message.snapshotType === 'string' ? 'payload' : Array.isArray(message.members) ? 'members' : Array.isArray(message.rooms) ? 'rooms' : Array.isArray(message.friends) ? 'friends' : Array.isArray(message.games) ? 'games' : record(message.party) && Array.isArray(message.party.members) ? 'partyMembers' : undefined;
    if (typeof snapshotId !== 'string' || snapshotId.length > 128 || !Number.isSafeInteger(chunkCount) || !Number.isSafeInteger(chunkIndex) || typeof chunkCount !== 'number' || typeof chunkIndex !== 'number' || chunkCount < 1 || chunkCount > 1024 || chunkIndex < 0 || chunkIndex >= chunkCount || revision === undefined || !field) throw new BeaconError('invalid_snapshot');
    const part = field === 'payload' ? [message.payload] : field === 'partyMembers' && record(message.party) ? message.party.members as unknown[] : message[field] as unknown[];
    const key = `${scope}:${message.type}:${snapshotId}:${revision}`;
    let assembly = this.assemblies.get(key);
    if (!assembly) {
      if (this.assemblies.size >= this.options.maxSnapshots!) throw new BeaconError('snapshot_limit');
      const timer = setTimeout(() => { this.assemblies.delete(key); this.emit('error', new BeaconError('snapshot_timeout')); if (this.ready) void this.syncState().catch(() => {}); }, this.options.requestTimeoutMs);
      assembly = { base: message, field, count: chunkCount, bytes: 0, parts: new Map(), timer }; this.assemblies.set(key, assembly);
    }
    if (assembly.count !== chunkCount || assembly.field !== field || assembly.base.requestId !== message.requestId || assembly.base.snapshotType !== message.snapshotType) throw new BeaconError('invalid_snapshot');
    const previous = assembly.parts.get(chunkIndex);
    if (previous && JSON.stringify(previous) !== JSON.stringify(part)) throw new BeaconError('invalid_snapshot');
    assembly.bytes += new TextEncoder().encode(JSON.stringify(part)).byteLength - (previous ? new TextEncoder().encode(JSON.stringify(previous)).byteLength : 0);
    if (assembly.bytes > this.options.maxMessageBytes! * 4) throw new BeaconError('snapshot_limit');
    assembly.parts.set(chunkIndex, part);
    if (assembly.parts.size !== chunkCount) return undefined;
    const values: unknown[] = [];
    for (let index = 0; index < chunkCount; index++) values.push(...assembly.parts.get(index)!);
    clearTimeout(assembly.timer); this.assemblies.delete(key); this.revisions.set(scope, Math.max(revision, this.revisions.get(scope) ?? -1));
    if (field === 'payload') {
      if (!values.every(value => typeof value === 'string')) throw new BeaconError('invalid_snapshot');
      const value: unknown = JSON.parse(values.join(''));
      if (!record(value) || value.type !== assembly.base.snapshotType || value.type === 'snapshot_chunk') throw new BeaconError('invalid_snapshot');
      return { ...value, type: value.type as string, ...(assembly.base.requestId !== undefined ? { requestId: assembly.base.requestId } : {}), ...(assembly.base.replayed === true ? { replayed: true } : {}) };
    }
    const { chunkIndex: _index, chunkCount: _count, ...base } = assembly.base;
    if (field === 'partyMembers' && record(base.party)) return { ...base, type: assembly.base.type, party: { ...base.party, members: values } };
    return { ...base, type: assembly.base.type, [field]: values };
  }
  private update(message: BeaconMessage): void {
    const revision = this.snapshotRevision(message);
    if (revision !== undefined && revision < (this.revisions.get(this.scope(message)) ?? -1)) return;
    if (message.type === 'auth_ok' || message.type === 'auth_refreshed') {
      const player = message.player;
      if (record(player) && typeof player.id === 'string' && typeof player.displayName === 'string') this.current = { ...this.current, player: { id: player.id, displayName: player.displayName } };
      clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
      if (typeof message.expiresAt === 'number' && Number.isFinite(message.expiresAt)) {
        this.refreshTimer = setTimeout(() => {
          this.refreshTimer = undefined;
          void this.refreshAuth().catch(error => {
            const safe = error instanceof BeaconError ? error : new BeaconError('token_unavailable');
            this.emit('error', safe); this.stop(safe);
          });
        }, Math.max(1000, Math.min(2147483647, message.expiresAt - Date.now() - 30000)));
      }
    }
    if (message.type === 'session_state') this.current = { ...this.current, session: message, room: message.room === null ? null : message };
    if (message.type === 'lobby_state') this.current = { ...this.current, lobby: message };
    if (message.type === 'lobby_update' && this.current.lobby && record(message.room) && typeof message.room.id === 'string') {
      const room = message.room;
      const existing = Array.isArray(this.current.lobby.rooms) ? this.current.lobby.rooms : [];
      const rooms = existing.filter(item => !record(item) || item.id !== room.id);
      if (message.change !== 'remove') rooms.push(room);
      this.current = { ...this.current, lobby: { ...this.current.lobby, rooms, lobbyRevision: message.lobbyRevision, revision: message.lobbyRevision } };
    }
    if (['room_joined', 'room_state', 'room_update', 'room_members'].includes(message.type)) this.current = { ...this.current, room: message };
    if (message.type === 'room_closed' || message.type === 'room_left') {
      const closedId = typeof message.roomId === 'string' ? message.roomId : undefined;
      const current = this.current.room;
      const currentId = current && typeof current.roomId === 'string' ? current.roomId : current && record(current.room) && typeof current.room.id === 'string' ? current.room.id : undefined;
      if (!closedId || !currentId || closedId === currentId) this.current = { ...this.current, room: null };
    }
    this.emit('state', this.state);
  }
  private clearAssemblies(): void { for (const item of this.assemblies.values()) clearTimeout(item.timer); this.assemblies.clear(); }
  private disconnected(): void {
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined;
    this.socket = undefined; this.ready = false; this.clearAssemblies(); this.revisions.clear();
    for (const [id, entry] of this.pending) {
      if (!entry.retry) this.finish(id, new BeaconError('disconnected', id));
      else { entry.messages = []; entry.bytes = 0; }
    }
    this.connection('disconnected'); this.emit('disconnected', this.state);
    if (this.stopped) return;
    if (this.options.reconnect === false) { this.stop(new BeaconError('disconnected')); return; }
    this.attempts++;
    const cap = Math.min(this.options.reconnectMaxMs!, this.options.reconnectMinMs! * 2 ** Math.min(this.attempts - 1, 16));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = undefined; this.open(); }, Math.round(cap * (0.5 + Math.random() * 0.5)));
  }
  private stop(error: BeaconError): void {
    clearTimeout(this.refreshTimer); this.refreshTimer = undefined;
    clearTimeout(this.handshakeTimer); this.handshakeTimer = undefined;
    clearTimeout(this.connectTimer); this.connectTimer = undefined;
    this.stopped = true; this.ready = false;
    clearTimeout(this.reconnectTimer); this.reconnectTimer = undefined;
    const socket = this.socket; this.socket = undefined; socket?.close();
    for (const id of this.pending.keys()) this.finish(id, new BeaconError(error.code, id));
    this.clearAssemblies(); this.revisions.clear(); this.connectReject?.(error); this.connectResolve = undefined; this.connectReject = undefined; this.connecting = undefined;
    this.connection('disconnected');
  }
  disconnect(): void { this.stop(new BeaconError('disconnected')); }
  private async getToken(): Promise<string> {
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        Promise.resolve().then(() => this.options.token()),
        new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new BeaconError('timeout')), this.options.requestTimeoutMs); })
      ]);
    } catch (error) { throw error instanceof BeaconError ? error : new BeaconError('token_unavailable'); }
    finally { clearTimeout(timer); }
  }
  async refreshAuth(): Promise<BeaconResult> {
    let token: string;
    token = await this.getToken();
    if (!token) throw new BeaconError('token_unavailable');
    return this.request({ type: 'refresh_auth', token });
  }
  syncState(): Promise<BeaconResult> { return this.request({ type: 'sync_state' }); }
  selectGame(gameId: string, compatibility: Compatibility = {}): Promise<BeaconResult> { return this.request({ type: 'select_game', gameId, ...compatibility }); }
  listRooms(filters: BeaconRoomFilters = {}): Promise<BeaconResult> { return this.request({ ...filters, type: 'list_rooms' }); }
  createRoom(input: BeaconRoomInput): Promise<BeaconResult> { return this.request({ ...input, type: 'create_room' }); }
  joinRoom(roomId: string, options: { password?: string; role?: 'player' | 'spectator'; invitationToken?: string } = {}): Promise<BeaconResult> { return this.request({ type: 'join_room', roomId, ...options }); }
  leaveRoom(): Promise<BeaconResult> { return this.request({ type: 'leave_room' }); }
  deleteRoom(roomId?: string): Promise<BeaconResult> { return this.request(roomId === undefined ? { type: 'delete_room' } : { type: 'delete_room', roomId }); }
  setReady(ready: boolean): Promise<BeaconResult> { return this.request({ type: 'ready', ready }); }
  startGame(): Promise<BeaconResult> { return this.request({ type: 'start_game' }); }
  ping(): Promise<BeaconResult> { return this.request({ type: 'ping' }); }
  updateRoom(settings: RoomSettings): Promise<BeaconResult> { return this.request({ type: 'update_room', ...settings }); }
  kickPlayer(playerId: string, ban = false): Promise<BeaconResult> { return this.request({ type: 'kick_player', playerId, ...(ban ? { ban } : {}) }); }
  unbanPlayer(playerId: string): Promise<BeaconResult> { return this.request({ type: 'unban_player', playerId }); }
  transferHost(playerId: string): Promise<BeaconResult> { return this.request({ type: 'transfer_host', playerId }); }
  invitePlayer(playerId: string): Promise<BeaconResult> { return this.request({ type: 'invite_player', playerId }); }
  quickJoin(filters: BeaconRoomFilters & { password?: string } = {}): Promise<BeaconResult> { return this.request({ ...filters, type: 'quick_join' }); }
  queueJoin(options: { minPlayers?: number; maxPlayers?: number } & Compatibility = {}): Promise<BeaconResult> { return this.request({ ...options, type: 'queue_join' }); }
  queueLeave(): Promise<BeaconResult> { return this.request({ type: 'queue_leave' }); }
  partyCreate(): Promise<BeaconResult> { return this.request({ type: 'party_create' }); }
  partyInvite(playerId: string): Promise<BeaconResult> { return this.request({ type: 'party_invite', playerId }); }
  partyAccept(invitationToken: string): Promise<BeaconResult> { return this.request({ type: 'party_accept', invitationToken }); }
  partyLeave(): Promise<BeaconResult> { return this.request({ type: 'party_leave' }); }
  friendRequest(playerId: string): Promise<BeaconResult> { return this.request({ type: 'friend_request', playerId }); }
  friendRespond(playerId: string, accept: boolean): Promise<BeaconResult> { return this.request({ type: 'friend_respond', playerId, accept }); }
  friendRemove(playerId: string): Promise<BeaconResult> { return this.request({ type: 'friend_remove', playerId }); }
  listFriends(): Promise<BeaconResult> { return this.request({ type: 'list_friends' }); }
  switchGame(gameId: string, compatibility: Compatibility = {}): Promise<BeaconResult> { return this.request({ type: 'switch_game', gameId, ...compatibility }); }
  listGames(): Promise<BeaconResult> { return this.request({ type: 'list_games' }); }
  listOwnedRooms(): Promise<BeaconResult> { return this.request({ type: 'list_owned_rooms' }); }
  blockPlayer(playerId: string): Promise<BeaconResult> { return this.request({ type: 'block_player', playerId }); }
  unblockPlayer(playerId: string): Promise<BeaconResult> { return this.request({ type: 'unblock_player', playerId }); }
  listBlocks(): Promise<BeaconResult> { return this.request({ type: 'list_blocks' }); }
}
