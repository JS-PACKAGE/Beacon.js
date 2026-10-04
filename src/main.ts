import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { setTimeout as delay } from 'node:timers/promises';
import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { loadConfig, validateConfig } from './config.js';
import type { Config, DevOptions } from './config.js';
import { createAuthProvider } from './auth/index.js';
import { RevocationRegistry } from './auth/revocations.js';
import { GameRegistry } from './games/index.js';
import { RoomManager } from './lobby/index.js';
import { startTransport, markAuthenticated } from './net/index.js';
import type { Transport, ControlTransport } from './net/index.js';
import { PROTOCOL_VERSION, ProtocolError, errorMessage } from './protocol/index.js';
import type { ClientMessage } from './protocol/index.js';
import { RequestLedger } from './protocol/requests.js';
import { SqliteRoomStore } from './store/index.js';
import { log, configureLogging, closeLogging } from './log/index.js';
import { startOperations } from './ops/index.js';
import type { OperationsService, OperationsHooks } from './ops/index.js';
import type { AuthProvider, GameProvider, GameSessionProvider, Peer, Player, Revocation, RoomStore } from './types.js';
import type { ClusterCoordinator } from './cluster/index.js';
import { startClusterBeacon } from './cluster/service.js';

export interface BeaconService {
  address(): AddressInfo;
  operationsAddress(): AddressInfo | undefined;
  stats(): Record<string, unknown>;
  close(): Promise<void>;
}
interface Connection { raw: Peer; peer: Peer; player?: Player; reply?: (message: Record<string, unknown>) => void }
function revoked(player: Player, records: readonly Revocation[]): boolean {
  return records.some(record => (record.tokenId !== undefined && record.tokenId === player.tokenId) ||
    (record.playerId === player.id && (record.revokedBefore === undefined || player.issuedAt === undefined || player.issuedAt <= record.revokedBefore)));
}

export interface BeaconOverrides {
  store?: RoomStore; auth?: AuthProvider; games?: GameProvider; sessions?: GameSessionProvider;
  coordinator?: ClusterCoordinator; authorityEpoch?: string; control?: ControlTransport;
  operationsFactory?: (hooks: OperationsHooks) => Promise<OperationsService>;
}
export async function startBeacon(config: Config, dev: DevOptions, overrides: BeaconOverrides = {}): Promise<BeaconService> {
  if (config.cluster.enabled && !overrides.coordinator) {
    validateConfig(config, dev);
    return startClusterBeacon(config, dev, startBeacon, overrides);
  }
  validateConfig(config, dev);
  await configureLogging(config.operations);
  let store: RoomStore;
  try { store = overrides.store ?? new SqliteRoomStore(config.db.path); }
  catch (error) { await closeLogging(); throw error; }
  let transport: Transport | undefined;
  let operations: OperationsService | undefined;
  let lobby: RoomManager | undefined;
  const connections = new Map<string, Connection>();
  const ledger = new RequestLedger(config, overrides.coordinator ? {
    reserve: (player, request, digest) => overrides.coordinator!.reserve(player, request, digest, overrides.authorityEpoch),
    complete: (player, request, replies) => overrides.coordinator!.complete(player, request, replies, overrides.authorityEpoch),
  } : undefined);
  const inFlight = new Set<Promise<void>>();
  const eventLoop = monitorEventLoopDelay({ resolution: 20 });
  eventLoop.enable();
  let maintenance = false;
  let closing: Promise<void> | undefined;
  let revisionHealthy = !config.auth.revocationUrl;
  let revocations: readonly Revocation[] = [];
  let maintenanceJob: Promise<void> | undefined;
  let revocationJob: Promise<void> | undefined;
  let timer: NodeJS.Timeout | undefined;
  let revocationTimer: NodeJS.Timeout | undefined;
  try {
    const games = overrides.games ?? new GameRegistry(config.games);
    await games.list();
    const auth = overrides.auth ?? createAuthProvider(config.auth);
    const manager = new RoomManager(config, store, games, overrides.sessions);
    lobby = manager;
    const registry = new RevocationRegistry(config.auth);
    const refreshRevocations = async (): Promise<void> => {
      try {
        overrides.coordinator?.assertLeader(overrides.authorityEpoch);
        revocations = await registry.refresh();
        await manager.enforceRevocations(revocations);
        revisionHealthy = true;
      } catch {
        revisionHealthy = false;
        operations?.metric('revocation_errors');
        log('error', 'revocation_refresh_failed');
        // Configured revocation authority is mandatory: do not retain unverified sessions.
        for (const connection of connections.values()) connection.raw.close(4003, 'Authentication unavailable');
      }
    };
    if (config.auth.revocationUrl) await refreshRevocations();
    const stats = (): Record<string, unknown> => ({ ...manager.stats(), connections: connections.size, inFlight: inFlight.size, maintenance, revocationHealthy: revisionHealthy, eventLoopP99Ms: eventLoop.percentile(99) / 1e6, rssBytes: process.memoryUsage().rss, cluster: overrides.coordinator?.health() ?? { enabled: false, role: 'standalone', healthy: true } });
    const setMaintenance = (enabled: boolean): void => { maintenance = enabled; manager.setMaintenance(enabled); };
    const dispatch = async (connection: Connection, message: ClientMessage): Promise<void> => {
      const requestId = message.requestId;
      const started = performance.now();
      const direct = (value: Record<string, unknown>): void => connection.raw.send(requestId ? { ...value, requestId } : value);
      if (connection.raw.closed) return;
      try {
        overrides.coordinator?.assertLeader(overrides.authorityEpoch);
        if (message.type !== 'auth') {
          if (!connection.player) throw new ProtocolError('auth_required');
          if (connection.player.expiresAt !== undefined && connection.player.expiresAt <= Date.now()) throw new ProtocolError('auth_expired');
          if (!revisionHealthy || revoked(connection.player, revocations)) throw new ProtocolError('token_revoked');
        }
        await ledger.execute(connection.player?.id ?? connection.raw.id, message, direct, async reply => {
          connection.reply = reply;
          try {
            if (message.type === 'auth' || message.type === 'refresh_auth') {
              if (maintenance || closing) throw new ProtocolError('maintenance');
              if (!revisionHealthy) throw new ProtocolError('auth_failed');
              if (message.type === 'auth' && connection.player) throw new ProtocolError('bad_request');
              let player: Player;
              try { player = await auth.verify(message.token); }
              catch { throw new ProtocolError('auth_failed'); }
              if (connection.raw.closed) return;
              overrides.coordinator?.assertLeader(overrides.authorityEpoch);
              if (revoked(player, revocations)) throw new ProtocolError('token_revoked');
              if (message.type === 'refresh_auth') {
                if (player.id !== connection.player?.id) throw new ProtocolError('forbidden');
                await manager.refreshAuthentication(connection.peer, player);
              } else if (!(await manager.authenticate(connection.peer, player))) return;
              connection.player = player;
              markAuthenticated(connection.raw, player.expiresAt);
              reply({ type: message.type === 'auth' ? 'auth_ok' : 'auth_refreshed', protocolVersion: PROTOCOL_VERSION, player: { id: player.id, displayName: player.displayName }, ...(player.expiresAt !== undefined ? { expiresAt: player.expiresAt } : {}) });
              if (message.type === 'auth') await manager.handle(connection.peer, { type: 'sync_state' });
            } else {
              if ((maintenance || closing) && ['create_room', 'join_room', 'quick_join', 'queue_join', 'start_game', 'party_create', 'party_accept'].includes(message.type)) throw new ProtocolError('maintenance');
              overrides.coordinator?.assertLeader(overrides.authorityEpoch);
              await manager.handle(connection.peer, message);
            }
            if (requestId) reply({ type: 'result', ok: true });
            operations?.metric('requests_ok');
          } catch (error) {
            const code = error instanceof ProtocolError ? error.code : 'server_error';
            if (code === 'server_error') log('error', 'request_failed');
            reply({ ...errorMessage(code), ok: false });
            operations?.metric(`errors_${code}`);
            if (message.type === 'auth') {
              reply({ type: 'auth_fail', code, ok: false });
              connection.raw.close(4003, 'Authentication failed');
            } else if (code === 'auth_expired' || code === 'token_revoked') connection.raw.close(4003, 'Authentication expired or revoked');
          } finally { delete connection.reply; }
        });
      } catch (error) {
        const code = error instanceof ProtocolError ? error.code : 'server_error';
        direct({ ...errorMessage(code), ok: false });
        if (code === 'auth_expired' || code === 'token_revoked') connection.raw.close(4003, 'Authentication expired or revoked');
      }
      finally {
        operations?.metric('request_duration_ms', performance.now() - started);
        operations?.metric('requests_total');
      }
    };
    transport = await startTransport(config, dev, {
      onConnect(raw) {
        const connection: Connection = { raw, peer: {
          id: raw.id, ip: raw.ip, get closed() { return raw.closed; },
          send(message) { raw.send(message); }, close(code, reason) { raw.close(code, reason); },
          reply(message) { if (connection.reply) connection.reply(message); else raw.send(message); },
        } };
        connections.set(raw.id, connection);
        manager.connect(connection.peer);
        operations?.metric('connections_opened');
      },
      onMessage(raw, message) {
        const connection = connections.get(raw.id);
        if (!connection) return Promise.resolve();
        const job = dispatch(connection, message);
        inFlight.add(job);
        void job.finally(() => inFlight.delete(job));
        return job;
      },
      onClose(raw) {
        const connection = connections.get(raw.id);
        if (connection) manager.disconnect(connection.peer);
        connections.delete(raw.id);
        operations?.metric('connections_closed');
      },
    }, overrides.control);
    const operationHooks: OperationsHooks = {
      stats, ready: () => !maintenance && !closing && revisionHealthy && manager.stats().storageHealthy !== false && (!overrides.coordinator || overrides.coordinator.health().role === 'leader'),
      ban: async (id, until, reason) => { await manager.banPlayer(id, until, reason); ledger.clearPlayer(id); },
      unban: id => manager.unbanPlayer(id),
      revoke: async (id, before) => { await manager.revokePlayer(id, before); ledger.clearPlayer(id); },
      closeRoom: id => manager.closeRoomById(id),
      reportMatch: (matchId, state) => manager.reportMatch(matchId, state),
      reportPlayerResult: (matchId, playerId, result) => manager.reportPlayerResult(matchId, playerId, result),
      maintenance: enabled => {
        store.audit({ at: Date.now(), actor: 'operator', action: 'maintenance', target: String(enabled) });
        setMaintenance(enabled);
      },
      audit: limit => store.listAudit(limit),
      rooms: (cursor, limit) => manager.listRooms(cursor, limit),
      room: id => manager.roomDetails(id),
      matches: (cursor, limit) => manager.listMatches(cursor, limit),
      match: id => manager.matchDetails(id),
      queueDiagnostics: () => manager.queueDiagnostics(),
      integrations: () => manager.integrations(),
      clusterHealth: () => overrides.coordinator?.health() ?? { enabled: false, role: 'standalone', healthy: true },
      authorizeMutation: () => { overrides.coordinator?.assertLeader(overrides.authorityEpoch); },
      reconcileMatch: id => manager.reconcileMatch(id),
      chatReports: (cursor, limit) => manager.chatReports(cursor, limit),
      chatReport: id => manager.chatReport(id),
      reviewChatReport: (id, action, until, reason) => manager.reviewChatReport(id, action, until, reason),
    };
    operations = await (overrides.operationsFactory ? overrides.operationsFactory(operationHooks) : startOperations(config, operationHooks));
    timer = setInterval(() => {
      if (maintenanceJob || closing) return;
      ledger.sweep();
      maintenanceJob = Promise.resolve().then(() => { overrides.coordinator?.assertLeader(overrides.authorityEpoch); return manager.maintain(); }).catch(() => { operations?.metric('maintenance_errors'); log('error', 'maintenance_failed'); }).finally(() => { maintenanceJob = undefined; });
    }, config.limits.maintenanceIntervalMs);
    timer.unref();
    if (config.auth.revocationUrl) {
      revocationTimer = setInterval(() => {
        if (revocationJob || closing) return;
        revocationJob = refreshRevocations().finally(() => { revocationJob = undefined; });
      }, config.auth.revocationIntervalMs);
      revocationTimer.unref();
    }
    const activeTransport = transport;
    const activeOperations = operations;
    return {
      address: () => activeTransport.address(), operationsAddress: () => activeOperations.address(), stats,
      close() {
        closing ??= (async () => {
          clearInterval(timer);
          clearInterval(revocationTimer);
          setMaintenance(true);
          const deadline = Date.now() + config.operations.drainTimeoutMs;
          activeTransport.drain(deadline);
          if (connections.size && config.operations.drainTimeoutMs) await delay(config.operations.drainTimeoutMs);
          await activeTransport.close();
          await Promise.allSettled([...inFlight]);
          await Promise.allSettled([...(maintenanceJob ? [maintenanceJob] : []), ...(revocationJob ? [revocationJob] : [])]);
          try {
            await manager.close();
            await manager.settle();
          } finally {
            await activeOperations.close();
            ledger.clear();
            store.close();
            eventLoop.disable();
            await closeLogging();
          }
        })();
        return closing;
      },
    };
  } catch (error) {
    clearInterval(timer);
    clearInterval(revocationTimer);
    await transport?.close();
    await lobby?.close().catch(() => undefined);
    await operations?.close();
    store.close();
    eventLoop.disable();
    await closeLogging();
    throw error;
  }
}

async function main(): Promise<void> {
  if (Number(process.versions.node.split('.')[0]) < 26) throw new Error('Beacon.js requires Node.js 26 or later');
  process.umask(0o077);
  const dev: DevOptions = { insecureWs: false, mockAuth: false };
  let configPath = 'config.yaml';
  const args = process.argv.slice(2);
  for (let index = 0; index < args.length; index++) {
    const arg = args[index];
    if (arg === '--dev-insecure-ws') dev.insecureWs = true;
    else if (arg === '--dev-mock-auth') dev.mockAuth = true;
    else if (arg === '--config' && args[index + 1]) configPath = args[++index]!;
    else throw new Error(`Unknown or incomplete argument: ${arg}`);
  }
  const config = await loadConfig(configPath, dev);
  const service = await startBeacon(config, dev);
  log('info', 'listening', { address: service.address().address, port: service.address().port, domain: config.public.domain, tls: config.public.tls, development: dev.insecureWs || dev.mockAuth });
  let stopping = false;
  const stop = (): void => {
    if (stopping) return;
    stopping = true;
    void service.close().catch(() => { log('error', 'shutdown_failed'); process.exitCode = 1; });
  };
  process.once('SIGINT', stop);
  process.once('SIGTERM', stop);
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  void main().catch(error => {
    console.error(error instanceof Error ? error.message : 'Beacon.js startup failed');
    process.exitCode = 1;
  });
}
