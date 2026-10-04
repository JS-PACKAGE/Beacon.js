import { request as httpRequest } from 'node:http';
import { request as httpsRequest } from 'node:https';
import { lstatSync, readFileSync } from 'node:fs';
import type { Config } from '../config.js';

export type ClusterConfig = Config['cluster'];
export type Json = Record<string, unknown>;
export function object(value: unknown): Json {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid coordination response');
  return value as Json;
}
export function privateFile(path: string): Buffer {
  const stat = lstatSync(path);
  if (!stat.isFile() || (stat.mode & 0o077) !== 0 || stat.size > 65536) throw new Error('Cluster credential must be a private regular file');
  return readFileSync(path);
}
export const base64 = (value: string): string => Buffer.from(value).toString('base64');
/** No redirects, bounded responses/deadlines, verified TLS. API errors never escape with credentials. */
export class EtcdClient {
  private token = '';
  private cursor = 0;
  private readonly tls: { ca?: Buffer; cert?: Buffer; key?: Buffer; minVersion: 'TLSv1.2' };
  constructor(private readonly config: ClusterConfig) {
    this.tls = { minVersion: 'TLSv1.2', ...(config.etcd.caPath ? { ca: readFileSync(config.etcd.caPath) } : {}), ...(config.etcd.certPath ? { cert: readFileSync(config.etcd.certPath) } : {}), ...(config.etcd.keyPath ? { key: privateFile(config.etcd.keyPath) } : {}) };
  }
  private async call(endpoint: string, path: string, payload: Json, streaming = false): Promise<Json> {
    const url = new URL(path, endpoint);
    const body = JSON.stringify(payload);
    const { promise, resolve, reject } = Promise.withResolvers<Json>();
      let settled = false;
      let bytes = 0;
      const chunks: Buffer[] = [];
      const finish = (error?: Error, value?: Json): void => {
        if (settled) return;
        settled = true; clearTimeout(timer);
        if (error) reject(error); else resolve(value!);
        req.destroy();
      };
      const req = (url.protocol === 'https:' ? httpsRequest : httpRequest)(url, { method: 'POST', ...this.tls, headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body), ...(this.token ? { Authorization: this.token } : {}) } }, response => {
        if (response.statusCode !== 200) { finish(new Error('Coordination unavailable')); return; }
        const parse = (): void => {
          try { finish(undefined, object(JSON.parse(Buffer.concat(chunks).toString('utf8')))); }
          catch { finish(new Error('Invalid coordination response')); }
        };
        response.on('data', (chunk: Buffer) => {
          bytes += chunk.length;
          if (bytes > this.config.maxSnapshotBytes * 2 + 65536) { finish(new Error('Coordination response limit')); return; }
          chunks.push(chunk);
          if (streaming && chunk.includes(10)) parse();
        });
        response.on('end', parse);
        response.on('error', () => finish(new Error('Coordination unavailable')));
      });
      const timer = setTimeout(() => finish(new Error('Coordination deadline')), this.config.requestTimeoutMs);
      req.on('error', () => finish(new Error('Coordination unavailable')));
      req.end(body);
    return promise;
  }
  async request(path: string, payload: Json, streaming = false): Promise<Json> {
    // Never retry mutations after an uncertain response. The caller fences itself instead.
    const endpoint = this.config.endpoints[this.cursor % this.config.endpoints.length]!;
    try {
      if (this.config.etcd.username && !this.token) {
        const auth = await this.call(endpoint, '/v3/auth/authenticate', { name: this.config.etcd.username, password: privateFile(this.config.etcd.passwordPath).toString('utf8').trim() });
        if (typeof auth.token !== 'string' || !auth.token) throw new Error('Coordination authentication unavailable');
        this.token = auth.token;
      }
      return await this.call(endpoint, path, payload, streaming);
    } catch { this.token = ''; this.cursor++; throw new Error('Coordination unavailable'); }
  }
}
