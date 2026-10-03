import { closeSync, constants, fstatSync, lstatSync, openSync, renameSync, unlinkSync, writeSync } from 'node:fs';
import type { Config } from '../config.js';
import { privateParent } from '../ops/files.js';

const sensitiveKey = /token|ticket|password|authorization|secret|jwt|credential|cookie|private.?key|body|stack|error.?message/i;
const jwt = /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/g;
const bearer = /\bBearer\s+[^\s,;]+/gi;
const assignedSecret = /\b(token|ticket|password|secret|authorization|credential)(=|:\s*)[^\s&,;]+/gi;
let sink: { fd: number; path: string; bytes: number; maxBytes: number; files: number } | undefined;

export function redact(value: unknown, seen = new WeakSet<object>(), depth = 0): unknown {
  if (typeof value === 'string') return value.replace(jwt, '[REDACTED]').replace(bearer, 'Bearer [REDACTED]').replace(assignedSecret, '$1$2[REDACTED]').replace(/:\/\/[^/@\s]+:[^/@\s]+@/g, '://[REDACTED]@').slice(0, 4096);
  if (value === null || typeof value !== 'object') return typeof value === 'bigint' ? value.toString() : value;
  if (value instanceof Error) return { category: 'error' };
  if (depth >= 16 || seen.has(value)) return '[OMITTED]';
  seen.add(value);
  if (Array.isArray(value)) return value.slice(0, 128).map(item => redact(item, seen, depth + 1));
  const result: Record<string, unknown> = Object.create(null) as Record<string, unknown>;
  for (const [key, item] of Object.entries(value).slice(0, 128)) result[key] = sensitiveKey.test(key) ? '[REDACTED]' : redact(item, seen, depth + 1);
  return result;
}

function safeFile(path: string): boolean {
  try {
    const info = lstatSync(path);
    if (!info.isFile() || info.isSymbolicLink() || (info.mode & 0o777) !== 0o600) throw new Error('Unsafe log file');
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function openLog(path: string): number {
  safeFile(path);
  const fd = openSync(path, constants.O_WRONLY | constants.O_APPEND | constants.O_CREAT | constants.O_NOFOLLOW, 0o600);
  const info = fstatSync(fd);
  if (!info.isFile() || (info.mode & 0o777) !== 0o600) { closeSync(fd); throw new Error('Unsafe log file'); }
  return fd;
}

export async function configureLogging(operations: Config['operations']): Promise<void> {
  await closeLogging();
  if (!operations.logPath) { log('info', 'persistent_logging_disabled'); return; }
  if (!Number.isSafeInteger(operations.logMaxBytes) || operations.logMaxBytes < 1024 || !Number.isSafeInteger(operations.logFiles) || operations.logFiles < 1 || operations.logFiles > 100) throw new Error('Invalid logging limits');
  await privateParent(operations.logPath);
  const fd = openLog(operations.logPath);
  sink = { fd, path: operations.logPath, bytes: fstatSync(fd).size, maxBytes: operations.logMaxBytes, files: operations.logFiles };
}

export async function closeLogging(): Promise<void> {
  if (sink) { const previous = sink; sink = undefined; closeSync(previous.fd); }
}

export function log(level: 'info' | 'warn' | 'error', event: string, fields: Record<string, unknown> = {}): void {
  let line = JSON.stringify({ time: new Date().toISOString(), level, event: redact(event), fields: redact(fields) });
  if (Buffer.byteLength(line) > 65536) line = JSON.stringify({ time: new Date().toISOString(), level, event: redact(event), fields: '[OMITTED: oversized]' });
  line += '\n';
  (level === 'info' ? process.stdout : process.stderr).write(line);
  if (!sink) return;
  try {
    if (Buffer.byteLength(line) > sink.maxBytes) line = JSON.stringify({ time: new Date().toISOString(), level, event: String(redact(event)).slice(0, 128), fields: '[OMITTED: oversized]' }) + '\n';
    const bytes = Buffer.byteLength(line);
    if (sink.bytes && sink.bytes + bytes > sink.maxBytes) {
      for (let i = 1; i <= sink.files; i++) safeFile(`${sink.path}.${i}`);
      closeSync(sink.fd);
      sink.fd = -1;
      if (safeFile(`${sink.path}.${sink.files}`)) unlinkSync(`${sink.path}.${sink.files}`);
      for (let i = sink.files - 1; i >= 1; i--) if (safeFile(`${sink.path}.${i}`)) renameSync(`${sink.path}.${i}`, `${sink.path}.${i + 1}`);
      renameSync(sink.path, `${sink.path}.1`);
      sink.fd = openLog(sink.path);
      sink.bytes = 0;
    }
    const buffer = Buffer.from(line);
    let offset = 0;
    while (offset < buffer.length) offset += writeSync(sink.fd, buffer, offset, buffer.length - offset);
    sink.bytes += bytes;
  } catch {
    if (sink?.fd !== undefined && sink.fd >= 0) closeSync(sink.fd);
    sink = undefined;
    process.stderr.write('{"level":"error","event":"persistent_logging_failed"}\n');
  }
}
