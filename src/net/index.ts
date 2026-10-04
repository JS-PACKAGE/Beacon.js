import { createServer as createHttpServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { createServer as createHttpsServer } from 'node:https';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { AddressInfo, Socket } from 'node:net';
import { isIP } from 'node:net';
import { timingSafeEqual } from 'node:crypto';
import { WebSocketServer, WebSocket, type RawData } from 'ws';
import { isLoopback, type Config, type DevOptions } from '../config.js';
import type { Peer } from '../types.js';
import { parseClient, ProtocolError, errorMessage, PROTOCOL_VERSION, type ClientMessage } from '../protocol/index.js';
import { TokenBucket } from '../security/rate.js';
import { allowUpgrade, sourceIp } from '../security/source.js';
import { log } from '../log/index.js';

export interface TransportHandlers {
  onConnect(peer: Peer): void;
  onMessage(peer: Peer, message: ClientMessage): Promise<void>;
  onClose(peer: Peer): void;
}
export interface Transport {
  address(): AddressInfo;
  drain(deadline: number): void;
  close(): Promise<void>;
}
const authentication = new WeakMap<Peer, (expiresAt?: number) => void>();
export function markAuthenticated(peer: Peer, expiresAt?: number): void { authentication.get(peer)?.(expiresAt); }
const origins = new WeakMap<Peer, string | undefined>();
export function peerOrigin(peer: Peer): string | undefined { return origins.get(peer); }
export interface ControlTransport { secret: string; assertLeader(): void }

export async function startTransport(config: Config, dev: DevOptions, handlers: TransportHandlers, control?: ControlTransport): Promise<Transport> {
  if (!isLoopback(config.server.listenHost)) throw new Error('Transport requires loopback binding');
  if (!control && !dev.insecureWs && config.public.tls === 'proxy' && !config.server.trustProxy) throw new Error('Proxy TLS requires trusted proxy');
  const options = { highWaterMark: config.limits.socketHighWaterMark, maxHeaderSize: 8192, requestTimeout: 10_000, headersTimeout: 10_000 };
  const server = control
    ? config.cluster.development ? createHttpServer(options) : createHttpsServer({ ...options, cert: await readFile(config.cluster.control.certPath), key: await readFile(config.cluster.control.keyPath), minVersion: 'TLSv1.2' })
    : config.public.tls === 'direct'
      ? createHttpsServer({ ...options, cert: await readFile(config.public.certPath), key: await readFile(config.public.keyPath), minVersion: 'TLSv1.2' })
      : createHttpServer(options);
  const wss = new WebSocketServer({ noServer: true, maxPayload: Math.min(4096, config.limits.inboundBytes), perMessageDeflate: false });
  const peers = new Map<WebSocket, Peer>();
  const counts = new Map<string, number>();
  const attempts = new Map<string, { bucket: TokenBucket; seenAt: number }>();
  const sockets = new Set<Socket>();
  let stopping = false;
  let closedTransport = false;
  const authorized = (request: IncomingMessage): boolean => {
    if (!control) return allowUpgrade(request, config, dev);
    if (!isLoopback(request.socket.remoteAddress ?? '')) return false;
    const supplied = request.headers.authorization;
    const expected = `Bearer ${control.secret}`;
    if (typeof supplied !== 'string' || Buffer.byteLength(supplied) !== Buffer.byteLength(expected) || !timingSafeEqual(Buffer.from(supplied), Buffer.from(expected))) return false;
    if (!config.cluster.development && (!('encrypted' in request.socket) || request.socket.encrypted !== true)) return false;
    if (request.headers.host !== new URL(config.cluster.control.advertiseUrl).host) return false;
    const ip = request.headers['x-beacon-ip'];
    const origin = request.headers['x-beacon-origin'];
    if (typeof ip !== 'string' || !isIP(ip)) return false;
    if (origin === undefined ? !config.server.allowNoOrigin : typeof origin !== 'string' || !config.server.allowedOrigins.includes(origin)) return false;
    try { control.assertLeader(); } catch { return false; }
    return true;
  };
  server.on('connection', socket => {
    sockets.add(socket);
    socket.once('close', () => sockets.delete(socket));
    if (!isLoopback(socket.remoteAddress ?? '')) socket.destroy();
  });
  server.on('request', (request, response) => {
    response.writeHead(authorized(request) ? 426 : 403, { Connection: 'close' });
    response.end();
  });
  server.on('clientError', (_error, socket) => socket.destroy());
  const maintenance = setInterval(() => {
    const now = Date.now();
    for (const [ip, attempt] of attempts) if (now - attempt.seenAt >= config.limits.connectionWindowMs && !counts.has(ip)) attempts.delete(ip);
  }, config.limits.maintenanceIntervalMs);
  maintenance.unref();

  server.on('upgrade', (request, socket, head) => {
    const reject = (status: 403 | 429 | 503): void => {
      socket.end(`HTTP/1.1 ${status} Rejected\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`);
    };
    if (stopping) { reject(503); return; }
    if (!authorized(request)) { reject(403); return; }
    const ip = control ? String(request.headers['x-beacon-ip']) : sourceIp(request, config);
    let attempt = attempts.get(ip);
    if (!attempt) {
      // A bounded table fails closed instead of evicting active rate limits.
      if (attempts.size >= Math.max(config.limits.maxConnections, 1024)) { reject(429); return; }
      attempt = { bucket: new TokenBucket(config.limits.connectionBurst, config.limits.connectionWindowMs), seenAt: Date.now() };
      attempts.set(ip, attempt);
    }
    attempt.seenAt = Date.now();
    if (!attempt.bucket.take() || peers.size >= config.limits.maxConnections || (counts.get(ip) ?? 0) >= config.limits.maxConnectionsPerIp) { reject(429); return; }
    wss.handleUpgrade(request, socket, head, ws => {
      counts.set(ip, (counts.get(ip) ?? 0) + 1);
      let closed = false;
      let parseFailures = 0;
      let rateViolations = 0;
      let running = false;
      let lastPong = Date.now();
      let expiryTimer: NodeJS.Timeout | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      const queue: ClientMessage[] = [];
      const bucket = new TokenBucket(config.limits.messageBurst, config.limits.messageWindowMs);
      const peer: Peer = {
        id: randomUUID(), ip,
        get closed() { return closed || ws.readyState !== WebSocket.OPEN; },
        send(message) {
          if (peer.closed) return;
          let text: string;
          try { text = JSON.stringify(message); } catch { peer.close(1011, 'Invalid outbound message'); return; }
          const bytes = Buffer.byteLength(text);
          if (bytes > config.limits.outboundBytes || bytes > 65536) {
            log('error', 'outbound_limit', { peerId: peer.id, bytes });
            peer.close(1009, 'Outbound limit'); return;
          }
          if (ws.bufferedAmount + bytes > config.limits.maxBufferedBytes) { peer.close(1013, 'Backpressure'); return; }
          ws.send(text, error => { if (error) ws.terminate(); });
        },
        close(code = 1000, reason = 'Closed') {
          if (closed) return;
          closed = true;
          queue.length = 0;
          ws.close(code, reason);
          closeTimer = setTimeout(() => ws.terminate(), 1000);
          closeTimer.unref();
        },
      };
      origins.set(peer, control ? request.headers['x-beacon-origin'] as string | undefined : request.headers.origin);
      const authTimer = setTimeout(() => {
        peer.send({ type: 'auth_fail', code: 'auth_failed' });
        peer.close(1008, 'Authentication required');
      }, config.limits.authDeadlineMs);
      authTimer.unref();
      authentication.set(peer, expiresAt => {
        if (peer.closed) return;
        clearTimeout(authTimer);
        clearTimeout(expiryTimer);
        if (expiresAt === undefined) return;
        const expire = (): void => {
          if (peer.closed) return;
          const remaining = expiresAt - Date.now();
          if (remaining > 0) {
            expiryTimer = setTimeout(expire, Math.min(remaining, 2_147_483_647));
            expiryTimer.unref();
          } else {
            peer.send(errorMessage('auth_expired'));
            peer.close(1008, 'Authentication expired');
          }
        };
        expire();
      });
      const heartbeat = setInterval(() => {
        if (peer.closed) return;
        if (Date.now() - lastPong >= config.limits.heartbeatTimeoutMs) { ws.terminate(); return; }
        ws.ping();
      }, config.limits.heartbeatIntervalMs);
      heartbeat.unref();
      ws.on('pong', () => { lastPong = Date.now(); });
      ws.on('error', () => ws.terminate());
      ws.once('close', () => {
        closed = true;
        queue.length = 0;
        clearTimeout(authTimer);
        clearTimeout(expiryTimer);
        clearTimeout(closeTimer);
        clearInterval(heartbeat);
        authentication.delete(peer);
        origins.delete(peer);
        peers.delete(ws);
        const count = (counts.get(ip) ?? 1) - 1;
        if (count > 0) counts.set(ip, count); else counts.delete(ip);
        try { handlers.onClose(peer); } catch { log('error', 'close_handler_failed', { peerId: peer.id }); }
      });
      async function drain(): Promise<void> {
        if (running) return;
        running = true;
        try {
          while (!peer.closed && queue.length) {
            const message = queue.shift();
            if (message) await handlers.onMessage(peer, message);
          }
        } catch {
          if (!peer.closed) { peer.send(errorMessage('server_error')); peer.close(1011, 'Handler failed'); }
          log('error', 'message_handler_failed', { peerId: peer.id });
        } finally { running = false; }
      }
      ws.on('message', (data: RawData, binary: boolean) => {
        if (peer.closed) return;
        if (binary) { peer.close(1003, 'Text messages required'); return; }
        const bytes = Array.isArray(data) ? data.reduce((total, chunk) => total + chunk.length, 0) : data.byteLength;
        if (bytes > Math.min(4096, config.limits.inboundBytes)) { peer.close(1009, 'Inbound limit'); return; }
        if (!bucket.take()) {
          peer.send({ ...errorMessage('rate_limited'), ...(messageRequestId(data) ? { requestId: messageRequestId(data), ok: false } : {}) });
          if (++rateViolations >= config.limits.maxRateViolations) peer.close(1008, 'Rate limit');
          return;
        }
        let message: ClientMessage;
        try {
          const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
          message = parseClient(text, config.limits.maxPageSize);
        } catch (error) {
          peer.send({ ...errorMessage(error instanceof ProtocolError ? error.code : 'bad_request'), ...(messageRequestId(data) ? { requestId: messageRequestId(data), ok: false } : {}) });
          if (error instanceof SyntaxError && ++parseFailures >= 3) peer.close(1008, 'Invalid messages');
          return;
        }
        if (queue.length >= config.limits.messageBurst) { peer.close(1013, 'Message queue full'); return; }
        queue.push(message);
        void drain();
      });
      peers.set(ws, peer);
      peer.send({ type: 'hello', serverVersion: '3.0.0', protocolVersion: PROTOCOL_VERSION, capabilities: ['resume', 'request_ids', 'idempotency', 'snapshots', 'matchmaking', 'match_confirmation', 'parties', 'game_sessions', 'invitations', 'match_results', 'chat', ...(config.cluster.enabled ? ['cross_host_ha'] : [])], authDeadlineMs: config.limits.authDeadlineMs });
      try { handlers.onConnect(peer); } catch { peer.close(1011, 'Connection handler failed'); }
    });
  });
  const listening = Promise.withResolvers<void>();
  server.once('error', listening.reject);
  server.listen(config.server.listenPort, config.server.listenHost, () => {
    server.removeListener('error', listening.reject);
    listening.resolve();
  });
  try { await listening.promise; } catch (error) { clearInterval(maintenance); wss.close(); throw error; }
  return {
    address() { return server.address() as AddressInfo; },
    drain(deadline) {
      stopping = true;
      for (const peer of peers.values()) peer.send({ type: 'server_draining', deadline });
    },
    async close() {
      if (closedTransport) return;
      closedTransport = true;
      stopping = true;
      clearInterval(maintenance);
      for (const ws of peers.keys()) ws.terminate();
      for (const socket of sockets) socket.destroy();
      const shutdown = Promise.withResolvers<void>();
      server.close(error => error ? shutdown.reject(error) : shutdown.resolve());
      wss.close();
      await shutdown.promise;
      counts.clear(); attempts.clear();
    },
  };
}

function messageRequestId(data: RawData): string | undefined {
  // Only echo validated correlation metadata; never echo request bodies or credentials.
  try {
    const text = Array.isArray(data) ? Buffer.concat(data).toString('utf8') : Buffer.isBuffer(data) ? data.toString('utf8') : Buffer.from(data).toString('utf8');
    const value: unknown = JSON.parse(text);
    if (value && typeof value === 'object' && 'requestId' in value && typeof value.requestId === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value.requestId)) return value.requestId;
  } catch { /* Malformed JSON has no reliable correlation identifier. */ }
  return undefined;
}
