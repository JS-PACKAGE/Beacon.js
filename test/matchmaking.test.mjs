import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { parseCapabilities, validateGameSettings, projectGame } from '../dist/games/capabilities.js';
import { GameRegistry } from '../dist/games/index.js';
import { HttpGameSessions } from '../dist/games/sessions.js';
import { HttpGameProfiles, parseProfiles } from '../dist/games/profiles.js';
import { selectMatch } from '../dist/lobby/matchmaking.js';

const base = { gameId: 'g', name: 'Game', enabled: true, source: 'config', maxPlayersPerRoom: 4 };
const descriptor = { minPlayers: 4, joinPolicies: ['closed', 'fill'], rules: { rounds: { type: 'number', integer: true, min: 1, max: 5, default: 3 }, map: { type: 'string', enum: ['a', 'b'] }, ranked: { type: 'boolean', default: false } }, roles: ['tank', 'damage'], teams: { count: 2, size: 2, requiredRoles: { tank: 1 } } };
const game = { ...base, capabilities: parseCapabilities(descriptor, 4) };
const now = 100000;
const policy = { skillSpread: 200, maxSkillSpread: 1000, teamSkillDelta: 100, maxTeamSkillDelta: 500, latencyMs: 80, maxLatencyMs: 200, relaxAfterMs: 30000, relaxEveryMs: 15000, skillStep: 100, latencyStep: 20 };
function party(id, skill, role = 'damage', queuedAt = now) {
  return { id, playerIds: [id], queuedAt, rolePreferences: { [id]: [role] }, profiles: [{ playerId: id, skill, measuredAt: now, regionRttMs: { east: 80 } }] };
}
function options(overrides = {}) { return { mode: 'advanced', game, now, playerCount: 4, region: 'east', blocked: () => false, policy, profileMaxAgeMs: 60000, searchLimit: 100000, ...overrides }; }
const roster = [party('a', 100, 'tank'), party('b', 100), party('c', 100, 'tank'), party('d', 100)];

test('capability descriptors validate strict boundaries and project only public fields', () => {
  const settings = { maxPlayers: 4, joinPolicy: 'closed', rules: { rounds: 5, map: 'b' } };
  assert.deepEqual({ ...validateGameSettings(game, settings) }, { rounds: 5, ranked: false, map: 'b' });
  for (const rules of [{ unknown: true }, { rounds: 0 }, { rounds: 1.5 }, { rounds: 6 }, { ranked: 1 }, { map: 'c' }]) assert.throws(() => validateGameSettings(game, { ...settings, rules }));
  assert.throws(() => validateGameSettings(game, { ...settings, maxPlayers: 3 }));
  assert.throws(() => validateGameSettings(game, { ...settings, joinPolicy: 'spectate' }));
  for (const bad of [{ ...descriptor, minPlayers: 5 }, { ...descriptor, secret: 'x' }, { ...descriptor, joinPolicies: ['closed', 'closed'] }, { ...descriptor, rules: { x: { type: 'number', min: 2, max: 1 } } }, { ...descriptor, teams: { count: 2, size: 2, requiredRoles: { unknown: 1 } } }, { ...descriptor, rules: { x: { type: 'string', enum: ['a'], default: 'b' } } }]) assert.throws(() => parseCapabilities(bad, 4));
  assert.equal(projectGame({ ...game, serviceToken: 'secret' }).serviceToken, undefined);
  assert.deepEqual(validateGameSettings(base, { maxPlayers: 1, joinPolicy: 'spectate', rules: { legacy: true } }), { legacy: true });
});

test('advanced matching balances skills, assigns required roles and never splits parties', () => {
  const members = [party('a', 100, 'tank'), party('b', 300), party('c', 300, 'tank'), party('d', 100)];
  const selected = selectMatch(members, options());
  assert.ok(selected);
  for (let team = 0; team < 2; team++) {
    const players = selected.players.filter(p => p.team === team);
    assert.equal(players.length, 2); assert.equal(players.filter(p => p.gameRole === 'tank').length, 1);
    assert.equal(players.reduce((sum, p) => sum + members.find(m => m.id === p.id).profiles[0].skill, 0), 400);
  }
  const duo = { id: 'duo', playerIds: ['a', 'b'], queuedAt: now, rolePreferences: { a: ['tank'], b: ['damage'] }, profiles: members.slice(0, 2).flatMap(p => p.profiles) };
  const grouped = selectMatch([duo, ...members.slice(2)], options());
  assert.ok(grouped); assert.equal(grouped.players.find(p => p.id === 'a').team, grouped.players.find(p => p.id === 'b').team);
  assert.equal(selectMatch([party('a', 100), party('b', 100), party('c', 100), party('d', 100)], options()), undefined);
});

test('FIFO skips infeasible oldest parties without starving a feasible oldest roster', () => {
  const fifoGame = { ...base, maxPlayersPerRoom: 2 };
  const parties = [{ id: 'oversize', playerIds: ['x', 'y', 'z'], queuedAt: 0 }, { id: 'first', playerIds: ['a'], queuedAt: 1 }, { id: 'blocked', playerIds: ['b'], queuedAt: 2 }, { id: 'later', playerIds: ['c'], queuedAt: 3 }];
  const opts = options({ mode: 'basic', game: fifoGame, playerCount: 2, blocked: (a, b) => a === 'b' && b === 'a' });
  assert.deepEqual(selectMatch(parties, opts).partyIds, ['first', 'later']);
  assert.deepEqual(selectMatch([...parties].reverse(), opts), selectMatch(parties, opts));
  assert.equal(selectMatch([{ id: 'party', playerIds: ['a', 'b'], queuedAt: 1 }], opts), undefined);
});

test('waiting relaxation progresses at exact boundaries and never exceeds hard budgets', () => {
  const waiting = roster.map(p => ({ ...p, queuedAt: 70000, profiles: p.profiles.map(profile => ({ ...profile, measuredAt: 99999, skill: p.id === 'b' ? 400 : 100, regionRttMs: { east: 100 } })) }));
  assert.equal(selectMatch(waiting, options({ now: 99999 })), undefined);
  assert.ok(selectMatch(waiting, options()));
  const young = waiting.map(p => p.id === 'd' ? { ...p, queuedAt: now } : p);
  assert.equal(selectMatch(young, options()), undefined);
  const never = waiting.map(p => ({ ...p, profiles: p.profiles.map(profile => ({ ...profile, regionRttMs: { east: 201 }, measuredAt: 1000000 })) }));
  assert.equal(selectMatch(never, options({ now: 1000000 })), undefined);
  const narrow = { ...policy, skillSpread: 0, maxSkillSpread: 0, teamSkillDelta: 0, maxTeamSkillDelta: 0 };
  assert.equal(selectMatch(waiting, options({ policy: narrow })), undefined);
});

test('trusted profiles fail closed on missing, stale, duplicated, malformed or unsupported regional data', () => {
  assert.throws(() => selectMatch(roster.map(p => ({ ...p, profiles: undefined })), options()), { code: 'matchmaking_profiles_unavailable' });
  assert.throws(() => selectMatch(roster, options({ now: now + 60001 })), { code: 'matchmaking_profiles_unavailable' });
  assert.equal(selectMatch(roster, options({ region: 'west' })), undefined);
  const response = { gameId: 'g', profiles: roster.flatMap(p => p.profiles) };
  assert.equal(parseProfiles(response, 'g', ['a', 'b', 'c', 'd'], now + 60000, 60000).length, 4);
  for (const bad of [{ ...response, gameId: 'other' }, { ...response, token: 'secret' }, { ...response, profiles: [...response.profiles.slice(0, 3), response.profiles[0]] }, { ...response, profiles: response.profiles.map(p => ({ ...p, regionRttMs: { east: -1 } })) }]) assert.throws(() => parseProfiles(bad, 'g', ['a', 'b', 'c', 'd'], now, 60000));
});

async function server(t, handler) {
  const http = createServer(handler); await new Promise(resolve => http.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { http.closeAllConnections(); http.close(resolve); }));
  return `http://127.0.0.1:${http.address().port}`;
}
function reply(res, body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
const config = { apiUrl: '', timeoutMs: 500, cacheTtlSec: 60, fallback: [game], sessionApiUrl: '', serviceTokenFile: '', profileApiUrl: '', profileMaxAgeMs: 60000 };

test('actual registry parses capabilities and session adapter rejects invalid rosters before allocation', async t => {
  const registry = new GameRegistry(config); assert.equal((await registry.list())[0].capabilities.teams.count, 2);
  assert.throws(() => new GameRegistry({ ...config, fallback: [{ ...base, capabilities: { ...descriptor, minPlayers: 10 } }] }));
  let calls = 0;
  const url = await server(t, (req, res) => {
    calls++; let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const request = JSON.parse(body); assert.equal(request.rules.rounds, 3);
      reply(res, { matchId: 'match', serverUrl: 'wss://games.example/play', expiresAt: Date.now() + 60000, tickets: Object.fromEntries(request.players.map(p => [p.id, `ticket-${p.id}`])) });
    });
  });
  const provider = new HttpGameSessions({ ...config, sessionApiUrl: url });
  const request = { operationId: 'op', roomId: 'room', gameId: 'g', version: '', mode: '', region: '', players: selectMatch(roster, options()).players };
  await assert.rejects(provider.create({ ...request, rules: { rounds: 6 } }), { code: 'game_service_unavailable' });
  await assert.rejects(provider.create({ ...request, players: request.players.map(p => ({ ...p, gameRole: 'unknown' })) }));
  assert.equal(calls, 0); assert.equal((await provider.create(request)).matchId, 'match'); assert.equal(calls, 1);
});

test('trusted HTTP adapter uses explicit proposed authenticated contract and no fallback', async t => {
  await assert.rejects(new HttpGameProfiles(config).profiles('g', ['a']), { code: 'matchmaking_profiles_unavailable' });
  const dir = await mkdtemp(join(tmpdir(), 'beacon-profiles-')); t.after(() => rm(dir, { recursive: true, force: true }));
  const tokenFile = join(dir, 'token'); await writeFile(tokenFile, 'trusted-service-token', { mode: 0o600 });
  let bad = false;
  const url = await server(t, (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/matchmaking/profiles'); assert.equal(req.headers.authorization, 'Bearer trusted-service-token');
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      assert.deepEqual(JSON.parse(body), { gameId: 'g', playerIds: ['a'] });
      reply(res, { gameId: 'g', profiles: [{ playerId: bad ? 'other' : 'a', skill: 100, measuredAt: Date.now(), regionRttMs: { east: 80 } }] });
    });
  });
  const adapter = new HttpGameProfiles({ ...config, profileApiUrl: url, serviceTokenFile: tokenFile });
  assert.equal((await adapter.profiles('g', ['a']))[0].skill, 100); bad = true;
  await assert.rejects(adapter.profiles('g', ['a']), { code: 'matchmaking_profiles_unavailable' });
});

test('descriptor rules share wire limits and fractional defaults survive session allocation', async t => {
  for (const rules of [
    Object.fromEntries(Array.from({ length: 17 }, (_, index) => [`rule${index}`, { type: 'boolean' }])),
    { ['a'.repeat(33)]: { type: 'boolean' } }, { serviceToken: { type: 'boolean' } },
    { text: { type: 'string', default: 'a'.repeat(129) } },
    { text: { type: 'string', maxLength: 129 } },
    Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`rule${index}`, { type: 'string', default: 'a'.repeat(128) }])),
  ]) assert.throws(() => parseCapabilities({ ...descriptor, rules }, 4));
  const capabilities = parseCapabilities({ ...descriptor, rules: { ratio: { type: 'number', min: 0, max: 1, default: 0.5 }, text: { type: 'string', maxLength: 128 } } }, 4);
  const fractionalGame = { ...base, capabilities };
  assert.deepEqual(validateGameSettings(fractionalGame, { maxPlayers: 4, joinPolicy: 'closed' }), { ratio: 0.5 });
  assert.equal(validateGameSettings(fractionalGame, { maxPlayers: 4, joinPolicy: 'closed', rules: { text: '界'.repeat(128) } }).text.length, 128);
  const oversized = parseCapabilities({ ...descriptor, rules: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`rule${index}`, { type: 'string' }])) }, 4);
  assert.throws(() => validateGameSettings({ ...base, capabilities: oversized }, { maxPlayers: 4, joinPolicy: 'closed', rules: Object.fromEntries(Array.from({ length: 8 }, (_, index) => [`rule${index}`, 'a'.repeat(128)])) }));
  const received = [];
  const url = await server(t, (req, res) => {
    let body = ''; req.on('data', chunk => { body += chunk; }); req.on('end', () => {
      const request = JSON.parse(body); received.push(request.rules.ratio);
      reply(res, { matchId: 'fractional', serverUrl: 'wss://games.example/play', expiresAt: Date.now() + 60000, tickets: Object.fromEntries(request.players.map(p => [p.id, `ticket-${p.id}`])) });
    });
  });
  const provider = new HttpGameSessions({ ...config, sessionApiUrl: url, fallback: [fractionalGame] });
  const players = selectMatch(roster, options()).players;
  const input = { operationId: 'op', roomId: 'room', gameId: 'g', version: '', mode: '', region: '', players };
  assert.equal((await provider.create(input)).matchId, 'fractional');
  assert.equal((await provider.create({ ...input, operationId: 'other', rules: { ratio: 0.25 } })).matchId, 'fractional');
  assert.deepEqual(received, [0.5, 0.25]);
});

test('capacity and zero-objective pruning keep ordinary large FIFO queues within explicit work bounds', () => {
  const parties = Array.from({ length: 40 }, (_, index) => ({ id: `p${index}`, playerIds: [`p${index}`], queuedAt: index }));
  assert.equal(selectMatch(parties, options({ mode: 'basic', game: { ...base, maxPlayersPerRoom: 41 }, playerCount: 41, searchLimit: 1 })), undefined);
  const caps = parseCapabilities({ minPlayers: 32, joinPolicies: ['closed'], rules: {}, teams: { count: 2, size: 16, requiredRoles: {} } }, 32);
  const largeGame = { ...base, maxPlayersPerRoom: 32, capabilities: caps };
  const selected = selectMatch(parties, options({ mode: 'basic', game: largeGame, playerCount: 32, searchLimit: 512 }));
  assert.deepEqual(selected.partyIds, parties.slice(0, 32).map(p => p.id));
  assert.equal(selected.players.filter(p => p.team === 0).length, 16);
  assert.equal(selected.players.filter(p => p.team === 1).length, 16);
  const advanced = parties.map(p => ({ ...p, profiles: [{ playerId: p.id, skill: 100, measuredAt: now, regionRttMs: { east: 80 } }] }));
  assert.deepEqual(selectMatch(advanced, options({ game: largeGame, playerCount: 32, searchLimit: 512 })).partyIds, selected.partyIds);
});

test('mandatory roles use feasible specialist assignment and reject impossible supply before partition search', () => {
  const caps = parseCapabilities({ minPlayers: 32, joinPolicies: ['closed'], rules: {}, roles: ['tank', 'damage', 'support'], teams: { count: 2, size: 16, requiredRoles: { tank: 1 } } }, 32);
  const roleGame = { ...base, maxPlayersPerRoom: 32, capabilities: caps };
  const parties = Array.from({ length: 32 }, (_, index) => ({ id: `p${index}`, playerIds: [`p${index}`], queuedAt: index, rolePreferences: { [`p${index}`]: ['damage', 'support'] } }));
  const opts = options({ mode: 'basic', game: roleGame, playerCount: 32, searchLimit: 512 });
  assert.equal(selectMatch(parties, { ...opts, searchLimit: 1 }), undefined);
  for (const index of [30, 31]) parties[index].rolePreferences[`p${index}`] = ['tank'];
  const selected = selectMatch(parties, opts);
  assert.ok(selected);
  for (let team = 0; team < 2; team++) assert.equal(selected.players.filter(p => p.team === team && p.gameRole === 'tank').length, 1);
  const scarce = parseCapabilities({ minPlayers: 4, joinPolicies: ['closed'], rules: {}, roles: ['tank', 'support'], teams: { count: 2, size: 2, requiredRoles: { tank: 1, support: 1 } } }, 4);
  const flexible = [party('a', 100, 'tank'), party('b', 100, 'support'), party('c', 100, 'tank'), party('d', 100, 'support')];
  flexible[0].rolePreferences.a = ['support', 'tank'];
  flexible[2].rolePreferences.c = ['support', 'tank'];
  assert.ok(selectMatch(flexible, options({ game: { ...base, capabilities: scarce }, searchLimit: 512 })));
});

test('search exhaustion is explicit and cannot mutate or replace the oldest queue roster', () => {
  const before = structuredClone(roster);
  assert.throws(() => selectMatch(roster, options({ searchLimit: 1 })), { code: 'matchmaking_search_exhausted' });
  assert.deepEqual(roster, before);
  assert.deepEqual(selectMatch(roster, options({ searchLimit: 512 })).partyIds, ['a', 'b', 'c', 'd']);
});

test('matcher requires explicit deployment policy, work budget and trusted freshness bound', () => {
  for (const field of ['policy', 'searchLimit', 'profileMaxAgeMs']) {
    const missing = options(); delete missing[field];
    assert.throws(() => selectMatch(roster, missing), { code: 'unsupported_game_feature' });
  }
});
