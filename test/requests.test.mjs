import test from 'node:test';
import assert from 'node:assert/strict';
import { environment, select } from './helpers.mjs';
import { parseClient } from '../dist/protocol/index.js';

async function command(client, message) {
  const start = client.messages.length;
  client.ws.send(JSON.stringify(message));
  const terminal = await client.wait(value => value.requestId === message.requestId && (value.type === 'result' || value.type === 'error'), start);
  return { terminal, messages: client.messages.slice(start).filter(value => value.requestId === message.requestId) };
}
test('mutations replay without creating twice; conflicts and other players cannot reuse results', async t => {
  const env = await environment(t);
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  const input = { type: 'create_room', name: 'Exactly one', requestId: 'create-1' };
  const first = await command(alice, input);
  const room = first.messages.find(value => value.type === 'room_joined').room;
  const repeat = await command(alice, { requestId: 'create-1', name: 'Exactly one', type: 'create_room' });
  assert.equal(repeat.messages.find(value => value.type === 'room_joined').room.id, room.id);
  assert.equal((await command(alice, { ...input, name: 'Different' })).terminal.code, 'request_conflict');
  const other = await command(bob, input);
  assert.notEqual(other.messages.find(value => value.type === 'room_joined').room.id, room.id);
  await command(alice, { type: 'leave_room', requestId: 'leave-1' });
  const listing = await command(alice, { type: 'list_rooms', requestId: 'list-1' });
  assert.equal(listing.messages.find(value => value.type === 'lobby_state').total, 2);
});
test('successful mutation remains replayable after authenticated transport replacement', async t => {
  const env = await environment(t, { lobby: { reconnectGraceMs: 1000 } });
  const alice = await env.connect(); await select(alice);
  const input = { type: 'create_room', name: 'Reconnect', requestId: 'stable-create' };
  const initial = await command(alice, input);
  const id = initial.messages.find(value => value.type === 'room_joined').room.id;
  await alice.close();
  const replacement = await env.connect();
  const replay = await command(replacement, input);
  assert.equal(replay.messages.find(value => value.type === 'room_joined').room.id, id);
  assert.equal(replay.terminal.ok, true);
});
test('token refresh preserves identity and seat, refuses an identity swap', async t => {
  const auth = { async verify(token) {
    if (token === 'alice-1' || token === 'alice-2') return { id: 'alice', displayName: 'Alice', authAt: Date.now(), expiresAt: Date.now() + 10000 };
    return { id: 'bob', displayName: 'Bob', authAt: Date.now(), expiresAt: Date.now() + 10000 };
  } };
  const env = await environment(t, {}, { auth });
  const alice = await env.connect('alice-1'); await select(alice);
  const created = await command(alice, { type: 'create_room', name: 'Refresh', requestId: 'refresh-room' });
  const id = created.messages.find(value => value.type === 'room_joined').room.id;
  const refreshed = await command(alice, { type: 'refresh_auth', token: 'alice-2', requestId: 'refresh-1' });
  assert.equal(refreshed.messages.find(value => value.type === 'auth_refreshed').player.id, 'alice');
  assert.equal((await command(alice, { type: 'refresh_auth', token: 'bob', requestId: 'refresh-2' })).terminal.code, 'forbidden');
  const state = await command(alice, { type: 'sync_state', requestId: 'refresh-state' });
  const room = state.messages.find(value => value.type === 'room_joined' || value.type === 'room_state');
  assert.equal(room.room?.id ?? room.roomId, id);
});
test('schema enforces protocol negotiation, correlation, queue bounds and strict room controls', () => {
  const invalid = [
    { type: 'auth', token: 'ok', protocolVersion: 1 },
    { type: 'create_room', name: 'x', requestId: '../unsafe' },
    { type: 'queue_join', minPlayers: 3, maxPlayers: 2 },
    { type: 'ready', ready: 'yes' }, { type: 'update_room' },
    { type: 'join_room', roomId: 'room', role: 'admin' },
    { type: 'list_rooms', page: 1, cursor: 'cursor' },
    { type: 'select_game', gameId: 'g-001', version: '貓'.repeat(64) },
  ];
  for (const value of invalid) assert.throws(() => parseClient(JSON.stringify(value), 200));
  assert.equal(parseClient(JSON.stringify({ type: 'update_room', password: '' }), 200).password, '');
});
