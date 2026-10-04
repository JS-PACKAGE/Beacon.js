import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, stat, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig, validateConfig } from '../dist/config.js';
import { parseClient, ProtocolError, CLIENT_FIELDS } from '../dist/protocol/index.js';
import { SqliteRoomStore } from '../dist/store/index.js';
import { backupDatabase } from '../dist/store/backup.js';
import { dev } from './helpers.mjs';

test('protocol rejects unknown fields and unsafe values; accepts Unicode room name boundaries', () => {
  const invalid = [
    { type: 'list_rooms', page: 0 }, { type: 'list_rooms', pageSize: 201 },
    { type: 'create_room', name: 'x'.repeat(33) }, { type: 'create_room', name: 'bad\nname' },
    { type: 'create_room', name: 'valid', maxPlayers: 1.5 }, { type: 'join_room', roomId: '../room' },
    { type: 'auth', token: 'ok', admin: true }, { type: 'ping', password: 'no' }, [], null,
  ];
  for (const message of invalid) assert.throws(() => parseClient(JSON.stringify(message), 200), error => error instanceof ProtocolError && error.code === 'bad_request');
  assert.throws(() => parseClient('{"type":"__proto__"}', 200), error => error.code === 'unknown_type');
  assert.equal(parseClient(JSON.stringify({ type: 'create_room', name: '貓'.repeat(32) }), 200).name, '貓'.repeat(32));
});

test('commented config loads and security modes fail closed; # inside strings is preserved', async t => {
  const config = await loadConfig('config.yaml', dev);
  assert.throws(() => validateConfig(config, { mockAuth: false, insecureWs: false }), /Mock authentication/);
  assert.throws(() => validateConfig({ ...config, server: { ...config.server, listenHost: '0.0.0.0' } }, dev), /loopback/);
  assert.throws(() => validateConfig({ ...config, auth: { ...config.auth, mode: 'jwks' } }, dev), /JWKS/);
  assert.throws(() => validateConfig({ ...config, auth: { ...config.auth, mode: 'jwks', jwksUrl: 'https://issuer.example/jwks', issuer: 'https://issuer.example', audience: 'beacon', revocationUrl: 'https://issuer.example/revocations', revocationTokenFile: '' } }, dev), /token file/);
  const schema = JSON.parse(await readFile(new URL('../protocol.schema.json', import.meta.url), 'utf8'));
  assert.deepEqual(schema.clientCommands, CLIENT_FIELDS);
  assert.equal(schema.version, 2);
  const dir = await mkdtemp(join(tmpdir(), 'beacon-config-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  config.auth.mockPlayers[0].token = 'quoted-"-#-token';
  const path = join(dir, 'config.yaml');
  await writeFile(path, '# 中文說明\n' + JSON.stringify(config, null, 2) + '\n# 結尾說明\n');
  assert.equal((await loadConfig(path, dev)).auth.mockPlayers[0].token, 'quoted-"-#-token');
});

test('SQLite restart, committed deletion, secure live backup, and corruption preservation', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-store-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'rooms.db');
  const room = { id: 'room-1', gameId: 'g-001', name: 'Durable', ownerId: 'alice', hostId: 'alice', passwordHash: null, maxPlayers: 3, state: 'open', createdAt: 123, updatedAt: 123, visibility: 'public', locked: false, version: '', mode: '', region: '', joinPolicy: 'closed', maxSpectators: 16, revision: 1, bannedIds: [], invitedIds: [], matchId: null };
  let store = new SqliteRoomStore(path);
  store.insert(room);
  store.setHost(room.id, 'bob', 456);
  const copy = join(dir, 'backup.db');
  await backupDatabase(path, copy);
  assert.equal((await stat(copy)).mode & 0o777, 0o600);
  await assert.rejects(backupDatabase(path, copy), { code: 'EEXIST' });
  const backupStore = new SqliteRoomStore(copy);
  assert.deepEqual(backupStore.load(), [{ ...room, hostId: 'bob', updatedAt: 456, revision: 2 }]);
  backupStore.close();
  store.close();
  store = new SqliteRoomStore(path);
  assert.equal(store.load()[0].hostId, 'bob');
  store.delete(room.id); store.close();
  store = new SqliteRoomStore(path);
  assert.deepEqual(store.load(), []); store.close();
  assert.equal((await stat(path)).mode & 0o777, 0o600);
  const corrupt = join(dir, 'corrupt.db');
  const original = Buffer.from('This is not a SQLite file; preserve me');
  await writeFile(corrupt, original);
  assert.throws(() => new SqliteRoomStore(corrupt), /Original file retained/);
  assert.deepEqual(await readFile(corrupt), original);
});

test('legacy room migration preserves credentials/ownership and complete updates/social/moderation survive restart', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-migrate-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const path = join(dir, 'legacy.db');
  const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY,applied_at INTEGER NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES(1,1);
    CREATE TABLE rooms(id TEXT PRIMARY KEY,game_id TEXT NOT NULL,name TEXT NOT NULL,password_hash TEXT,max_players INTEGER NOT NULL,host_id TEXT NOT NULL,state TEXT NOT NULL CHECK(state IN ('open','closed')),created_at INTEGER NOT NULL,updated_at INTEGER NOT NULL) STRICT;
    INSERT INTO rooms VALUES('r','g','Legacy','protected-hash',4,'creator','open',1,2);`);
  db.close();
  let store = new SqliteRoomStore(path);
  const migrated = store.load()[0];
  assert.equal(migrated.passwordHash, 'protected-hash');
  assert.equal(migrated.ownerId, 'creator');
  assert.equal(migrated.visibility, 'public');
  const updated = { ...migrated, hostId: 'new-host', state: 'in_game', matchId: 'match', locked: true, bannedIds: ['banned'], invitedIds: ['invited'], revision: 2 };
  store.update(updated);
  assert.throws(() => store.update({ ...updated, bannedIds: ['bad\nid'] }));
  store.saveModeration({ playerId: 'banned', bannedUntil: 999, revokedBefore: 123, reason: 'abuse' });
  store.saveSocial({ a: 'z', b: 'a', status: 'pending', requestedBy: 'z' });
  store.saveSocial({ a: 'a', b: 'z', status: 'accepted', requestedBy: 'z' });
  store.audit({ at: 2, actor: 'operations', action: 'ban', target: 'banned' });
  store.close();
  store = new SqliteRoomStore(path);
  assert.deepEqual(store.load(), [updated]);
  assert.equal(store.listModeration()[0].revokedBefore, 123);
  assert.deepEqual(store.listSocial(), [{ a: 'a', b: 'z', status: 'accepted', requestedBy: 'z' }]);
  assert.equal(store.listAudit(1)[0].action, 'ban');
  const matchRequest = { operationId: 'stable-operation', roomId: updated.id, gameId: updated.gameId, players: [{ id: 'new-host', role: 'player' }], version: '', mode: '', region: '' };
  store.update({ ...updated, state: 'starting', matchId: null, matchRequest });
  store.close();
  store = new SqliteRoomStore(path);
  assert.deepEqual(store.load()[0].matchRequest, matchRequest);
  assert.throws(() => store.update({ ...updated, matchRequest: { ...matchRequest, roomId: 'another-room' } }));
  store.update(updated);
  assert.equal(store.load()[0].matchRequest, undefined);
  store.deleteSocial('z', 'a');
  assert.deepEqual(store.listSocial(), []);
  store.close();
});
