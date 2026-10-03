import { pathToFileURL } from 'node:url';
import type { AddressInfo } from 'node:net';
import { loadConfig, validateConfig } from './config.js';
import type { Config, DevOptions } from './config.js';
import { createAuthProvider } from './auth/index.js';
import { GameRegistry } from './games/index.js';
import { RoomManager } from './lobby/index.js';
import { startTransport, markAuthenticated } from './net/index.js';
import { ProtocolError, errorMessage } from './protocol/index.js';
import { SqliteRoomStore } from './store/index.js';
import { log } from './log/index.js';
import type { AuthProvider, GameProvider, RoomStore } from './types.js';

export interface BeaconService {
  address(): AddressInfo;
  close(): Promise<void>;
}

export async function startBeacon(config: Config, dev: DevOptions, overrides: { store?: RoomStore; auth?: AuthProvider; games?: GameProvider } = {}): Promise<BeaconService> {
  validateConfig(config, dev);
  const store = overrides.store ?? new SqliteRoomStore(config.db.path);
  try {
    const games = overrides.games ?? new GameRegistry(config.games);
    await games.list();
    const auth = overrides.auth ?? createAuthProvider(config.auth);
    const lobby = new RoomManager(config, store, games);
    const transport = await startTransport(config, dev, {
      onConnect(peer) { lobby.connect(peer); },
      async onMessage(peer, message) {
        try {
          if (message.type === 'auth') {
            let player;
            try { player = await auth.verify(message.token); }
            catch {
              log('warn', 'authentication_failed');
              peer.send({ type: 'auth_fail', code: 'auth_failed' });
              peer.close(4003, 'Authentication failed');
              return;
            }
            if (await lobby.authenticate(peer, player)) {
              markAuthenticated(peer, player.expiresAt);
              peer.send({ type: 'auth_ok', player: { id: player.id, displayName: player.displayName } });
            }
          } else {
            await lobby.handle(peer, message);
          }
        } catch (error) {
          const code = error instanceof ProtocolError ? error.code : 'server_error';
          if (code === 'server_error') log('error', 'request_failed');
          peer.send(errorMessage(code));
          if (code === 'auth_expired') peer.close(4003, 'Authentication expired');
        }
      },
      onClose(peer) { lobby.disconnect(peer); },
    });
    let maintenanceRunning = false;
    const timer = setInterval(() => {
      if (maintenanceRunning) return;
      maintenanceRunning = true;
      void lobby.maintain().catch(() => log('error', 'maintenance_failed')).finally(() => { maintenanceRunning = false; });
    }, config.limits.maintenanceIntervalMs);
    timer.unref();
    let closing: Promise<void> | undefined;
    return {
      address() { return transport.address(); },
      close() {
        closing ??= (async () => {
          clearInterval(timer);
          await transport.close();
          await lobby.settle();
          store.close();
        })();
        return closing;
      },
    };
  } catch (error) {
    store.close();
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
    // Startup errors are generated locally, never provider response bodies or credentials.
    console.error(error instanceof Error ? error.message : 'Beacon.js startup failed');
    process.exitCode = 1;
  });
}
