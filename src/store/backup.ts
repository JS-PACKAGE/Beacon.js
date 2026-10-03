import { DatabaseSync, backup } from 'node:sqlite';
import { chmod, mkdir, open, unlink } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { loadConfig } from '../config.js';

export async function backupDatabase(source: string, destination: string): Promise<void> {
  if (resolve(source) === resolve(destination)) throw new Error('Backup destination must differ from the live database');
  await mkdir(dirname(destination), { recursive: true, mode: 0o700 });
  const target = await open(destination, 'wx', 0o600);
  await target.close();
  let db: DatabaseSync | undefined;
  try {
    db = new DatabaseSync(source, { readOnly: true, allowExtension: false });
    const integrity = db.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Source database integrity check failed');
    await backup(db, destination);
    await chmod(destination, 0o600);
  } catch (error) {
    await unlink(destination);
    throw error;
  } finally { db?.close(); }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.umask(0o077);
  const args = process.argv.slice(2);
  const destination = args[0];
  const configPath = args.length === 3 && args[1] === '--config' ? args[2] : 'config.yaml';
  if (!destination || !(args.length === 1 || (args.length === 3 && args[1] === '--config'))) {
    console.error('Usage: npm run backup -- OUTPUT [--config config.yaml]');
    process.exitCode = 1;
  } else {
    void loadConfig(configPath, { mockAuth: true, insecureWs: true })
      .then(config => backupDatabase(config.db.path, destination))
      .then(() => console.log('SQLite backup completed (0600)'))
      .catch(() => { console.error('Backup failed; existing destination files are never overwritten'); process.exitCode = 1; });
  }
}
