import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { EtcdClient } from '../dist/cluster/etcd.js';
import { loadConfig } from '../dist/config.js';

test('authentication failure rotates away from unavailable endpoint without retrying uncertain mutations', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-etcd-auth-'));
  const passwordPath = join(dir, 'password'); await writeFile(passwordPath, 'private-test-secret', { mode: 0o600 });
  const dead = createServer(); const opened = Promise.withResolvers(); dead.listen(0, '127.0.0.1', opened.resolve); await opened.promise;
  const deadPort = dead.address().port; const stopped = Promise.withResolvers(); dead.close(stopped.resolve); await stopped.promise;
  let authenticated = 0; let mutations = 0;
  const server = createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    response.setHeader('content-type', 'application/json');
    if (request.url === '/v3/auth/authenticate') {
      assert.deepEqual(JSON.parse(body), { name: 'test-user', password: 'private-test-secret' }); authenticated++;
      response.end(JSON.stringify({ token: 'authenticated-token' })); return;
    }
    assert.equal(request.headers.authorization, 'authenticated-token'); mutations++;
    response.end(JSON.stringify({ succeeded: true, header: { revision: '1' } }));
  });
  const ready = Promise.withResolvers(); server.listen(0, '127.0.0.1', ready.resolve); await ready.promise;
  t.after(async () => { const closed = Promise.withResolvers(); server.close(closed.resolve); await closed.promise; await rm(dir, { recursive: true, force: true }); });
  const config = (await loadConfig('config.yaml', { insecureWs: true, mockAuth: true })).cluster;
  config.endpoints = [`http://127.0.0.1:${deadPort}`, `http://127.0.0.1:${server.address().port}`];
  config.requestTimeoutMs = 500; config.etcd.username = 'test-user'; config.etcd.passwordPath = passwordPath;
  const client = new EtcdClient(config);
  await assert.rejects(client.request('/v3/kv/txn', { compare: [] }), /Coordination unavailable/);
  assert.equal(mutations, 0);
  assert.equal((await client.request('/v3/kv/txn', { compare: [] })).succeeded, true);
  assert.equal(authenticated, 1); assert.equal(mutations, 1);
});
