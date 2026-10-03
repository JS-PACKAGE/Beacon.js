import test from 'node:test';
import assert from 'node:assert/strict';
import { environment } from './helpers.mjs';
import { BeaconClient } from '../dist/client/index.js';

test('SDK replays mutation outcome without resurrecting deleted room state', async t => {
  const env = await environment(t);
  const client = new BeaconClient({ url: `ws://127.0.0.1:${env.service.address().port}`, allowInsecure: true, reconnect: false, token: () => 'dev-alice' });
  t.after(() => client.disconnect());
  await client.connect(); await client.selectGame('g-001');
  const input = { type: 'create_room', name: 'Old outcome' };
  const first = await client.request(input, { requestId: 'sdk-create' });
  const id = first.messages.find(value => value.type === 'room_joined').room.id;
  await client.deleteRoom();
  assert.equal(client.state.room, null);
  const repeated = await client.request(input, { requestId: 'sdk-create' });
  assert.equal(repeated.messages.find(value => value.type === 'room_joined').room.id, id);
  assert.equal(client.state.room, null);
  const listing = await client.listRooms();
  assert.equal(listing.messages.find(value => value.type === 'lobby_state').total, 0);
});
test('replaying an earlier leave does not clear a newly joined room', async t => {
  const env = await environment(t);
  const client = new BeaconClient({ url: `ws://127.0.0.1:${env.service.address().port}`, allowInsecure: true, reconnect: false, token: () => 'dev-alice' });
  t.after(() => client.disconnect());
  await client.connect(); await client.selectGame('g-001');
  await client.createRoom({ name: 'Earlier' });
  await client.request({ type: 'leave_room' }, { requestId: 'sdk-leave' });
  const next = await client.createRoom({ name: 'Current' });
  const id = next.messages.find(value => value.type === 'room_joined').room.id;
  await client.request({ type: 'leave_room' }, { requestId: 'sdk-leave' });
  assert.equal(client.state.room.room?.id ?? client.state.room.roomId, id);
});
test('single oversized game entry survives minimum-size transport without truncation', async t => {
  const labels = Array.from({ length: 32 }, (_, index) => `${index}-` + '\\'.repeat(60));
  const game = { gameId: 'large', name: 'Complete metadata', maxPlayersPerRoom: 4, enabled: true, source: 'config', versions: labels, modes: labels, regions: labels };
  const env = await environment(t, { limits: { outboundBytes: 2048 } }, { games: { async list() { return [game]; } } });
  const client = new BeaconClient({ url: `ws://127.0.0.1:${env.service.address().port}`, allowInsecure: true, reconnect: false, token: () => 'dev-alice' });
  t.after(() => client.disconnect());
  await client.connect();
  const result = await client.request({ type: 'list_games' });
  const listed = result.messages.find(message => message.type === 'games');
  assert.deepEqual(listed.games[0].versions, labels);
  assert.deepEqual(listed.games[0].modes, labels);
  assert.deepEqual(listed.games[0].regions, labels);
});
test('resuming into a running match admits the player exactly once', async t => {
  let admissions = 0;
  const sessions = {
    async create(input) { return { matchId: 'm1', serverUrl: 'wss://game.test/play', expiresAt: Date.now() + 60000, tickets: Object.fromEntries(input.players.map(player => [player.id, `t-${player.id}`])) }; },
    async admit(_match, playerId) { admissions++; return { serverUrl: 'wss://game.test/play', ticket: `a${admissions}-${playerId}`, expiresAt: Date.now() + 60000 }; },
    async status() { return 'in_game'; },
    async cancel() {},
  };
  const env = await environment(t, { lobby: { reconnectGraceMs: 5000 }, limits: { maintenanceIntervalMs: 50 } }, { sessions });
  const connect = async (token) => { const c = new BeaconClient({ url: `ws://127.0.0.1:${env.service.address().port}`, allowInsecure: true, reconnect: false, token: () => token }); t.after(() => c.disconnect()); const log = []; c.on('message', m => log.push(m)); await c.connect(); return { c, log }; };
  const alice = await connect('dev-alice');
  await alice.c.selectGame('g-001');
  await alice.c.createRoom({ name: 'Resume', maxPlayers: 1 });
  await alice.c.setReady(true);
  await alice.c.startGame();
  for (let i = 0; i < 100 && !(await alice.c.syncState()).messages.some(m => m.type === 'room_state' && m.room?.state === 'in_game'); i++) await new Promise(r => setTimeout(r, 30));
  alice.c.disconnect();
  const before = admissions;
  const resumed = await connect('dev-alice');
  await new Promise(r => setTimeout(r, 100));
  assert.equal(admissions - before, 1);
  assert.equal(resumed.log.filter(m => m.type === 'game_admission').length, 1);
});
