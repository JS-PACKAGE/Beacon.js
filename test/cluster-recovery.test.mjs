import test from 'node:test';
import assert from 'node:assert/strict';
import { Worker } from 'node:worker_threads';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { ClusterCoordinator } from '../dist/cluster/index.js';
import { loadConfig } from '../dist/config.js';

test('recovery health stays nonblocking while checkpoint reads exceed ordinary RPC deadlines', { timeout: 40000 }, async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-slow-recovery-'));
  // Coordination RPC intentionally blocks this thread. The HTTP fixture must own independent I/O,
  // just like real etcd, or the post-recovery linearizable health check cannot receive its response.
  const server = new Worker(`
    const { parentPort } = require('node:worker_threads');
    const { createServer } = require('node:http');
    const { setTimeout: sleep } = require('node:timers/promises');
    const generation = '11111111-1111-4111-8111-111111111111';
    const checkpoint = Buffer.from(JSON.stringify({ version: 1, snapshot: '', requests: {} }));
    createServer(async (request, response) => {
      let body = ''; for await (const chunk of request) body += chunk;
      const value = JSON.parse(body); const key = value.key ? Buffer.from(value.key, 'base64').toString() : '';
      const send = result => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(result) + '\\n'); };
      if (request.url === '/v3/lease/grant') { send({ ID: '1', TTL: '30' }); return; }
      if (request.url === '/v3/lease/keepalive') { send({ result: { ID: '1', TTL: '30' } }); return; }
      if (request.url === '/v3/kv/txn') { send({ succeeded: true, header: { revision: '2' } }); return; }
      if (request.url === '/v3/kv/range' && key.endsWith('/state')) {
        const head = { version: 2, generation, chunks: 128, journal: 0, bytes: checkpoint.length };
        send({ kvs: [{ value: Buffer.from(JSON.stringify(head)).toString('base64'), mod_revision: '1' }] }); return;
      }
      if (key.includes('/chunk/')) {
        await sleep(110);
        const index = Number(key.split('/').at(-1));
        send({ kvs: [{ value: (index === 0 ? checkpoint : Buffer.alloc(0)).toString('base64') }] }); return;
      }
      send({ kvs: [] });
    }).listen(0, '127.0.0.1', function () { parentPort.postMessage(this.address().port); });
  `, { eval: true });
  const ready = Promise.withResolvers(); server.once('message', ready.resolve); server.once('error', ready.reject);
  const port = await ready.promise;
  const config = await loadConfig('config.yaml', { insecureWs: true, mockAuth: true });
  config.db.path = join(dir, 'local.db');
  Object.assign(config.cluster, { enabled: true, development: true, nodeId: 'slow-recovery', prefix: '/recovery-test', endpoints: [`http://127.0.0.1:${port}`], requestTimeoutMs: 400, maxSnapshotBytes: 1024, maxStateBytes: 131072, checkpointInterval: 32, leaseTtlSeconds: 30 });
  const completed = Promise.withResolvers();
  const coordinator = new ClusterCoordinator(config, () => completed.resolve(), () => {});
  t.after(async () => { await coordinator.close(); await server.terminate(); await rm(dir, { recursive: true, force: true }); });
  await sleep(1000);
  const started = performance.now();
  const health = coordinator.health();
  assert.equal(health.role, 'recovering'); assert.equal(health.healthy, false);
  assert.ok(performance.now() - started < 1000);
  await completed.promise;
  assert.equal(coordinator.health().role, 'leader');
});
