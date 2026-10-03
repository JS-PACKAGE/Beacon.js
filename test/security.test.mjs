import test from 'node:test';
import assert from 'node:assert/strict';
import { performance } from 'node:perf_hooks';
import { hashPassword, verifyPassword } from '../dist/security/password.js';
import { TokenBucket } from '../dist/security/rate.js';
import { redact } from '../dist/log/index.js';
import { allowUpgrade, sourceIp } from '../dist/security/source.js';
import { loadConfig } from '../dist/config.js';

const dev = { insecureWs: false, mockAuth: true };
const config = await loadConfig('config.yaml', { insecureWs: true, mockAuth: true });
const production = { ...config, server: { ...config.server, trustProxy: true, allowNoOrigin: true }, public: { ...config.public, tls: 'proxy' } };
const request = (headers = {}, remoteAddress = '127.0.0.1', encrypted = false) => ({ headers, socket: { remoteAddress, encrypted } });

test('scrypt salts are independent and password comparison rejects malformed hashes', async () => {
  const first = await hashPassword('房間 secret');
  const second = await hashPassword('房間 secret');
  assert.notEqual(first, second);
  assert.match(first, /^scrypt\$16384\$8\$1\$[a-f0-9]{32}\$[a-f0-9]{128}$/);
  assert.equal(await verifyPassword('房間 secret', first), true);
  assert.equal(await verifyPassword('wrong secret', first), false);
  assert.equal(await verifyPassword('secret', 'scrypt$999999999$8$1$salt$key'), false);
  // Valid wrong passwords still run the same scrypt and timingSafeEqual path.
  assert.equal(await verifyPassword('', first), false);
});

test('token bucket refills without rewarding backward clock movement', () => {
  const bucket = new TokenBucket(2, 1000);
  const now = performance.now();
  assert.equal(bucket.take(now), true);
  assert.equal(bucket.take(now), true);
  assert.equal(bucket.take(now), false);
  assert.equal(bucket.take(now - 100), false);
  assert.equal(bucket.take(now + 501), true);
  assert.equal(bucket.take(now + 501), false);
  assert.throws(() => new TokenBucket(0, 100));
});

test('recursive logger redacts credentials, JWT strings, errors and cycles', () => {
  const fields = { token: 'one', nested: [{ PASSWORD: 'two', authorization: 'three', jwtValue: 'four', text: 'Bearer five eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature' }], error: new Error('token=secret') };
  fields.cycle = fields;
  const result = JSON.stringify(redact(fields));
  for (const secret of ['one', 'two', 'three', 'four', 'five', 'token=secret', 'eyJhbGci']) assert.equal(result.includes(secret), false);
  assert.match(result, /REDACTED/);
  assert.match(result, /OMITTED/);
});

test('proxy security requires loopback, TLS proof, exact host and allowed origin', () => {
  const headers = { host: production.public.domain, 'x-forwarded-proto': 'https' };
  assert.equal(allowUpgrade(request(headers), production, dev), true);
  assert.equal(allowUpgrade(request(headers, '192.0.2.1'), production, dev), false);
  assert.equal(allowUpgrade(request({ ...headers, 'x-forwarded-proto': 'http' }), production, dev), false);
  assert.equal(allowUpgrade(request({ ...headers, 'x-forwarded-proto': 'https,http' }), production, dev), false);
  assert.equal(allowUpgrade(request({ ...headers, host: 'evil.test' }), production, dev), false);
  assert.equal(allowUpgrade(request({ ...headers, origin: 'https://evil.test' }), production, dev), false);
  assert.equal(allowUpgrade(request(headers), { ...production, server: { ...production.server, trustProxy: false } }, dev), false);
  const direct = { ...production, public: { ...production.public, tls: 'direct' } };
  assert.equal(allowUpgrade(request(headers), direct, dev), false);
  assert.equal(allowUpgrade(request(headers, '127.0.0.1', true), direct, dev), true);
  assert.equal(allowUpgrade(request(headers, '192.0.2.1', true), direct, dev), false);
});

test('client IP uses only validated trusted forwarding headers', () => {
  const headers = { 'cf-connecting-ip': '203.0.113.7', 'x-forwarded-for': '192.0.2.9, 198.51.100.4' };
  assert.equal(sourceIp(request(headers), production), '203.0.113.7');
  assert.equal(sourceIp(request({ ...headers, 'cf-connecting-ip': 'spoof, 203.0.113.7' }), production), '198.51.100.4');
  assert.equal(sourceIp(request({ 'x-forwarded-for': '192.0.2.1, invalid' }), production), '127.0.0.1');
  assert.equal(sourceIp(request(headers), { ...production, server: { ...production.server, trustProxy: false } }), '127.0.0.1');
  assert.equal(sourceIp(request(headers, '192.0.2.1'), production), '192.0.2.1');
});
