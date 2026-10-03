import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loadConfig } from '../dist/config.js';
import { startBeacon } from '../dist/main.js';

// Isolated local development exercise: never connects to or mutates a production lobby.
const args = process.argv.slice(2);
let clients = 100; let rounds = 1; let roomSize = 8;
for (let i = 0; i < args.length; i++) {
  const key = args[i]; const value = Number(args[++i]);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error('Expected a positive integer');
  if (key === '--clients' && value <= 10000) clients = value;
  else if (key === '--rounds' && value <= 100) rounds = value;
  else if (key === '--room-size' && value <= 200) roomSize = value;
  else throw new Error('Usage: node scripts/load.mjs [--clients 1..10000] [--rounds 1..100] [--room-size 1..200]');
}
const dir = await mkdtemp(join(tmpdir(), 'beacon-load-'));
const config = await loadConfig('config.yaml', { mockAuth: true, insecureWs: true });
config.server.listenPort = 0; config.db.path = join(dir, 'load.db');
config.operations.enabled = false; config.operations.logPath = ''; config.operations.backupDirectory = ''; config.operations.alertUrl = ''; config.operations.drainTimeoutMs = 0;
config.auth.mode = 'mock'; config.auth.revocationUrl = ''; config.games.apiUrl = ''; config.games.sessionApiUrl = '';
config.lobby.reconnectGraceMs = 0;
Object.assign(config.limits, { maxConnections: clients + 10, maxConnectionsPerIp: clients + 10, connectionBurst: clients * 2 + 10, messageBurst: 10000, maxRoomsPerGame: clients + 10 });
config.auth.mockPlayers = Array.from({ length: clients }, (_, i) => ({ token: `load-${i}`, id: `load-${i}`, displayName: `Load ${i}` }));
config.games.fallback = [{ gameId: 'load', name: 'Capacity exercise', maxPlayersPerRoom: roomSize, enabled: true }];
const hist = monitorEventLoopDelay({ resolution: 10 }); hist.enable();
let service;
const sockets = [];
const latencies = [];
let requests = 0; let received = 0; let sequence = 0;
const started = performance.now();
async function connect(index) {
  const ws = new WebSocket(`ws://127.0.0.1:${service.address().port}`);
  const pending = new Map();
  const hello = Promise.withResolvers();
  ws.addEventListener('message', event => {
    received++;
    const message = JSON.parse(event.data);
    if (message.type === 'hello') hello.resolve();
    const waiting = pending.get(message.requestId);
    if (!waiting) return;
    waiting.messages.push(message);
    if (message.type === 'result' || message.type === 'error') {
      clearTimeout(waiting.timer); pending.delete(message.requestId);
      if (message.type === 'error') waiting.reject(new Error(`Load operation rejected: ${message.code}`));
      else waiting.resolve(waiting.messages);
    }
  });
  ws.addEventListener('error', () => hello.reject(new Error('Load socket failed')));
  ws.addEventListener('close', () => { for (const waiting of pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error('Load socket closed')); } pending.clear(); });
  sockets.push(ws);
  await Promise.race([hello.promise, new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Load handshake timed out')), 10000); timer.unref(); })]);
  const request = message => new Promise((resolve, reject) => {
    const requestId = `load-request-${++sequence}`; const at = performance.now(); requests++;
    const timer = setTimeout(() => { pending.delete(requestId); reject(new Error('Load operation timed out')); }, 30000);
    pending.set(requestId, { messages: [], timer, reject, resolve: messages => { latencies.push(performance.now() - at); resolve(messages); } });
    ws.send(JSON.stringify({ ...message, requestId }));
  });
  await request({ type: 'auth', token: `load-${index}`, protocolVersion: 2 });
  await request({ type: 'select_game', gameId: 'load' });
  return { ws, request };
}
async function waves(peers, operation) {
  for (let index = 0; index < peers.length; index += 10) await Promise.all(peers.slice(index, index + 10).map(operation));
}
try {
  service = await startBeacon(config, { mockAuth: true, insecureWs: true });
  const peers = [];
  // Bound connection establishment so the exercise measures churn, not an artificial SYN flood.
  for (let i = 0; i < clients; i += 50) peers.push(...await Promise.all(Array.from({ length: Math.min(50, clients - i) }, (_, j) => connect(i + j))));
  for (let round = 0; round < rounds; round++) {
    for (let i = 0; i < peers.length; i += roomSize) {
      const group = peers.slice(i, i + roomSize);
      const created = await group[0].request({ type: 'create_room', name: `Load ${round}-${i}`, maxPlayers: group.length });
      const id = created.find(message => message.type === 'room_joined')?.room.id;
      if (!id) throw new Error('Create response omitted room identity');
      await waves(group.slice(1), peer => peer.request({ type: 'join_room', roomId: id }));
      await waves(group, peer => peer.request({ type: 'ready', ready: true }));
      await waves(group.slice(1), peer => peer.request({ type: 'leave_room' }));
      await group[0].request({ type: 'delete_room' });
    }
  }
  const state = service.stats();
  if (state.connections !== clients) throw new Error('Not all load clients remained connected');
  latencies.sort((a, b) => a - b);
  const percentile = fraction => latencies[Math.min(latencies.length - 1, Math.floor(latencies.length * fraction))];
  console.log(JSON.stringify({ scenario: 'isolated single-process server+clients; not a production capacity guarantee', clients, roomSize, rounds, requests, received, messagesPerRequest: Math.round(received / requests), elapsedMs: Math.round(performance.now() - started), latencyP50Ms: percentile(.5), latencyP95Ms: percentile(.95), eventLoopP99Ms: hist.percentile(99) / 1e6, rssBytes: process.memoryUsage().rss, final: state }, null, 2));
} finally {
  hist.disable();
  for (const ws of sockets) ws.close();
  await service?.close();
  await rm(dir, { recursive: true, force: true });
}
