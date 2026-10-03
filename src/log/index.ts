const sensitiveKey = /token|password|authorization|secret|jwt|credential|cookie|private.?key|body|stack|error.?message/i;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const bearer = /\bBearer\s+[^\s,;]+/gi;

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return value.replace(jwt, '[REDACTED]').replace(bearer, 'Bearer [REDACTED]');
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Error) return { category: 'error' };
  if (depth >= 16 || seen.has(value)) return '[OMITTED]';
  seen.add(value);
  if (Array.isArray(value)) return value.map(item => redact(item, seen, depth + 1));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value)) result[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(item, seen, depth + 1);
  return result;
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  const line = JSON.stringify({ time: new Date().toISOString(), level, event: redact(event), fields: redact(fields) });
  (level === 'info' ? process.stdout : process.stderr).write(`${line}\n`);
}
