import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BeaconClient, BeaconError } from '../dist/client/index.js';

class ControlledSocket {
  static instances = [];
  readyState = 0;
  sent = [];
  listeners = new Map();
  constructor(url) { this.url = url; ControlledSocket.instances.push(this); }
  addEventListener(type, listener) {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push(listener); this.listeners.set(type, listeners);
  }
  emit(type, event = {}) { for (const listener of this.listeners.get(type) ?? []) listener(event); }
  open() { this.readyState = 1; this.emit('open'); }
  send(wire) { this.sent.push(JSON.parse(wire)); }
  packet(message) { this.emit('message', { data: JSON.stringify(message) }); }
  close() { if (this.readyState === 3) return; this.readyState = 3; this.emit('close'); }
}
async function until(predicate) {
  for (let i = 0; i < 200; i++) { if (predicate()) return; await delay(2); }
  throw new Error('Controlled client did not reach expected state');
}
async function authenticate(socket, player = 'player') {
  socket.open();
  await until(() => socket.sent.some(message => message.type === 'auth'));
  const auth = socket.sent.find(message => message.type === 'auth');
  assert.equal(auth.protocolVersion, 2);
  // The real server delivers the post-auth snapshot inside the auth request, before its terminal result.
  socket.packet({ type: 'auth_ok', requestId: auth.requestId, player: { id: player } });
  socket.packet({ type: 'session_state', requestId: auth.requestId, room: null, members: [], revision: 1 });
  socket.packet({ type: 'result', requestId: auth.requestId, ok: true });
}
async function fixture(t, options = {}) {
  const client = new BeaconClient({ url: 'wss://lobby.example', token: () => 'private-token', WebSocket: ControlledSocket, reconnect: false, ...options });
  t.after(() => client.disconnect());
  const connected = client.connect();
  const socket = ControlledSocket.instances.at(-1);
  await authenticate(socket); await connected;
  return { client, socket };
}

test('SDK requires secure transport and explicit development opt-in', () => {
  assert.throws(() => new BeaconClient({ url: 'ws://localhost', token: () => '', WebSocket: ControlledSocket }), error => error.code === 'insecure_url');
  assert.throws(() => new BeaconClient({ url: 'wss://token@lobby.example', token: () => '', WebSocket: ControlledSocket }), error => error.code === 'insecure_url');
  const client = new BeaconClient({ url: 'ws://localhost', allowInsecure: true, token: () => '', WebSocket: ControlledSocket });
  client.disconnect();
});

test('requests correlate concurrent direct outputs and wait for terminal result, not broadcasts', async t => {
  const { client, socket } = await fixture(t);
  let resolved = false;
  const first = client.request({ type: 'list_rooms' }).then(value => { resolved = true; return value; });
  const second = client.ping();
  const a = socket.sent.at(-2), b = socket.sent.at(-1);
  socket.packet({ type: 'lobby_state', rooms: [{ id: 'broadcast' }], revision: 2 });
  socket.packet({ type: 'lobby_state', requestId: a.requestId, rooms: [], revision: 3 });
  await delay(0); assert.equal(resolved, false);
  socket.packet({ type: 'pong', requestId: b.requestId });
  socket.packet({ type: 'result', requestId: b.requestId, ok: true });
  assert.equal((await second).messages[0].type, 'pong');
  socket.packet({ type: 'result', requestId: a.requestId, ok: true });
  const result = await first;
  assert.equal(result.messages.length, 1);
  assert.deepEqual(result.messages[0].rooms, []);
});

test('out-of-order chunk snapshots never expose partial members or mix snapshots; stale state is discarded', async t => {
  const { client, socket } = await fixture(t);
  const observed = [];
  client.on('room_state', message => observed.push(message));
  const packet = (snapshotId, revision, chunkIndex, id) => ({ type: 'room_state', roomId: 'room', room: { id: 'room', revision }, snapshotId, revision, chunkIndex, chunkCount: 2, members: [{ id }] });
  socket.packet(packet('old', 2, 0, 'old-a'));
  socket.packet(packet('new', 3, 1, 'b'));
  assert.equal(observed.length, 0); assert.equal(client.state.room, null);
  socket.packet(packet('new', 3, 0, 'a'));
  assert.deepEqual(client.state.room.members.map(member => member.id), ['a', 'b']);
  assert.equal(observed.length, 1);
  socket.packet(packet('old', 2, 1, 'old-b'));
  socket.packet({ type: 'room_state', roomId: 'room', revision: 1, members: [] });
  assert.equal(observed.length, 1);
  assert.equal(client.state.room.revision, 3);
});

test('typed rejections, deadlines and disconnect free pending capacity without exposing server text', async t => {
  const { client, socket } = await fixture(t, { maxPending: 1, requestTimeoutMs: 100 });
  const denied = client.startGame();
  await assert.rejects(client.ping(), error => error.code === 'pending_limit');
  socket.packet({ type: 'error', requestId: socket.sent.at(-1).requestId, code: 'not_ready', message: 'private-token' });
  await assert.rejects(denied, error => error instanceof BeaconError && error.code === 'not_ready' && !error.message.includes('private-token'));
  const timed = client.request({ type: 'ping' }, { timeoutMs: 10 });
  await assert.rejects(timed, error => error.code === 'timeout');
  const disconnected = client.createRoom({ name: 'room', maxPlayers: 2 });
  socket.close();
  await assert.rejects(disconnected, error => error.code === 'disconnected');
  assert.equal(client.state.connection, 'disconnected');
});

test('reconnect refreshes token, resyncs then retries only explicitly retained exact request IDs', async t => {
  let tokenCalls = 0;
  const { client, socket } = await fixture(t, { reconnect: true, reconnectMinMs: 2, reconnectMaxMs: 2, token: () => `token-${++tokenCalls}` });
  const unsafe = client.createRoom({ name: 'unsafe', maxPlayers: 2 });
  const retained = client.request({ type: 'ready', ready: true }, { retryOnReconnect: true, requestId: 'stable-id' });
  const rejection = assert.rejects(unsafe, error => error.code === 'disconnected');
  const previousCount = ControlledSocket.instances.length;
  socket.close(); await rejection;
  await until(() => ControlledSocket.instances.length > previousCount);
  const replacement = ControlledSocket.instances.at(-1);
  await authenticate(replacement);
  await until(() => replacement.sent.some(message => message.requestId === 'stable-id'));
  assert.equal(tokenCalls, 2);
  assert.equal(replacement.sent[0].token, 'token-2');
  assert.deepEqual(replacement.sent.at(-1), { type: 'ready', ready: true, requestId: 'stable-id' });
  assert.equal(replacement.sent.some(message => message.type === 'create_room'), false);
  replacement.packet({ type: 'result', requestId: 'stable-id', ok: true });
  await retained;
});

test('refreshAuth obtains a fresh callback token and command errors retain correlation', async t => {
  let generation = 0;
  const { client, socket } = await fixture(t, { token: () => `token-${++generation}` });
  const refresh = client.refreshAuth();
  await until(() => socket.sent.some(message => message.type === 'refresh_auth'));
  const request = socket.sent.at(-1);
  assert.equal(request.token, 'token-2');
  socket.packet({ type: 'result', requestId: request.requestId, ok: false, code: 'token_revoked' });
  await assert.rejects(refresh, error => error.code === 'token_revoked' && error.requestId === request.requestId);
});

test('terminal success cannot resolve an incomplete chunk snapshot', async t => {
  const { client, socket } = await fixture(t);
  const pending = client.syncState();
  const requestId = socket.sent.at(-1).requestId;
  socket.packet({ type: 'session_state', requestId, room: { id: 'room' }, snapshotId: 'partial', revision: 2, chunkCount: 2, chunkIndex: 0, members: [{ id: 'one' }] });
  socket.packet({ type: 'result', requestId, ok: true });
  await assert.rejects(pending, error => error.code === 'incomplete_snapshot');
  assert.equal(client.state.room, null);
});

test('cached replay resyncRequired resolves only after a complete fresh sync', async t => {
  const { client, socket } = await fixture(t, { maxPending: 1 });
  let settled = false;
  const pending = client.request({ type: 'list_rooms' }, { requestId: 'replay' }).then(result => { settled = true; return result; });
  socket.packet({ type: 'result', requestId: 'replay', ok: true, resyncRequired: true });
  const sync = socket.sent.at(-1);
  assert.equal(sync.type, 'sync_state');
  await delay(0); assert.equal(settled, false);
  socket.packet({ type: 'session_state', requestId: sync.requestId, room: null, members: [], revision: 4 });
  socket.packet({ type: 'result', requestId: sync.requestId, ok: true });
  assert.equal((await pending).messages[0].type, 'session_state');
});

test('permanent authentication and replacement closes do not reconnect in a loop', async t => {
  const { client, socket } = await fixture(t, { reconnect: true, reconnectMinMs: 2 });
  const count = ControlledSocket.instances.length;
  socket.readyState = 3; socket.emit('close', { code: 4001 });
  await delay(10);
  assert.equal(ControlledSocket.instances.length, count);
  assert.equal(client.state.connection, 'disconnected');
});

test('an older correlated stable page is returned without overwriting newer live state', async t => {
  const { client, socket } = await fixture(t);
  socket.packet({ type: 'lobby_state', revision: 10, rooms: [{ id: 'live' }] });
  const page = client.listRooms({ cursor: 'older-snapshot' });
  const requestId = socket.sent.at(-1).requestId;
  socket.packet({ type: 'lobby_state', requestId, revision: 5, rooms: [{ id: 'page' }] });
  socket.packet({ type: 'result', requestId, ok: true });
  assert.equal((await page).messages[0].rooms[0].id, 'page');
  assert.equal(client.state.lobby.rooms[0].id, 'live');
});

test('live lobby deltas use lobby revision rather than an unrelated room revision', async t => {
  const { client, socket } = await fixture(t);
  socket.packet({ type: 'lobby_state', lobbyRevision: 20, revision: 20, rooms: [{ id: 'room', revision: 1 }] });
  socket.packet({ type: 'lobby_update', lobbyRevision: 21, change: 'update', room: { id: 'room', revision: 2, locked: true } });
  assert.equal(client.state.lobby.rooms[0].locked, true);
  socket.packet({ type: 'lobby_update', lobbyRevision: 19, change: 'remove', room: { id: 'room', revision: 100 } });
  assert.equal(client.state.lobby.rooms.length, 1);
  socket.packet({ type: 'lobby_update', lobbyRevision: 22, change: 'remove', room: { id: 'room', revision: 3 } });
  assert.deepEqual(client.state.lobby.rooms, []);
});

test('token callback and initial connection are deadline bounded even without a transport response', async t => {
  const client = new BeaconClient({ url: 'wss://lobby.example', token: () => new Promise(() => {}), WebSocket: ControlledSocket, requestTimeoutMs: 10 });
  t.after(() => client.disconnect());
  const connecting = client.connect();
  ControlledSocket.instances.at(-1).open();
  await assert.rejects(connecting, error => error.code === 'timeout');
  assert.equal(client.state.connection, 'disconnected');
});

test('bounded friends, games and nested party collections assemble into their original consumer shape', async t => {
  const { client, socket } = await fixture(t);
  for (const [command, type, field] of [
    ['list_friends', 'friends_state', 'friends'],
    ['list_games', 'games_state', 'games'],
    ['party_create', 'party_state', 'partyMembers']
  ]) {
    const pending = client.request({ type: command });
    const requestId = socket.sent.at(-1).requestId;
    const metadata = { type, requestId, revision: 0, snapshotId: `${field}-snapshot`, chunkCount: 2 };
    function packet(index) {
      const values = [{ id: `${field}-${index}` }];
      return field === 'partyMembers'
        ? { ...metadata, chunkIndex: index, party: { id: 'party', leaderId: 'leader', members: values } }
        : { ...metadata, chunkIndex: index, [field]: values };
    }
    socket.packet(packet(1));
    socket.packet(packet(0));
    socket.packet({ type: 'result', requestId, ok: true });
    const result = (await pending).messages[0];
    const values = field === 'partyMembers' ? result.party.members : result[field];
    assert.deepEqual(values.map(value => value.id), [`${field}-0`, `${field}-1`]);
    assert.equal(result.chunkCount, undefined);
    if (field === 'partyMembers') assert.equal(result.party.leaderId, 'leader');
  }
});
