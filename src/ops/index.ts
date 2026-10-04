import { createServer, request as httpRequest, type IncomingMessage, type ServerResponse } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { createHash, randomUUID, timingSafeEqual } from 'node:crypto';
import { ProtocolError } from '../protocol/index.js';
import { readRules } from '../protocol/index.js';
import { lstatSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import type { Config } from '../config.js';
import { readSecretFile } from '../auth/secrets.js';
import { log } from '../log/index.js';
import { scheduledBackup } from './backups.js';

export interface OperationsHooks {
  stats(): Record<string, unknown>;
  ready(): boolean;
  ban(playerId: string, until: number, reason: string): Promise<void>;
  unban(playerId: string): Promise<void>;
  revoke(playerId: string, before: number): Promise<void>;
  closeRoom(roomId: string): Promise<void>;
  reportMatch(matchId: string, state: 'ended' | 'failed'): Promise<void>;
  reportPlayerResult(matchId: string, playerId: string, result: Record<string, string | number | boolean>): Promise<void>;
  maintenance(enabled: boolean): void;
  audit(limit: number): unknown[];
}
export interface OperationsService {
  address(): AddressInfo | undefined;
  close(): Promise<void>;
  metric(name: string, value?: number): void;
}

const loopback = (host: string): boolean => host === '127.0.0.1' || host === '::1' || host === '::ffff:127.0.0.1';
const digest = (text: string): Buffer => createHash('sha256').update(text).digest();
const id = (value: unknown): value is string => typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:@-]{0,127}$/.test(value);
const playerId = (value: unknown): value is string => typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= 128 && !/[\p{Cc}\p{Cs}]/u.test(value);
const timestamp = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0;

async function body(request: IncomingMessage): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim() !== 'application/json') throw new Error('Invalid request');
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string);
    size += buffer.length;
    if (size > 4096) throw new Error('Invalid request');
    chunks.push(buffer);
  }
  const parsed: unknown = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error('Invalid request');
  return parsed as Record<string, unknown>;
}
function fields(value: Record<string, unknown>, names: string[]): void {
  if (Object.keys(value).length !== names.length || names.some(name => !Object.hasOwn(value, name))) throw new Error('Invalid request');
}
function reply(response: ServerResponse, status: number, value: unknown): void {
  let payload = JSON.stringify(value);
  if (Buffer.byteLength(payload) > 65536) { status = 503; payload = '{"error":"unavailable"}'; }
  response.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', connection: 'close' });
  response.end(payload);
}

export async function sendAlert(url: string, token: string, event: string): Promise<void> {
  if (url.length > 2048 || token.length > 4096 || /[^\x21-\x7e]/.test(token) || (event !== 'not_ready' && event !== 'backup_failed')) throw new Error('Invalid alert payload');
  const target = new URL(url);
  if (target.username || target.password || target.hash || (target.protocol !== 'https:' && !(target.protocol === 'http:' && loopback(target.hostname.replace(/^\[|\]$/g, ''))))) throw new Error('Invalid alert endpoint');
  const payload = JSON.stringify({ service: 'beacon', event, severity: event === 'backup_failed' ? 'critical' : 'warning', id: randomUUID(), at: Date.now() });
  await new Promise<void>((resolve, reject) => {
    // Settle exactly once. destroy() without an error argument avoids a second, unhandled 'error' event.
    let settled = false;
    const settle = (error?: Error): void => {
      if (settled) return;
      settled = true;
      clearTimeout(deadline);
      if (error) { request.destroy(); reject(error); } else resolve();
    };
    const request = (target.protocol === 'https:' ? httpsRequest : httpRequest)(target, { method: 'POST', headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload), ...(token ? { authorization: `Bearer ${token}` } : {}) } }, response => {
      let size = 0;
      response.on('data', (chunk: Buffer) => { size += chunk.length; if (size > 8192) settle(new Error('Alert response too large')); });
      response.on('error', () => settle(new Error('Alert response failed')));
      response.on('end', () => {
        if (response.statusCode && response.statusCode >= 200 && response.statusCode < 300) settle(); else settle(new Error('Alert rejected'));
      });
    });
    const deadline = setTimeout(() => settle(new Error('Alert timeout')), 5000);
    request.on('error', () => settle(new Error('Alert request failed')));
    request.end(payload);
  });
}

export async function startOperations(config: Config, hooks: OperationsHooks): Promise<OperationsService> {
  const options = config.operations;
  let tokenDigest: Buffer | undefined;
  if (options.enabled) {
    if (!loopback(options.listenHost) || !options.tokenFile) throw new Error('Operations requires loopback and private authentication');
    const info = lstatSync(options.tokenFile);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('Operations requires a mode0600 token file');
    const token = readSecretFile(options.tokenFile);
    if (token.length > 4096) throw new Error('Invalid operations token file');
    tokenDigest = digest(token);
  }
  const alertToken = options.alertTokenFile ? readSecretFile(options.alertTokenFile) : '';
  if (alertToken.length > 4096) throw new Error('Invalid alert token file');
  const counters = new Map<string, number>();
  let closed = false;
  let backupFailed = false;
  let lastAlert = 0;
  let backupTask: Promise<void> | undefined;
  let alertTask: Promise<void> | undefined;
  const timers: NodeJS.Timeout[] = [];
  const metric = (name: string, value = 1): void => {
    if (!/^[a-z][a-z0-9_]{0,63}$/.test(name) || !Number.isFinite(value) || (!counters.has(name) && counters.size >= 64)) return;
    const next = (counters.get(name) ?? 0) + value;
    if (Number.isFinite(next)) counters.set(name, next);
  };
  const runBackup = (): Promise<void> => {
    if (backupTask) return backupTask;
    backupTask = scheduledBackup(config.db.path, options.backupDirectory, options.backupRetention)
      .then(() => { backupFailed = false; metric('backups_completed'); log('info', 'backup_completed'); })
      .catch(() => { backupFailed = true; metric('backups_failed'); log('error', 'backup_failed'); })
      .finally(() => { backupTask = undefined; });
    return backupTask;
  };
  const runAlert = (): Promise<void> => {
    if (alertTask) return alertTask;
    let event: string;
    try { event = backupFailed ? 'backup_failed' : !hooks.ready() ? 'not_ready' : ''; }
    catch { event = 'not_ready'; }
    if (!event || Date.now() - lastAlert < options.alertIntervalMs) return Promise.resolve();
    lastAlert = Date.now();
    alertTask = sendAlert(options.alertUrl, alertToken, event)
      .then(() => { metric('alerts_delivered'); })
      .catch(() => { metric('alerts_failed'); log('warn', 'alert_delivery_failed'); })
      .finally(() => { alertTask = undefined; });
    return alertTask;
  };
  const server = options.enabled ? createServer({ maxHeaderSize: 8192 }, (request, response) => {
    void (async () => {
      if (closed || !loopback(request.socket.remoteAddress ?? '')) { reply(response, 403, { error: 'forbidden' }); return; }
      const authorization = request.headers.authorization;
      if (!tokenDigest || typeof authorization !== 'string' || authorization.length > 4103 || !authorization.startsWith('Bearer ') || !timingSafeEqual(tokenDigest, digest(authorization.slice(7)))) {
        metric('admin_auth_denied'); reply(response, 403, { error: 'forbidden' }); return;
      }
      metric('admin_requests');
      const url = new URL(request.url ?? '/', 'http://localhost');
      if (request.method === 'GET') {
        if (url.pathname === '/audit') {
          if ([...url.searchParams.keys()].some(key => key !== 'limit') || url.searchParams.getAll('limit').length > 1) throw new Error('Invalid request');
          const limit = Number(url.searchParams.get('limit') ?? 100);
          if (!Number.isSafeInteger(limit) || limit < 1 || limit > 200) throw new Error('Invalid request');
          reply(response, 200, { audit: hooks.audit(limit) }); return;
        }
        if (url.search) throw new Error('Invalid request');
        if (url.pathname === '/health') { reply(response, 200, { status: 'ok' }); return; }
        if (url.pathname === '/ready') { const ready = hooks.ready(); reply(response, ready ? 200 : 503, { ready }); return; }
        if (url.pathname === '/metrics') {
          const stats = Object.fromEntries(Object.entries(hooks.stats()).filter(([name, value]) => /^[a-z][a-zA-Z0-9_]{0,63}$/.test(name) && !/id|token|ticket|secret|password|authorization/i.test(name) && (typeof value === 'boolean' || (typeof value === 'number' && Number.isFinite(value)))).slice(0, 64));
          reply(response, 200, { counters: Object.fromEntries(counters), stats, integrations: { backups: options.backupDirectory ? 'enabled' : 'unconfigured', alerts: options.alertUrl ? 'enabled' : 'unconfigured', logging: options.logPath ? 'enabled' : 'unconfigured' } }); return;
        }
      } else if (request.method === 'POST' && !url.search) {
        const input = await body(request);
        switch (url.pathname) {
          case '/ban':
            fields(input, ['playerId', 'until', 'reason']);
            if (!playerId(input.playerId) || !timestamp(input.until) || typeof input.reason !== 'string' || Buffer.byteLength(input.reason) > 256 || /[\p{Cc}\p{Cs}]/u.test(input.reason)) throw new Error('Invalid request');
            await hooks.ban(input.playerId, input.until, input.reason); break;
          case '/unban':
            fields(input, ['playerId']); if (!playerId(input.playerId)) throw new Error('Invalid request');
            await hooks.unban(input.playerId); break;
          case '/revoke':
            fields(input, ['playerId', 'before']); if (!playerId(input.playerId) || !timestamp(input.before)) throw new Error('Invalid request');
            await hooks.revoke(input.playerId, input.before); break;
          case '/rooms/close':
            fields(input, ['roomId']); if (!id(input.roomId)) throw new Error('Invalid request');
            await hooks.closeRoom(input.roomId); break;
          case '/matches/result':
            fields(input, ['matchId', 'state']);
            if (!id(input.matchId) || (input.state !== 'ended' && input.state !== 'failed')) throw new Error('Invalid request');
            try { await hooks.reportMatch(input.matchId, input.state); }
            catch (error) { if (error instanceof ProtocolError && error.code === 'room_not_found') { reply(response, 404, { error: 'not_found' }); return; } throw error; }
            break;
          case '/matches/player-result': {
            fields(input, ['matchId', 'playerId', 'result']);
            if (!id(input.matchId) || !playerId(input.playerId)) throw new Error('Invalid request');
            let result: Record<string, string | number | boolean>;
            try { result = readRules(input.result); } catch { throw new Error('Invalid request'); }
            try { await hooks.reportPlayerResult(input.matchId, input.playerId, result); }
            catch (error) { if (error instanceof ProtocolError && error.code === 'room_not_found') { reply(response, 404, { error: 'not_found' }); return; } throw error; }
            break;
          }
          case '/maintenance':
            fields(input, ['enabled']); if (typeof input.enabled !== 'boolean') throw new Error('Invalid request');
            hooks.maintenance(input.enabled); break;
          default: reply(response, 404, { error: 'not_found' }); return;
        }
        metric('admin_actions_completed'); reply(response, 200, { ok: true }); return;
      }
      reply(response, 404, { error: 'not_found' });
    })().catch(() => { metric('admin_requests_failed'); if (!response.headersSent) reply(response, 400, { error: 'request_failed' }); else response.destroy(); });
  }) : undefined;
  if (server) {
    server.requestTimeout = 5000; server.headersTimeout = 5000; server.timeout = 5000; server.maxRequestsPerSocket = 1; server.maxConnections = 32;
    try {
      await new Promise<void>((resolve, reject) => { server.once('error', reject); server.listen(options.listenPort, options.listenHost, () => { server.removeListener('error', reject); resolve(); }); });
    } catch (error) { server.close(); throw error; }
    server.on('error', () => log('error', 'operations_listener_failed'));
    log('info', 'operations_enabled');
  } else log('info', 'operations_disabled');
  if (options.backupDirectory) {
    await runBackup();
    const timer = setInterval(() => { if (!closed) void runBackup(); }, options.backupIntervalMs); timer.unref(); timers.push(timer);
  } else log('info', 'scheduled_backups_unconfigured');
  if (options.alertUrl) {
    await runAlert();
    const timer = setInterval(() => { if (!closed) void runAlert(); }, options.alertIntervalMs); timer.unref(); timers.push(timer);
  } else log('info', 'alerts_unconfigured');
  return {
    address: () => { const value = server?.address(); return value && typeof value !== 'string' ? value : undefined; },
    metric,
    close: async () => {
      closed = true; for (const timer of timers) clearInterval(timer);
      if (server?.listening) await new Promise<void>((resolve, reject) => {
        const timer = setTimeout(() => server.closeAllConnections(), options.drainTimeoutMs); timer.unref();
        server.close(error => { clearTimeout(timer); if (error) reject(error); else resolve(); });
      });
      await Promise.all([backupTask, alertTask]);
    },
  };
}
