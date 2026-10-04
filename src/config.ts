import { readFile } from 'node:fs/promises';
import { isIP } from 'node:net';
import type { Game } from './types.js';
import { readSecretFile } from './auth/secrets.js';
import { parseCapabilities } from './games/capabilities.js';

export interface Config {
  server: { listenHost: string; listenPort: number; trustProxy: boolean; trustedProxyAddresses: string[]; allowedOrigins: string[]; allowNoOrigin: boolean };
  public: { domain: string; tls: 'proxy' | 'direct'; certPath: string; keyPath: string };
  auth: { mode: 'mock' | 'jwks' | 'remote'; jwksUrl: string; issuer: string; audience: string; apiUrl: string; timeoutMs: number; jwksCacheTtlSec: number; mockPlayers: { token: string; id: string; displayName: string }[]; revocationUrl: string; revocationTokenFile: string; revocationIntervalMs: number };
  games: { apiUrl: string; timeoutMs: number; cacheTtlSec: number; fallback: Omit<Game, 'source'>[]; sessionApiUrl: string; serviceTokenFile: string; profileApiUrl: string; profileMaxAgeMs: number };
  lobby: { reconnectGraceMs: number; maxRoomsPerPlayer: number; requestCacheSize: number; requestCacheTtlMs: number; snapshotTtlMs: number; inviteTtlMs: number; maxSpectators: number; matchmakingWaitMs: number; maxPartySize: number; matchConfirmMs: number; resultRetentionMs: number; maxResults: number; invitationRetentionMs: number };
  matching: { skillSpread: number; maxSkillSpread: number; teamSkillDelta: number; maxTeamSkillDelta: number; latencyMs: number; maxLatencyMs: number; relaxAfterMs: number; relaxEveryMs: number; skillStep: number; latencyStep: number; searchLimit: number };
  chat: { maxTextLength: number; retentionMs: number; maxMessages: number; reportRetentionMs: number; maxReports: number; burst: number; windowMs: number; maxMuteMs: number };
  cluster: { enabled: boolean; nodeId: string; endpoints: string[]; prefix: string; leaseTtlSeconds: number; requestTimeoutMs: number; maxSnapshotBytes: number; maxStateBytes: number; checkpointInterval: number; development: boolean; control: { listenHost: string; listenPort: number; advertiseUrl: string; secretPath: string; certPath: string; keyPath: string; caPath: string }; etcd: { username: string; passwordPath: string; caPath: string; certPath: string; keyPath: string } };
  operations: { enabled: boolean; listenHost: string; listenPort: number; tokenFile: string; logPath: string; logMaxBytes: number; logFiles: number; backupDirectory: string; backupIntervalMs: number; backupRetention: number; alertUrl: string; alertTokenFile: string; alertIntervalMs: number; drainTimeoutMs: number };
  room: { emptyTtlSec: number };
  db: { path: string };
  limits: { authDeadlineMs: number; heartbeatIntervalMs: number; heartbeatTimeoutMs: number; maxConnectionsPerIp: number; maxConnections: number; connectionBurst: number; connectionWindowMs: number; messageBurst: number; messageWindowMs: number; maxRateViolations: number; passwordFailures: number; passwordWindowMs: number; maxRoomsPerGame: number; inboundBytes: number; outboundBytes: number; maxBufferedBytes: number; socketHighWaterMark: number; defaultPageSize: number; maxPageSize: number; maintenanceIntervalMs: number };
}

export interface DevOptions { insecureWs: boolean; mockAuth: boolean }

export function isLoopback(address: string): boolean {
  const normalized = address.startsWith('::ffff:') ? address.slice(7) : address;
  return normalized === '::1' || (isIP(normalized) === 4 && normalized.startsWith('127.'));
}

function record(value: unknown, name: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`Invalid config object: ${name}`);
  return value as Record<string, unknown>;
}
function string(value: unknown, name: string, empty = false): asserts value is string {
  if (typeof value !== 'string' || (!empty && !value.length)) throw new Error(`Invalid config string: ${name}`);
}
function integer(value: unknown, name: string, min = 1, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < min || value > max) throw new Error(`Invalid config integer: ${name}`);
}
function boolean(value: unknown, name: string): void {
  if (typeof value !== 'boolean') throw new Error(`Invalid config boolean: ${name}`);
}
function strings(value: unknown, name: string): void {
  if (!Array.isArray(value) || !value.every(v => typeof v === 'string')) throw new Error(`Invalid config array: ${name}`);
}
function keys(object: Record<string, unknown>, allowed: readonly string[], name: string): void {
  for (const key of Object.keys(object)) if (!allowed.includes(key)) throw new Error(`Unknown config key: ${name}.${key}`);
  for (const key of allowed) if (!(key in object)) throw new Error(`Missing config key: ${name}.${key}`);
}

export function validateConfig(value: unknown, dev: DevOptions): Config {
  const root = record(value, 'root');
  keys(root, ['server', 'public', 'auth', 'games', 'room', 'db', 'limits', 'lobby', 'matching', 'operations', 'chat', 'cluster'], 'root');
  const server = record(root.server, 'server');
  keys(server, ['listenHost', 'listenPort', 'trustProxy', 'trustedProxyAddresses', 'allowedOrigins', 'allowNoOrigin'], 'server');
  string(server.listenHost, 'listenHost');
  if (!isLoopback(server.listenHost)) throw new Error('Only a loopback listenHost is permitted');
  integer(server.listenPort, 'listenPort', 0, 65535);
  boolean(server.trustProxy, 'trustProxy'); boolean(server.allowNoOrigin, 'allowNoOrigin');
  strings(server.trustedProxyAddresses, 'trustedProxyAddresses'); strings(server.allowedOrigins, 'allowedOrigins');
  const pub = record(root.public, 'public');
  keys(pub, ['domain', 'tls', 'certPath', 'keyPath'], 'public');
  string(pub.domain, 'domain'); string(pub.certPath, 'certPath', true); string(pub.keyPath, 'keyPath', true);
  if (!/^[a-z0-9.-]+$/i.test(pub.domain)) throw new Error('Invalid public.domain');
  if (pub.tls !== 'proxy' && pub.tls !== 'direct') throw new Error('Invalid public.tls');
  if (pub.tls === 'direct' && (!pub.certPath || !pub.keyPath)) throw new Error('Direct TLS requires certificate and private key paths');
  if (pub.tls === 'proxy' && server.trustProxy !== true && !dev.insecureWs) throw new Error('Proxy TLS requires trustProxy');
  const auth = record(root.auth, 'auth');
  keys(auth, ['mode', 'jwksUrl', 'issuer', 'audience', 'apiUrl', 'timeoutMs', 'jwksCacheTtlSec', 'mockPlayers', 'revocationUrl', 'revocationTokenFile', 'revocationIntervalMs'], 'auth');
  string(auth.revocationUrl, 'auth.revocationUrl', true); string(auth.revocationTokenFile, 'auth.revocationTokenFile', true); integer(auth.revocationIntervalMs, 'auth.revocationIntervalMs');
  if (auth.revocationTokenFile) readSecretFile(auth.revocationTokenFile);
  if (auth.revocationUrl && auth.mode !== 'mock' && !auth.revocationTokenFile) throw new Error('Revocation list requires a token file');
  if (!['mock', 'jwks', 'remote'].includes(String(auth.mode))) throw new Error('Invalid auth.mode');
  if (auth.mode === 'mock' && !dev.mockAuth) throw new Error('Mock authentication requires --dev-mock-auth');
  for (const key of ['jwksUrl', 'issuer', 'audience', 'apiUrl']) string(auth[key], `auth.${key}`, true);
  integer(auth.timeoutMs, 'auth.timeoutMs'); integer(auth.jwksCacheTtlSec, 'jwksCacheTtlSec');
  if (auth.mode === 'jwks' && (!auth.jwksUrl || !auth.issuer || !auth.audience)) throw new Error('JWKS requires URL, issuer and audience');
  if (auth.mode === 'remote' && !auth.apiUrl) throw new Error('Remote authentication requires apiUrl');
  if (!Array.isArray(auth.mockPlayers)) throw new Error('Invalid mockPlayers');
  for (const entry of auth.mockPlayers) {
    const player = record(entry, 'mockPlayers'); keys(player, ['token', 'id', 'displayName'], 'mockPlayers');
    for (const key of ['token', 'id', 'displayName']) string(player[key], `mockPlayers.${key}`);
  }
  const games = record(root.games, 'games');
  keys(games, ['apiUrl', 'timeoutMs', 'cacheTtlSec', 'fallback', 'sessionApiUrl', 'serviceTokenFile', 'profileApiUrl', 'profileMaxAgeMs'], 'games');
  string(games.profileApiUrl, 'games.profileApiUrl', true); integer(games.profileMaxAgeMs, 'games.profileMaxAgeMs');
  string(games.sessionApiUrl, 'games.sessionApiUrl', true); string(games.serviceTokenFile, 'games.serviceTokenFile', true);
  if (games.serviceTokenFile) readSecretFile(games.serviceTokenFile);
  string(games.apiUrl, 'games.apiUrl', true); integer(games.timeoutMs, 'games.timeoutMs'); integer(games.cacheTtlSec, 'games.cacheTtlSec');
  if (!Array.isArray(games.fallback)) throw new Error('Invalid games.fallback');
  for (const entry of games.fallback) {
    const game = record(entry, 'fallback');
    for (const key of Object.keys(game)) if (!['gameId', 'name', 'maxPlayersPerRoom', 'enabled', 'serverHint', 'versions', 'modes', 'regions', 'capabilities'].includes(key)) throw new Error(`Unknown config game key: ${key}`);
    string(game.gameId, 'gameId'); string(game.name, 'game.name'); integer(game.maxPlayersPerRoom, 'maxPlayersPerRoom'); boolean(game.enabled, 'game.enabled');
    if (game.capabilities !== undefined) game.capabilities = parseCapabilities(game.capabilities, Number(game.maxPlayersPerRoom));
    if (game.serverHint !== undefined) string(game.serverHint, 'serverHint');
    for (const key of ['versions', 'modes', 'regions']) if (game[key] !== undefined) {
      const values = game[key];
      if (!Array.isArray(values) || values.length > 32 || !values.every(v => typeof v === 'string' && v.length > 0 && Buffer.byteLength(v) <= 64 && !/[\p{Cc}\p{Cs}]/u.test(v))) throw new Error(`Invalid game.${key}`);
      game[key] = Object.freeze([...values]);
    }
  }
  const operations = record(root.operations, 'operations');
  keys(operations, ['enabled', 'listenHost', 'listenPort', 'tokenFile', 'logPath', 'logMaxBytes', 'logFiles', 'backupDirectory', 'backupIntervalMs', 'backupRetention', 'alertUrl', 'alertTokenFile', 'alertIntervalMs', 'drainTimeoutMs'], 'operations');
  boolean(operations.enabled, 'operations.enabled'); string(operations.listenHost, 'operations.listenHost');
  if (!isLoopback(operations.listenHost)) throw new Error('Operations must listen on loopback');
  integer(operations.listenPort, 'operations.listenPort', 0, 65535);
  for (const key of ['tokenFile', 'logPath', 'backupDirectory', 'alertUrl', 'alertTokenFile']) string(operations[key], `operations.${key}`, true);
  for (const key of ['logMaxBytes', 'logFiles', 'backupIntervalMs', 'backupRetention', 'alertIntervalMs', 'drainTimeoutMs']) integer(operations[key], `operations.${key}`, key === 'drainTimeoutMs' ? 0 : 1);
  if (operations.enabled && !operations.tokenFile) throw new Error('Operations requires a token file');
  for (const key of ['tokenFile', 'alertTokenFile']) if (operations[key]) readSecretFile(String(operations[key]));
  const lobby = record(root.lobby, 'lobby');
  const lobbyKeys = ['reconnectGraceMs', 'maxRoomsPerPlayer', 'requestCacheSize', 'requestCacheTtlMs', 'snapshotTtlMs', 'inviteTtlMs', 'maxSpectators', 'matchmakingWaitMs', 'maxPartySize', 'matchConfirmMs', 'resultRetentionMs', 'maxResults', 'invitationRetentionMs'];
  keys(lobby, lobbyKeys, 'lobby');
  for (const key of lobbyKeys) integer(lobby[key], `lobby.${key}`, key === 'maxSpectators' || key === 'reconnectGraceMs' ? 0 : 1);
  const matching = record(root.matching, 'matching');
  const matchingKeys = ['skillSpread', 'maxSkillSpread', 'teamSkillDelta', 'maxTeamSkillDelta', 'latencyMs', 'maxLatencyMs', 'relaxAfterMs', 'relaxEveryMs', 'skillStep', 'latencyStep', 'searchLimit'];
  keys(matching, matchingKeys, 'matching');
  for (const key of matchingKeys) integer(matching[key], `matching.${key}`, key === 'relaxEveryMs' || key === 'searchLimit' ? 1 : 0);
  if (Number(matching.maxSkillSpread) < Number(matching.skillSpread) || Number(matching.maxTeamSkillDelta) < Number(matching.teamSkillDelta) || Number(matching.maxLatencyMs) < Number(matching.latencyMs) || Number(matching.searchLimit) > 1000000) throw new Error('Invalid matching policy');
  const chat = record(root.chat, 'chat');
  const chatKeys = ['maxTextLength','retentionMs','maxMessages','reportRetentionMs','maxReports','burst','windowMs','maxMuteMs'];
  keys(chat, chatKeys, 'chat'); for (const key of chatKeys) integer(chat[key], `chat.${key}`);
  if (Number(chat.maxTextLength) > 2000) throw new Error('Chat text limit exceeds protocol limit');
  const cluster = record(root.cluster, 'cluster');
  keys(cluster, ['enabled','nodeId','endpoints','prefix','leaseTtlSeconds','requestTimeoutMs','maxSnapshotBytes','maxStateBytes','checkpointInterval','development','control','etcd'], 'cluster');
  boolean(cluster.enabled, 'cluster.enabled'); boolean(cluster.development, 'cluster.development'); string(cluster.nodeId, 'cluster.nodeId'); string(cluster.prefix, 'cluster.prefix');
  strings(cluster.endpoints, 'cluster.endpoints');
  for (const key of ['leaseTtlSeconds','requestTimeoutMs','maxSnapshotBytes']) integer(cluster[key], `cluster.${key}`, key === 'leaseTtlSeconds' ? 5 : 1);
  integer(cluster.maxSnapshotBytes, 'cluster.maxSnapshotBytes', 1024, 900000); integer(cluster.maxStateBytes, 'cluster.maxStateBytes', Number(cluster.maxSnapshotBytes), 268435456); integer(cluster.checkpointInterval, 'cluster.checkpointInterval', 1, 128);
  if (Number(cluster.requestTimeoutMs) >= Number(cluster.leaseTtlSeconds) * 250) throw new Error('Cluster request timeout must be below one quarter lease lifetime');
  const control = record(cluster.control, 'cluster.control');
  keys(control, ['listenHost','listenPort','advertiseUrl','secretPath','certPath','keyPath','caPath'], 'cluster.control');
  string(control.listenHost, 'cluster.control.listenHost'); if (!isLoopback(control.listenHost)) throw new Error('Cluster control must listen on loopback');
  integer(control.listenPort, 'cluster.control.listenPort', 0, 65535);
  for (const key of ['advertiseUrl','secretPath']) string(control[key], `cluster.control.${key}`, cluster.enabled !== true);
  for (const key of ['certPath','keyPath','caPath']) string(control[key], `cluster.control.${key}`, true);
  const etcd = record(cluster.etcd, 'cluster.etcd'); keys(etcd, ['username','passwordPath','caPath','certPath','keyPath'], 'cluster.etcd');
  for (const key of ['username','passwordPath','caPath','certPath','keyPath']) string(etcd[key], `cluster.etcd.${key}`, true);
  if (cluster.enabled) {
    if (!(cluster.endpoints as string[]).length) throw new Error('Cluster requires etcd endpoints');
    if (cluster.development && !dev.insecureWs) throw new Error('Development cluster requires explicit development transport flag');
    for (const endpoint of cluster.endpoints as string[]) {
      const url = new URL(endpoint);
      if (url.username || url.password || url.hash || (url.protocol !== 'https:' && !(cluster.development && url.protocol === 'http:' && isLoopback(url.hostname.replace(/^\[|\]$/g, ''))))) throw new Error('Etcd endpoints require authenticated TLS, or loopback development HTTP');
    }
    const controlUrl = new URL(String(control.advertiseUrl));
    if (controlUrl.username || controlUrl.password || controlUrl.hash || (controlUrl.protocol !== 'wss:' && !(cluster.development && controlUrl.protocol === 'ws:' && isLoopback(controlUrl.hostname.replace(/^\[|\]$/g, ''))))) throw new Error('Cluster control requires WSS, or loopback development WS');
    if (Boolean(control.certPath) !== Boolean(control.keyPath)) throw new Error('Cluster control certificate and key must be configured together');
    readSecretFile(String(control.secretPath));
    if (!cluster.development && (!etcd.username || !etcd.passwordPath || !etcd.caPath || !control.certPath || !control.keyPath || !control.caPath)) throw new Error('Production cluster requires authenticated TLS');
    if (etcd.passwordPath) readSecretFile(String(etcd.passwordPath));
  }
  for (const endpoint of [auth.mode === 'jwks' ? auth.jwksUrl : auth.apiUrl, auth.revocationUrl, games.apiUrl, games.sessionApiUrl, games.profileApiUrl, operations.alertUrl]) {
    if (endpoint) {
      const url = new URL(String(endpoint));
      if (url.username || url.password || url.hash) throw new Error('API URLs cannot contain credentials or fragments');
      if (url.protocol !== 'https:' && !(dev.mockAuth && url.protocol === 'http:' && isLoopback(url.hostname.replace(/^\[|\]$/g, '')))) throw new Error('External API URLs must use HTTPS (loopback HTTP only in development)');
    }
  }
  const room = record(root.room, 'room'); keys(room, ['emptyTtlSec'], 'room'); integer(room.emptyTtlSec, 'emptyTtlSec', 0);
  const db = record(root.db, 'db'); keys(db, ['path'], 'db'); string(db.path, 'db.path');
  const limits = record(root.limits, 'limits');
  const limitNames = ['authDeadlineMs', 'heartbeatIntervalMs', 'heartbeatTimeoutMs', 'maxConnectionsPerIp', 'maxConnections', 'connectionBurst', 'connectionWindowMs', 'messageBurst', 'messageWindowMs', 'maxRateViolations', 'passwordFailures', 'passwordWindowMs', 'maxRoomsPerGame', 'inboundBytes', 'outboundBytes', 'maxBufferedBytes', 'socketHighWaterMark', 'defaultPageSize', 'maxPageSize', 'maintenanceIntervalMs'];
  keys(limits, limitNames, 'limits');
  for (const key of limitNames) integer(limits[key], `limits.${key}`);
  if (Number(limits.outboundBytes) < 2048 || Number(limits.defaultPageSize) > Number(limits.maxPageSize) || Number(limits.heartbeatTimeoutMs) < Number(limits.heartbeatIntervalMs)) throw new Error('Inconsistent limits');
  return value as Config;
}

export async function loadConfig(path = 'config.yaml', dev: DevOptions = { insecureWs: false, mockAuth: false }): Promise<Config> {
  // YAML 1.2 flow-style JSON with # comments, without a runtime parser dependency.
  let value: unknown;
  try {
    const source = await readFile(path, 'utf8');
    let quoted = false;
    let escaped = false;
    let comment = false;
    let json = '';
    for (const char of source) {
      if (comment) {
        if (char === '\n' || char === '\r') { comment = false; json += char; }
        continue;
      }
      if (!quoted && char === '#') { comment = true; continue; }
      json += char;
      if (quoted && escaped) { escaped = false; continue; }
      if (quoted && char === '\\') { escaped = true; continue; }
      if (char === '"') quoted = !quoted;
    }
    value = JSON.parse(json);
  } catch { throw new Error('config.yaml must use documented YAML 1.2 flow syntax with optional # comments'); }
  return validateConfig(value, dev);
}
