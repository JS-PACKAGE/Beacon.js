import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { environment, select } from './helpers.mjs';

async function command(client, payload) {
  const requestId = crypto.randomUUID();
  const result = await client.request({ ...payload, requestId }, 'result', value => value.requestId === requestId);
  assert.equal(result.ok, true, JSON.stringify(result));
}

async function adminEnvironment(t, sessions) {
  const env = await environment(t, {}, { ...(sessions ? { sessions } : {}), games: { async list() { return [{ gameId: 'g-001', name: 'Diagnostic test', enabled: true, source: 'config', maxPlayersPerRoom: 4 }]; } } });
  const tokenFile = join(env.dir, 'operator.key');
  await writeFile(tokenFile, 'private-test-operator', { mode: 0o600 });
  Object.assign(env.config.operations, { enabled: true, tokenFile, listenPort: 0 });
  await env.restart();
  const admin = async (path, input, authorized = true) => {
    const response = await fetch(`http://127.0.0.1:${env.service.operationsAddress().port}${path}`, { headers: { authorization: authorized ? 'Bearer private-test-operator' : 'Bearer wrong', 'content-type': 'application/json' }, ...(input === undefined ? {} : { method: 'POST', body: JSON.stringify(input) }) });
    return { status: response.status, body: await response.json() };
  };
  return { env, admin };
}

test('operator reconciles provider-authoritative state, preserves durable match history and never exposes credentials', async t => {
  let authoritative = 'in_game';
  let fail = false;
  const checked = [];
  const sessions = {
    async create(input) { return { matchId: 'ops-match-1', serverUrl: 'https://game.invalid', expiresAt: Date.now() + 60000, tickets: Object.fromEntries(input.players.map(player => [player.id, 'private-game-ticket'])) }; },
    async admit() { return { serverUrl: 'https://game.invalid', expiresAt: Date.now() + 60000, ticket: 'private-game-ticket' }; },
    async status(matchId) { checked.push(matchId); if (fail) throw new Error('private-provider-failure'); return authoritative; },
    async cancel() {},
  };
  const { env, admin } = await adminEnvironment(t, sessions);
  const alice = await env.connect(); await select(alice);
  const created = await alice.request({ type: 'create_room', name: 'Private diagnostic room', password: 'private-room-password' }, 'room_joined');
  await command(alice, { type: 'ready', ready: true });
  await alice.request({ type: 'start_game' }, 'game_started');
  const detail = await admin('/rooms/' + created.room.id);
  assert.equal(detail.status, 200);
  assert.equal(JSON.stringify(detail.body).includes('private-game-ticket'), false);
  assert.equal(Object.hasOwn(detail.body, 'passwordHash'), false);
  assert.equal((await admin('/matches/reconcile', { matchId: 'ops-match-1' }, false)).status, 403);
  fail = true;
  assert.notEqual((await admin('/matches/reconcile', { matchId: 'ops-match-1' })).status, 200);
  assert.equal((await admin('/matches/ops-match-1')).body.state, 'in_game');
  fail = false; authoritative = 'ended';
  assert.equal((await admin('/matches/reconcile', { matchId: 'ops-match-1' })).status, 200);
  assert.ok(checked.includes('ops-match-1'));
  assert.equal((await admin('/matches/ops-match-1')).body.state, 'ended');
  const audit = await admin('/audit?limit=200');
  assert.ok(audit.body.audit.some(event => event.target === 'ops-match-1' && /reconcile/.test(event.action)));
  await env.restart();
  assert.equal((await admin('/matches/ops-match-1')).body.state, 'ended');
  const history = await admin('/matches?limit=1');
  assert.equal(history.status, 200);
  assert.equal(history.body.items[0].matchId, 'ops-match-1');
});

test('operator report review is durable, privately retains evidence and applies moderation rather than fake success', async t => {
  const { env, admin } = await adminEnvironment(t);
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  const created = await alice.request({ type: 'create_room', name: 'Reported room' }, 'room_joined');
  await bob.request({ type: 'join_room', roomId: created.room.id }, 'room_joined');
  await command(alice, { type: 'chat_send', scope: 'room', text: 'report evidence' });
  const live = await bob.wait(value => value.type === 'chat_message');
  const messageId = live.message.id;
  assert.equal(typeof messageId, 'string');
  await command(bob, { type: 'chat_report', messageId, reason: 'abuse' });
  const reports = await admin('/chat/reports');
  assert.equal(reports.status, 200); assert.equal(reports.body.items.length, 1);
  const reportId = reports.body.items[0].id;
  assert.equal((await admin('/chat/reports/' + reportId, undefined, false)).status, 403);
  assert.equal((await admin('/chat/reports/' + reportId)).body.message.text, 'report evidence');
  const until = Date.now() + 60000;
  assert.equal((await admin('/chat/reports/review', { reportId, action: 'mute', until, reason: 'operator reviewed' })).status, 200);
  const denied = await alice.request({ type: 'chat_send', scope: 'room', text: 'muted message', requestId: crypto.randomUUID() }, 'error');
  assert.equal(denied.code, 'chat_muted');
  assert.equal((await admin('/chat/reports/' + reportId)).body.status, 'mute');
  assert.ok((await admin('/audit?limit=200')).body.audit.some(event => event.target === reportId && /report/.test(event.action)));
  await env.restart();
  const restored = await admin('/chat/reports/' + reportId);
  assert.equal(restored.body.status, 'mute'); assert.equal(restored.body.message.text, 'report evidence');
});
