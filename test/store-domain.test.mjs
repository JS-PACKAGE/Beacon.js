import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { SqliteRoomStore } from '../dist/store/index.js';

async function stores(t) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-domain-'));
  const primaryPath = join(directory, 'primary.db');
  const primary = new SqliteRoomStore(primaryPath);
  const replica = new SqliteRoomStore(join(directory, 'replica.db'));
  t.after(async () => { primary.close(); replica.close(); await rm(directory, { recursive: true, force: true }); });
  return { primary, replica, primaryPath };
}
const message = (id, text = 'hello') => ({ id, scope: 'room', scopeId: 'room', senderId: 'alice', text, recipients: ['alice', 'bob'], createdAt: 100 });

test('large durable history replicates a small new message and nested updates atomically', async t => {
  const { primary, replica } = await stores(t);
  const original = { ...primary.loadDomain(), chat: Array.from({ length: 600 }, (_, index) => message(`old-${index}`, 'a'.repeat(2000))) };
  primary.saveDomain(original);
  replica.importSnapshot(primary.exportSnapshot());
  let delta;
  primary.setChangesetHook(bytes => { delta = bytes; replica.applyChangeset(bytes); });
  const next = { ...original, chat: [...original.chat, message('new-message')] };
  primary.saveDomain(next);
  assert.ok(delta.byteLength < 10000, 'a small message must fit the bounded operation journal despite large retained history');
  assert.deepEqual(replica.loadDomain().chat.at(-1), message('new-message'));
  primary.transaction(() => {
    primary.saveDomain({ ...next, chat: [...next.chat, message('temporary')] });
    primary.saveDomain({ ...next, chat: [...next.chat, message('final')] });
  });
  assert.equal(primary.loadDomain().chat.some(item => item.id === 'temporary'), false);
  assert.deepEqual(primary.loadDomain(), replica.loadDomain());
  primary.setChangesetHook(() => { throw new Error('coordinator unavailable'); });
  assert.throws(() => primary.saveDomain({ ...next, chat: [...next.chat, message('rolled-back')] }), /coordinator unavailable/);
  assert.equal(primary.loadDomain().chat.some(item => item.id === 'rolled-back'), false);
  primary.setChangesetHook(bytes => replica.applyChangeset(bytes));
  primary.saveDomain({ ...primary.loadDomain(), chat: [...primary.loadDomain().chat, message('after-recovery')] });
  assert.deepEqual(primary.loadDomain(), replica.loadDomain());
});

test('legacy private result migration retains inbox evidence while ownerless invitations become unusable', async t => {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-domain-migrate-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const path = join(directory, 'legacy.db');
  let store = new SqliteRoomStore(path);
  store.insert({ id: 'room', gameId: 'game', name: 'Legacy', ownerId: 'alice', hostId: 'alice', passwordHash: null, maxPlayers: 2, state: 'open', createdAt: 100, updatedAt: 100, visibility: 'public', locked: false, version: '', mode: '', region: '', joinPolicy: 'closed', maxSpectators: 0, revision: 1, bannedIds: [], invitedIds: [], matchId: null });
  store.close();
  const db = new DatabaseSync(path);
  const room = db.prepare('SELECT metadata FROM rooms WHERE id=?').get('room');
  const metadata = JSON.parse(room.metadata);
  metadata.seats = [{ playerId: 'alice', role: 'player', ready: false, gameId: 'game', version: '', mode: '', region: '', displayName: 'Alice', expiresAt: Date.now() + 60000, pendingResult: { matchId: 'legacy-match', result: { score: 12, won: true } } }];
  db.prepare('UPDATE rooms SET metadata=? WHERE id=?').run(JSON.stringify(metadata), 'room');
  db.exec("DROP TABLE domain_records; CREATE TABLE domain_state(id INTEGER PRIMARY KEY CHECK(id=1),data TEXT NOT NULL CHECK(json_valid(data))) STRICT; DELETE FROM schema_migrations WHERE version=5");
  db.prepare('INSERT INTO invitations(token,target,expires_at,room_id,party_id,metadata) VALUES(?,?,?,?,?,?)').run('legacy-invite', 'bob', Date.now() + 60000, 'room', null, '{}');
  db.close();
  store = new SqliteRoomStore(path);
  try {
    const domain = store.loadDomain();
    assert.deepEqual(domain.results[0].result, { score: 12, won: true });
    assert.equal(domain.results[0].playerId, 'alice');
    assert.equal(domain.results[0].matchId, 'legacy-match');
    assert.deepEqual(domain.matches[0].roster, ['alice']);
    assert.equal(Object.hasOwn(store.load()[0].seats[0], 'pendingResult'), false);
    assert.deepEqual(store.listInvitations(), []);
  } finally { store.close(); }
});

test('malformed durable records fail before persistence and conflicting changesets abort', async t => {
  const { primary, replica } = await stores(t);
  const domain = primary.loadDomain();
  assert.throws(() => primary.saveDomain({ ...domain, reports: [{ id: 'bad', reporterId: 'outsider', message: message('evidence'), reason: 'claim', createdAt: 100, status: 'pending' }] }));
  assert.deepEqual(primary.loadDomain().reports, []);
  let changeset;
  primary.setChangesetHook(bytes => { changeset = bytes; });
  primary.saveDomain({ ...domain, chat: [message('same-id', 'original')] });
  replica.saveDomain({ ...replica.loadDomain(), chat: [message('same-id', 'conflicting')] });
  assert.throws(() => replica.applyChangeset(changeset), /conflict/i);
  assert.equal(replica.loadDomain().chat[0].text, 'conflicting');
});
