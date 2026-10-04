import type { DatabaseSync } from 'node:sqlite';
import { createHash } from 'node:crypto';
import { domainId, domainKinds, type DomainKind } from './domain.js';
import { readRules } from '../protocol/index.js';

/** One-time transactional migration: retain old private results, invalidate ownerless invitations. */
export function migrateDomain(db: DatabaseSync): void {
  db.exec("CREATE TABLE domain_records(kind TEXT NOT NULL, id TEXT NOT NULL, data TEXT NOT NULL CHECK(json_valid(data)), PRIMARY KEY(kind,id)) STRICT");
  const insert = db.prepare('INSERT INTO domain_records VALUES(?,?,?)');
  const previous = db.prepare('SELECT data FROM domain_state WHERE id=1').get();
  if (previous) {
    const raw: unknown = JSON.parse(String(previous.data));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => !domainKinds.includes(key as DomainKind))) throw new Error('Invalid legacy domain');
    const domain = raw as Record<string, unknown>;
    for (const kind of domainKinds) {
      const values = domain[kind] ?? [];
      if (!Array.isArray(values)) throw new Error('Invalid legacy domain');
      for (const value of values) insert.run(kind, domainId(kind, value), JSON.stringify(value));
    }
  }
  const find = db.prepare('SELECT data FROM domain_records WHERE kind=? AND id=?');
  for (const room of db.prepare('SELECT id,game_id,created_at,metadata FROM rooms').all()) {
    const metadata: unknown = JSON.parse(String(room.metadata));
    if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) throw new Error('Invalid legacy room');
    const data = metadata as Record<string, unknown>;
    if (data.seats === undefined) continue;
    if (!Array.isArray(data.seats)) throw new Error('Invalid legacy seats');
    let changed = false;
    const clean: Record<string, unknown>[] = [];
    const rosters = new Map<string, string[]>();
    for (const raw of data.seats) {
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid legacy seat');
      const { pendingResult, ...seat } = raw as Record<string, unknown>;
      clean.push(seat);
      if (pendingResult === undefined) continue;
      changed = true;
      if (!pendingResult || typeof pendingResult !== 'object' || Array.isArray(pendingResult)) throw new Error('Invalid legacy result');
      const pending = pendingResult as Record<string, unknown>;
      if (Object.keys(pending).some(key => !['matchId', 'result'].includes(key)) || typeof pending.matchId !== 'string' || typeof seat.playerId !== 'string') throw new Error('Invalid legacy result');
      const result = { resultId: createHash('sha256').update(JSON.stringify(['legacy-result', pending.matchId, seat.playerId])).digest('hex'), matchId: pending.matchId, playerId: seat.playerId, roomId: String(room.id), result: readRules(pending.result), createdAt: Number(room.created_at) };
      if (!find.get('results', result.resultId)) insert.run('results', domainId('results', result), JSON.stringify(result));
      const roster = rosters.get(pending.matchId) ?? []; roster.push(seat.playerId); rosters.set(pending.matchId, roster);
    }
    for (const [matchId, roster] of rosters) {
      if (find.get('matches', matchId)) continue;
      const match = { matchId, roomId: String(room.id), gameId: String(room.game_id), roster, createdAt: Number(room.created_at), state: 'ended' };
      insert.run('matches', domainId('matches', match), JSON.stringify(match));
    }
    if (changed) db.prepare('UPDATE rooms SET metadata=? WHERE id=?').run(JSON.stringify({ ...data, seats: clean }), String(room.id));
  }
  db.exec("DELETE FROM invitations WHERE json_extract(metadata,'$.sender') IS NULL OR json_extract(metadata,'$.status') IS NULL OR json_extract(metadata,'$.createdAt') IS NULL; DROP TABLE domain_state");
}
