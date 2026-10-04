export interface OperationsPage { items: unknown[]; nextCursor?: string }

const scalarFields: Record<string, true> = Object.fromEntries(['id', 'roomId', 'matchId', 'gameId', 'game', 'gameVersion', 'version', 'name', 'state', 'status', 'hostId', 'leaderId', 'playerId', 'displayName', 'partyId', 'proposalId', 'reportId', 'messageId', 'reporterId', 'authorId', 'scope', 'action', 'at', 'actor', 'target', 'createdAt', 'updatedAt', 'startedAt', 'finishedAt', 'endedAt', 'resolvedAt', 'reviewedAt', 'deadline', 'expiresAt', 'until', 'queuedAt', 'waitMs', 'ageMs', 'oldestWaitMs', 'oldestProposalAgeMs', 'oldestQueueAgeMs', 'maxWaitMs', 'count', 'queued', 'proposals', 'parties', 'players', 'accepted', 'minPlayers', 'maxPlayers', 'capacity', 'memberCount', 'operationId', 'joinPolicy', 'region', 'role', 'team', 'ready', 'healthy', 'enabled', 'configured', 'available', 'fenced', 'leader', 'isLeader', 'nodeId', 'term', 'revision', 'replicatedRevision', 'replicationBytes', 'lag', 'lagMs', 'leaseRemainingMs', 'lastSuccessAt', 'lastFailureAt', 'lastCheckAt', 'latencyMs', 'failures', 'errorCode', 'mode', 'provider', 'backend', 'auth', 'games', 'storage', 'cluster'].map(key => [key, true as const]));
const objectFields: Record<string, true> = Object.fromEntries(['members', 'roster', 'teams', 'queue', 'proposal', 'entries', 'integrations', 'dependencies', 'authentication', 'gameSessions', 'profiles', 'persistence', 'replication', 'election', 'summary', 'evidence', 'message', 'review', 'result', 'reconcile', 'cluster'].map(key => [key, true as const]));
const evidenceFields: Record<string, true> = { text: true, reason: true };
Object.assign(scalarFields, { senderId: true, scopeId: true, visibility: true, locked: true, maxSpectators: true });
Object.assign(objectFields, { proposals: true, parties: true, players: true, accepted: true });
Object.assign(scalarFields, { dedupEntries: true, dedupIndeterminate: true, dedupCapacity: true, dedupPerPlayerCapacity: true, dedupWindowMs: true, dedupPolicy: true });

// An allowlist is deliberately used rather than removing known secrets: new provider
// diagnostics are private until consciously added to the administrative contract.
export function projectDiagnostic(value: unknown, report = false, depth = 0): unknown {
  if (depth === 0 && (!value || typeof value !== 'object')) return {};
  if (depth > 6) return undefined;
  if (value === null || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : undefined;
  if (typeof value === 'string') return Buffer.byteLength(value) <= (report ? 8000 : 256) && !/[\p{Cc}\p{Cs}]/u.test(value) ? value : undefined;
  if (Array.isArray(value)) return value.slice(0, 200).map(item => projectDiagnostic(item, report, depth + 1)).filter(item => item !== undefined);
  if (!value || typeof value !== 'object') return undefined;
  const output: Record<string, unknown> = {};
  for (const [key, item] of Object.entries(value).slice(0, 128)) {
    if (Object.hasOwn(scalarFields, key) && (item === null || ['string', 'number', 'boolean'].includes(typeof item))) {
      const safe = projectDiagnostic(item, report, depth + 1); if (safe !== undefined) output[key] = safe;
    } else if (Object.hasOwn(objectFields, key) || (report && Object.hasOwn(evidenceFields, key))) {
      const safe = projectDiagnostic(item, report, depth + 1); if (safe !== undefined) output[key] = safe;
    }
  }
  return output;
}

export function projectPage(page: OperationsPage, limit: number, report = false, cursor?: string): OperationsPage {
  const items: unknown[] = [];
  const count = Math.min(page.items.length, limit);
  let bytes = 64;
  for (let index = 0; index < count; index++) {
    const projected = projectDiagnostic(page.items[index], report);
    const size = Buffer.byteLength(JSON.stringify(projected)) + (items.length ? 1 : 0);
    if (items.length && bytes + size > 65536) break;
    items.push(projected);
    bytes += size;
    if (bytes > 65536) break;
  }
  const nextCursor = items.length < page.items.length
    ? String(Number(cursor ?? 0) + items.length)
    : page.nextCursor;
  return { items, ...(nextCursor !== undefined && /^[0-9]{1,10}$/.test(nextCursor) ? { nextCursor } : {}) };
}

export function pagination(url: URL): { cursor: string | undefined; limit: number } {
  for (const key of url.searchParams.keys()) if (!['cursor', 'limit'].includes(key) || url.searchParams.getAll(key).length !== 1) throw new Error('Invalid request');
  const cursor = url.searchParams.get('cursor') ?? undefined;
  const rawLimit = url.searchParams.get('limit') ?? '50';
  if ((cursor !== undefined && (!/^(0|[1-9][0-9]{0,9})$/.test(cursor) || Number(cursor) > 1_000_000_000)) || !/^[1-9][0-9]{0,2}$/.test(rawLimit)) throw new Error('Invalid request');
  const limit = Number(rawLimit);
  if (limit > 200) throw new Error('Invalid request');
  return { cursor, limit };
}
