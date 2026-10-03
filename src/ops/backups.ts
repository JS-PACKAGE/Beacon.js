import { lstat, readdir, unlink } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { backupDatabase } from '../store/backup.js';
import { privateDirectory } from './files.js';

const ownedName = /^beacon-backup-\d{13}-[0-9a-f-]{36}\.sqlite$/;

export async function scheduledBackup(source: string, directory: string, retention: number): Promise<string> {
  if (!Number.isSafeInteger(retention) || retention < 1) throw new Error('Invalid backup retention');
  const root = await privateDirectory(directory);
  const sourceInfo = await lstat(source);
  if (!sourceInfo.isFile() || sourceInfo.isSymbolicLink()) throw new Error('Unsafe backup source');
  const destination = join(root, `beacon-backup-${Date.now()}-${randomUUID()}.sqlite`);
  await backupDatabase(source, destination);
  const files: string[] = [];
  for (const name of await readdir(root)) {
    if (!ownedName.test(name)) continue;
    const info = await lstat(join(root, name));
    if (info.isFile() && !info.isSymbolicLink() && (info.mode & 0o777) === 0o600) files.push(name);
  }
  files.sort().reverse();
  for (const name of files.slice(retention)) await unlink(join(root, name));
  return destination;
}
