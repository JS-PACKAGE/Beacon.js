import test from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { BeaconClient, BeaconError } from '../dist/client/index.js';
import { createServer } from 'node:http';
import { WebSocketServer } from 'ws';

const game = { gameId: 'game', name: 'Game', maxPlayersPerRoom: 8, enabled: true, source: 'config' };
const roomFixture = input => ({ id: 'room', gameId: 'game', name: 'Room', ownerId: 'owner', hostId: 'owner', playerCount: 1, spectatorCount: 0, maxPlayers: 8, maxSpectators: 0, hasPassword: false, state: 'open', visibility: 'public', locked: false, version: '', mode: '', region: '', joinPolicy: 'closed', revision: 0, createdAt: 1, ...input });
const memberFixture = input => ({ id: 'member', displayName: 'Member', isHost: false, ready: false, role: 'player', connected: true, ...input });
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
  packet(input) {
    let message = input;
    if (message.type === 'auth_ok') message = { ...message, player: { displayName: 'Player', ...message.player } };
    if (message.type === 'session_state') message = { ready: false, role: 'player', ...message };
    if (message.type === 'lobby_state') message = { game, total: message.rooms.length, ...message, rooms: message.rooms.map(roomFixture) };
    if (message.type === 'room_state') message = { playerCount: message.members.length, change: 'sync', room: roomFixture({ id: message.roomId, revision: message.revision }), ...message };
    if (message.room) message = { ...message, room: roomFixture(message.room) };
    if (message.members && ['session_state', 'room_joined', 'room_state'].includes(message.type)) message = { ...message, members: message.members.map(memberFixture) };
    this.emit('message', { data: JSON.stringify(message) });
  }
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
  assert.equal(auth.protocolVersion, 3);
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
    ['list_friends', 'friends', 'friends'],
    ['list_games', 'games', 'games'],
    ['party_create', 'party_state', 'partyMembers']
  ]) {
    const pending = client.request({ type: command });
    const requestId = socket.sent.at(-1).requestId;
    const metadata = { type, requestId, revision: 0, snapshotId: `${field}-snapshot`, chunkCount: 2 };
    function packet(index) {
      const id = `${field}-${index}`;
      const values = field === 'friends' ? [{ playerId: id, status: 'accepted', requestedBy: 'leader', online: true }] : field === 'games' ? [{ ...game, gameId: id }] : [{ playerId: id, online: true }];
      return field === 'partyMembers'
        ? { ...metadata, chunkIndex: index, party: { id: 'party', leaderId: 'leader', members: values } }
        : { ...metadata, chunkIndex: index, [field]: values };
    }
    socket.packet(packet(1));
    socket.packet(packet(0));
    socket.packet({ type: 'result', requestId, ok: true });
    const result = (await pending).messages[0];
    const values = field === 'partyMembers' ? result.party.members : result[field];
    assert.deepEqual(values.map(value => value.playerId ?? value.gameId), [`${field}-0`, `${field}-1`]);
    assert.equal(result.chunkCount, undefined);
    if (field === 'partyMembers') assert.equal(result.party.leaderId, 'leader');
  }
});

test('AbortSignal removes retained requests and listeners without canceling committed state pushes', async t => {
  const { client, socket } = await fixture(t, { maxPending: 1 });
  const controller = new AbortController();
  let added = 0, removed = 0;
  const add = controller.signal.addEventListener.bind(controller.signal);
  const remove = controller.signal.removeEventListener.bind(controller.signal);
  controller.signal.addEventListener = (...args) => { added++; add(...args); };
  controller.signal.removeEventListener = (...args) => { removed++; remove(...args); };
  const pending = client.partyCreate({ signal: controller.signal, retryOnReconnect: true });
  const requestId = socket.sent.at(-1).requestId;
  controller.abort();
  await assert.rejects(pending, error => error.code === 'aborted');
  assert.equal(added, removed);
  socket.packet({ type: 'party_state', party: { id: 'party', leaderId: 'player', members: [{ playerId: 'player', online: true }] } });
  socket.packet({ type: 'result', requestId, ok: true });
  assert.equal(client.state.party.id, 'party');
  const next = client.ping(); const id = socket.sent.at(-1).requestId;
  socket.packet({ type: 'pong', requestId: id }); socket.packet({ type: 'result', requestId: id, ok: true });
  assert.equal((await next).get('pong').type, 'pong');
  const count = socket.sent.length;
  await assert.rejects(client.ping({ signal: controller.signal }), error => error.code === 'aborted');
  assert.equal(socket.sent.length, count);
});

test('social, proposal and durable result pushes normalize state and acknowledgement removes results', async t => {
  const { client, socket } = await fixture(t);
  socket.packet({ type: 'friends', friends: [{ playerId: 'friend', status: 'accepted', requestedBy: 'player', online: false }] });
  socket.packet({ type: 'friend_presence', playerId: 'friend', online: true, gameId: 'game' });
  assert.equal(client.state.friends.friend.gameId, 'game');
  socket.packet({ type: 'blocks', playerIds: ['blocked'] });
  socket.packet({ type: 'invitations', invitations: [{ invitationToken: 'invite', target: 'player', sender: 'sender', status: 'pending', createdAt: 1, expiresAt: 100 }] });
  assert.equal(client.state.invitations.invite.target, 'player');
  socket.packet({ type: 'invitation_resolved', invitationToken: 'invite', status: 'declined' });
  assert.deepEqual(client.state.invitations, {});
  socket.packet({ type: 'queue_state', queued: true, queueId: 'queue', expiresAt: 100 });
  socket.packet({ type: 'match_proposal', proposalId: 'proposal', deadline: 100, members: ['player'], accepted: [] });
  assert.equal(client.state.proposal.proposalId, 'proposal');
  socket.packet({ type: 'match_proposal_resolved', proposalId: 'proposal', reason: 'declined' });
  assert.equal(client.state.proposal, null);
  const result = { resultId: 'result', matchId: 'match', playerId: 'player', roomId: 'room', result: { score: 0 }, createdAt: 1 };
  socket.packet({ type: 'match_result', ...result });
  socket.packet({ type: 'match_results', results: [{ ...result, resultId: 'result2' }] });
  assert.deepEqual(Object.keys(client.state.results), ['result', 'result2']);
  socket.packet({ type: 'match_result_acked', resultId: 'result' });
  assert.deepEqual(Object.keys(client.state.results), ['result2']);
});

test('acknowledged result history stays in typed replies without resurrecting the pending inbox', async t => {
  const { client, socket } = await fixture(t);
  const result = { resultId: 'result', matchId: 'match', playerId: 'player', roomId: 'room', result: { score: 1 }, createdAt: 1 };
  socket.packet({ type: 'match_result', ...result });
  socket.packet({ type: 'match_result_acked', resultId: result.resultId });
  assert.deepEqual(client.state.results, {});
  const history = client.listMatchResults();
  const requestId = socket.sent.at(-1).requestId;
  const acknowledged = { ...result, acknowledgedAt: 2 };
  socket.packet({ type: 'match_results', requestId, results: [acknowledged] });
  socket.packet({ type: 'result', requestId, ok: true });
  assert.deepEqual((await history).get('match_results').results, [acknowledged]);
  assert.deepEqual(client.state.results, {});
  socket.packet({ type: 'match_result', ...result });
  assert.equal(client.state.results.result.resultId, 'result');
  socket.packet({ type: 'match_results', results: [acknowledged] });
  assert.deepEqual(client.state.results, {});
  socket.packet({ type: 'match_result', ...acknowledged });
  assert.deepEqual(client.state.results, {});
});

test('unknown and malformed wire shapes never reach typed events', async t => {
  const { client, socket } = await fixture(t);
  const messages = [], errors = [];
  client.on('message', message => messages.push(message)); client.on('error', error => errors.push(error.code));
  socket.emit('message', { data: JSON.stringify({ type: 'friends', friends: [{ playerId: 3 }] }) });
  assert.deepEqual(messages, []); assert.deepEqual(errors, ['invalid_message']);
  assert.equal(client.state.connection, 'disconnected');
});

test('malformed frames close a native WebSocket and reject connection without an invalid close-code exception', async t => {
  const server = createServer();
  const sockets = new WebSocketServer({ server });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  const client = new BeaconClient({ url: `ws://127.0.0.1:${server.address().port}`, token: () => 'fixture', allowInsecure: true, reconnect: false });
  t.after(async () => {
    client.disconnect();
    for (const peer of sockets.clients) peer.terminate();
    await new Promise(resolve => sockets.close(resolve));
    await new Promise(resolve => server.close(resolve));
  });
  const errors = [];
  client.on('error', error => errors.push(error.code));
  sockets.on('connection', peer => peer.send(JSON.stringify({ type: 'unknown_frame' })));
  await assert.rejects(client.connect(), error => error.code === 'disconnected');
  assert.deepEqual(errors, ['invalid_message']);
  assert.equal(client.state.connection, 'disconnected');
});
