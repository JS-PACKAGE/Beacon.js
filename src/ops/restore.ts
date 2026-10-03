import { mkdtemp, rm, lstat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { backupDatabase } from '../store/backup.js';
import { SqliteRoomStore } from '../store/index.js';

export interface RestoreDrillResult { integrity: 'ok'; rooms: number; migrationVersions: number[] }

// The caller never supplies a destination: migration writes are confined to our temporary copy.
export async function restoreDrill(source: string): Promise<RestoreDrillResult> {
  const info = await lstat(source);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('Restore source must be a regular database file');
  const directory = await mkdtemp(join(tmpdir(), 'beacon-restore-drill-'));
  const destination = join(directory, 'restored.sqlite');
  let database: DatabaseSync | undefined;
  let store: SqliteRoomStore | undefined;
  try {
    await backupDatabase(source, destination);
    database = new DatabaseSync(destination, { readOnly: true, allowExtension: false });
    const expectedIds = database.prepare('SELECT id FROM rooms ORDER BY id').all().map(row => row.id);
    database.close(); database = undefined;
    store = new SqliteRoomStore(destination);
    const rooms = store.load();
    if (JSON.stringify(rooms.map(room => room.id).sort()) !== JSON.stringify(expectedIds)) throw new Error('Room restore verification failed');
    // Loading exercises the current persisted room validator after the real migrations.
    store.listModeration(); store.listSocial(); store.listAudit(200);
    store.close(); store = undefined;
    database = new DatabaseSync(destination, { readOnly: true, allowExtension: false });
    const integrity = database.prepare('PRAGMA integrity_check').all();
    if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('Restored database integrity failed');
    const migrationVersions = database.prepare('SELECT version FROM schema_migrations ORDER BY version').all().map(row => {
      if (typeof row.version !== 'number' || !Number.isSafeInteger(row.version)) throw new Error('Invalid migration version');
      return row.version;
    });
    return { integrity: 'ok', rooms: rooms.length, migrationVersions };
  } finally {
    store?.close(); database?.close();
    await rm(directory, { recursive: true, force: true });
  }
}
