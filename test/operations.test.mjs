import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, readFile, readdir, lstat, rm, symlink, chmod, realpath } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { createServer } from 'node:http';
import { DatabaseSync } from 'node:sqlite';
import { loadConfig } from '../dist/config.js';
import { startOperations, sendAlert, OperationsError } from '../dist/ops/index.js';
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
    authorizeMutation: () => {},
    rooms: () => ({ items: [] }), room: () => undefined,
    matches: () => ({ items: [] }), match: () => undefined,
    queueDiagnostics: () => ({ entries: [] }), integrations: () => ({ configured: false }),
    clusterHealth: () => ({ enabled: false }),
    reconcileMatch: async (...args) => { calls.push(['reconcile', ...args]); return { state: 'ended' }; },
    chatReports: () => ({ items: [] }), chatReport: () => undefined,
    reviewChatReport: async (...args) => { calls.push(['review', ...args]); },
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

test('admin diagnostic pages and report details are private, bounded and authenticated; rejected actions do not mutate', async t => {
  const { directory, config, hooks, calls } = await setup(t);
  const tokenFile = join(directory, 'diagnostics.token');
  await writeFile(tokenFile, 'diagnostics-secret', { mode: 0o600 });
  Object.assign(config.operations, { enabled: true, listenPort: 0, tokenFile });
  const secretFields = { password: 'hidden-password', passwordHash: 'hidden-hash', token: 'hidden-token', ticket: 'hidden-ticket', diagnostics: { providerSecret: 'hidden-provider' } };
  const room = { id: 'room-1', state: 'running', members: [{ playerId: 'alice', ...secretFields }], ...secretFields };
  hooks.rooms = (cursor, limit) => ({ items: [room, { id: 'room-2' }], nextCursor: String(Number(cursor ?? 0) + limit) });
  hooks.room = identifier => identifier === 'room-1' ? room : undefined;
  hooks.matches = () => ({ items: [{ matchId: 'match-1', state: 'ended', roster: [{ playerId: 'alice' }], ...secretFields }] });
  hooks.match = identifier => identifier === 'match-1' ? { matchId: identifier, state: 'ended', ...secretFields } : undefined;
  hooks.chatReport = identifier => identifier === 'report-1' ? { reportId: identifier, status: 'pending', evidence: { messageId: 'message-1', text: 'bounded evidence', ...secretFields }, reason: 'abuse', ...secretFields } : undefined;
  hooks.chatReports = () => ({ items: [hooks.chatReport('report-1')] });
  hooks.queueDiagnostics = () => ({ entries: [{ partyId: 'party-1', waitMs: 500 }], ...secretFields });
  hooks.integrations = () => ({ gameSessions: { configured: true, healthy: false, ...secretFields }, ...secretFields });
  hooks.clusterHealth = () => ({ role: 'follower', healthy: true, ...secretFields });
  const service = await startOperations(config, hooks);
  t.after(() => service.close());
  const base = `http://127.0.0.1:${service.address().port}`;
  const request = (path, input, authorized = true) => fetch(base + path, { headers: { authorization: authorized ? 'Bearer diagnostics-secret' : 'Bearer wrong', 'content-type': 'application/json' }, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
  for (const path of ['/rooms', '/rooms/room-1', '/matches', '/matches/match-1', '/queue', '/integrations', '/cluster', '/chat/reports', '/chat/reports/report-1']) {
    assert.equal((await request(path, undefined, false)).status, 403);
    const response = await request(path); assert.equal(response.status, 200);
    assert.equal(JSON.stringify(await response.json()).includes('hidden-'), false);
  }
  const page = await (await request('/rooms?limit=1&cursor=0')).json();
  assert.equal(page.items.length, 1); assert.equal(page.nextCursor, '1');
  assert.equal(page.items[0].members[0].playerId, 'alice');
  assert.equal((await (await request('/chat/reports/report-1')).json()).evidence.text, 'bounded evidence');
  for (const query of ['limit=0', 'limit=201', 'limit=1&limit=2', 'cursor=-1', 'cursor=1000000001', 'other=1']) assert.equal((await request('/rooms?' + query)).status, 400);
  assert.equal((await request('/rooms/missing')).status, 404);
  assert.equal((await request('/matches/reconcile', { matchId: 'match-1' }, false)).status, 403);
  hooks.reconcileMatch = async () => { throw new OperationsError(409, 'conflict'); };
  assert.equal((await request('/matches/reconcile', { matchId: 'match-1' })).status, 409);
  const before = calls.length;
  assert.equal((await request('/chat/reports/review', { reportId: 'report-1', action: 'mute', until: 0, reason: 'reviewed' })).status, 400);
  assert.equal((await request('/chat/reports/review', { reportId: 'report-1', action: 'dismiss', until: 0, reason: 'x'.repeat(5000) })).status, 400);
  hooks.authorizeMutation = () => { throw new OperationsError(409, 'not_leader'); };
  const rejected = await request('/chat/reports/review', { reportId: 'report-1', action: 'dismiss', until: 0, reason: 'reviewed' });
  assert.equal(rejected.status, 409); assert.deepEqual(await rejected.json(), { error: 'not_leader' });
  assert.equal((await request('/maintenance', { enabled: true })).status, 409);
  assert.equal(calls.length, before);
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
  config.operations.tokenFile = path;
  config.operations.listenHost = '0.0.0.0';
  await assert.rejects(startOperations(config, hooks), /loopback/);
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
  assert.equal(result.integrity, 'ok'); assert.equal(result.rooms, 1);
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
  assert.equal(result.rooms, 1);
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
  assert.deepEqual(Object.keys(received.payload).sort(), ['at', 'event', 'id', 'service', 'severity']);
  assert.equal(received.payload.severity, 'warning');
  assert.match(received.payload.id, /^[0-9a-f-]{36}$/);
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

test('operator report pagination respects byte limits without losing evidence or records', async t => {
  const { directory, config, hooks } = await setup(t);
  const tokenFile = join(directory, 'page.token');
  await writeFile(tokenFile, 'page-operator', { mode: 0o600 });
  Object.assign(config.operations, { enabled: true, listenPort: 0, tokenFile });
  const reports = Array.from({ length: 50 }, (_, index) => ({
    id: `report-${index}`, status: 'pending',
    message: { id: `message-${index}`, text: '界'.repeat(1000) },
  }));
  hooks.chatReports = (cursor, limit) => {
    const offset = Number(cursor ?? 0);
    const items = reports.slice(offset, offset + limit);
    return { items, ...(offset + items.length < reports.length ? { nextCursor: String(offset + items.length) } : {}) };
  };
  const service = await startOperations(config, hooks);
  t.after(() => service.close());
  const seen = [];
  let cursor;
  do {
    const response = await fetch(`http://127.0.0.1:${service.address().port}/chat/reports${cursor === undefined ? '' : `?cursor=${cursor}`}`, {
      headers: { authorization: 'Bearer page-operator' },
    });
    assert.equal(response.status, 200);
    const wire = await response.text();
    assert.ok(Buffer.byteLength(wire) <= 65536);
    const page = JSON.parse(wire);
    assert.ok(page.items.length > 0);
    for (const report of page.items) {
      assert.equal(report.message.text, '界'.repeat(1000));
      seen.push(report.id);
    }
    const next = page.nextCursor;
    if (next !== undefined) assert.ok(Number(next) > Number(cursor ?? 0));
    cursor = next;
  } while (cursor !== undefined);
  assert.deepEqual(seen, reports.map(report => report.id));
});
