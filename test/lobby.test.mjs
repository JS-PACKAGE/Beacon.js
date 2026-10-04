import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { SqliteRoomStore } from '../dist/store/index.js';
import { environment, select } from './helpers.mjs';

async function create(client, options = {}) {
  return (await client.request({ type: 'create_room', name: '貓咪房間', ...options }, 'room_joined')).room;
}

test('game scope, password protection, atomic concurrent capacity, host transfer and deletion', async t => {
  const env = await environment(t);
  const alice = await env.connect();
  const bob = await env.connect('dev-bob');
  const carol = await env.connect('dev-carol');
  assert.equal((await alice.request({ type: 'list_rooms' }, 'error')).code, 'not_in_lobby');
  await select(alice); await select(bob); await select(carol, 'g-002');
  const room = await create(alice, { password: 'secret-room', maxPlayers: 2 });
  const listed = await bob.request({ type: 'list_rooms' }, 'lobby_state');
  assert.equal(listed.rooms[0].hasPassword, true);
  assert.equal(JSON.stringify(listed).includes('secret-room'), false);
  assert.equal((await carol.request({ type: 'list_rooms' }, 'lobby_state')).total, 0);
  assert.equal((await carol.request({ type: 'join_room', roomId: room.id, password: 'secret-room' }, 'error')).code, 'wrong_game');
  assert.equal((await bob.request({ type: 'join_room', roomId: room.id }, 'error')).code, 'room_password_required');
  assert.equal((await bob.request({ type: 'join_room', roomId: room.id, password: 'wrong' }, 'error')).code, 'room_password_incorrect');
  await carol.request({ type: 'switch_game', gameId: 'g-001' }, 'lobby_state');
  const starts = [bob.messages.length, carol.messages.length];
  bob.ws.send(JSON.stringify({ type: 'join_room', roomId: room.id, password: 'secret-room' }));
  carol.ws.send(JSON.stringify({ type: 'join_room', roomId: room.id, password: 'secret-room' }));
  const results = await Promise.all([bob, carol].map((client, i) => client.wait(message => message.type === 'room_joined' || message.type === 'error', starts[i])));
  assert.deepEqual(results.map(result => result.type).sort(), ['error', 'room_joined']);
  assert.equal(results.find(result => result.type === 'error').code, 'room_full');
  assert.equal(results.find(result => result.type === 'room_joined').room.playerCount, 2);
  const winner = results[0].type === 'room_joined' ? bob : carol;
  assert.equal((await winner.request({ type: 'delete_room' }, 'error')).code, 'host_only');
  const transferStart = winner.messages.length;
  await alice.request({ type: 'leave_room' }, 'lobby_state');
  const state = await winner.wait(message => message.type === 'room_state', transferStart);
  assert.equal(state.members[0].isHost, true);
  await alice.request({ type: 'join_room', roomId: room.id, password: 'secret-room' }, 'room_joined');
  assert.equal((await alice.request({ type: 'delete_room' }, 'error')).code, 'host_only');
  const closedStart = alice.messages.length;
  await winner.request({ type: 'delete_room' }, 'room_closed');
  assert.equal((await alice.wait(message => message.type === 'room_closed', closedStart)).reason, 'deleted');
  assert.equal((await alice.request({ type: 'list_rooms' }, 'lobby_state')).total, 0);
});

test('restart retains rooms but not occupancy; first join changes durable host; delete never resurrects', async t => {
  const env = await environment(t);
  let alice = await env.connect(); await select(alice);
  const room = await create(alice, { maxPlayers: 3 });
  await env.restart();
  const bob = await env.connect('dev-bob');
  const initial = await select(bob);
  assert.equal(initial.rooms[0].id, room.id);
  assert.equal(initial.rooms[0].playerCount, 0);
  const joined = await bob.request({ type: 'join_room', roomId: room.id }, 'room_joined');
  assert.equal(joined.members[0].isHost, true);
  alice = await env.connect(); await select(alice);
  await alice.request({ type: 'join_room', roomId: room.id }, 'room_joined');
  assert.equal((await alice.request({ type: 'delete_room' }, 'error')).code, 'host_only');
  await bob.request({ type: 'delete_room' }, 'room_closed');
  await env.restart();
  const carol = await env.connect('dev-carol');
  assert.equal((await select(carol)).total, 0);
});

test('latest authenticated connection replaces transport and preserves its logical room seat', async t => {
  const env = await environment(t, { lobby: { reconnectGraceMs: 30000 } });
  const old = await env.connect(); await select(old);
  const room = await create(old, { maxPlayers: 1 });
  const start = old.messages.length;
  const latest = await env.connect();
  assert.equal((await old.wait(message => message.type === 'error', start)).code, 'session_replaced');
  const resumed = await latest.wait(message => message.type === 'session_state');
  assert.equal(resumed.room.id, room.id);
  assert.equal(resumed.members[0].isHost, true);
  assert.equal(resumed.room.playerCount, 1);
  assert.equal((await latest.request({ type: 'join_room', roomId: room.id }, 'error')).code, 'already_in_room');
});

test('empty TTL applies after leave and restart; occupied rooms survive; removal pushes', async t => {
  const env = await environment(t, { room: { emptyTtlSec: 1 }, limits: { maintenanceIntervalMs: 20 } });
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  const room = await create(alice);
  await new Promise(resolve => setTimeout(resolve, 1100));
  assert.equal((await bob.request({ type: 'list_rooms' }, 'lobby_state')).rooms[0].id, room.id);
  const start = bob.messages.length;
  await alice.request({ type: 'leave_room' }, 'lobby_state');
  await bob.wait(message => message.type === 'lobby_update' && message.change === 'remove', start);
  assert.equal((await bob.request({ type: 'list_rooms' }, 'lobby_state')).total, 0);
  await create(alice);
  await env.restart();
  const carol = await env.connect('dev-carol');
  assert.equal((await select(carol)).total, 1);
  await carol.wait(message => message.type === 'lobby_update' && message.change === 'remove');
  assert.equal((await carol.request({ type: 'list_rooms' }, 'lobby_state')).total, 0);
});

test('switch_game leaves current room and updates count for same-game lobby observers', async t => {
  const env = await environment(t);
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  const room = await create(alice);
  const start = bob.messages.length;
  const next = await alice.request({ type: 'switch_game', gameId: 'g-002' }, 'lobby_state');
  assert.equal(next.game.gameId, 'g-002');
  const update = await bob.wait(message => message.type === 'lobby_update' && message.change === 'update' && message.room.id === room.id, start);
  assert.equal(update.room.playerCount, 0);
});

test('write failures return storage_error without changing creation, deletion, or host membership', async t => {
  let actual;
  let failing = false;
  const wrapper = {
    load() { return actual.load(); },
    insert(room) { if (failing) throw new Error('disk failure'); actual.insert(room); },
    setHost(...args) { if (failing) throw new Error('disk failure'); actual.setHost(...args); },
    delete(id) { if (failing) throw new Error('disk failure'); actual.delete(id); },
    update(room) { if (failing) throw new Error('disk failure'); actual.update(room); },
    listModeration() { return actual.listModeration(); },
    saveModeration(record) { actual.saveModeration(record); },
    listSocial() { return actual.listSocial(); },
    saveSocial(link) { actual.saveSocial(link); },
    deleteSocial(...args) { actual.deleteSocial(...args); },
    audit(event) { actual.audit(event); },
    listAudit(limit) { return actual.listAudit(limit); },
    listParties() { return actual.listParties(); },
    saveParty(party) { actual.saveParty(party); },
    deleteParty(id) { actual.deleteParty(id); },
    listInvitations() { return actual.listInvitations(); },
    saveInvitation(invitation) { actual.saveInvitation(invitation); },
    deleteInvitation(token) { actual.deleteInvitation(token); },
    listBlocks() { return actual.listBlocks(); },
    saveBlock(block) { actual.saveBlock(block); },
    deleteBlock(playerId, targetId) { actual.deleteBlock(playerId, targetId); },
    close() { actual.close(); },
  };
  // The injected store is created lazily at load so environment owns its temporary directory.
  const originalLoad = wrapper.load;
  wrapper.load = function () { if (!actual) actual = new SqliteRoomStore(path); return originalLoad(); };
  let path;
  // Use a separate temporary path supplied by an isolated configuration-free store.
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const dir = await mkdtemp(join(tmpdir(), 'beacon-failure-'));
  path = join(dir, 'rooms.db');
  t.after(() => rm(dir, { recursive: true, force: true }));
  const env = await environment(t, {}, { store: wrapper });
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  failing = true;
  assert.equal((await alice.request({ type: 'create_room', name: 'Must not exist' }, 'error')).code, 'storage_error');
  assert.equal((await bob.request({ type: 'list_rooms' }, 'lobby_state')).total, 0);
  assert.equal(actual.load().length, 0);
  failing = false;
  const room = await create(alice);
  await bob.request({ type: 'join_room', roomId: room.id }, 'room_joined');
  failing = true;
  assert.equal((await alice.request({ type: 'leave_room' }, 'error')).code, 'storage_error');
  assert.equal((await alice.request({ type: 'delete_room' }, 'error')).code, 'storage_error');
  const state = await bob.request({ type: 'list_rooms' }, 'lobby_state');
  assert.equal(state.rooms[0].playerCount, 2);
  assert.equal(actual.load()[0].hostId, 'alice');
  failing = false;
  await alice.request({ type: 'delete_room' }, 'room_closed');
  assert.deepEqual(actual.load(), []);
});

test('disconnect during scrypt releases reservation; no ghost member or retained seat', async t => {
  const env = await environment(t);
  const alice = await env.connect(); const bob = await env.connect('dev-bob'); const carol = await env.connect('dev-carol');
  await select(alice); await select(bob); await select(carol);
  const room = await create(alice, { password: 'reserve-test', maxPlayers: 2 });
  bob.ws.send(JSON.stringify({ type: 'join_room', roomId: room.id, password: 'reserve-test' }));
  await bob.close();
  // Connection closure confirms cancellation; retry only if the close handshake raced the reservation release.
  const joined = await carol.request({ type: 'join_room', roomId: room.id, password: 'reserve-test' }, 'room_joined');
  assert.deepEqual(joined.members.map(member => member.id).sort(), ['alice', 'carol']);
});

test('room pagination is bounded by bytes and page size with no omissions or password leakage', async t => {
  const env = await environment(t, { lobby: { maxRoomsPerPlayer: 25 }, limits: { outboundBytes: 2048, defaultPageSize: 20, maxPageSize: 200 } });
  const alice = await env.connect(); await select(alice);
  const ids = [];
  for (let i = 0; i < 25; i++) { ids.push((await create(alice, { name: `${i}-` + '貓'.repeat(29) })).id); await alice.request({ type: 'leave_room' }, 'lobby_state'); }
  let page = 1;
  const received = [];
  while (page) {
    const state = await alice.request({ type: 'list_rooms', page, pageSize: 20 }, 'lobby_state');
    assert.equal(state.total, 25);
    assert.ok(Buffer.byteLength(JSON.stringify(state)) <= 2048);
    assert.ok(state.rooms.length <= 20);
    received.push(...state.rooms.map(room => room.id));
    page = state.nextPage;
  }
  assert.deepEqual(received, ids);
});

test('password failures are bounded per verified player and never consume room capacity', async t => {
  const env = await environment(t, { limits: { passwordFailures: 2 } });
  const alice = await env.connect(); const bob = await env.connect('dev-bob');
  await select(alice); await select(bob);
  const room = await create(alice, { password: 'correct', maxPlayers: 2 });
  for (let i = 0; i < 2; i++) assert.equal((await bob.request({ type: 'join_room', roomId: room.id, password: 'wrong' }, 'error')).code, 'room_password_incorrect');
  assert.equal((await bob.request({ type: 'join_room', roomId: room.id, password: 'correct' }, 'error')).code, 'rate_limited');
  const carol = await env.connect('dev-carol'); await select(carol);
  assert.equal((await carol.request({ type: 'join_room', roomId: room.id, password: 'correct' }, 'room_joined')).room.playerCount, 2);
});

test('large member snapshots split into bounded frames and reassemble without omissions', async t => {
  const mockPlayers = Array.from({ length: 24 }, (_, i) => ({ token: `local-${i}`, id: `player-${i}`, displayName: `${i}-` + 'x'.repeat(120) }));
  const env = await environment(t, {
    auth: { mockPlayers },
    games: { fallback: [{ gameId: 'g-001', name: 'Large game', maxPlayersPerRoom: 1000, enabled: true }] },
    limits: { outboundBytes: 2048 },
  });
  const host = await env.connect('local-0'); await select(host);
  const room = await create(host);
  let last;
  let lastStart;
  for (let i = 1; i < mockPlayers.length; i++) {
    last = await env.connect(`local-${i}`); await select(last);
    lastStart = last.messages.length;
    await last.request({ type: 'join_room', roomId: room.id }, 'room_joined');
  }
  const first = await last.wait(message => message.type === 'room_joined', lastStart);
  assert.ok(first.chunkCount > 1);
  await last.wait(message => message.type === 'room_joined' && message.chunkIndex === first.chunkCount - 1, lastStart);
  const frames = last.messages.slice(lastStart).filter(message => message.type === 'room_joined');
  assert.equal(frames.length, first.chunkCount);
  const members = frames.flatMap(frame => frame.members);
  assert.deepEqual(members.map(member => member.id).sort(), mockPlayers.map(player => player.id).sort());
  assert.equal(members.filter(member => member.isHost).map(member => member.id).join(), 'player-0');
  for (const frame of frames) {
    assert.equal(frame.room.playerCount, 24);
    assert.ok(Buffer.byteLength(JSON.stringify(frame)) <= 2048);
  }
  const state = await host.wait(message => message.type === 'room_state' && message.playerCount === 24);
  await host.wait(message => message.type === 'room_state' && message.playerCount === 24 && message.chunkIndex === state.chunkCount - 1);
  const stateFrames = host.messages.filter(message => message.type === 'room_state' && message.playerCount === 24);
  assert.deepEqual(stateFrames.flatMap(frame => frame.members).map(member => member.id).sort(), mockPlayers.map(player => player.id).sort());
});
