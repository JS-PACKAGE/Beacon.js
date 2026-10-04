import { Worker } from 'node:worker_threads';
import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import { ProtocolError } from '../protocol/index.js';
import { object, type Json } from './etcd.js';
import type { DurableRequests } from '../protocol/requests.js';

export interface ClusterHealth { enabled: boolean; nodeId: string; role: string; healthy: boolean; leaseRemainingMs: number; revision: string; leaderId?: string; replicationBytes: number; url?: string; epoch?: string }
/** Worker owns network coordination while SQLite's synchronous pre-commit hook waits boundedly. */
export class ClusterCoordinator implements DurableRequests {
  private readonly worker: Worker;
  private readonly shared: SharedArrayBuffer;
  private unavailable = false;
  private closed = false;
  constructor(private readonly config: Config, onElected: (snapshot: string, epoch: string) => void, onLost: () => void) {
    this.shared = new SharedArrayBuffer(config.cluster.maxSnapshotBytes + 65552);
    this.worker = new Worker(new URL('./worker.js', import.meta.url), { workerData: { config: config.cluster, replicaPath: `${config.db.path}.replica`, maxRequests: Math.min(config.limits.maxConnections * config.lobby.requestCacheSize, 10000), maxPlayerRequests: Math.min(config.lobby.requestCacheSize, 128), requestTtlMs: config.lobby.requestCacheTtlMs } });
    this.worker.on('message', (message: { event: string; snapshot?: string; epoch?: string }) => {
      if (this.closed) return;
      if (message.event === 'elected') onElected(message.snapshot!, message.epoch!);
      else if (message.event === 'lost') onLost();
    });
    this.worker.on('error', () => { this.unavailable = true; onLost(); });
    this.worker.on('exit', () => { this.unavailable = true; if (!this.closed) onLost(); });
  }
  private rpc(command: string, value?: unknown, epoch?: string): unknown {
    if (this.unavailable || this.closed) throw new ProtocolError('cluster_unavailable');
    const signal = new Int32Array(this.shared, 0, 4);
    Atomics.store(signal, 0, 0);
    this.worker.postMessage({ command, value, epoch, shared: this.shared });
    const deadline = this.config.cluster.requestTimeoutMs *
      (Math.ceil(this.config.cluster.maxStateBytes / this.config.cluster.maxSnapshotBytes) + this.config.cluster.checkpointInterval + 64) + 1000;
    const result = Atomics.wait(signal, 0, 0, deadline);
    if (result === 'timed-out') {
      this.unavailable = true;
      void this.worker.terminate();
      throw new ProtocolError('cluster_unavailable');
    }
    const response = object(JSON.parse(Buffer.from(this.shared, 16, Atomics.load(signal, 1)).toString('utf8')));
    if (response.error !== undefined) {
      const code = response.error;
      if (code === 'storage_full' || code === 'request_capacity' || code === 'request_indeterminate' || code === 'cluster_unavailable') throw new ProtocolError(code);
      throw new ProtocolError('cluster_unavailable');
    }
    return response.result;
  }
  health(): ClusterHealth {
    if (this.unavailable || this.closed) return { enabled: true, nodeId: this.config.cluster.nodeId, role: 'unavailable', healthy: false, leaseRemainingMs: 0, revision: '0', replicationBytes: 0 };
    return this.rpc('health') as ClusterHealth;
  }
  assertLeader(epoch?: string): void { this.rpc('fence', undefined, epoch); }
  invalidate(): void {
    this.unavailable = true;
    void this.worker.terminate();
  }
  commitChangeset(changeset: Uint8Array, epoch?: string): void { this.rpc('changeset', changeset, epoch); }
  reserve(playerId: string, requestId: string, digest: string, epoch?: string): { status: 'reserved' | 'complete' | 'conflict' | 'indeterminate'; replies?: Json[] } {
    return this.rpc('reserve', { key: createHash('sha256').update(JSON.stringify([playerId, requestId])).digest('hex'), owner: createHash('sha256').update(playerId).digest('hex'), digest }, epoch) as { status: 'reserved' | 'complete' | 'conflict' | 'indeterminate'; replies?: Json[] };
  }
  complete(playerId: string, requestId: string, replies: Json[], epoch?: string): void {
    this.rpc('complete', { key: createHash('sha256').update(JSON.stringify([playerId, requestId])).digest('hex'), replies }, epoch);
  }
  async close(): Promise<void> {
    if (this.closed) return;
    try { this.rpc('stop'); } catch { /* Lease expiry still fences shutdown if quorum is unavailable. */ }
    this.closed = true;
    await this.worker.terminate();
  }
}
