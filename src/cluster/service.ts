import { readFileSync } from 'node:fs';
import { WebSocket } from 'ws';
import type { Config, DevOptions } from '../config.js';
import type { Peer } from '../types.js';
import type { ClientMessage } from '../protocol/index.js';
import { startTransport, markAuthenticated, peerOrigin, type ControlTransport } from '../net/index.js';
import { startOperations, OperationsError, type OperationsHooks, type OperationsService } from '../ops/index.js';
import { ClusterCoordinator } from './index.js';
import { privateFile, object } from './etcd.js';
import { SqliteRoomStore } from '../store/index.js';
import type { BeaconService, BeaconOverrides } from '../main.js';

interface Tunnel { socket?: WebSocket; epoch?: string; ready: Promise<void>; resolve(): void; reject(error: Error): void }
export async function startClusterBeacon(config: Config, dev: DevOptions, factory: (config: Config, dev: DevOptions, overrides: BeaconOverrides) => Promise<BeaconService>, overrides: BeaconOverrides): Promise<BeaconService> {
  if (overrides.store) throw new Error('Cluster requires local SQLite materialization');
  const secret = privateFile(config.cluster.control.secretPath).toString('utf8').trim();
  if (!/^[\x21-\x7e]{32,4096}$/.test(secret)) throw new Error('Invalid cluster control credential');
  let authority: BeaconService | undefined;
  let hooks: OperationsHooks | undefined;
  let desiredEpoch: string | undefined;
  let stopped = false;
  let lifecycle = Promise.resolve();
  let operations: OperationsService | undefined;
  const tunnels = new Map<Peer, Tunnel>();
  const closeTunnels = (): void => {
    for (const [peer, tunnel] of tunnels) { tunnel.socket?.terminate(); tunnel.reject(new Error('Authority changed')); peer.close(1013, 'Authority changed; reconnect and sync'); }
    tunnels.clear();
  };
  const coordinator = new ClusterCoordinator(config, (snapshot, epoch) => {
    desiredEpoch = epoch;
    lifecycle = lifecycle.then(async () => {
      await authority?.close().catch(() => undefined); authority = undefined; hooks = undefined;
      if (stopped || desiredEpoch !== epoch) return;
      const store = new SqliteRoomStore(config.db.path);
      try {
        coordinator.assertLeader(epoch);
        store.importSnapshot(snapshot);
        store.setChangesetHook(value => coordinator.commitChangeset(value, epoch));
        store.setDurabilityFailureHook(() => {
          coordinator.invalidate();
          desiredEpoch = undefined;
          closeTunnels();
        });
        const control: ControlTransport = { secret, assertLeader: () => coordinator.assertLeader(epoch) };
        const runtimeConfig: Config = { ...config, server: { ...config.server, listenHost: config.cluster.control.listenHost, listenPort: config.cluster.control.listenPort }, operations: { ...config.operations, drainTimeoutMs: 0 } };
        authority = await factory(runtimeConfig, dev, { ...overrides, store, coordinator, authorityEpoch: epoch, control, operationsFactory: async value => {
          hooks = value;
          return { address: () => operations?.address(), metric: (name, amount) => operations?.metric(name, amount), async close() {} };
        } });
        if (stopped || desiredEpoch !== epoch) { await authority.close().catch(() => undefined); authority = undefined; hooks = undefined; }
      } catch { try { store.close(); } catch { /* Startup may already have closed the materialization. */ } hooks = undefined; await coordinator.close(); }
    }).catch(() => undefined);
  }, () => {
    desiredEpoch = undefined; closeTunnels();
    lifecycle = lifecycle.then(async () => { await authority?.close().catch(() => undefined); authority = undefined; hooks = undefined; }).catch(() => undefined);
  });
  const required = (): OperationsHooks => {
    if (!hooks || !authority) throw new OperationsError(409, 'not_leader');
    try { coordinator.assertLeader(desiredEpoch); } catch { throw new OperationsError(503, 'unavailable'); }
    return hooks;
  };
  const stats = (): Record<string, unknown> => ({ ...(authority?.stats() ?? {}), connections: tunnels.size, cluster: coordinator.health() });
  try {
    operations = await startOperations(config, {
      stats, ready: () => !!authority && coordinator.health().role === 'leader' && !!hooks?.ready(),
      ban: (id, until, reason) => required().ban(id, until, reason), unban: id => required().unban(id), revoke: (id, before) => required().revoke(id, before), closeRoom: id => required().closeRoom(id), reportMatch: (id, state) => required().reportMatch(id, state), reportPlayerResult: (id, player, result) => required().reportPlayerResult(id, player, result), maintenance: enabled => required().maintenance(enabled), audit: limit => required().audit(limit), rooms: (cursor, limit) => required().rooms(cursor, limit), room: id => required().room(id), matches: (cursor, limit) => required().matches(cursor, limit), match: id => required().match(id), queueDiagnostics: () => required().queueDiagnostics(), integrations: () => required().integrations(), clusterHealth: () => coordinator.health(), authorizeMutation: () => { required(); }, reconcileMatch: id => required().reconcileMatch(id), chatReports: (cursor, limit) => required().chatReports(cursor, limit), chatReport: id => required().chatReport(id), reviewChatReport: (id, action, until, reason) => required().reviewChatReport(id, action, until, reason),
    });
    const transport = await startTransport(config, dev, {
      onConnect(peer) {
        const barrier = Promise.withResolvers<void>();
        // Handshake rejection is also observed when no command arrives before disconnect.
        void barrier.promise.catch(() => undefined);
        const tunnel: Tunnel = { ready: barrier.promise, resolve: () => barrier.resolve(), reject: barrier.reject };
        tunnels.set(peer, tunnel);
        const health = coordinator.health();
        if (!health.healthy || !health.url || !health.epoch) { tunnel.reject(new Error('Authority unavailable')); peer.close(1013, 'Authority unavailable'); return; }
        const url = new URL(health.url);
        if (!['wss:', 'ws:'].includes(url.protocol) || (!config.cluster.development && url.protocol !== 'wss:') || url.username || url.password) { peer.close(1013, 'Invalid authority'); return; }
        tunnel.epoch = health.epoch;
        const origin = peerOrigin(peer);
        const socket = new WebSocket(url, { handshakeTimeout: config.cluster.requestTimeoutMs, maxPayload: config.limits.outboundBytes, perMessageDeflate: false, headers: { Authorization: `Bearer ${secret}`, 'x-beacon-ip': peer.ip, ...(origin !== undefined ? { 'x-beacon-origin': origin } : {}) }, ...(config.cluster.control.caPath ? { ca: readFileSync(config.cluster.control.caPath) } : {}), minVersion: 'TLSv1.2' });
        tunnel.socket = socket;
        socket.on('open', () => tunnel.resolve());
        socket.on('message', (data, binary) => {
          if (binary) { socket.terminate(); return; }
          try {
            const message = object(JSON.parse(data.toString()));
            if (message.type === 'hello') return;
            const current = coordinator.health();
            if (!current.healthy || current.epoch !== tunnel.epoch) {
              socket.terminate();
              peer.close(1013, 'Authority changed; reconnect and sync');
              return;
            }
            if (message.type === 'auth_ok' || message.type === 'auth_refreshed') markAuthenticated(peer, typeof message.expiresAt === 'number' ? message.expiresAt : undefined);
            peer.send(message);
          } catch { socket.terminate(); }
        });
        socket.on('error', () => { tunnel.reject(new Error('Authority unavailable')); peer.close(1013, 'Authority unavailable'); });
        socket.on('close', () => { tunnel.reject(new Error('Authority disconnected')); peer.close(1013, 'Authority disconnected; reconnect and sync'); });
      },
      async onMessage(peer, message: ClientMessage) {
        const tunnel = tunnels.get(peer);
        if (!tunnel) return;
        try {
          await tunnel.ready;
          const health = coordinator.health();
          if (!health.healthy || health.epoch !== tunnel.epoch || tunnel.socket?.readyState !== WebSocket.OPEN) throw new Error('Authority changed');
          const text = JSON.stringify(message);
          if (tunnel.socket.bufferedAmount + Buffer.byteLength(text) > config.limits.maxBufferedBytes) throw new Error('Control backpressure');
          tunnel.socket.send(text);
        } catch { peer.close(1013, 'Authority unavailable; reconnect and sync'); }
      },
      onClose(peer) { const tunnel = tunnels.get(peer); tunnel?.socket?.terminate(); tunnel?.reject(new Error('Client disconnected')); tunnels.delete(peer); },
    });
    const healthTimer = setInterval(() => {
      try {
        const health = coordinator.health();
        for (const [peer, tunnel] of tunnels) if (!health.healthy || health.epoch !== tunnel.epoch) peer.close(1013, 'Authority changed; reconnect and sync');
      } catch { closeTunnels(); }
    }, Math.max(250, config.cluster.requestTimeoutMs));
    healthTimer.unref();
    const activeOperations = operations;
    return { address: () => transport.address(), operationsAddress: () => activeOperations.address(), stats, async close() {
      if (stopped) return;
      stopped = true; desiredEpoch = undefined; clearInterval(healthTimer); closeTunnels();
      await transport.close(); await lifecycle; await authority?.close().catch(() => undefined); await coordinator.close(); await activeOperations.close();
    } };
  } catch (error) { stopped = true; await coordinator.close(); await authority?.close().catch(() => undefined); await operations?.close(); throw error; }
}
