import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, existsSync, lstatSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';
import type { RoomStore, StoredRoom } from '../types.js';

export class SqliteRoomStore implements RoomStore {
  private readonly db: DatabaseSync;

  constructor(path: string) {
    if (path === ':memory:') throw new Error('Room persistence requires a database file');
    const existed = existsSync(path);
    if (existed && !lstatSync(path).isFile()) throw new Error('Database path must be a regular file, not a symlink');
    mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    if (!existed) closeSync(openSync(path, 'wx', 0o600));
    let db: DatabaseSync | undefined;
    try {
      db = new DatabaseSync(path, { timeout: 3000, enableForeignKeyConstraints: true, enableDoubleQuotedStringLiterals: false, allowExtension: false });
      const integrity = db.prepare('PRAGMA integrity_check').all();
      if (integrity.length !== 1 || integrity[0]?.integrity_check !== 'ok') throw new Error('integrity_check failed');
      chmodSync(path, 0o600);
      db.exec('PRAGMA journal_mode = WAL; PRAGMA synchronous = FULL;');
      db.exec('BEGIN IMMEDIATE');
      try {
        db.exec('CREATE TABLE IF NOT EXISTS schema_migrations (version INTEGER PRIMARY KEY, applied_at INTEGER NOT NULL) STRICT');
        const versions = db.prepare('SELECT version FROM schema_migrations ORDER BY version').all();
        if (versions.some(row => row.version !== 1)) throw new Error('Unsupported schema version');
        if (!versions.length) {
          db.exec(`CREATE TABLE rooms (
            id TEXT PRIMARY KEY, game_id TEXT NOT NULL, name TEXT NOT NULL,
            password_hash TEXT, max_players INTEGER NOT NULL CHECK(max_players > 0),
            host_id TEXT NOT NULL, state TEXT NOT NULL CHECK(state IN ('open', 'closed')),
            created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
          ) STRICT;
          CREATE INDEX rooms_game ON rooms(game_id);`);
          db.prepare('INSERT INTO schema_migrations(version, applied_at) VALUES(1, ?)').run(Date.now());
        }
        db.exec('COMMIT');
      } catch (error) {
        if (db.isTransaction) db.exec('ROLLBACK');
        throw error;
      }
      for (const suffix of ['-wal', '-shm']) if (existsSync(path + suffix)) chmodSync(path + suffix, 0o600);
      this.db = db;
      this.load();
    } catch {
      db?.close();
      throw new Error('Unable to open or validate room database. Original file retained; restore a backup or repair the database. 保留原檔，請還原備份或修復。');
    }
  }

  load(): StoredRoom[] {
    return this.db.prepare('SELECT * FROM rooms ORDER BY created_at, id').all().map(row => {
      const { id, game_id, name, host_id, password_hash, max_players, state, created_at, updated_at } = row;
      if (typeof id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(id) ||
          typeof game_id !== 'string' || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(game_id) ||
          typeof name !== 'string' || [...name].length < 1 || [...name].length > 32 || /[\p{Cc}\p{Cs}]/u.test(name) ||
          typeof host_id !== 'string' || !host_id.length || Buffer.byteLength(host_id) > 128 ||
          !(password_hash === null || (typeof password_hash === 'string' && password_hash.length <= 512)) ||
          typeof max_players !== 'number' || !Number.isSafeInteger(max_players) || max_players < 1 ||
          (state !== 'open' && state !== 'closed') ||
          typeof created_at !== 'number' || !Number.isSafeInteger(created_at) ||
          typeof updated_at !== 'number' || !Number.isSafeInteger(updated_at)) throw new Error('Invalid persisted room data');
      return { id, gameId: game_id, name, hostId: host_id, passwordHash: password_hash, maxPlayers: max_players, state, createdAt: created_at, updatedAt: updated_at };
    });
  }

  private commit(write: () => void): void {
    this.db.exec('BEGIN IMMEDIATE');
    try {
      write();
      this.db.exec('COMMIT');
    } catch (error) {
      if (this.db.isTransaction) this.db.exec('ROLLBACK');
      throw error;
    }
  }

  insert(room: StoredRoom): void {
    this.commit(() => {
      this.db.prepare('INSERT INTO rooms(id, game_id, name, password_hash, max_players, host_id, state, created_at, updated_at) VALUES(?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(room.id, room.gameId, room.name, room.passwordHash, room.maxPlayers, room.hostId, room.state, room.createdAt, room.updatedAt);
    });
  }
  setHost(id: string, hostId: string, updatedAt: number): void {
    this.commit(() => {
      if (this.db.prepare('UPDATE rooms SET host_id = ?, updated_at = ? WHERE id = ?').run(hostId, updatedAt, id).changes !== 1) throw new Error('Room no longer exists');
    });
  }
  delete(id: string): void {
    this.commit(() => {
      if (this.db.prepare('DELETE FROM rooms WHERE id = ?').run(id).changes !== 1) throw new Error('Room no longer exists');
    });
  }
  close(): void { this.db.close(); }
}
