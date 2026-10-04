import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { AuditEvent, Moderation, PlayerBlock, RoomStore, SocialLink, StoredInvitation, StoredParty, StoredRoom, ReconnectSeat } from '../types.js';
import { readRules } from '../protocol/index.js';

function text(value: unknown, max = 128, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function integer(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function roomValid(room: StoredRoom): void {
  if (!text(room.id) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(room.id) || !text(room.gameId) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(room.gameId) || !text(room.name, 128) || [...room.name].length > 32 || !text(room.ownerId) || !text(room.hostId) || !(room.passwordHash === null || text(room.passwordHash, 512)) || !integer(room.maxPlayers, 1) || !['open', 'starting', 'in_game', 'closed'].includes(room.state) || !['public', 'unlisted', 'invite'].includes(room.visibility) || typeof room.locked !== 'boolean' || ![room.version, room.mode, room.region].every(v => text(v, 64, true)) || !['closed', 'fill', 'spectate'].includes(room.joinPolicy) || !integer(room.maxSpectators) || !integer(room.revision, 1) || ![room.bannedIds, room.invitedIds].every(v => Array.isArray(v) && v.length <= 10000 && v.every(id => text(id)) && new Set(v).size === v.length) || !(room.matchId === null || text(room.matchId)) || !integer(room.createdAt) || !integer(room.updatedAt)) throw new Error('Invalid persisted room data');
  if (room.matchRequest !== undefined) {
    const request = room.matchRequest;
    if (!request || typeof request !== 'object' || Object.keys(request).some(key => !['operationId', 'roomId', 'gameId', 'players', 'version', 'mode', 'region', 'rules'].includes(key)) || !text(request.operationId) || request.roomId !== room.id || request.gameId !== room.gameId || request.version !== room.version || request.mode !== room.mode || request.region !== room.region || !Array.isArray(request.players) || !request.players.length || !request.players.every(player => player && typeof player === 'object' && Object.keys(player).length === 2 && text(player.id) && (player.role === 'player' || player.role === 'spectator')) || new Set(request.players.map(player => player.id)).size !== request.players.length || Buffer.byteLength(JSON.stringify(request)) > 262144) throw new Error('Invalid persisted match request');
    if (request.rules !== undefined) { try { if (JSON.stringify(readRules(request.rules)) !== JSON.stringify(room.rules)) throw new Error('Invalid persisted match request'); } catch { throw new Error('Invalid persisted match request'); } }
  }
  if (room.rules !== undefined) { try { if (JSON.stringify(readRules(room.rules)) !== JSON.stringify(room.rules)) throw new Error('Invalid persisted room data'); } catch { throw new Error('Invalid persisted room data'); } }
  if (room.seats !== undefined) seatsValid(room.seats, room.maxPlayers + room.maxSpectators);
}
function seatsValid(seats: ReconnectSeat[], max: number): void {
  if (!Array.isArray(seats) || seats.length > max || new Set(seats.map(seat => seat.playerId)).size !== seats.length) throw new Error('Invalid persisted room data');
  for (const seat of seats) {
    if (!seat || typeof seat !== 'object' || Object.keys(seat).some(key => !['playerId', 'role', 'ready', 'gameId', 'version', 'mode', 'region', 'displayName', 'expiresAt', 'pendingResult'].includes(key)) || !text(seat.playerId) || (seat.role !== 'player' && seat.role !== 'spectator') || typeof seat.ready !== 'boolean' || !text(seat.gameId) || ![seat.version, seat.mode, seat.region].every(value => text(value, 64, true)) || !text(seat.displayName) || !integer(seat.expiresAt)) throw new Error('Invalid persisted room data');
    if (seat.pendingResult !== undefined) {
      const pending = seat.pendingResult;
      if (!pending || typeof pending !== 'object' || Object.keys(pending).some(key => key !== 'matchId' && key !== 'result') || !text(pending.matchId)) throw new Error('Invalid persisted room data');
      try { if (JSON.stringify(readRules(pending.result)) !== JSON.stringify(pending.result)) throw new Error('Invalid persisted room data'); } catch { throw new Error('Invalid persisted room data'); }
    }
  }
}
function moderationValid(value: Moderation): void {
  if (!text(value.playerId) || !integer(value.bannedUntil) || !integer(value.revokedBefore) || !text(value.reason, 1024, true)) throw new Error('Invalid moderation data');
}
function socialValid(value: SocialLink): void {
  if (!text(value.a) || !text(value.b) || value.a === value.b || !['pending', 'accepted'].includes(value.status) || (value.requestedBy !== value.a && value.requestedBy !== value.b)) throw new Error('Invalid social data');
}
function partyValid(value: StoredParty): void {
  if (!text(value.id) || !text(value.leaderId) || !Array.isArray(value.members) || value.members.length < 1 || value.members.length > 128 || !value.members.every(id => text(id)) || new Set(value.members).size !== value.members.length || !value.members.includes(value.leaderId)) throw new Error('Invalid party data');
}
function invitationValid(value: StoredInvitation): void {
  const keys = Object.keys(value);
  if (!text(value.token) || !text(value.target) || !integer(value.expiresAt, 1) || keys.some(key => !['token', 'target', 'expiresAt', 'roomId', 'partyId'].includes(key)) || (value.roomId === undefined) === (value.partyId === undefined) || (value.roomId !== undefined && !text(value.roomId)) || (value.partyId !== undefined && !text(value.partyId))) throw new Error('Invalid invitation data');
}
function blockValid(value: PlayerBlock): void {
  if (!text(value.playerId) || !text(value.targetId) || value.playerId === value.targetId || Object.keys(value).some(key => key !== 'playerId' && key !== 'targetId')) throw new Error('Invalid block data');
}
function auditValid(value: AuditEvent): void {
  if (!integer(value.at) || !text(value.actor) || !text(value.action) || !text(value.target, 256, true)) throw new Error('Invalid audit data');
}
function metadata(room: StoredRoom): string {
  const { ownerId, visibility, locked, version, mode, region, joinPolicy, maxSpectators, revision, bannedIds, invitedIds, matchId, matchRequest, rules, seats } = room;
  return JSON.stringify({ ownerId, visibility, locked, version, mode, region, joinPolicy, maxSpectators, revision, bannedIds, invitedIds, matchId, ...(matchRequest === undefined ? {} : { matchRequest }), ...(rules === undefined ? {} : { rules }), ...(seats?.length ? { seats } : {}) });
}
export class SqliteRoomStore implements RoomStore {
  private readonly db: DatabaseSync;
  constructor(path: string) {
    if (path === ':memory:') throw new Error('Room persistence requires a database file');
    const existed = existsSync(path);
    if (existed && !lstatSync(path).isFile()) throw new Error('Database path must be a regular file, not a symlink');
    for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix) && !lstatSync(path + suffix).isFile()) throw new Error('Database sidecar must be a regular file');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existed) closeSync(openSync(path, 'wx', 0o600));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { timeout: 3000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('integrity_check failed');
      chmodSync(path, 0o600);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL; BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
        const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
        if (versions.some(row => row.version !== 1 && row.version !== 2 && row.version !== 3) || (versions.length && versions[0]?.version !== 1)) throw new Error('Unsupported schema version');
        if (!versions.length) {
          db.exec(`CREATE TABLE rooms (
            id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL,
            password_hash TEXT, max_players INTEGER NOT NULL CHECK(max_players > 0),
            host_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          ) STRICT; CREATE INDEX rooms_game ON rooms(game_id);`);
          db.prepare('INSERT INTO schema_migrations VALUES(1, ?)').run(Date.now());
        }
        if (!versions.some(row => row.version === 2)) {
          db.exec(`CREATE TABLE rooms_expanded (
            id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL,
            password_hash TEXT, max_players INTEGER NOT NULL CHECK(max_players > 0),
            host_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'starting', 'in_game', 'closed')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL, metadata TEXT NOT NULL CHECK(json_valid(metadata))
          ) STRICT;
          INSERT INTO rooms_expanded SELECT id, game_id, name, password_hash, max_players, host_id, state, created_at, updated_at,
          json_object('ownerId',host_id,'visibility','public','locked',json('false'),'version','','mode','','region','','joinPolicy','closed','maxSpectators',16,'revision',1,'bannedIds',json('[]'),'invitedIds',json('[]'),'matchId',NULL) FROM rooms;
          DROP TABLE rooms; ALTER TABLE rooms_expanded RENAME TO rooms; CREATE INDEX rooms_game ON rooms(game_id);
          CREATE TABLE moderation(player_id TEXT PRIMARY KEY, banned_until INTEGER NOT NULL, revoked_before INTEGER NOT NULL, reason TEXT NOT NULL) STRICT;
          CREATE TABLE social(a TEXT NOT NULL,b TEXT NOT NULL,status TEXT NOT NULL CHECK(status IN ('pending','accepted')),requested_by TEXT NOT NULL,PRIMARY KEY(a,b),CHECK(a != b)) STRICT;
          CREATE TABLE audit_events(id INTEGER PRIMARY KEY,at INTEGER NOT NULL,actor TEXT NOT NULL,action TEXT NOT NULL,target TEXT NOT NULL) STRICT;`);
          db.prepare('INSERT INTO schema_migrations VALUES(2, ?)').run(Date.now());
        }
        if (!versions.some(row => row.version === 3)) {
          db.exec(`CREATE TABLE parties(id TEXT PRIMARY KEY, leader_id TEXT NOT NULL, members TEXT NOT NULL CHECK(json_valid(members))) STRICT;
          CREATE TABLE invitations(token TEXT PRIMARY KEY, target TEXT NOT NULL, expires_at INTEGER NOT NULL, room_id TEXT, party_id TEXT) STRICT;
          CREATE TABLE blocks(player_id TEXT NOT NULL, target_id TEXT NOT NULL, PRIMARY KEY(player_id, target_id), CHECK(player_id != target_id)) STRICT;`);
          db.prepare('INSERT INTO schema_migrations VALUES(3, ?)').run(Date.now());
        }
        this.db = db;
        this.load(); this.listModeration(); this.listSocial(); this.listParties(); this.listInvitations(); this.listBlocks(); this.listAudit(1000);
        db.exec('COMMIT');
      } catch (error) { if (db.isTransaction) db.exec('ROLLBACK'); throw error; }
      for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
    } catch {
      db?.close();
      throw new Error('Unable to open or validate room database. Original file retained; restore a backup or repair the database. 保留原檔，請還原備份或修復。');
    }
  }
  load(): StoredRoom[] {
    return this.db.prepare('SELECT * FROM rooms ORDER BY created_at, rowid').all().map(row => {
      if (typeof row.metadata !== 'string' || Buffer.byteLength(row.metadata) > 3000000) throw new Error('Invalid persisted room data');
      const data: unknown = JSON.parse(row.metadata);
      if (!data || typeof data !== 'object' || Array.isArray(data)) throw new Error('Invalid persisted room data');
      const allowed = ['ownerId', 'visibility', 'locked', 'version', 'mode', 'region', 'joinPolicy', 'maxSpectators', 'revision', 'bannedIds', 'invitedIds', 'matchId', 'matchRequest', 'rules', 'seats'];
      if (Object.keys(data).some(key => !allowed.includes(key))) throw new Error('Invalid persisted room metadata');
      const room = { ...data, id: row.id, gameId: row.game_id, name: row.name, hostId: row.host_id, passwordHash: row.password_hash, maxPlayers: row.max_players, state: row.state, createdAt: row.created_at, updatedAt: row.updated_at } as StoredRoom;
      roomValid(room);
      return room;
    });
  }
  private commit(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try { write(); this.db.exec('COMMIT'); }
    catch (error) { if (this.db.isTransaction) this.db.exec('ROLLBACK'); throw error; }
  }
  insert(room: StoredRoom): void {
    roomValid(room);
    this.commit(() => { this.db.prepare('INSERT INTO rooms(id,game_id,name,password_hash,max_players,host_id,state,created_at,updated_at,metadata) VALUES(?,?,?,?,?,?,?,?,?,?)').run(room.id, room.gameId, room.name, room.passwordHash, room.maxPlayers, room.hostId, room.state, room.createdAt, room.updatedAt, metadata(room)); });
  }
  update(room: StoredRoom): void {
    roomValid(room);
    this.commit(() => {
      if (this.db.prepare('UPDATE rooms SET game_id=?,name=?,password_hash=?,max_players=?,host_id=?,state=?,created_at=?,updated_at=?,metadata=? WHERE id=?').run(room.gameId, room.name, room.passwordHash, room.maxPlayers, room.hostId, room.state, room.createdAt, room.updatedAt, metadata(room), room.id).changes !== 1) throw new Error('Room no longer exists');
    });
  }
  setHost(id: string, hostId: string, updatedAt: number): void {
    if (!text(hostId) || !integer(updatedAt)) throw new Error('Invalid room host');
    this.commit(() => { if (this.db.prepare("UPDATE rooms SET host_id=?,updated_at=?,metadata=json_set(metadata,'$.revision',json_extract(metadata,'$.revision')+1) WHERE id=?").run(hostId, updatedAt, id).changes !== 1) throw new Error('Room no longer exists'); });
  }
  delete(id: string): void { this.commit(() => { if (this.db.prepare('DELETE FROM rooms WHERE id=?').run(id).changes !== 1) throw new Error('Room no longer exists'); }); }
  listModeration(): Moderation[] {
    return this.db.prepare('SELECT player_id AS playerId,banned_until AS bannedUntil,revoked_before AS revokedBefore,reason FROM moderation ORDER BY player_id').all().map(row => { const item = { ...row } as unknown as Moderation; moderationValid(item); return item; });
  }
  saveModeration(record: Moderation): void {
    moderationValid(record);
    this.commit(() => { this.db.prepare('INSERT INTO moderation VALUES(?,?,?,?) ON CONFLICT(player_id) DO UPDATE SET banned_until=excluded.banned_until,revoked_before=excluded.revoked_before,reason=excluded.reason').run(record.playerId, record.bannedUntil, record.revokedBefore, record.reason); });
  }
  listSocial(): SocialLink[] {
    return this.db.prepare('SELECT a,b,status,requested_by AS requestedBy FROM social ORDER BY a,b').all().map(row => { const item = { ...row } as unknown as SocialLink; socialValid(item); if (item.a >= item.b) throw new Error('Invalid social ordering'); return item; });
  }
  saveSocial(link: SocialLink): void {
    socialValid(link);
    const a = link.a < link.b ? link.a : link.b;
    const b = link.a < link.b ? link.b : link.a;
    this.commit(() => { this.db.prepare('INSERT INTO social VALUES(?,?,?,?) ON CONFLICT(a,b) DO UPDATE SET status=excluded.status,requested_by=excluded.requested_by').run(a, b, link.status, link.requestedBy); });
  }
  deleteSocial(a: string, b: string): void {
    if (!text(a) || !text(b) || a === b) throw new Error('Invalid social data');
    this.commit(() => { this.db.prepare('DELETE FROM social WHERE a=? AND b=?').run(a < b ? a : b, a < b ? b : a); });
  }
  listParties(): StoredParty[] {
    return this.db.prepare('SELECT id, leader_id AS leaderId, members FROM parties ORDER BY id').all().map(row => {
      const members: unknown = JSON.parse(String(row.members));
      const party = { id: row.id, leaderId: row.leaderId, members } as StoredParty;
      partyValid(party); return party;
    });
  }
  saveParty(party: StoredParty): void {
    partyValid(party);
    this.commit(() => { this.db.prepare('INSERT INTO parties VALUES(?,?,?) ON CONFLICT(id) DO UPDATE SET leader_id=excluded.leader_id, members=excluded.members').run(party.id, party.leaderId, JSON.stringify(party.members)); });
  }
  deleteParty(id: string): void {
    if (!text(id)) throw new Error('Invalid party data');
    this.commit(() => { this.db.prepare('DELETE FROM parties WHERE id=?').run(id); });
  }
  listInvitations(): StoredInvitation[] {
    return this.db.prepare('SELECT token, target, expires_at AS expiresAt, room_id AS roomId, party_id AS partyId FROM invitations ORDER BY token').all().map(row => {
      const invitation: StoredInvitation = { token: String(row.token), target: String(row.target), expiresAt: Number(row.expiresAt), ...(row.roomId ? { roomId: String(row.roomId) } : {}), ...(row.partyId ? { partyId: String(row.partyId) } : {}) };
      invitationValid(invitation); return invitation;
    });
  }
  saveInvitation(invitation: StoredInvitation): void {
    invitationValid(invitation);
    this.commit(() => { this.db.prepare('INSERT INTO invitations VALUES(?,?,?,?,?) ON CONFLICT(token) DO UPDATE SET target=excluded.target, expires_at=excluded.expires_at, room_id=excluded.room_id, party_id=excluded.party_id').run(invitation.token, invitation.target, invitation.expiresAt, invitation.roomId ?? null, invitation.partyId ?? null); });
  }
  deleteInvitation(token: string): void {
    if (!text(token)) throw new Error('Invalid invitation data');
    this.commit(() => { this.db.prepare('DELETE FROM invitations WHERE token=?').run(token); });
  }
  listBlocks(): PlayerBlock[] {
    return this.db.prepare('SELECT player_id AS playerId, target_id AS targetId FROM blocks ORDER BY player_id, target_id').all().map(row => { const block = { ...row } as unknown as PlayerBlock; blockValid(block); return block; });
  }
  saveBlock(block: PlayerBlock): void {
    blockValid(block);
    this.commit(() => { this.db.prepare('INSERT INTO blocks VALUES(?,?) ON CONFLICT DO NOTHING').run(block.playerId, block.targetId); });
  }
  deleteBlock(playerId: string, targetId: string): void {
    if (!text(playerId) || !text(targetId) || playerId === targetId) throw new Error('Invalid block data');
    this.commit(() => { this.db.prepare('DELETE FROM blocks WHERE player_id=? AND target_id=?').run(playerId, targetId); });
  }
  audit(event: AuditEvent): void {
    auditValid(event);
    this.commit(() => { this.db.prepare('INSERT INTO audit_events(at,actor,action,target) VALUES(?,?,?,?)').run(event.at, event.actor, event.action, event.target); });
  }
  listAudit(limit: number): AuditEvent[] {
    if (!integer(limit, 1) || limit > 1000) throw new Error('Invalid audit limit');
    return this.db.prepare('SELECT at,actor,action,target FROM audit_events ORDER BY id DESC LIMIT ?').all(limit).map(row => { const item = { ...row } as unknown as AuditEvent; auditValid(item); return item; });
  }
  close(): void { this.db.close(); }
}
