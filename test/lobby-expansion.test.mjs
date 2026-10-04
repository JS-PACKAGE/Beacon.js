import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';
import { SqliteRoomStore } from '../dist/store/index.js';
import { RoomManager } from '../dist/lobby/index.js';

async function fixture(t, options = {}, providerOptions = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-lobby-state-'));
  const config = await loadConfig('config.yaml', { mockAuth: true, insecureWs: true });
  Object.assign(config.lobby, { reconnectGraceMs: 1000, maxRoomsPerPlayer: 100 }, options.lobby);
  Object.assign(config.limits, options.limits);
  config.room.emptyTtlSec = 0;
  const store = new SqliteRoomStore(join(directory, 'state.db'));
  const calls = { create: [], admit: [], cancel: [], status: [] };
  let state = 'in_game';
  const provider = {
    async create(request) {
      calls.create.push(structuredClone(request));
      if (providerOptions.create) return providerOptions.create(request);
      return { matchId: `match-${request.operationId}`, serverUrl: 'wss://game.example/session', expiresAt: Date.now() + 60000, tickets: Object.fromEntries(request.players.map(player => [player.id, `ticket-${player.id}`])) };
    },
    async admit(matchId, playerId, role) { calls.admit.push({ matchId, playerId, role }); return { serverUrl: 'wss://game.example/session', ticket: `admission-${playerId}`, expiresAt: Date.now() + 60000 }; },
    async status(matchId) { calls.status.push(matchId); return state; },
    async cancel(matchId) { calls.cancel.push(matchId); },
  };
  const games = { async list() { return options.games ?? [{ gameId: 'game', name: 'Game', enabled: true, maxPlayersPerRoom: 8, source: 'config' }]; } };
  let manager = new RoomManager(config, store, games, provider);
  t.after(async () => { await manager.close(); store.close(); await rm(directory, { recursive: true, force: true }); });
  const connect = async (id, fields = {}, selectGame = true) => {
    const peer = { id: randomUUID(), ip: '127.0.0.1', closed: false, messages: [], direct: [], send(message) { this.messages.push(message); }, reply(message) { this.direct.push(message); this.messages.push(message); }, close() { this.closed = true; } };
    manager.connect(peer);
    await manager.authenticate(peer, { id, displayName: id, authAt: Date.now(), issuedAt: Date.now(), ...fields });
    peer.command = async message => { const start = peer.messages.length; await manager.handle(peer, message); return peer.messages.slice(start); };
    if (selectGame) await peer.command({ type: 'select_game', gameId: 'game' });
    return peer;
  };
  return { config, store, calls, connect, get manager() { return manager; }, setState(value) { state = value; }, async restart() { await manager.close(); manager = new RoomManager(config, store, games, provider); }, async flush() { await new Promise(resolve => setImmediate(resolve)); await manager.settle(); } };
}
async function create(peer, fields = {}) { return (await peer.command({ type: 'create_room', name: 'Room', ...fields })).find(message => message.type === 'room_joined').room; }
function code(expected) { return error => error.code === expected; }

test('ready gating, spectator separation, per-recipient handoff, admissions and provider end recovery', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const bob = await f.connect('bob'); const observer = await f.connect('observer');
  const room = await create(alice, { maxPlayers: 2, maxSpectators: 1, joinPolicy: 'spectate' });
  await bob.command({ type: 'join_room', roomId: room.id });
  await assert.rejects(alice.command({ type: 'start_game' }), code('not_ready'));
  await alice.command({ type: 'ready', ready: true }); await bob.command({ type: 'ready', ready: true });
  await alice.command({ type: 'start_game' });
  assert.equal(f.store.load()[0].state, 'in_game');
  assert.equal(f.calls.create.length, 1);
  assert.equal(alice.direct.find(message => message.type === 'game_started').ticket, 'ticket-alice');
  assert.equal(bob.messages.find(message => message.type === 'game_started').ticket, 'ticket-bob');
  assert.equal(JSON.stringify(alice.messages).includes('ticket-bob'), false);
  const messages = await observer.command({ type: 'join_room', roomId: room.id, role: 'spectator' });
  assert.equal(messages.find(message => message.type === 'room_joined').room.spectatorCount, 1);
  assert.equal(messages.find(message => message.type === 'game_admission').ticket, 'admission-observer');
  assert.equal(f.calls.admit[0].role, 'spectator');
  await assert.rejects(observer.command({ type: 'ready', ready: true }), code('forbidden'));
  await assert.rejects(alice.command({ type: 'transfer_host', playerId: 'observer' }), code('forbidden'));
  f.setState('ended'); await f.manager.maintain(); await f.flush();
  assert.equal(f.store.load()[0].state, 'open'); assert.equal(f.store.load()[0].matchId, null);
  const sync = await bob.command({ type: 'sync_state' });
  assert.equal(sync.find(message => message.type === 'session_state').ready, false);
});

test('slow allocation does not block commands; leaving cancels its late successful response', async t => {
  let resolveAllocation; let entered;
  const started = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, {}, { create(request) { entered(request); return new Promise(resolve => { resolveAllocation = resolve; }); } });
  const alice = await f.connect('alice'); const room = await create(alice);
  await alice.command({ type: 'ready', ready: true });
  const pending = alice.command({ type: 'start_game' });
  const rejected = assert.rejects(pending, code('invalid_state'));
  const request = await started;
  assert.equal(f.store.load()[0].matchRequest.operationId, request.operationId);
  assert.equal((await alice.command({ type: 'ping' }))[0].type, 'pong');
  await alice.command({ type: 'leave_room' });
  resolveAllocation({ matchId: 'late-match', serverUrl: 'wss://game.example/session', expiresAt: Date.now() + 60000, tickets: { alice: 'secret-ticket' } });
  await rejected; await f.flush();
  assert.deepEqual(f.calls.cancel, ['late-match']);
  assert.equal(f.store.load().find(value => value.id === room.id).state, 'open');
  assert.equal(alice.messages.some(message => message.type === 'game_started'), false);
});

test('ambiguous allocation failure survives restart and replays the same durable operation', async t => {
  let fail = true;
  const f = await fixture(t, {}, { create(request) { if (fail) throw new Error('lost response'); return { matchId: 'recovered-match', serverUrl: 'wss://game.example/session', expiresAt: Date.now() + 60000, tickets: { alice: 'recovered-ticket' } }; } });
  const alice = await f.connect('alice'); await create(alice); await alice.command({ type: 'ready', ready: true });
  await assert.rejects(alice.command({ type: 'start_game' }), code('game_service_unavailable'));
  const operation = f.store.load()[0].matchRequest;
  assert.equal(f.store.load()[0].state, 'starting');
  await f.restart(); fail = false; await f.manager.maintain(); await f.flush();
  assert.deepEqual(f.calls.create[1], operation);
  assert.equal(f.store.load()[0].matchId, 'recovered-match');
  assert.equal(f.store.load()[0].matchRequest, undefined);
  f.setState('ended'); await f.manager.maintain(); await f.flush();
  assert.equal(f.store.load()[0].state, 'open');
});

test('verified reconnect retains readiness and reserved capacity, then expiry transfers host without ownership', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const bob = await f.connect('bob'); const carol = await f.connect('carol');
  const room = await create(alice, { maxPlayers: 2 }); await bob.command({ type: 'join_room', roomId: room.id }); await alice.command({ type: 'ready', ready: true });
  alice.closed = true; f.manager.disconnect(alice); await f.manager.settle();
  await assert.rejects(carol.command({ type: 'join_room', roomId: room.id }), code('room_full'));
  const reconnect = { id: randomUUID(), ip: '127.0.0.1', closed: false, messages: [], send(message) { this.messages.push(message); }, close() { this.closed = true; } };
  f.manager.connect(reconnect); await f.manager.authenticate(reconnect, { id: 'alice', displayName: 'Alice', authAt: Date.now(), issuedAt: Date.now() });
  await f.manager.handle(reconnect, { type: 'sync_state' });
  const resumed = reconnect.messages.find(message => message.type === 'session_state');
  assert.equal(resumed.ready, true); assert.equal(resumed.room.id, room.id); assert.equal(resumed.members.length, 2);
  reconnect.closed = true; f.manager.disconnect(reconnect); await f.manager.settle(); await f.manager.maintain(Date.now() + 1001);
  assert.equal(f.store.load()[0].hostId, 'bob'); assert.equal(f.store.load()[0].ownerId, 'alice');
  await carol.command({ type: 'join_room', roomId: room.id });
});

test('in-game reconnect obtains a fresh admission and persistent match status is recovered rather than cleared', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const room = await create(alice, { joinPolicy: 'fill' }); await alice.command({ type: 'ready', ready: true }); await alice.command({ type: 'start_game' });
  await f.restart(); await f.manager.maintain(); await f.flush();
  assert.equal(f.store.load()[0].state, 'in_game'); assert.equal(f.calls.status.length, 1);
  const owner = await f.connect('alice', {}, false);
  const latest = await f.connect('alice', {}, false);
  const messages = await latest.command({ type: 'sync_state' });
  assert.equal(messages.find(message => message.type === 'session_state').room.id, room.id);
  assert.equal(messages.find(message => message.type === 'game_admission').ticket, 'admission-alice');
  assert.equal(f.calls.admit.length, 1);
  assert.equal(owner.closed, true);
});

test('target-bound invitations bypass password only for recipient, expire on policy change and owner can recover private rooms', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const bob = await f.connect('bob'); const carol = await f.connect('carol');
  const room = await create(alice, { password: 'private-password', visibility: 'invite', locked: true });
  const invitation = (await alice.command({ type: 'invite_player', playerId: 'bob' })).find(message => message.type === 'room_invitation');
  await assert.rejects(carol.command({ type: 'join_room', roomId: room.id, invitationToken: invitation.invitationToken }), code('forbidden'));
  await bob.command({ type: 'join_room', roomId: room.id, invitationToken: invitation.invitationToken });
  await bob.command({ type: 'leave_room' });
  const next = (await alice.command({ type: 'invite_player', playerId: 'bob' })).find(message => message.type === 'room_invitation');
  await alice.command({ type: 'update_room', locked: false });
  await assert.rejects(bob.command({ type: 'join_room', roomId: room.id, invitationToken: next.invitationToken }), code('invitation_expired'));
  assert.equal((await carol.command({ type: 'list_rooms' }))[0].total, 0);
  await f.restart(); const owner = await f.connect('alice', {}, false);
  const restored = await owner.command({ type: 'sync_state' });
  assert.equal(restored.find(message => message.type === 'session_state').members[0].isHost, true);
});

test('password guessing limit follows player across active replacement and failed writes do not expose phantom changes', async t => {
  const f = await fixture(t, { limits: { passwordFailures: 2 } });
  const alice = await f.connect('alice'); let bob = await f.connect('bob'); const room = await create(alice, { password: 'correct' });
  await assert.rejects(bob.command({ type: 'join_room', roomId: room.id, password: 'wrong' }), code('room_password_incorrect'));
  bob = await f.connect('bob'); await assert.rejects(bob.command({ type: 'join_room', roomId: room.id, password: 'wrong' }), code('room_password_incorrect'));
  bob = await f.connect('bob'); await assert.rejects(bob.command({ type: 'join_room', roomId: room.id, password: 'correct' }), code('rate_limited'));
  const update = f.store.update.bind(f.store); f.store.update = () => { throw new Error('disk unavailable'); };
  const before = alice.messages.length;
  await assert.rejects(alice.command({ type: 'update_room', visibility: 'invite' }), code('storage_error'));
  assert.equal(alice.messages.slice(before).some(message => message.type === 'lobby_update'), false);
  assert.equal(f.store.load()[0].visibility, 'public'); assert.equal(f.manager.stats().storageHealthy, false);
  f.store.update = update; await alice.command({ type: 'ready', ready: true }); assert.equal(f.manager.stats().storageHealthy, true);
});

test('cursor snapshots are stable through room deletion and reject cross-player reuse', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob');
  const ids = [];
  for (const name of ['A', 'B', 'C']) { ids.push((await create(alice, { name })).id); await alice.command({ type: 'leave_room' }); }
  const first = (await bob.command({ type: 'list_rooms', pageSize: 1 }))[0];
  assert.equal(first.rooms[0].id, ids[0]);
  await assert.rejects(alice.command({ type: 'list_rooms', pageSize: 1, cursor: first.nextCursor }), code('bad_request'));
  await f.manager.closeRoomById(ids[1]);
  const second = (await bob.command({ type: 'list_rooms', pageSize: 1, cursor: first.nextCursor }))[0];
  assert.equal(second.snapshotId, first.snapshotId); assert.equal(second.revision, first.revision); assert.equal(second.total, 3); assert.equal(second.rooms[0].id, ids[1]);
  const live = (await bob.command({ type: 'list_rooms', pageSize: 1, page: 2 }))[0]; assert.equal(live.total, 2); assert.equal(live.live, true);
  await f.manager.maintain(Date.now() + f.config.lobby.snapshotTtlMs + 1);
  await assert.rejects(bob.command({ type: 'list_rooms', pageSize: 1, cursor: first.nextCursor }), code('snapshot_expired'));
});

test('friend consent is durable and pending friendship never leaks online presence', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob');
  await alice.command({ type: 'friend_request', playerId: 'bob' });
  const pending = (await bob.command({ type: 'list_friends' }))[0].friends[0]; assert.equal(pending.status, 'pending'); assert.equal(Object.hasOwn(pending, 'online'), false);
  await assert.rejects(alice.command({ type: 'friend_respond', playerId: 'bob', accept: true }), code('forbidden'));
  await bob.command({ type: 'friend_respond', playerId: 'alice', accept: true });
  assert.equal((await alice.command({ type: 'list_friends' }))[0].friends[0].online, true);
  await f.restart(); const restored = await f.connect('alice');
  const accepted = (await restored.command({ type: 'list_friends' }))[0].friends[0]; assert.equal(accepted.status, 'accepted'); assert.equal(accepted.online, false);
  await restored.command({ type: 'friend_remove', playerId: 'bob' }); assert.equal(f.store.listSocial().length, 0);
});

test('FIFO matchmaking never splits a party, persists before membership and cancels the whole group on disconnect', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob'); const carol = await f.connect('carol');
  await alice.command({ type: 'party_create' });
  const invitation = (await alice.command({ type: 'party_invite', playerId: 'bob' })).find(message => message.type === 'party_invitation');
  await bob.command({ type: 'party_accept', invitationToken: invitation.invitationToken });
  await assert.rejects(bob.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 }), code('forbidden'));
  await alice.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 });
  assert.equal(f.manager.stats().queuedPlayers, 2); assert.equal(f.store.load().length, 0);
  const insert = f.store.insert.bind(f.store); f.store.insert = () => { throw new Error('disk unavailable'); };
  await assert.rejects(carol.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 }), code('storage_error'));
  assert.equal(f.manager.stats().queuedPlayers, 3); assert.equal(f.store.load().length, 0);
  f.store.insert = insert; await carol.command({ type: 'queue_leave' }); await carol.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 });
  assert.equal(f.store.load().length, 1); assert.equal(f.manager.stats().queuedPlayers, 0);
  const ids = [alice, bob, carol].map(peer => peer.messages.find(message => message.type === 'match_found').room.id); assert.equal(new Set(ids).size, 1);
  assert.deepEqual(alice.messages.findLast(message => message.type === 'room_state').members.map(member => member.id), ['alice', 'bob', 'carol']);
  for (const peer of [alice, bob, carol]) await peer.command({ type: 'leave_room' });
  await alice.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 }); bob.closed = true; f.manager.disconnect(bob); await f.manager.settle();
  assert.equal(f.manager.stats().queuedPlayers, 0); assert.equal(alice.messages.findLast(message => message.type === 'queue_state').queued, false);
});

test('moderation persists across restart, timestamp revocation fails closed for missing issuance and maintenance blocks admission', async t => {
  const f = await fixture(t); const alice = await f.connect('alice');
  await f.manager.banPlayer('alice', Date.now() + 60000, 'policy'); assert.equal(alice.closed, true);
  await f.restart(); await assert.rejects(f.connect('alice'), code('player_banned'));
  await f.manager.unbanPlayer('alice'); const current = await f.connect('alice', { issuedAt: undefined });
  await f.manager.revokePlayer('alice', Date.now() - 1000); assert.equal(current.closed, true);
  await assert.rejects(f.connect('alice', { issuedAt: undefined }), code('token_revoked'));
  const fresh = await f.connect('alice', { issuedAt: Date.now() + 1000 });
  f.manager.setMaintenance(true); await assert.rejects(create(fresh), code('maintenance')); await assert.rejects(f.connect('bob'), code('maintenance'));
  assert.ok(f.store.listAudit(100).some(event => event.action === 'revoke'));
});

test('large single game metadata and admission tickets fragment within byte budget without loss', async t => {
  const versions = ['', ...Array.from({ length: 31 }, (_, i) => `${i}-` + '貓'.repeat(20))];
  const f = await fixture(t, { limits: { outboundBytes: 2048 }, games: [{ gameId: 'game', name: 'Large metadata', enabled: true, maxPlayersPerRoom: 2000, versions, modes: versions, regions: versions, source: 'config' }] }, {
    create(request) { return { matchId: 'large-ticket-match', serverUrl: 'wss://game.example/session', expiresAt: Date.now() + 60000, tickets: { alice: 'x'.repeat(8192) } }; },
  });
  const alice = await f.connect('alice');
  function assemble(packets, type) {
    const frames = packets.filter(packet => packet.type === 'snapshot_chunk' && packet.snapshotType === type);
    assert.ok(frames.length > 1);
    assert.equal(new Set(frames.map(frame => frame.snapshotId)).size, 1);
    assert.equal(frames.length, frames[0].chunkCount);
    for (const frame of frames) assert.ok(Buffer.byteLength(JSON.stringify({ ...frame, requestId: 'r'.repeat(128) })) <= 2048);
    return JSON.parse(frames.sort((a, b) => a.chunkIndex - b.chunkIndex).map(frame => frame.payload).join(''));
  }
  const games = assemble(await alice.command({ type: 'list_games' }), 'games');
  assert.deepEqual(games.games[0].versions, versions); assert.deepEqual(games.games[0].regions, versions);
  const listing = assemble(await alice.command({ type: 'list_rooms' }), 'lobby_state');
  assert.deepEqual(listing.game.modes, versions);
  const room = await create(alice); assert.equal(room.maxPlayers, 2000);
  await alice.command({ type: 'ready', ready: true });
  const started = assemble(await alice.command({ type: 'start_game' }), 'game_started');
  assert.equal(started.ticket, 'x'.repeat(8192));
});

test('owner room quota survives transport changes and quick join excludes locked and incompatible rooms', async t => {
  const f = await fixture(t, { lobby: { maxRoomsPerPlayer: 1 } });
  const alice = await f.connect('alice'); const bob = await f.connect('bob');
  const room = await create(alice, { locked: true }); await alice.command({ type: 'leave_room' });
  const replacement = await f.connect('alice');
  await assert.rejects(create(replacement), code('rate_limited'));
  await assert.rejects(bob.command({ type: 'quick_join' }), code('room_not_found'));
  await replacement.command({ type: 'join_room', roomId: room.id }); await replacement.command({ type: 'update_room', locked: false });
  await bob.command({ type: 'switch_game', gameId: 'game', version: 'new' });
  await assert.rejects(bob.command({ type: 'quick_join' }), code('room_not_found'));
  await bob.command({ type: 'switch_game', gameId: 'game' });
  const joined = await bob.command({ type: 'quick_join' });
  assert.equal(joined.find(message => message.type === 'room_joined').room.id, room.id);
});

test('expired invitation is unusable even for its intended recipient', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob');
  const room = await create(alice, { visibility: 'invite' });
  const invitation = (await alice.command({ type: 'invite_player', playerId: 'bob' })).find(message => message.type === 'room_invitation');
  await f.manager.maintain(invitation.expiresAt + 1);
  await assert.rejects(bob.command({ type: 'join_room', roomId: room.id, invitationToken: invitation.invitationToken }), code('invitation_expired'));
});

test('owner can delete an empty room they left and then create again', async t => {
  const f = await fixture(t, { lobby: { maxRoomsPerPlayer: 1 } });
  const alice = await f.connect('alice'); const bob = await f.connect('bob');
  const room = await create(alice); await alice.command({ type: 'leave_room' });
  await assert.rejects(create(alice), code('rate_limited'));
  const owned = (await alice.command({ type: 'list_owned_rooms' }))[0];
  assert.equal(owned.rooms[0].id, room.id);
  await assert.rejects(bob.command({ type: 'delete_room', roomId: room.id }), code('forbidden'));
  await bob.command({ type: 'join_room', roomId: room.id });
  await assert.rejects(alice.command({ type: 'delete_room', roomId: room.id }), code('invalid_state'));
  await bob.command({ type: 'leave_room' });
  const closed = await alice.command({ type: 'delete_room', roomId: room.id });
  assert.equal(closed.find(message => message.type === 'room_closed').reason, 'deleted');
  assert.equal((await create(alice)).id === room.id, false);
});

test('room rules reach the match request and a player result stays private', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const bob = await f.connect('bob');
  const room = await create(alice, { rules: { map: 'harbor', ranked: false } });
  assert.equal(room.rules.map, 'harbor');
  await bob.command({ type: 'join_room', roomId: room.id });
  await alice.command({ type: 'ready', ready: true }); await bob.command({ type: 'ready', ready: true });
  await alice.command({ type: 'start_game' });
  assert.deepEqual(f.calls.create[0].rules, { map: 'harbor', ranked: false });
  const matchId = f.store.load()[0].matchId;
  await f.manager.reportPlayerResult(matchId, 'alice', { score: 3 });
  assert.equal(alice.messages.find(message => message.type === 'match_result').result.score, 3);
  assert.equal(bob.messages.some(message => message.type === 'match_result'), false);
  await f.manager.reportMatch(matchId, 'ended');
  assert.equal(f.store.load()[0].state, 'open');
  await f.manager.reportMatch(matchId, 'ended');
});

test('blocks stop invites, friend requests and matchmaking pairs; seats and parties survive restart', async t => {
  const f = await fixture(t);
  const alice = await f.connect('alice'); const bob = await f.connect('bob'); const carol = await f.connect('carol');
  await alice.command({ type: 'block_player', playerId: 'bob' });
  await assert.rejects(bob.command({ type: 'friend_request', playerId: 'alice' }), code('forbidden'));
  await assert.rejects(alice.command({ type: 'friend_request', playerId: 'bob' }), code('forbidden'));
  const room = await create(alice);
  await assert.rejects(alice.command({ type: 'invite_player', playerId: 'bob' }), code('forbidden'));
  await alice.command({ type: 'party_create' });
  await assert.rejects(alice.command({ type: 'party_invite', playerId: 'bob' }), code('forbidden'));
  await alice.command({ type: 'party_leave' });
  await alice.command({ type: 'leave_room' });
  await alice.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2 });
  await bob.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2 });
  assert.equal(f.manager.stats().queuedPlayers, 2);
  assert.equal(f.store.load().some(item => item.name === 'Matchmaking'), false);
  await alice.command({ type: 'queue_leave' }); await bob.command({ type: 'queue_leave' });
  await f.restart();
  assert.equal(f.store.listParties().length, 0);
  assert.equal(f.store.listBlocks().length, 1);
  const restored = await f.connect('alice', {}, false);
  assert.equal(restored.roomId, undefined);
  assert.deepEqual((await restored.command({ type: 'list_blocks' }))[0].playerIds, ['bob']);
  await restored.command({ type: 'unblock_player', playerId: 'bob' });
  await restored.command({ type: 'party_create' });
  await f.restart();
  const again = await f.connect('alice', {}, false);
  const party = await again.command({ type: 'sync_state' });
  assert.equal(party.find(message => message.type === 'party_state').party.leaderId, 'alice');
  void room;
});
