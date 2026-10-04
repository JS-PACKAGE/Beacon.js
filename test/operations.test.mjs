import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, lstat, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../dist/config.js';
import { startOperations, sendAlert } from '../dist/ops/index.js';
import { ProtocolError } from '../dist/protocol/index.js';
import { scheduledBackup } from '../dist/ops/backups.js';
import { restoreDrill } from '../dist/ops/restore.js';
import { configureLogging, closeLogging, log } from '../dist/log/index.js';
import { SqliteRoomStore } from '../dist/store/index.js';
import { dev } from './helpers.mjs';

async function setup(t) {
  const directory = await mkdtemp(join(await realpath(tmpdir()), 'beacon-ops-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig('config.yaml', dev);
  config.operations = { ...config.operations, enabled: false, tokenFile: '', logPath: '', backupDirectory: '', alertUrl: '', alertTokenFile: '' };
  const calls = [];
  const hooks = {
    ready: () => true,
    stats: () => ({ rooms: 2, players: 3, playerId: 'private-player', token: 'private-token' }),
    ban: async (...args) => { calls.push(['ban', ...args]); },
    unban: async (...args) => { calls.push(['unban', ...args]); },
    revoke: async (...args) => { calls.push(['revoke', ...args]); },
    closeRoom: async (...args) => { calls.push(['close', ...args]); },
    maintenance: (...args) => { calls.push(['maintenance', ...args]); },
    audit: limit => [{ at: 1, actor: 'operator', action: 'ban', target: 'alice', limit }],
    reportMatch: async (...args) => { calls.push(['match', ...args]); },
    reportPlayerResult: async (...args) => { calls.push(['player-result', ...args]); },
  };
  return { directory, config, calls, hooks };
}

test('internal operations rejects unauthorized and invalid requests and hides hook diagnostics', async t => {
  const { directory, config, calls, hooks } = await setup(t);
  const token = 'private-operator-token-123456789';
  const tokenFile = join(directory, 'admin.token');
  await writeFile(tokenFile, token, { mode: 0o600 });
  Object.assign(config.operations, { enabled: true, listenPort: 0, tokenFile });
  const service = await startOperations(config, hooks);
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const request = (path, input, authorization = `Bearer ${token}`) => fetch(base + path, { headers: { authorization, 'content-type': 'application/json' }, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
  for (const path of ['/health', '/ready', '/metrics', '/audit', '/ban', '/unban', '/revoke', '/rooms/close', '/matches/result', '/matches/player-result', '/maintenance']) {
    assert.equal((await request(path, path === '/ban' ? {} : undefined, 'Bearer wrong')).status, 403);
  }
  assert.equal((await request('/health')).status, 200);
  assert.deepEqual(await (await request('/ready')).json(), { ready: true });
  service.metric('commands_completed', 2);
  service.metric('invalid-secret-token', 4);
  const metrics = await (await request('/metrics')).json();
  assert.equal(metrics.counters.commands_completed, 2);
  assert.deepEqual(metrics.stats, { rooms: 2, players: 3 });
  assert.equal(JSON.stringify(metrics).includes('private-'), false);
  assert.equal((await request('/audit?limit=201')).status, 400);
  assert.equal((await request('/ban', { playerId: 'alice', until: 123, reason: 'abuse', extra: true })).status, 400);
  assert.equal((await request('/ban', { playerId: 'alice', until: 123, reason: 'x'.repeat(5000) })).status, 400);
  assert.deepEqual(calls, []);
  for (const [path, body] of [
    ['/ban', { playerId: 'alice', until: 123, reason: 'abuse' }],
    ['/unban', { playerId: 'alice' }], ['/revoke', { playerId: 'alice', before: 100 }],
    ['/rooms/close', { roomId: 'room-1' }], ['/maintenance', { enabled: true }],
    ['/matches/result', { matchId: 'match-1', state: 'ended' }],
    ['/matches/player-result', { matchId: 'match-1', playerId: 'alice', result: { score: 1 } }],
  ]) assert.equal((await request(path, body)).status, 200);
  hooks.reportMatch = async () => { throw new ProtocolError('room_not_found'); };
  assert.equal((await request('/matches/result', { matchId: 'missing', state: 'failed' })).status, 404);
  hooks.ready = () => false;
  assert.equal((await request('/ready')).status, 503);
  hooks.unban = async () => { throw new Error(`secret ${token}`); };
  const failed = await request('/unban', { playerId: 'alice' });
  assert.equal(failed.status, 400);
  assert.deepEqual(await failed.json(), { error: 'request_failed' });
});

test('operations disabled means no listener; admin token permissions and symlinks fail closed', async t => {
  const { directory, config, hooks } = await setup(t);
  const disabled = await startOperations(config, hooks);
  assert.equal(disabled.address(), undefined);
  await disabled.close();
  const path = join(directory, 'token');
  await writeFile(path, 'private-operator-token-123456789', { mode: 0o644 });
  Object.assign(config.operations, { enabled: true, listenPort: 0, tokenFile: path });
  await assert.rejects(startOperations(config, hooks), /mode0600/);
  await chmod(path, 0o600);
  const link = join(directory, 'link'); await symlink(path, link);
  config.operations.tokenFile = link;
  await assert.rejects(startOperations(config, hooks), /mode0600/);
});

test('scheduled backups use SQLite snapshots, retain only own private files and restore in isolation', async t => {
  const { directory } = await setup(t);
  const source = join(directory, 'live.sqlite');
  const store = new SqliteRoomStore(source);
  t.after(() => store.close());
  const room = { id: 'r-1', gameId: 'g-001', name: 'Durable', hostId: 'alice', ownerId: 'alice', passwordHash: null, maxPlayers: 3, state: 'open', visibility: 'public', locked: false, version: '', mode: '', region: '', joinPolicy: 'closed', maxSpectators: 16, revision: 1, bannedIds: [], invitedIds: [], matchId: null, createdAt: 123, updatedAt: 123 };
  store.insert(room);
  const backups = join(directory, 'backups');
  const first = await scheduledBackup(source, backups, 2);
  await writeFile(join(backups, 'keep.sqlite'), 'unrelated');
  const linkName = 'beacon-backup-0000000000000-00000000-0000-0000-0000-000000000000.sqlite';
  await symlink(source, join(backups, linkName));
  await new Promise(resolve => setTimeout(resolve, 2));
  await scheduledBackup(source, backups, 2);
  await new Promise(resolve => setTimeout(resolve, 2));
  const last = await scheduledBackup(source, backups, 2);
  assert.equal((await readdir(backups)).filter(name => name.startsWith('beacon-backup-') && name !== linkName).length, 2);
  await assert.rejects(lstat(first), { code: 'ENOENT' });
  assert.equal(await readFile(join(backups, 'keep.sqlite'), 'utf8'), 'unrelated');
  assert.equal((await lstat(join(backups, linkName))).isSymbolicLink(), true);
  assert.equal((await lstat(last)).mode & 0o777, 0o600);
  const before = await readFile(last);
  const result = await restoreDrill(last);
  assert.equal(result.integrity, 'ok'); assert.equal(result.rooms, 1); assert.deepEqual(result.migrationVersions, [1, 2, 3]);
  assert.deepEqual(await readFile(last), before);
  assert.deepEqual(store.load(), [room]);
});

test('restore drill executes real legacy migrations and preserves corrupt input', async t => {
  const { directory } = await setup(t);
  const legacy = join(directory, 'legacy.sqlite');
  const db = new DatabaseSync(legacy);
  db.exec(`CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT;
    INSERT INTO schema_migrations VALUES(1,1);
    CREATE TABLE rooms(id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL, password_hash TEXT, max_players INTEGER NOT NULL, host_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open','closed')), created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL) STRICT;
    INSERT INTO rooms VALUES('r-old','g-001','Legacy',NULL,3,'alice','open',1,1);`);
  db.close();
  const before = await readFile(legacy);
  const result = await restoreDrill(legacy);
  assert.equal(result.rooms, 1); assert.deepEqual(result.migrationVersions, [1, 2, 3]);
  assert.deepEqual(await readFile(legacy), before);
  const bad = join(directory, 'bad.sqlite'); await writeFile(bad, 'invalid sqlite');
  await assert.rejects(restoreDrill(bad)); assert.equal(await readFile(bad, 'utf8'), 'invalid sqlite');
});

test('alerts deliver bounded real HTTP webhook requests and reject external plaintext or oversized replies', async t => {
  let received;
  const server = createServer(async (request, response) => {
    const chunks = []; for await (const chunk of request) chunks.push(chunk);
    received = { token: request.headers.authorization, payload: JSON.parse(Buffer.concat(chunks)) };
    response.end(request.url === '/large' ? 'x'.repeat(9000) : '{}');
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  const base = `http://127.0.0.1:${server.address().port}`;
  await sendAlert(base, 'webhook-token', 'not_ready');
  assert.equal(received.token, 'Bearer webhook-token'); assert.equal(received.payload.event, 'not_ready');
  assert.deepEqual(Object.keys(received.payload).sort(), ['at', 'event', 'service']);
  await assert.rejects(sendAlert(base + '/large', '', 'not_ready'));
  await assert.rejects(sendAlert('http://example.com/webhook', '', 'not_ready'), /Invalid alert endpoint/);
});

test('persistent logging rotates private files and redacts tickets, authorization and nested credentials', async t => {
  const { directory, config } = await setup(t);
  const path = join(directory, 'logs', 'beacon.log');
  Object.assign(config.operations, { logPath: path, logMaxBytes: 1024, logFiles: 2 });
  await configureLogging(config.operations);
  t.after(() => closeLogging());
  for (let i = 0; i < 12; i++) log('info', 'operation', { index: i, message: 'x'.repeat(200), ticket: 'private-ticket', authorization: 'Bearer private-token', nested: { password: 'private-password' } });
  await closeLogging();
  const names = await readdir(join(directory, 'logs'));
  assert.deepEqual(names.sort(), ['beacon.log', 'beacon.log.1', 'beacon.log.2']);
  for (const name of names) {
    const file = join(directory, 'logs', name);
    assert.equal((await lstat(file)).mode & 0o777, 0o600);
    assert.doesNotMatch(await readFile(file, 'utf8'), /private-ticket|private-token|private-password/);
  }
  const unsafe = join(directory, 'unsafe.log'); await symlink(path, unsafe);
  config.operations.logPath = unsafe;
  await assert.rejects(configureLogging(config.operations), /Unsafe log file/);
});

test('configured integrations run without an admin listener and stop on close', async t => {
  const { directory, config, hooks } = await setup(t);
  const source = join(directory, 'scheduled.sqlite');
  const store = new SqliteRoomStore(source);
  let deliveries = 0;
  const webhook = createServer((request, response) => { request.resume(); deliveries++; response.end('{}'); });
  await new Promise(resolve => webhook.listen(0, '127.0.0.1', resolve));
  config.db.path = source;
  Object.assign(config.operations, { backupDirectory: join(directory, 'scheduled-backups'), backupIntervalMs: 20, backupRetention: 1, alertUrl: `http://127.0.0.1:${webhook.address().port}`, alertIntervalMs: 20 });
  hooks.ready = () => false;
  const service = await startOperations(config, hooks);
  try {
    assert.equal(service.address(), undefined);
    assert.equal(deliveries, 1);
    await new Promise(resolve => setTimeout(resolve, 80));
    assert.ok(deliveries >= 2);
    assert.equal((await readdir(config.operations.backupDirectory)).length, 1);
    await service.close();
    const count = deliveries;
    await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(deliveries, count);
  } finally {
    await service.close();
    store.close();
    await new Promise(resolve => webhook.close(resolve));
  }
});
