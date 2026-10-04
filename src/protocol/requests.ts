import { createHash } from 'node:crypto';
import type { Config } from '../config.js';
import type { ClientMessage } from './index.js';
import { ProtocolError } from './index.js';

type Reply = Record<string, unknown>;
interface Entry { digest: string; expiresAt: number; replies: Reply[]; bytes: number; completed: boolean; done: Promise<void>; finish(): void }
export interface DurableRequests {
  reserve(playerId: string, requestId: string, digest: string): { status: 'reserved' | 'complete' | 'conflict' | 'indeterminate'; replies?: Reply[] };
  complete(playerId: string, requestId: string, replies: Reply[]): void;
}
const reads = new Set(['ping', 'list_rooms', 'list_games', 'list_friends', 'sync_state']);
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).sort(([a], [b]) => a.localeCompare(b)).map(([key, item]) => [key, canonical(item)]));
  return value;
}
/** Process-local, bounded replay window. Hashes inputs; never retains plaintext credentials. */
export class RequestLedger {
  private readonly players = new Map<string, Map<string, Entry>>();
  private bytes = 0;
  constructor(private readonly config: Config, private readonly durable?: DurableRequests) {}

  async execute(playerId: string, message: ClientMessage, send: (reply: Reply) => void, operation: (reply: (value: Reply) => void) => Promise<void>): Promise<void> {
    const requestId = message.requestId;
    if (this.durable && !requestId && !reads.has(message.type) && message.type !== 'auth' && message.type !== 'refresh_auth') throw new ProtocolError('request_id_required');
    if (!requestId || reads.has(message.type) || message.type === 'auth' || message.type === 'refresh_auth') {
      await operation(value => send(requestId ? { ...value, requestId } : value));
      return;
    }
    this.sweep();
    let requests = this.players.get(playerId);
    const digest = createHash('sha256').update(JSON.stringify(canonical(message))).digest('hex');
    const previous = requests?.get(requestId);
    if (previous && this.durable) await previous.done;
    if (previous && !this.durable) {
      if (previous.digest !== digest) throw new ProtocolError('request_conflict');
      await previous.done;
      for (const reply of previous.replies) {
        if (typeof reply.expiresAt === 'number' && reply.expiresAt <= Date.now()) continue;
        send({ ...reply, replayed: true, ...(reply.type === 'result' ? { resyncRequired: true } : {}) });
      }
      return;
    }
    if (this.durable) {
      const reservation = this.durable.reserve(playerId, requestId, digest);
      if (reservation.status === 'conflict') throw new ProtocolError('request_conflict');
      if (reservation.status === 'indeterminate') throw new ProtocolError('request_indeterminate');
      if (reservation.status === 'complete') {
        for (const reply of reservation.replies ?? []) send({ ...reply, replayed: true, resyncRequired: true });
        return;
      }
    }
    if (!requests) {
      if (this.players.size >= this.config.limits.maxConnections * 2) throw new ProtocolError('rate_limited');
      requests = new Map(); this.players.set(playerId, requests);
    }
    while (requests.size >= this.config.lobby.requestCacheSize) {
      const oldest = [...requests].find(([, entry]) => entry.completed);
      if (!oldest) throw new ProtocolError('rate_limited');
      this.bytes -= oldest[1].bytes; requests.delete(oldest[0]);
    }
    const globalLimit = this.config.limits.maxBufferedBytes * Math.min(this.config.limits.maxConnections, 256);
    if (this.bytes >= globalLimit) throw new ProtocolError('rate_limited');
    const barrier = Promise.withResolvers<void>();
    const entry: Entry = { digest, expiresAt: Date.now() + this.config.lobby.requestCacheTtlMs, replies: [], bytes: 0, completed: false, done: barrier.promise, finish: () => barrier.resolve() };
    requests.set(requestId, entry);
    let overflowed = false;
    let durableCompleted = false;
    try {
      await operation(value => {
        const reply: Reply = { ...value, requestId };
        const bytes = Buffer.byteLength(JSON.stringify(reply));
        if (entry.bytes + bytes > this.config.limits.maxBufferedBytes || this.bytes + bytes > globalLimit) {
          overflowed = true;
          this.bytes -= entry.bytes; entry.bytes = 0; entry.replies = [];
        }
        if (!overflowed || reply.type === 'result' || reply.type === 'error') {
          const cached = overflowed ? { ...reply, resyncRequired: true } : reply;
          const size = Buffer.byteLength(JSON.stringify(cached));
          entry.replies.push(cached); entry.bytes += size; this.bytes += size;
        }
        if (!this.durable) send(reply);
      });
      if (this.durable) {
        this.durable.complete(playerId, requestId, entry.replies);
        durableCompleted = true;
        for (const reply of entry.replies) send(reply);
      }
    } finally {
      if (this.durable && !durableCompleted) {
        this.bytes -= entry.bytes;
        requests.delete(requestId);
      }
      entry.completed = true;
      entry.expiresAt = Date.now() + this.config.lobby.requestCacheTtlMs;
      entry.finish();
    }
  }

  sweep(now = Date.now()): void {
    for (const [player, requests] of this.players) {
      for (const [id, entry] of requests) if (entry.completed && entry.expiresAt <= now) { this.bytes -= entry.bytes; requests.delete(id); }
      if (!requests.size) this.players.delete(player);
    }
  }
  clearPlayer(playerId: string): void {
    const requests = this.players.get(playerId);
    if (!requests) return;
    // Pending commands retain their barrier so a replacement session cannot execute twice.
    for (const [id, entry] of requests) if (entry.completed) { this.bytes -= entry.bytes; requests.delete(id); }
    if (!requests.size) this.players.delete(playerId);
  }
  clear(): void { this.players.clear(); this.bytes = 0; }
}
