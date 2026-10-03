import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { get } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import { startTransport, markAuthenticated } from '../dist/net/index.js';
import { loadConfig } from '../dist/config.js';

const base = await loadConfig('config.yaml', { insecureWs: true, mockAuth: true });
const localDev = { insecureWs: true, mockAuth: true };
async function fixture(t, changes = {}, handlers = {}, dev = localDev) {
  const config = { ...base, ...changes, server: { ...base.server, listenHost: '127.0.0.1', listenPort: 0, allowNoOrigin: true, ...changes.server }, public: { ...base.public, tls: 'proxy', ...changes.public }, limits: { ...base.limits, authDeadlineMs: 5000, heartbeatIntervalMs: 1000, heartbeatTimeoutMs: 3000, ...changes.limits } };
  const transport = await startTransport(config, dev, { onConnect() {}, async onMessage(peer, message) { peer.send({ type: 'received', message }); }, onClose() {}, ...handlers });
  t.after(() => transport.close());
  return { transport, config, url: `${config.public.tls === 'direct' ? 'wss' : 'ws'}://127.0.0.1:${transport.address().port}` };
}
function client(t, url, options = {}) {
  const ws = new WebSocket(url, options);
  const messages = [];
  const pending = [];
  ws.on('message', bytes => {
    const message = JSON.parse(bytes.toString());
    const next = pending.shift();
    if (next) next.resolve(message); else messages.push(message);
  });
  ws.on('error', () => {});
  t.after(() => ws.terminate());
  return { ws, async next() {
    if (messages.length) return messages.shift();
    const waiter = Promise.withResolvers();
    pending.push(waiter);
    return Promise.race([waiter.promise, delay(2000).then(() => { throw new Error('Message timeout'); })]);
  } };
}
async function rejected(t, url, options) {
  const { ws } = client(t, url, options);
  const response = Promise.withResolvers();
  ws.once('unexpected-response', (_request, incoming) => { incoming.resume(); response.resolve(incoming.statusCode); ws.terminate(); });
  return Promise.race([response.promise, delay(2000).then(() => { throw new Error('Upgrade rejection timeout'); })]);
}

test('development ws sends hello first and rejects regular HTTP', async t => {
  const { url } = await fixture(t);
  const c = client(t, url);
  const greeting = await c.next();
  assert.equal(greeting.type, 'hello');
  assert.equal(greeting.protocolVersion, 2);
  c.ws.send(JSON.stringify({ type: 'ping' }));
  assert.equal((await c.next()).message.type, 'ping');
  const result = Promise.withResolvers();
  get(url.replace('ws:', 'http:'), response => { response.resume(); result.resolve(response.statusCode); }).on('error', result.reject);
  assert.equal(await result.promise, 426);
});

test('production proxy rejects spoofed TLS, Host and Origin', async t => {
  const { url, config } = await fixture(t, { server: { trustProxy: true, allowedOrigins: ['https://client.test'] } }, {}, { insecureWs: false, mockAuth: true });
  const headers = { Host: config.public.domain, 'X-Forwarded-Proto': 'https', Origin: 'https://client.test' };
  assert.equal(await rejected(t, url, { headers: { ...headers, 'X-Forwarded-Proto': 'http' } }), 403);
  assert.equal(await rejected(t, url, { headers: { ...headers, Host: 'spoof.test' } }), 403);
  assert.equal(await rejected(t, url, { headers: { ...headers, Origin: 'https://evil.test' } }), 403);
  const c = client(t, url, { headers });
  assert.equal((await c.next()).type, 'hello');
});

test('unknown schema fields reject; unknown types stay connected; three JSON failures close', async t => {
  const { url } = await fixture(t);
  const c = client(t, url);
  await c.next();
  c.ws.send('{"type":"ping","extra":true}');
  assert.equal((await c.next()).code, 'bad_request');
  for (let i = 0; i < 4; i++) {
    c.ws.send('{"type":"nonexistent"}');
    assert.equal((await c.next()).code, 'unknown_type');
  }
  const closed = once(c.ws, 'close');
  for (let i = 0; i < 3; i++) { c.ws.send('{'); assert.equal((await c.next()).code, 'bad_request'); }
  assert.equal((await closed)[0], 1008);
});

test('binary and oversized inbound messages close without dispatching', async t => {
  let dispatched = 0;
  const { url } = await fixture(t, {}, { async onMessage() { dispatched++; } });
  for (const payload of [Buffer.from('binary'), 'x'.repeat(4097)]) {
    const c = client(t, url);
    await c.next();
    const closed = once(c.ws, 'close');
    c.ws.send(payload);
    assert.ok([1003, 1009].includes((await closed)[0]));
  }
  assert.equal(dispatched, 0);
});

test('authentication deadline and explicit expiry close generically', async t => {
  const { url } = await fixture(t, { limits: { authDeadlineMs: 40 } });
  const c = client(t, url);
  await c.next();
  const closed = once(c.ws, 'close');
  assert.deepEqual(await c.next(), { type: 'auth_fail', code: 'auth_failed' });
  assert.equal((await closed)[0], 1008);
  const authenticated = await fixture(t, { limits: { authDeadlineMs: 40 } }, { onConnect(peer) { markAuthenticated(peer, Date.now() + 100); } });
  const second = client(t, authenticated.url);
  await second.next();
  const expired = once(second.ws, 'close');
  assert.equal((await second.next()).code, 'auth_expired');
  assert.equal((await expired)[0], 1008);
});

test('heartbeat reclaims clients that suppress pong', async t => {
  const { url } = await fixture(t, { limits: { heartbeatIntervalMs: 20, heartbeatTimeoutMs: 60 } }, { onConnect(peer) { markAuthenticated(peer); } });
  const c = client(t, url, { autoPong: false });
  await c.next();
  assert.equal((await once(c.ws, 'close'))[0], 1006);
});

test('persistent rate violations close and connection quotas deny excess peers', async t => {
  const { url } = await fixture(t, { limits: { messageBurst: 1, messageWindowMs: 10000, maxRateViolations: 2, maxConnectionsPerIp: 1 } });
  const c = client(t, url);
  await c.next();
  assert.equal(await rejected(t, url, {}), 429);
  c.ws.send('{"type":"ping"}');
  assert.equal((await c.next()).type, 'received');
  const closed = once(c.ws, 'close');
  c.ws.send('{"type":"ping"}');
  assert.equal((await c.next()).code, 'rate_limited');
  c.ws.send('{"type":"ping"}');
  assert.equal((await c.next()).code, 'rate_limited');
  assert.equal((await closed)[0], 1008);
});

test('outbound oversize and backpressure reject rather than truncate', async t => {
  for (const limits of [{ outboundBytes: 2048 }, { maxBufferedBytes: 1024 }]) {
    const { url } = await fixture(t, { limits }, { async onMessage(peer) { peer.send({ type: 'large', value: 'a'.repeat(3000) }); } });
    const c = client(t, url);
    await c.next();
    const closed = once(c.ws, 'close');
    c.ws.send('{"type":"ping"}');
    assert.ok([1009, 1013].includes((await closed)[0]));
  }
});

test('disconnect callback is not blocked by a running async handler', async t => {
  const entered = Promise.withResolvers();
  const blocked = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const { url } = await fixture(t, {}, { async onMessage(peer) { entered.resolve(peer); await blocked.promise; }, onClose(peer) { disconnected.resolve(peer.closed); } });
  const c = client(t, url);
  await c.next();
  c.ws.send('{"type":"ping"}');
  const peer = await entered.promise;
  c.ws.terminate();
  assert.equal(await disconnected.promise, true);
  assert.equal(peer.closed, true);
  blocked.resolve();
});

test('direct TLS supports wss but refuses plaintext ws', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-tls-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const certPath = join(directory, 'cert.pem');
  const keyPath = join(directory, 'key.pem');
  await promisify(execFile)('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath, '-out', certPath, '-days', '1', '-subj', '/CN=localhost']);
  const { url, config } = await fixture(t, { public: { tls: 'direct', certPath, keyPath } }, {}, { insecureWs: false, mockAuth: true });
  const c = client(t, url, { rejectUnauthorized: false, headers: { Host: config.public.domain } });
  assert.equal((await c.next()).type, 'hello');
  const plain = client(t, url.replace('wss:', 'ws:'));
  const failure = once(plain.ws, 'error');
  await failure;
});

test('total connection quota applies across trusted forwarded client IPs', async t => {
  const { url } = await fixture(t, { server: { trustProxy: true }, limits: { maxConnections: 1 } });
  const first = client(t, url, { headers: { 'CF-Connecting-IP': '192.0.2.1' } });
  await first.next();
  assert.equal(await rejected(t, url, { headers: { 'CF-Connecting-IP': '192.0.2.2' } }), 429);
});

test('connection-rate bucket survives disconnect and refills', async t => {
  const { url } = await fixture(t, { limits: { connectionBurst: 1, connectionWindowMs: 120 } });
  const first = client(t, url);
  await first.next();
  const closed = once(first.ws, 'close');
  first.ws.close();
  await closed;
  assert.equal(await rejected(t, url, {}), 429);
  await delay(140);
  assert.equal((await client(t, url).next()).type, 'hello');
});

test('bounded queue closes without waiting on an outstanding handler', async t => {
  const entered = Promise.withResolvers();
  const release = Promise.withResolvers();
  const disconnected = Promise.withResolvers();
  const { url } = await fixture(t, { limits: { messageBurst: 1, messageWindowMs: 10 } }, {
    async onMessage() { entered.resolve(); await release.promise; },
    onClose() { disconnected.resolve(); },
  });
  const c = client(t, url);
  await c.next();
  c.ws.send('{"type":"ping"}');
  await entered.promise;
  await delay(15);
  c.ws.send('{"type":"ping"}');
  await delay(15);
  const closed = once(c.ws, 'close');
  c.ws.send('{"type":"ping"}');
  assert.equal((await closed)[0], 1013);
  await disconnected.promise;
  release.resolve();
});
