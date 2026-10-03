import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { generateKeyPairSync, sign } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { AuthError, MockAuthProvider, RemoteVerifyProvider, JwksProvider, createAuthProvider } from '../dist/auth/index.js';
import { GameRegistry } from '../dist/games/index.js';

const config = {
  mode: 'jwks', jwksUrl: '', issuer: 'https://issuer.example', audience: 'beacon', apiUrl: '',
  timeoutMs: 500, jwksCacheTtlSec: 60,
  mockPlayers: [{ token: 'local-secret', id: 'p1', displayName: '玩家一' }],
};
const key1 = generateKeyPairSync('rsa', { modulusLength: 2048 });
const key2 = generateKeyPairSync('rsa', { modulusLength: 2048 });
function jwk(key, kid) { return { ...key.publicKey.export({ format: 'jwk' }), kid, alg: 'RS256', use: 'sig' }; }
function jwt(claims = {}, key = key1, kid = 'one', header = {}) {
  const first = Buffer.from(JSON.stringify({ alg: 'RS256', kid, ...header })).toString('base64url');
  const second = Buffer.from(JSON.stringify({ iss: config.issuer, aud: config.audience, sub: 'p1', name: '玩家一', exp: Math.floor(Date.now() / 1000) + 60, ...claims })).toString('base64url');
  return `${first}.${second}.${sign('RSA-SHA256', Buffer.from(`${first}.${second}`), key.privateKey).toString('base64url')}`;
}
async function http(t, handler) {
  const server = createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return `http://127.0.0.1:${server.address().port}`;
}
function reply(res, body, status = 200) { res.writeHead(status, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
const fallback = [{ gameId: 'fallback', name: '備援', maxPlayersPerRoom: 4, enabled: true }];
const remoteGame = { gameId: 'g1', name: '遊戲一', maxPlayersPerRoom: 8, enabled: true, serverHint: 'wss://game.example/play' };

test('mock only accepts explicit configured tokens and returns independent identities', async () => {
  const provider = createAuthProvider({ ...config, mode: 'mock' });
  assert.ok(provider instanceof MockAuthProvider);
  const first = await provider.verify('local-secret');
  assert.equal(first.id, 'p1'); first.id = 'changed';
  assert.equal((await provider.verify('local-secret')).id, 'p1');
  await assert.rejects(provider.verify('p1'), AuthError);
  assert.throws(() => new MockAuthProvider({ ...config, mockPlayers: [{ token: 't', id: 'x', displayName: '\n' }] }), AuthError);
});

test('remote verifies via exact POST/Bearer contract and rejects malformed identity/status/body', async t => {
  let body = { playerId: 'p2', displayName: '遠端玩家' };
  let status = 200;
  const url = await http(t, (req, res) => {
    assert.equal(req.method, 'POST'); assert.equal(req.url, '/v1/verify');
    assert.equal(req.headers.authorization, 'Bearer access-token');
    reply(res, body, status);
  });
  const provider = new RemoteVerifyProvider({ ...config, apiUrl: url });
  assert.equal((await provider.verify('access-token')).id, 'p2');
  for (const bad of [{ playerId: '', displayName: 'ok' }, { playerId: 1, displayName: 'ok' }, { playerId: 'x', displayName: 'x'.repeat(129) }, { playerId: 'x\n', displayName: 'ok' }, null]) {
    body = bad; await assert.rejects(provider.verify('access-token'), AuthError);
  }
  body = { playerId: 'x', displayName: 'ok', padding: 'x'.repeat(17000) };
  await assert.rejects(provider.verify('access-token'), AuthError);
  status = 401; body = { secret: 'access-token' };
  await assert.rejects(provider.verify('access-token'), { name: 'AuthError', message: 'Authentication failed' });
});

test('remote does not forward bearer redirects, times out, and fails closed on unavailable API', async t => {
  let leaked = 0;
  const target = await http(t, (_req, res) => { leaked++; reply(res, { playerId: 'x', displayName: 'x' }); });
  const source = await http(t, (_req, res) => { res.writeHead(302, { location: target }); res.end(); });
  await assert.rejects(new RemoteVerifyProvider({ ...config, apiUrl: source }).verify('secret'), AuthError);
  assert.equal(leaked, 0);
  const hanging = await http(t, () => {});
  await assert.rejects(new RemoteVerifyProvider({ ...config, apiUrl: hanging, timeoutMs: 30 }).verify('secret'), AuthError);
  const malformed = await http(t, (_req, res) => { res.end('{'); });
  await assert.rejects(new RemoteVerifyProvider({ ...config, apiUrl: malformed }).verify('secret'), AuthError);
  await assert.rejects(new RemoteVerifyProvider({ ...config, apiUrl: 'http://127.0.0.1:0', timeoutMs: 30 }).verify('secret'), AuthError);
});

test('JWKS accepts signed identity/expiry; rejects tampering, algorithms, issuer/audience and invalid claims', async t => {
  let requests = 0;
  const url = await http(t, (req, res) => { assert.equal(req.method, 'GET'); assert.equal(req.url, '/keys'); requests++; reply(res, { keys: [jwk(key1, 'one')] }); });
  const provider = new JwksProvider({ ...config, jwksUrl: `${url}/keys` });
  const player = await provider.verify(jwt());
  assert.equal(player.id, 'p1'); assert.ok(player.expiresAt > player.authAt);
  await provider.verify(jwt({ aud: ['other', 'beacon'] }));
  const now = Math.floor(Date.now() / 1000);
  for (const claims of [{ exp: now - 1 }, { exp: 'later' }, { nbf: now + 100 }, { nbf: 'later' }, { iss: 'wrong' }, { aud: 'wrong' }, { sub: '' }, { name: 'x'.repeat(129) }]) {
    await assert.rejects(provider.verify(jwt(claims)), AuthError);
  }
  for (const alg of ['none', 'HS256', 'RS512']) await assert.rejects(provider.verify(jwt({}, key1, 'one', { alg })), AuthError);
  await assert.rejects(provider.verify(jwt({}, key2)), AuthError);
  const token = jwt(); const parts = token.split('.');
  parts[1] = Buffer.from(JSON.stringify({ sub: 'admin' })).toString('base64url');
  await assert.rejects(provider.verify(parts.join('.')), AuthError);
  await assert.rejects(provider.verify('a.b.'), AuthError);
  await assert.rejects(provider.verify(jwt({}, key1, 'one', { crit: ['custom'] })), AuthError);
  assert.equal(requests, 1);
});

test('JWKS unknown-kid refresh is single-flight and bounded; TTL re-fetch failure is fail-closed', async t => {
  let keys = [jwk(key1, 'one')]; let requests = 0; let fail = false;
  const url = await http(t, (_req, res) => { requests++; reply(res, { keys }, fail ? 503 : 200); });
  const provider = new JwksProvider({ ...config, jwksUrl: url, jwksCacheTtlSec: 1 });
  await provider.verify(jwt());
  await Promise.all(Array.from({ length: 10 }, (_, i) => assert.rejects(provider.verify(jwt({}, key2, `unknown-${i}`)), AuthError)));
  assert.equal(requests, 1);
  await delay(1050);
  keys = [jwk(key2, 'two')];
  await Promise.all(Array.from({ length: 5 }, () => provider.verify(jwt({}, key2, 'two'))));
  assert.equal(requests, 2);
  await assert.rejects(provider.verify(jwt()), AuthError);
  await delay(1050); fail = true;
  await assert.rejects(provider.verify(jwt({}, key2, 'two')), AuthError);
  assert.equal(requests, 3);
});

test('JWKS unknown kid and manual refresh adopt rotated keys; invalid key registries fail closed', async t => {
  let keys = [jwk(key1, 'one')]; let requests = 0;
  const url = await http(t, (_req, res) => { requests++; reply(res, { keys }); });
  const provider = new JwksProvider({ ...config, jwksUrl: url });
  await provider.verify(jwt()); await delay(1050);
  keys = [jwk(key2, 'two')];
  await provider.verify(jwt({}, key2, 'two')); assert.equal(requests, 2);
  await delay(1050); keys = [jwk(key1, 'one')]; await provider.refresh();
  await provider.verify(jwt()); assert.equal(requests, 3);
  keys = [jwk(key1, 'same'), jwk(key2, 'same')];
  await assert.rejects(new JwksProvider({ ...config, jwksUrl: url }).verify(jwt({}, key1, 'same')), AuthError);
  keys = [{ kty: 'oct', kid: 'one', k: 'secret', alg: 'HS256' }];
  await assert.rejects(new JwksProvider({ ...config, jwksUrl: url }).verify(jwt()), AuthError);
});

test('games loads exact endpoint with single-flight, cache, forced refresh, expiry and stale fallback', async t => {
  let requests = 0; let fail = false;
  const url = await http(t, (req, res) => { requests++; assert.equal(req.method, 'GET'); assert.equal(req.url, '/v1/games'); reply(res, [remoteGame], fail ? 503 : 200); });
  const registry = new GameRegistry({ apiUrl: url, timeoutMs: 500, cacheTtlSec: 1, fallback });
  const lists = await Promise.all(Array.from({ length: 10 }, () => registry.list()));
  assert.equal(requests, 1); assert.equal(lists[0][0].source, 'api');
  assert.equal(lists[0][0].maxPlayersPerRoom, 8); assert.equal(lists[0][0].serverHint, remoteGame.serverHint);
  const cached = await registry.list();
  assert.equal(cached[0].source, 'cache'); assert.equal(requests, 1);
  assert.deepEqual(await registry.list(), cached);
  await registry.list(true); assert.equal(requests, 2);
  await delay(1050); await registry.list(); assert.equal(requests, 3);
  fail = true; const stale = await registry.list(true);
  assert.equal(stale[0].source, 'cache'); assert.equal(stale[0].gameId, 'g1');
  assert.deepEqual(await registry.list(), stale); assert.equal(requests, 4);
});

test('game IDs incompatible with select_game are rejected before reaching consumers', async t => {
  let gameId = 'has spaces';
  const url = await http(t, (_req, res) => reply(res, [{ ...remoteGame, gameId }]));
  const registry = new GameRegistry({ apiUrl: url, timeoutMs: 500, cacheTtlSec: 60, fallback });
  for (const invalid of ['has spaces', '/path', '遊戲', '_leading', 'a'.repeat(129)]) {
    gameId = invalid;
    const visible = await registry.list(true);
    assert.equal(visible[0].gameId, 'fallback');
    assert.equal(visible[0].source, 'config');
  }
  gameId = 'game-valid_1:version.2';
  assert.equal((await registry.list(true))[0].gameId, gameId);
});

test('games uses config fallback on malformed/oversized API and validates identity/capacity/hints', async t => {
  let body = [remoteGame];
  const url = await http(t, (_req, res) => reply(res, body));
  for (const invalid of [[{ ...remoteGame, gameId: '' }], [{ ...remoteGame, maxPlayersPerRoom: 0 }], [{ ...remoteGame, maxPlayersPerRoom: -1 }], [{ ...remoteGame, maxPlayersPerRoom: 1.5 }], [{ ...remoteGame, maxPlayersPerRoom: Number.MAX_SAFE_INTEGER + 1 }], [{ ...remoteGame, enabled: 'true' }], [{ ...remoteGame, serverHint: '\n' }], [remoteGame, remoteGame], [{ ...remoteGame, name: 'x'.repeat(270000) }], {}]) {
    body = invalid;
    const registry = new GameRegistry({ apiUrl: url, timeoutMs: 500, cacheTtlSec: 60, fallback });
    assert.equal((await registry.list())[0].source, 'config');
  }
  body = [{ ...remoteGame, enabled: false }];
  assert.equal((await new GameRegistry({ apiUrl: url, timeoutMs: 500, cacheTtlSec: 60, fallback }).list())[0].enabled, false);
  body = Array.from({ length: 257 }, (_, index) => ({ ...remoteGame, gameId: `game-${index}`, maxPlayersPerRoom: 201 }));
  const large = await new GameRegistry({ apiUrl: url, timeoutMs: 500, cacheTtlSec: 60, fallback }).list();
  assert.equal(large.length, 257); assert.equal(large[0].maxPlayersPerRoom, 201);
  const offline = new GameRegistry({ apiUrl: '', timeoutMs: 500, cacheTtlSec: 60, fallback });
  assert.equal((await offline.list(true))[0].source, 'config');
  const empty = new GameRegistry({ apiUrl: 'http://127.0.0.1:0', timeoutMs: 30, cacheTtlSec: 60, fallback: [] });
  assert.deepEqual(await empty.list(), []);
  assert.throws(() => new GameRegistry({ apiUrl: '', timeoutMs: 500, cacheTtlSec: 60, fallback: [{ ...remoteGame, name: '\n' }] }));
});
