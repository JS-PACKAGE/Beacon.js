import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { isLoopback, type Config, type DevOptions } from '../config.js';

function normalize(ip: string): string { return ip.startsWith('::ffff:') ? ip.slice(7) : ip; }
function header(request: IncomingMessage, name: string): string | undefined {
  const value = request.headers[name];
  return typeof value === 'string' ? value : undefined;
}
export function trustedRemote(remote: string, config: Config): boolean {
  return config.server.trustProxy && (isLoopback(remote) || config.server.trustedProxyAddresses.some(ip => normalize(ip) === normalize(remote)));
}
export function sourceIp(request: IncomingMessage, config: Config): string {
  const remote = normalize(request.socket.remoteAddress ?? '');
  if (!trustedRemote(remote, config)) return remote;
  const cf = header(request, 'cf-connecting-ip');
  if (cf && isIP(cf)) return normalize(cf);
  const forwarded = header(request, 'x-forwarded-for');
  const rightmost = forwarded?.split(',').at(-1)?.trim();
  return rightmost && isIP(rightmost) ? normalize(rightmost) : remote;
}

export function allowUpgrade(request: IncomingMessage, config: Config, dev: DevOptions): boolean {
  const remote = request.socket.remoteAddress ?? '';
  if (!isLoopback(remote)) return false;
  const origin = header(request, 'origin');
  if (origin === undefined ? !config.server.allowNoOrigin : !config.server.allowedOrigins.includes(origin)) return false;
  if (dev.insecureWs) return true;
  const host = header(request, 'host');
  if (host?.toLowerCase() !== config.public.domain.toLowerCase() && host?.toLowerCase() !== `${config.public.domain.toLowerCase()}:443`) return false;
  if (config.public.tls === 'direct') return 'encrypted' in request.socket && request.socket.encrypted === true;
  return trustedRemote(remote, config) && header(request, 'x-forwarded-proto') === 'https';
}
