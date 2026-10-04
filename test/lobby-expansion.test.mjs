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
  Object.assign(config.matching, options.matching);
  Object.assign(config.games, options.gameConfig);
  Object.assign(config.chat, options.chat);
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
    async admit(matchId, playerId, role) { calls.admit.push({ matchId, playerId, role }); if (providerOptions.admit) return providerOptions.admit(matchId, playerId, role); return { serverUrl: 'wss://game.example/session', ticket: `admission-${playerId}`, expiresAt: Date.now() + 60000 }; },
    async status(matchId) { calls.status.push(matchId); return state; },
    async cancel(matchId) { calls.cancel.push(matchId); },
  };
  const games = { async list() { return options.games ?? [{ gameId: 'game', name: 'Game', enabled: true, maxPlayersPerRoom: 8, source: 'config' }]; }, ...(options.profiles ? { profiles: options.profiles } : {}) };
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
  await carol.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 });
  const proposal = alice.messages.findLast(message => message.type === 'match_proposal');
  assert.equal(f.store.load().length, 0);
  await alice.command({ type: 'match_accept', proposalId: proposal.proposalId }); await bob.command({ type: 'match_accept', proposalId: proposal.proposalId });
  const insert = f.store.insert.bind(f.store); f.store.insert = () => { throw new Error('disk unavailable'); };
  await assert.rejects(carol.command({ type: 'match_accept', proposalId: proposal.proposalId }), code('storage_error'));
  assert.equal(f.store.load().length, 0); assert.equal(alice.messages.some(message => message.type === 'match_found'), false);
  f.store.insert = insert; await carol.command({ type: 'match_accept', proposalId: proposal.proposalId });
  assert.equal(f.store.load().length, 1); assert.equal(f.manager.stats().queuedPlayers, 0);
  const ids = [alice, bob, carol].map(peer => peer.messages.find(message => message.type === 'match_found').room.id); assert.equal(new Set(ids).size, 1);
  assert.deepEqual(new Set(alice.messages.findLast(message => message.type === 'room_state').members.map(member => member.id)), new Set(['alice', 'bob', 'carol']));
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
  assert.equal(f.store.load().length, 1);
  assert.equal(alice.messages.some(item => item.type === 'match_proposal'), false);
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

test('blocking closes pending social acceptance and invitation inbox survives restart with terminal privacy', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob');
  await alice.command({ type: 'friend_request', playerId: 'bob' }); await alice.command({ type: 'party_create' });
  const invitation = (await alice.command({ type: 'party_invite', playerId: 'bob' })).find(item => item.type === 'party_invitation');
  await f.restart(); const a = await f.connect('alice'); const b = await f.connect('bob');
  assert.equal((await b.command({ type: 'list_invitations' }))[0].invitations[0].invitationToken, invitation.invitationToken);
  await a.command({ type: 'block_player', playerId: 'bob' });
  await assert.rejects(b.command({ type: 'friend_respond', playerId: 'alice', accept: true }), code('forbidden'));
  await assert.rejects(b.command({ type: 'party_accept', invitationToken: invitation.invitationToken }), code('invitation_expired'));
  assert.equal(f.store.listInvitations()[0].status, 'revoked');
  assert.equal((await b.command({ type: 'list_invitations', direction: 'outgoing' }))[0].invitations.length, 0);
});

test('private results remain immutable after room deletion and restart; ACK survives reconnect', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); await create(alice);
  await alice.command({ type: 'ready', ready: true }); await alice.command({ type: 'start_game' });
  const matchId = alice.messages.findLast(item => item.type === 'game_started').matchId;
  await f.manager.reportMatch(matchId, 'ended'); await alice.command({ type: 'delete_room' }); await f.restart();
  await f.manager.reportMatch(matchId, 'ended'); await f.manager.reportPlayerResult(matchId, 'alice', { won: true });
  await f.manager.reportPlayerResult(matchId, 'alice', { won: true });
  await assert.rejects(f.manager.reportPlayerResult(matchId, 'alice', { won: false }), code('request_conflict'));
  const restored = await f.connect('alice'); const inbox = (await restored.command({ type: 'list_match_results' }))[0];
  assert.equal(inbox.results.length, 1); const resultId = inbox.results[0].resultId;
  await restored.command({ type: 'sync_state' }); await restored.command({ type: 'sync_state' });
  assert.equal(restored.messages.filter(item => item.type === 'match_result' && item.resultId === resultId).length, 2);
  await restored.command({ type: 'ack_match_result', resultId }); await f.restart();
  const next = await f.connect('alice'); await next.command({ type: 'sync_state' });
  assert.equal(next.messages.some(item => item.type === 'match_result'), false);
});

test('grouped join failure never splits party and chat is private to original recipients', async t => {
  const f = await fixture(t); const alice = await f.connect('alice'); const bob = await f.connect('bob'); const carol = await f.connect('carol');
  const room = await create(carol, { maxPlayers: 3, password: 'secret' });
  await alice.command({ type: 'party_create' }); const invite = (await alice.command({ type: 'party_invite', playerId: 'bob' })).find(item => item.type === 'party_invitation');
  await bob.command({ type: 'party_accept', invitationToken: invite.invitationToken });
  await assert.rejects(alice.command({ type: 'party_join_room', roomId: room.id, password: 'bad' }), code('room_password_incorrect'));
  assert.equal(f.store.load()[0].seats.length, 1);
  await alice.command({ type: 'party_join_room', roomId: room.id, password: 'secret' });
  assert.equal(f.store.load()[0].seats.length, 3);
  const message = (await alice.command({ type: 'chat_send', scope: 'room', text: 'private' })).find(item => item.type === 'chat_message');
  await carol.command({ type: 'chat_mute', scope: 'room', playerId: 'alice', until: Date.now() + 1000 });
  await assert.rejects(alice.command({ type: 'chat_send', scope: 'room', text: 'muted' }), code('chat_muted'));
  await bob.command({ type: 'chat_report', messageId: message.message.id, reason: 'evidence' });
  await bob.command({ type: 'block_player', playerId: 'alice' });
  assert.equal((await bob.command({ type: 'chat_history', scope: 'room' }))[0].messages.length, 0);
  const outsider = await f.connect('outsider'); await outsider.command({ type: 'select_game', gameId: 'game' });
  await assert.rejects(outsider.command({ type: 'chat_history', scope: 'room' }), code('room_not_found'));
});

test('decline drops the entire party; accepted parties requeue at their original age and maintenance rematches without a new join', async t => {
  const f = await fixture(t);
  const [a, b, c, d, e, g] = await Promise.all(['a', 'b', 'c', 'd', 'e', 'g'].map(id => f.connect(id)));
  for (const [leader, member] of [[a, b], [c, d], [e, g]]) {
    await leader.command({ type: 'party_create' });
    const invite = (await leader.command({ type: 'party_invite', playerId: member === b ? 'b' : member === d ? 'd' : 'g' })).find(item => item.type === 'party_invitation');
    await member.command({ type: 'party_accept', invitationToken: invite.invitationToken });
  }
  await a.command({ type: 'queue_join', minPlayers: 4, maxPlayers: 4 });
  const original = f.store.loadDomain().queue[0];
  await c.command({ type: 'queue_join', minPlayers: 4, maxPlayers: 4 });
  const proposal = a.messages.findLast(item => item.type === 'match_proposal');
  await e.command({ type: 'queue_join', minPlayers: 4, maxPlayers: 4 });
  await c.command({ type: 'match_decline', proposalId: proposal.proposalId });
  assert.equal(d.messages.findLast(item => item.type === 'queue_state').queued, false);
  assert.equal(f.store.loadDomain().queue.find(item => item.id === original.id).at, original.at);
  await f.manager.maintain();
  const rematch = a.messages.findLast(item => item.type === 'match_proposal');
  assert.notEqual(rematch.proposalId, proposal.proposalId);
  assert.deepEqual(new Set(rematch.members), new Set(['a', 'b', 'e', 'g']));
  assert.equal(f.store.load().length, 0);
});

test('proposal deadline drops any nonunanimous party and retains accepted party age', async t => {
  const f = await fixture(t);
  const [a, b, c] = await Promise.all(['a', 'b', 'c'].map(id => f.connect(id)));
  await a.command({ type: 'party_create' });
  const invite = (await a.command({ type: 'party_invite', playerId: 'b' })).find(item => item.type === 'party_invitation');
  await b.command({ type: 'party_accept', invitationToken: invite.invitationToken });
  await a.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 });
  const original = f.store.loadDomain().queue[0];
  await c.command({ type: 'queue_join', minPlayers: 3, maxPlayers: 3 });
  const proposal = a.messages.findLast(item => item.type === 'match_proposal');
  await a.command({ type: 'match_accept', proposalId: proposal.proposalId });
  await b.command({ type: 'match_accept', proposalId: proposal.proposalId });
  await f.manager.maintain(proposal.deadline);
  assert.equal(c.messages.findLast(item => item.type === 'queue_state').queued, false);
  assert.equal(f.store.loadDomain().queue[0].at, original.at);
  assert.deepEqual(f.store.loadDomain().queue[0].members, ['a', 'b']);
});

test('search exhaustion preserves queue and game minimum/team counts are skipped instead of crashing', async t => {
  const game = { gameId: 'game', name: 'Team game', enabled: true, source: 'config', maxPlayersPerRoom: 4, capabilities: { minPlayers: 4, joinPolicies: ['closed'], rules: {}, teams: { count: 2, size: 2, requiredRoles: {} } } };
  const f = await fixture(t, { games: [game], matching: { searchLimit: 1 } });
  const peers = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.connect(id)));
  for (const peer of peers) await peer.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 4 });
  assert.equal(f.manager.stats().queuedPlayers, 4);
  assert.equal(peers.some(peer => peer.messages.some(item => item.code === 'matchmaking_search_exhausted')), true);
  f.config.matching.searchLimit = 100000;
  await f.manager.maintain();
  assert.equal(peers[0].messages.findLast(item => item.type === 'match_proposal').members.length, 4);
});

test('waiting advanced profiles refresh outside serialization and revoked queue identity cannot resurrect', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let calls = 0; let release; let entered;
  const pending = new Promise(resolve => { entered = resolve; });
  const f = await fixture(t, { gameConfig: { profileMaxAgeMs: 10 }, profiles: async (_gameId, ids) => {
    calls++;
    if (calls > 1) { entered(); await new Promise(resolve => { release = resolve; }); }
    return ids.map(playerId => ({ playerId, skill: 100, measuredAt: now, regionRttMs: { east: 20 } }));
  } });
  const a = await f.connect('a');
  await a.command({ type: 'switch_game', gameId: 'game', region: 'east' });
  await a.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2, matching: 'advanced' });
  now += 11;
  const maintenance = f.manager.maintain(now); await pending;
  await a.command({ type: 'list_blocks' });
  await a.command({ type: 'queue_leave' }); release(); await maintenance;
  assert.equal(f.manager.stats().queuedPlayers, 0);
  assert.equal(f.store.loadDomain().queue.length, 0);
  assert.equal(a.messages.some(item => item.type === 'match_proposal'), false);
});

test('missing trusted refresh never downgrades to FIFO and disconnected waiting players cannot match', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  let available = true;
  const f = await fixture(t, { gameConfig: { profileMaxAgeMs: 10 }, profiles: async (_gameId, ids) => {
    if (!available) throw new Error('profile backend offline');
    return ids.map(playerId => ({ playerId, skill: playerId === 'a' ? 100 : 1000, measuredAt: now, regionRttMs: { east: 20 } }));
  } });
  const a = await f.connect('a'); const b = await f.connect('b');
  for (const peer of [a, b]) { await peer.command({ type: 'switch_game', gameId: 'game', region: 'east' }); await peer.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2, matching: 'advanced' }); }
  now += 11; available = false; await f.manager.maintain(now);
  assert.equal(f.manager.stats().queuedPlayers, 2);
  assert.equal(a.messages.findLast(item => item.type === 'error').code, 'profile_unavailable');
  assert.equal(a.messages.some(item => item.type === 'match_proposal'), false);
  await a.command({ type: 'queue_leave' }); await b.command({ type: 'queue_leave' });
  await a.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2 }); a.closed = true;
  await b.command({ type: 'queue_join', minPlayers: 2, maxPlayers: 2 }); await f.manager.maintain(now);
  assert.equal(b.messages.some(item => item.type === 'match_proposal'), false);
});

test('leader controls and grouped SQL failure are atomic with no leaked join output', async t => {
  const f = await fixture(t); const a = await f.connect('a'); const b = await f.connect('b'); const host = await f.connect('host');
  const room = await create(host, { maxPlayers: 3 });
  await a.command({ type: 'party_create' });
  const invitation = (await a.command({ type: 'party_invite', playerId: 'b' })).find(item => item.type === 'party_invitation');
  await b.command({ type: 'party_accept', invitationToken: invitation.invitationToken });
  await assert.rejects(b.command({ type: 'party_transfer_leader', playerId: 'a' }), code('forbidden'));
  await assert.rejects(b.command({ type: 'party_join_room', roomId: room.id }), code('forbidden'));
  const update = f.store.update.bind(f.store); f.store.update = () => { throw new Error('SQL failed'); };
  const before = [a.messages.length, b.messages.length, host.messages.length];
  await assert.rejects(a.command({ type: 'party_join_room', roomId: room.id }), code('storage_error'));
  assert.equal(f.store.load()[0].seats.length, 1);
  for (const [index, peer] of [a, b, host].entries()) assert.equal(peer.messages.slice(before[index]).some(item => item.type === 'room_joined' || item.type === 'room_state'), false);
  f.store.update = update;
  await a.command({ type: 'party_transfer_leader', playerId: 'b' });
  await b.command({ type: 'party_join_room', roomId: room.id });
  assert.equal(f.store.load()[0].seats.length, 3);
  await b.command({ type: 'party_kick', playerId: 'a' });
  assert.deepEqual(f.store.listParties()[0].members, ['b']);
  await b.command({ type: 'party_disband' }); assert.equal(f.store.listParties().length, 0);
});

test('invitation decline/revoke/accept ownership and terminal lifecycle survive restart', async t => {
  const f = await fixture(t); const a = await f.connect('a'); const b = await f.connect('b'); const outsider = await f.connect('outsider');
  await a.command({ type: 'party_create' });
  const issue = async () => (await a.command({ type: 'party_invite', playerId: 'b' })).find(item => item.type === 'party_invitation');
  const declined = await issue();
  await assert.rejects(outsider.command({ type: 'decline_invitation', invitationToken: declined.invitationToken }), code('forbidden'));
  await b.command({ type: 'decline_invitation', invitationToken: declined.invitationToken });
  await assert.rejects(b.command({ type: 'party_accept', invitationToken: declined.invitationToken }), code('invitation_expired'));
  const revoked = await issue(); await assert.rejects(b.command({ type: 'revoke_invitation', invitationToken: revoked.invitationToken }), code('forbidden'));
  await a.command({ type: 'revoke_invitation', invitationToken: revoked.invitationToken });
  const accepted = await issue(); await b.command({ type: 'party_accept', invitationToken: accepted.invitationToken });
  await f.restart(); const restored = await f.connect('b');
  const inbox = (await restored.command({ type: 'list_invitations' }))[0].invitations;
  assert.equal(inbox.find(item => item.invitationToken === declined.invitationToken).status, 'declined');
  assert.equal(inbox.find(item => item.invitationToken === revoked.invitationToken).status, 'revoked');
  assert.equal(inbox.find(item => item.invitationToken === accepted.invitationToken).status, 'accepted');
  assert.equal((await (await f.connect('outsider')).command({ type: 'list_invitations' }))[0].invitations.length, 0);
});

test('chat history excludes later members, reports retain private evidence beyond chat retention', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const f = await fixture(t, { chat: { retentionMs: 10, reportRetentionMs: 100 } });
  const a = await f.connect('a'); const b = await f.connect('b'); const c = await f.connect('c');
  const room = await create(a); await b.command({ type: 'join_room', roomId: room.id });
  const sent = (await a.command({ type: 'chat_send', scope: 'room', text: 'private evidence' })).find(item => item.type === 'chat_message');
  await c.command({ type: 'join_room', roomId: room.id });
  assert.equal((await c.command({ type: 'chat_history', scope: 'room' }))[0].messages.length, 0);
  await assert.rejects(c.command({ type: 'chat_report', messageId: sent.message.id, reason: 'not my evidence' }), code('forbidden'));
  const report = (await b.command({ type: 'chat_report', messageId: sent.message.id, reason: 'review' })).find(item => item.type === 'chat_reported');
  await assert.rejects(b.command({ type: 'chat_mute', scope: 'room', playerId: 'a', until: now + 100 }), code('forbidden'));
  now += 11; await f.manager.maintain(now);
  assert.equal((await b.command({ type: 'chat_history', scope: 'room' }))[0].messages.length, 0);
  assert.equal(f.manager.chatReport(report.reportId).message.text, 'private evidence');
  await f.restart(); assert.equal(f.manager.chatReport(report.reportId).message.text, 'private evidence');
  now += 100; await f.manager.maintain(now); assert.equal(f.manager.chatReport(report.reportId), undefined);
});

test('trusted proposal assignments reach the provider unchanged and stale acceptance fails closed', async t => {
  let now = Date.now(); t.mock.method(Date, 'now', () => now);
  const game = { gameId: 'game', name: 'Team game', enabled: true, source: 'config', maxPlayersPerRoom: 4, regions: ['east'], capabilities: { minPlayers: 4, joinPolicies: ['closed'], rules: {}, roles: ['tank', 'damage'], teams: { count: 2, size: 2, requiredRoles: { tank: 1 } } } };
  const f = await fixture(t, { games: [game], gameConfig: { profileMaxAgeMs: 100 }, profiles: async (_gameId, ids) => ids.map(playerId => ({ playerId, skill: 100, measuredAt: now, regionRttMs: { east: 20 } })) });
  const peers = await Promise.all(['a', 'b', 'c', 'd'].map(id => f.connect(id, {}, false)));
  for (const [index, peer] of peers.entries()) {
    await peer.command({ type: 'select_game', gameId: 'game', region: 'east' });
    await peer.command({ type: 'queue_join', matching: 'advanced', minPlayers: 4, maxPlayers: 4, rolePreferences: [index % 2 === 0 ? 'tank' : 'damage'] });
    now++;
  }
  const proposal = peers[0].messages.findLast(item => item.type === 'match_proposal');
  const assignments = f.store.loadDomain().proposals[0].players;
  for (const peer of peers.slice(0, 3)) await peer.command({ type: 'match_accept', proposalId: proposal.proposalId });
  now += 101;
  await assert.rejects(peers[3].command({ type: 'match_accept', proposalId: proposal.proposalId }), code('profile_unavailable'));
  assert.equal(f.store.load().length, 0);
  await peers[3].command({ type: 'match_decline', proposalId: proposal.proposalId });
  await f.manager.maintain(now);
  await peers[3].command({ type: 'queue_join', matching: 'advanced', minPlayers: 4, maxPlayers: 4, rolePreferences: ['damage'] });
  const fresh = peers[0].messages.findLast(item => item.type === 'match_proposal');
  assert.notEqual(fresh.proposalId, proposal.proposalId);
  const confirmed = f.store.loadDomain().proposals[0].players;
  assert.deepEqual(confirmed, assignments);
  for (const peer of peers) await peer.command({ type: 'match_accept', proposalId: fresh.proposalId });
  for (const peer of peers) await peer.command({ type: 'ready', ready: true });
  await peers[0].command({ type: 'start_game' });
  assert.deepEqual(f.calls.create[0].players, confirmed);
});

test('read commands bypass mutation snapshots/SQL and maintenance errors roll back durable state and outputs', async t => {
  const f = await fixture(t); const a = await f.connect('a'); const b = await f.connect('b');
  const room = await create(a, { visibility: 'invite' });
  const invitation = (await a.command({ type: 'invite_player', playerId: 'b' })).find(item => item.type === 'room_invitation');
  const transaction = f.store.transaction.bind(f.store);
  f.store.transaction = () => { throw new Error('SQL unavailable'); };
  for (const type of ['list_rooms', 'list_games', 'list_friends', 'list_blocks', 'list_owned_rooms', 'list_invitations', 'list_match_results', 'sync_state']) await a.command({ type });
  const before = a.messages.length;
  await assert.rejects(a.command({ type: 'ready', ready: true }), code('storage_error'));
  assert.equal(a.messages.length, before);
  f.store.transaction = transaction;
  const save = f.store.saveInvitation.bind(f.store); f.store.saveInvitation = () => { throw new Error('expiry SQL failed'); };
  await assert.rejects(f.manager.maintain(invitation.expiresAt), code('storage_error'));
  assert.equal(f.store.listInvitations()[0].status, 'pending');
  assert.equal((await b.command({ type: 'list_invitations' }))[0].invitations[0].status, 'pending');
  f.store.saveInvitation = save;
  await f.manager.maintain(invitation.expiresAt);
  assert.equal(f.store.listInvitations()[0].status, 'expired');
  assert.equal(room.visibility, 'invite');
});

test('late transport disconnect after manager shutdown cannot write to a disposed store', async t => {
  const f = await fixture(t); const a = await f.connect('a'); await create(a);
  await f.manager.close();
  const persisted = f.store.load();
  const transaction = f.store.transaction.bind(f.store); let writes = 0;
  f.store.transaction = () => { writes++; throw new Error('store already disposed'); };
  try {
    a.closed = true; f.manager.disconnect(a); await f.manager.settle();
    assert.equal(writes, 0);
    assert.deepEqual(f.store.load(), persisted);
  } finally { f.store.transaction = transaction; }
});
