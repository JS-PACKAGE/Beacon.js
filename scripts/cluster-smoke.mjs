// Isolated real-etcd exercise; this tool NEVER starts/stops or reconfigures etcd.
// Prerequisites: built dist/, Node26, 3 healthy etcd v3 JSON gateways; unique unused TCP ports.
// node scripts/cluster-smoke.mjs --endpoints http://127.0.0.1:23791,http://127.0.0.1:23792,http://127.0.0.1:23793 --base-port 29100 --quorum-marker /tmp/beacon-quorum-lost
// After QUORUM_READY, the infrastructure owner stops TWO etcd members, then creates the marker.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import { mkdtemp, writeFile, access, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import WebSocket from 'ws';
import { loadConfig } from '../dist/config.js';

const args = process.argv.slice(2);
const option = (name, fallback) => { const index = args.indexOf(name); return index < 0 ? fallback : args[index + 1]; };
const endpoints = option('--endpoints', 'http://127.0.0.1:23791,http://127.0.0.1:23792,http://127.0.0.1:23793').split(',');
const base = Number(option('--base-port', '29100'));
const marker = option('--quorum-marker', '');
const tlsDirectory = option('--tls-directory', '');
const etcdUsername = option('--etcd-user', '');
const etcdPasswordPath = option('--etcd-password-file', '');
if (tlsDirectory && (!etcdUsername || !etcdPasswordPath || endpoints.some(endpoint => new URL(endpoint).protocol !== 'https:'))) throw new Error('TLS smoke requires HTTPS etcd, username and a private password file');
if (endpoints.length < 3 || !Number.isInteger(base) || base < 1024 || base > 65000) throw new Error('Provide three isolated etcd endpoints and a valid base port');
const dir = await mkdtemp(join(tmpdir(), 'beacon-ha-smoke-'));
const secret = randomUUID() + randomUUID();
const token = randomUUID();
await writeFile(join(dir, 'control.secret'), secret, { mode: 0o600 });
await writeFile(join(dir, 'operations.secret'), token, { mode: 0o600 });
const nodes = [];
const clients = [];
const providerOperations = new Map();
const providerMatches = new Map();
let holdAdmissions = false;
let admissionPending = false;
let releaseAdmission;
const gameServer = createServer(async (request, response) => {
  const send = (status, value) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(value)); };
  if (request.method === 'POST' && request.url === '/v1/matches') {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    let match = providerOperations.get(input.operationId);
    if (!match) { match = { matchId: `match-${randomUUID()}`, state: 'in_game', serverUrl: 'wss://game.invalid/session', expiresAt: Date.now() + 300000, tickets: Object.fromEntries(input.players.map(player => [player.id, `test-ticket-${player.id}`])) }; providerOperations.set(input.operationId, match); providerMatches.set(match.matchId, match); }
    send(201, match); return;
  }
  if (request.method === 'POST' && /^\/v1\/matches\/[^/]+\/admissions$/.test(request.url)) {
    let text = ''; for await (const chunk of request) text += chunk;
    const input = JSON.parse(text);
    if (holdAdmissions) {
      const held = Promise.withResolvers(); releaseAdmission = held.resolve; admissionPending = true;
      await held.promise;
      send(200, { serverUrl: 'wss://game.invalid/session', expiresAt: Date.now() + 300000, ticket: 'STALE-ADMISSION-MUST-NOT-LEAK' }); return;
    }
    send(200, { serverUrl: 'wss://game.invalid/session', expiresAt: Date.now() + 300000, ticket: `test-ticket-${input.playerId}` }); return;
  }
  const id = decodeURIComponent(request.url.split('/').at(-1));
  if (request.method === 'GET' && providerMatches.has(id)) { send(200, { state: providerMatches.get(id).state }); return; }
  if (request.method === 'DELETE' && providerMatches.has(id)) { providerMatches.get(id).state = 'ended'; send(200, {}); return; }
  send(404, {});
});
const listening = Promise.withResolvers(); gameServer.listen(0, '127.0.0.1', listening.resolve); await listening.promise;
const gamePort = gameServer.address().port;
async function until(operation, timeout = 30000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) { try { const value = await operation(); if (value) return value; } catch {} await sleep(150); }
  throw new Error('HA condition deadline');
}
async function admin(node, path, body) {
  const response = await fetch(`http://127.0.0.1:${node.ops}/${path}`, { method: body ? 'POST' : 'GET', headers: { Authorization: `Bearer ${token}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(5000) });
  return { status: response.status, body: await response.json() };
}
function launch(node) {
  node.process = spawn(process.execPath, ['dist/main.js', '--config', node.path, '--dev-insecure-ws', '--dev-mock-auth'], { stdio: ['ignore', 'pipe', 'pipe'] });
  node.output = '';
  for (const stream of [node.process.stdout, node.process.stderr]) stream.on('data', data => { node.output = (node.output + data.toString()).slice(-8192); });
}
async function leader(excluded = []) {
  return until(async () => {
    for (const node of nodes.filter(node => !excluded.includes(node) && node.process.exitCode === null)) {
      const result = await admin(node, 'cluster');
      if (result.status === 200 && result.body.role === 'leader' && result.body.healthy && result.body.leaseRemainingMs > 0) {
        const ready = await admin(node, 'ready');
        if (ready.status === 200) return node;
      }
    }
  }, 45000);
}
async function connect(node, player) {
  const ws = new WebSocket(`ws://127.0.0.1:${node.port}`);
  const messages = [];
  ws.on('message', bytes => messages.push(JSON.parse(bytes.toString())));
  const open = Promise.withResolvers(); ws.once('open', open.resolve); ws.once('error', open.reject); await open.promise;
  const client = { ws, messages, async command(value, id = randomUUID()) {
    const start = messages.length;
    ws.send(JSON.stringify({ ...value, requestId: id }));
    const result = await until(() => messages.slice(start).find(item => item.requestId === id && (item.type === 'result' || item.type === 'error')), 15000);
    assert.notEqual(result.ok, false, `Command rejected: ${result.code}`);
    return messages.slice(start);
  } };
  clients.push(client);
  await client.command({ type: 'auth', token: `dev-${player}`, protocolVersion: 3 });
  return client;
}
async function select(client) { await client.command({ type: 'select_game', gameId: 'g-001' }); }
async function stop(node, signal = 'SIGKILL') {
  if (node.process.exitCode !== null || node.process.signalCode !== null) return;
  const exited = Promise.withResolvers(); node.process.once('exit', exited.resolve); node.process.kill(signal); await exited.promise;
}
let passed = false;
try {
  const template = await loadConfig('config.yaml', { insecureWs: true, mockAuth: true });
  for (let index = 0; index < 3; index++) {
    const config = structuredClone(template);
    const node = { id: `smoke-${index}`, port: base + index, control: base + 10 + index, ops: base + 20 + index, path: join(dir, `node-${index}.yaml`) };
    Object.assign(config.server, { listenHost: '127.0.0.1', listenPort: node.port, allowNoOrigin: true });
    Object.assign(config.limits, { messageBurst: 1000, connectionBurst: 1000, maxConnectionsPerIp: 100, maintenanceIntervalMs: 500 });
    config.db.path = join(dir, `node-${index}.db`);
    config.games.timeoutMs = 30000;
    config.games.sessionApiUrl = `http://127.0.0.1:${gamePort}`;
    config.lobby.reconnectGraceMs = 120000;
    config.operations.enabled = true; config.operations.listenPort = node.ops; config.operations.tokenFile = join(dir, 'operations.secret'); config.operations.drainTimeoutMs = 0;
    config.cluster = { ...config.cluster, enabled: true, development: true, nodeId: node.id, endpoints, prefix: `/beacon-smoke/${dir.split('/').at(-1)}`, leaseTtlSeconds: 6, requestTimeoutMs: 800, maxSnapshotBytes: 524288, maxStateBytes: 67108864, checkpointInterval: 8, control: { listenHost: '127.0.0.1', listenPort: node.control, advertiseUrl: `ws://127.0.0.1:${node.control}`, secretPath: join(dir, 'control.secret'), certPath: '', keyPath: '', caPath: '' }, etcd: { username: '', passwordPath: '', caPath: '', certPath: '', keyPath: '' } };
    if (tlsDirectory) {
      config.cluster.development = false;
      Object.assign(config.cluster.control, {
        advertiseUrl: `wss://127.0.0.1:${node.control}`,
        certPath: join(tlsDirectory, 'server.pem'), keyPath: join(tlsDirectory, 'server.key'), caPath: join(tlsDirectory, 'ca.pem'),
      });
      Object.assign(config.cluster.etcd, { username: etcdUsername, passwordPath: etcdPasswordPath, caPath: join(tlsDirectory, 'ca.pem') });
    }
    await writeFile(node.path, JSON.stringify(config), { mode: 0o600 }); nodes.push(node); launch(node);
  }
  let initialLeader = await leader();
  const alice = await connect(nodes[0], 'alice'); const bob = await connect(nodes[1], 'bob');
  await select(alice); await select(bob);
  await alice.command({ type: 'friend_request', playerId: 'bob' }); await bob.command({ type: 'friend_respond', playerId: 'alice', accept: true });
  const createId = 'stable-create';
  const created = await alice.command({ type: 'create_room', name: 'Durable HA room', joinPolicy: 'fill' }, createId);
  const room = created.find(item => item.type === 'room_joined').room;
  await bob.command({ type: 'join_room', roomId: room.id });
  await alice.command({ type: 'ready', ready: true }); await bob.command({ type: 'ready', ready: true });
  const started = await alice.command({ type: 'start_game' });
  const matchId = started.find(item => item.type === 'game_started').matchId;
  const admissionGateway = nodes.find(node => node !== initialLeader);
  const admissionClient = await connect(admissionGateway, 'bob');
  await select(admissionClient);
  holdAdmissions = true;
  admissionClient.ws.send(JSON.stringify({ type: 'sync_state', requestId: 'old-authority-admission' }));
  await until(() => admissionPending);
  const pausedAdmissionLeader = initialLeader;
  pausedAdmissionLeader.process.kill('SIGSTOP');
  initialLeader = await leader([pausedAdmissionLeader]);
  holdAdmissions = false;
  releaseAdmission();
  pausedAdmissionLeader.process.kill('SIGCONT');
  await sleep(2000);
  assert.equal(admissionClient.messages.some(item => item.ticket === 'STALE-ADMISSION-MUST-NOT-LEAK'), false);
  assert.equal(admissionClient.messages.some(item => item.requestId === 'old-authority-admission' && item.type === 'result' && item.ok === true), false);
  console.log('PASS paused provider admission cannot escape expired authority after failover');
  assert.equal((await admin(initialLeader, 'matches/player-result', { matchId, playerId: 'alice', result: { score: 9 } })).status, 200);
  providerMatches.get(matchId).state = 'ended';
  assert.equal((await admin(initialLeader, 'matches/result', { matchId, state: 'ended' })).status, 200);
  assert.equal(bob.messages.some(item => item.type === 'match_result' && item.result?.score === 9), false);
  await stop(initialLeader);
  const replacement = await leader([initialLeader]);
  const surviving = nodes.filter(node => node !== initialLeader);
  const recoveredAlice = await connect(surviving[0], 'alice'); const recoveredBob = await connect(surviving[1], 'bob');
  await select(recoveredAlice); await select(recoveredBob);
  const friends = await recoveredAlice.command({ type: 'list_friends' });
  assert.equal(friends.some(item => item.friends?.some(friend => friend.playerId === 'bob' && friend.status === 'accepted')), true);
  const results = await recoveredAlice.command({ type: 'list_match_results' });
  assert.equal(results.some(item => item.results?.some(result => result.matchId === matchId && result.result.score === 9)), true);
  const bobResults = await recoveredBob.command({ type: 'list_match_results' });
  assert.equal(bobResults.some(item => item.results?.some(result => result.playerId === 'alice')), false);
  const replay = await recoveredAlice.command({ type: 'create_room', name: 'Durable HA room', joinPolicy: 'fill' }, createId);
  assert.equal(replay.some(item => item.replayed === true), true);
  assert.equal((await admin(replacement, 'rooms')).body.items.some(item => item.id === room.id), true);
  // Restart killed node against its ORIGINAL local file; it must materialize authority, not bootstrap stale data.
  launch(initialLeader); await until(async () => (await admin(initialLeader, 'cluster')).status === 200);
  const pausedClient = await connect(replacement, 'carol'); await select(pausedClient);
  replacement.process.kill('SIGSTOP');
  pausedClient.ws.send(JSON.stringify({ type: 'create_room', name: 'Stale forbidden', requestId: 'paused-stale' }));
  const fencedLeader = await leader([replacement]);
  replacement.process.kill('SIGCONT');
  await sleep(2000);
  assert.equal(pausedClient.messages.some(item => item.requestId === 'paused-stale' && item.type === 'result' && item.ok === true), false);
  assert.equal((await admin(fencedLeader, 'rooms')).body.items.some(item => item.name === 'Stale forbidden'), false);
  console.log('PASS election, cross-gateway shared rooms/social/private results, kill+restore, restart dedup, paused stale-writer fencing');
  if (marker) {
    const quorumClient = await connect(fencedLeader, 'carol'); await select(quorumClient);
    console.log(`QUORUM_READY ${marker}`);
    await until(async () => { try { await access(marker); return true; } catch { return false; } }, 180000);
    quorumClient.ws.send(JSON.stringify({ type: 'create_room', name: 'No quorum forbidden', requestId: 'quorum-write' }));
    await sleep(10000);
    assert.equal(quorumClient.messages.some(item => item.requestId === 'quorum-write' && item.type === 'result' && item.ok === true), false);
    for (const node of nodes) {
      const mutation = await admin(node, 'maintenance', { enabled: false });
      assert.equal([409, 503].includes(mutation.status), true);
      const readiness = await admin(node, 'ready'); assert.equal(readiness.status, 503);
    }
    console.log('PASS real etcd quorum loss rejects writes/admin and fails readiness closed');
  } else console.log('QUORUM NOT EXERCISED: rerun with --quorum-marker and stop two isolated etcd members externally');
  passed = true;
} finally {
  releaseAdmission?.();
  for (const client of clients) client.ws.terminate();
  for (const node of nodes) { if (node.process.exitCode === null && node.process.signalCode === null) { node.process.kill('SIGCONT'); await stop(node); } }
  await new Promise(resolve => gameServer.close(resolve));
  if (passed) await rm(dir, { recursive: true, force: true });
  else {
    for (const node of nodes) {
      const events = node.output.split('\n').flatMap(line => {
        try { const value = JSON.parse(line); return typeof value.event === 'string' && /^[a-z_]{1,80}$/.test(value.event) ? [{ event: value.event }] : []; } catch { return []; }
      });
      await writeFile(join(dir, `${node.id}.events.json`), JSON.stringify({ exitCode: node.process.exitCode, signal: node.process.signalCode, events }), { mode: 0o600 });
    }
    console.error(`Smoke evidence retained privately at ${dir}`);
  }
}
