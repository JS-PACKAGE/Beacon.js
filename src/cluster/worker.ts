import { parentPort, workerData } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { EtcdClient, base64, object, type ClusterConfig, type Json } from './etcd.js';
import { SqliteRoomStore } from '../store/index.js';

interface Dedup { digest: string; owner: string; expiresAt: number; replies?: Json[] }
interface State { version: 1; snapshot: string; requests: Record<string, Dedup> }
interface Manifest { version: 2; generation: string; chunks: number; journal: number; bytes: number }
interface Input { config: ClusterConfig; replicaPath: string; maxRequests: number; maxPlayerRequests: number; requestTtlMs: number }
const input = workerData as Input;
const config = input.config;
const client = new EtcdClient(config);
const replica = new SqliteRoomStore(input.replicaPath);
const leaderKey = base64(`${config.prefix}/leader`);
const stateKey = base64(`${config.prefix}/state`);
let state: State = { version: 1, snapshot: '', requests: {} };
let revision = '0';
let manifest: Manifest | undefined;
let durableText = JSON.stringify(state);
let lease = '';
let leaderValue = '';
let leader: Json | undefined;
let deadline = 0;
let active = false;
let recovering = false;
let stopped = false;
let replicationBytes = Buffer.byteLength(durableText);
let serial = Promise.resolve();
function enqueue<T>(operation: () => Promise<T>): Promise<T> {
  const job = serial.then(operation);
  serial = job.then(() => undefined, () => undefined);
  return job;
}
function lose(): void {
  active = false; deadline = 0; lease = ''; leaderValue = '';
  parentPort?.postMessage({ event: 'lost' });
}
function comparisons(): Json[] {
  if (!active || Date.now() >= deadline) throw new Error('not_leader');
  return [{ key: leaderKey, target: 'VALUE', result: 'EQUAL', value: base64(leaderValue) }, { key: leaderKey, target: 'LEASE', result: 'EQUAL', lease }];
}
async function fence(): Promise<void> {
  try {
    const response = await client.request('/v3/kv/txn', { compare: comparisons(), success: [{ requestRange: { key: leaderKey } }] });
    if (response.succeeded !== true) throw new Error('not_leader');
  } catch { lose(); throw new Error('cluster_unavailable'); }
}
async function renew(): Promise<void> {
  if (deadline - Date.now() > config.leaseTtlSeconds * 500) return;
  const started = Date.now();
  const response = await client.request('/v3/lease/keepalive', { ID: lease }, true);
  const result = object(response.result);
  const ttl = Number(result.TTL);
  if (!Number.isSafeInteger(ttl) || ttl < 1 || String(result.ID) !== lease) throw new Error('Lease expired');
  deadline = started + ttl * 1000 - config.requestTimeoutMs;
}
async function fencedTransaction(success: Json[]): Promise<Json> {
  await renew();
  const response = await client.request('/v3/kv/txn', { compare: [...comparisons(), { key: stateKey, target: 'MOD', result: 'EQUAL', mod_revision: revision }], success });
  if (response.succeeded !== true) throw new Error('not_leader');
  return response;
}
async function cleanup(keep?: string): Promise<void> {
  const prefix = `${config.prefix}/data/`;
  const end = `${config.prefix}/data0`;
  const listed = await client.request('/v3/kv/range', { key: base64(prefix), range_end: base64(end), keys_only: true, limit: '4096' });
  if (listed.more === true) throw new Error('Cluster orphan cleanup limit');
  const old = new Set<string>();
  for (const entry of Array.isArray(listed.kvs) ? listed.kvs : []) {
    const key = Buffer.from(String(object(entry).key), 'base64').toString('utf8');
    const generation = key.slice(prefix.length).split('/')[0]!;
    if (generation !== keep && /^[a-f0-9-]{36}$/.test(generation)) old.add(generation);
  }
  for (const generation of old) {
    const root = `${prefix}${generation}/`;
    await fencedTransaction([{ requestDeleteRange: { key: base64(root), range_end: base64(`${prefix}${generation}0`) } }]);
  }
}
async function persist(next: State, changeset?: Uint8Array): Promise<void> {
  const updates: Record<string, Dedup> = {};
  const removed: string[] = [];
  for (const [key, entry] of Object.entries(next.requests)) if (state.requests[key] !== entry) updates[key] = entry;
  for (const key of Object.keys(state.requests)) if (!Object.hasOwn(next.requests, key)) removed.push(key);
  const encodedDelta = JSON.stringify({ changeset: changeset ? Buffer.from(changeset).toString('base64') : '', updates, removed });
  if (Buffer.byteLength(encodedDelta) > config.maxSnapshotBytes) throw new Error('storage_full');
  const checkpoint = !manifest || manifest.journal >= config.checkpointInterval;
  const estimate = replicationBytes + Buffer.byteLength(encodedDelta);
  if (!checkpoint && estimate > config.maxStateBytes) throw new Error('storage_full');
  let size = estimate;
  try {
    if (changeset) replica.applyChangeset(changeset);
    if (checkpoint) {
      next = { ...next, snapshot: replica.exportSnapshot() };
      const text = JSON.stringify(next);
      size = Buffer.byteLength(text);
      if (size > config.maxStateBytes) throw new Error('storage_full');
      const generation = randomUUID();
      const data = Buffer.from(text);
      const chunks = Math.ceil(data.length / config.maxSnapshotBytes);
      for (let index = 0; index < chunks; index++) {
        await fencedTransaction([{ requestPut: { key: base64(`${config.prefix}/data/${generation}/chunk/${index}`), value: data.subarray(index * config.maxSnapshotBytes, (index + 1) * config.maxSnapshotBytes).toString('base64') } }]);
      }
      const nextManifest: Manifest = { version: 2, generation, chunks, journal: 0, bytes: size };
      const committed = await fencedTransaction([{ requestPut: { key: stateKey, value: base64(JSON.stringify(nextManifest)) } }]);
      revision = String(object(committed.header).revision);
      manifest = nextManifest;
      state = next; durableText = text; replicationBytes = size;
      // Only the CAS-published checkpoint permits deletion of old checkpoint/journal data.
      await cleanup(generation);
    } else {
      const priorManifest = manifest;
      if (!priorManifest) throw new Error('Missing durable manifest');
      const nextManifest: Manifest = { ...priorManifest, journal: priorManifest.journal + 1, bytes: size };
      const committed = await fencedTransaction([
        { requestPut: { key: base64(`${config.prefix}/data/${priorManifest.generation}/log/${nextManifest.journal}`), value: base64(encodedDelta) } },
        { requestPut: { key: stateKey, value: base64(JSON.stringify(nextManifest)) } },
      ]);
      revision = String(object(committed.header).revision);
      manifest = nextManifest; state = next; replicationBytes = size;
    }
  } catch { lose(); throw new Error('cluster_unavailable'); }
}
async function restore(record: Json): Promise<void> {
  const head = object(JSON.parse(Buffer.from(String(record.value), 'base64').toString('utf8')));
  if (head.version !== 2 || typeof head.generation !== 'string' || !/^[a-f0-9-]{36}$/.test(head.generation) || !Number.isSafeInteger(head.chunks) || Number(head.chunks) < 1 || Number(head.chunks) > Math.ceil(config.maxStateBytes / config.maxSnapshotBytes) || !Number.isSafeInteger(head.journal) || Number(head.journal) < 0 || Number(head.journal) > config.checkpointInterval || Number(head.bytes) > config.maxStateBytes) throw new Error('Invalid cluster manifest');
  manifest = head as unknown as Manifest;
  revision = String(record.mod_revision);
  const chunks: Buffer[] = [];
  for (let index = 0; index < manifest.chunks; index++) {
    await renew();
    const response = await client.request('/v3/kv/range', { key: base64(`${config.prefix}/data/${manifest.generation}/chunk/${index}`) });
    if (!Array.isArray(response.kvs) || response.kvs.length !== 1) throw new Error('Missing checkpoint chunk');
    const chunk = Buffer.from(String(object(response.kvs[0]).value), 'base64');
    if (chunk.length > config.maxSnapshotBytes) throw new Error('Checkpoint chunk limit');
    chunks.push(chunk);
  }
  durableText = Buffer.concat(chunks).toString('utf8');
  const parsed = object(JSON.parse(durableText));
  if (parsed.version !== 1 || typeof parsed.snapshot !== 'string' || Object.keys(object(parsed.requests)).length > input.maxRequests) throw new Error('Invalid durable state');
  state = parsed as unknown as State;
  replica.importSnapshot(state.snapshot);
  for (let index = 1; index <= manifest.journal; index++) {
    await renew();
    const response = await client.request('/v3/kv/range', { key: base64(`${config.prefix}/data/${manifest.generation}/log/${index}`) });
    if (!Array.isArray(response.kvs) || response.kvs.length !== 1) throw new Error('Missing journal entry');
    const encoded = Buffer.from(String(object(response.kvs[0]).value), 'base64');
    if (encoded.length > config.maxSnapshotBytes) throw new Error('Journal entry limit');
    const entry = object(JSON.parse(encoded.toString('utf8')));
    if (typeof entry.changeset !== 'string' || !Array.isArray(entry.removed)) throw new Error('Invalid journal entry');
    if (entry.changeset) replica.applyChangeset(Buffer.from(entry.changeset, 'base64'));
    const requests = { ...state.requests, ...object(entry.updates) } as Record<string, Dedup>;
    for (const key of entry.removed) { if (typeof key !== 'string') throw new Error('Invalid request removal'); delete requests[key]; }
    if (Object.keys(requests).length > input.maxRequests) throw new Error('Request capacity');
    state = { ...state, requests };
  }
  state = { ...state, snapshot: replica.exportSnapshot() };
  if (Buffer.byteLength(JSON.stringify(state)) > config.maxStateBytes) throw new Error('Restored state limit');
  replicationBytes = manifest.bytes;
  await cleanup(manifest.generation);
}
async function tick(): Promise<void> {
  if (stopped) return;
  try {
    if (active) {
      const started = Date.now();
      const response = await client.request('/v3/lease/keepalive', { ID: lease }, true);
      const result = object(response.result);
      const ttl = Number(result.TTL);
      if (!Number.isSafeInteger(ttl) || ttl < 1 || String(result.ID) !== lease) throw new Error('Lease expired');
      deadline = started + ttl * 1000 - config.requestTimeoutMs;
      await fence();
      return;
    }
    const range = await client.request('/v3/kv/range', { key: leaderKey });
    const kv = Array.isArray(range.kvs) ? range.kvs[0] : undefined;
    if (kv) {
      const record = object(kv);
      leader = object(JSON.parse(Buffer.from(String(record.value), 'base64').toString('utf8')));
      return;
    }
    leader = undefined;
    const grant = await client.request('/v3/lease/grant', { TTL: String(config.leaseTtlSeconds) });
    lease = String(grant.ID);
    if (!/^[1-9][0-9]*$/.test(lease)) throw new Error('Invalid lease');
    leaderValue = JSON.stringify({ nodeId: config.nodeId, url: config.control.advertiseUrl, epoch: randomUUID() });
    const elected = await client.request('/v3/kv/txn', { compare: [{ key: leaderKey, target: 'VERSION', result: 'EQUAL', version: '0' }], success: [{ requestPut: { key: leaderKey, value: base64(leaderValue), lease } }] });
    if (elected.succeeded !== true) { await client.request('/v3/lease/revoke', { ID: lease }); lease = ''; return; }
    active = true;
    deadline = Date.now() + config.leaseTtlSeconds * 1000 - config.requestTimeoutMs;
    leader = object(JSON.parse(leaderValue));
    recovering = true;
    const restored = await client.request('/v3/kv/range', { key: stateKey });
    const stored = Array.isArray(restored.kvs) ? restored.kvs[0] : undefined;
    if (stored) await restore(object(stored));
    else {
      state = { version: 1, snapshot: '', requests: {} }; revision = '0'; manifest = undefined;
      durableText = JSON.stringify(state); replicationBytes = Buffer.byteLength(durableText);
      replica.importSnapshot('');
      await cleanup();
    }
    await fence();
    recovering = false;
    parentPort?.postMessage({ event: 'elected', snapshot: state.snapshot, epoch: object(JSON.parse(leaderValue)).epoch });
  } catch { recovering = false; lose(); leader = undefined; }
}
parentPort?.on('message', (request: { command: string; value?: unknown; epoch?: string; shared: SharedArrayBuffer }) => {
  if (request.command === 'health' && recovering) {
    const signal = new Int32Array(request.shared, 0, 4);
    const bytes = new Uint8Array(request.shared, 16);
    const encoded = Buffer.from(JSON.stringify({ result: { enabled: true, nodeId: config.nodeId, role: 'recovering', healthy: false, leaseRemainingMs: Math.max(0, deadline - Date.now()), revision, replicationBytes } }));
    bytes.set(encoded); Atomics.store(signal, 1, encoded.length); Atomics.store(signal, 0, 1); Atomics.notify(signal, 0);
    return;
  }
  void enqueue(async () => {
    const signal = new Int32Array(request.shared, 0, 4);
    const bytes = new Uint8Array(request.shared, 16);
    try {
      if (request.epoch !== undefined && (!active || leader?.epoch !== request.epoch)) throw new Error('cluster_unavailable');
      let result: unknown;
      switch (request.command) {
        case 'health': {
          try {
            if (active) await fence();
            else {
              const response = await client.request('/v3/kv/range', { key: leaderKey });
              const entry = Array.isArray(response.kvs) ? response.kvs[0] : undefined;
              leader = entry ? object(JSON.parse(Buffer.from(String(object(entry).value), 'base64').toString('utf8'))) : undefined;
            }
          } catch { leader = undefined; if (active) lose(); }
          result = { enabled: true, nodeId: config.nodeId, role: active && Date.now() < deadline ? 'leader' : leader ? 'follower' : 'unavailable', healthy: !!leader && (!active || Date.now() < deadline), leaseRemainingMs: Math.max(0, deadline - Date.now()), revision, leaderId: leader?.nodeId, replicationBytes, url: leader?.url, epoch: leader?.epoch, dedupEntries: Object.keys(state.requests).length, dedupIndeterminate: Object.values(state.requests).filter(item => !item.replies).length, dedupCapacity: input.maxRequests, dedupPerPlayerCapacity: input.maxPlayerRequests, dedupWindowMs: input.requestTtlMs, dedupPolicy: 'Completed outcomes expire after replay window; indeterminate reservations never replay and retain bounded per-player tombstones' };
          break;
        }
        case 'fence': await fence(); result = true; break;
        case 'changeset': {
          if (!(request.value instanceof Uint8Array)) throw new Error('Invalid changeset');
          await persist(state, request.value); result = true; break;
        }
        case 'reserve': {
          await fence();
          const value = object(request.value);
          const key = String(value.key);
          const prior = state.requests[key];
          if (prior && (!prior.replies || prior.expiresAt > Date.now())) { result = prior.digest !== value.digest ? { status: 'conflict' } : prior.replies ? { status: 'complete', replies: prior.replies } : { status: 'indeterminate' }; break; }
          const requests = { ...state.requests };
          for (const [id, item] of Object.entries(requests)) if (item.replies && item.expiresAt <= Date.now()) delete requests[id];
          // Pending outcomes never expire into replayability: bounded capacity fails closed.
          if (Object.keys(requests).length >= input.maxRequests) throw new Error('request_capacity');
          if (Object.values(requests).filter(item => item.owner === value.owner).length >= input.maxPlayerRequests) throw new Error('request_capacity');
          requests[key] = { digest: String(value.digest), owner: String(value.owner), expiresAt: Date.now() + input.requestTtlMs };
          await persist({ ...state, requests }); result = { status: 'reserved' }; break;
        }
        case 'complete': {
          const value = object(request.value);
          const key = String(value.key);
          const prior = state.requests[key];
          if (!prior || !Array.isArray(value.replies)) throw new Error('request_indeterminate');
          await persist({ ...state, requests: { ...state.requests, [key]: { ...prior, expiresAt: Date.now() + input.requestTtlMs, replies: value.replies as Json[] } } }); result = true; break;
        }
        case 'stop': stopped = true; if (lease) await client.request('/v3/lease/revoke', { ID: lease }); replica.close(); lose(); result = true; break;
        default: throw new Error('Invalid coordination command');
      }
      const encoded = Buffer.from(JSON.stringify({ result }));
      if (encoded.length > bytes.length) throw new Error('Coordination reply limit');
      bytes.set(encoded); Atomics.store(signal, 1, encoded.length); Atomics.store(signal, 0, 1);
    } catch (error) {
      const safe = error instanceof Error && ['storage_full', 'request_capacity', 'request_indeterminate'].includes(error.message) ? error.message : 'cluster_unavailable';
      const encoded = Buffer.from(JSON.stringify({ error: safe })); bytes.set(encoded); Atomics.store(signal, 1, encoded.length); Atomics.store(signal, 0, 2);
    } finally { Atomics.notify(signal, 0); }
  });
});
const timer = setInterval(() => { void enqueue(tick); }, Math.max(250, config.leaseTtlSeconds * 1000 / 3));
void enqueue(tick);
parentPort?.on('close', () => clearInterval(timer));
