import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SqliteRoomStore } from '../dist/store/index.js';

test('small writes above one MiB replicate only changed rows without exporting entire database', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-ha-changeset-'));
  const source = new SqliteRoomStore(join(dir, 'source.db'));
  const replica = new SqliteRoomStore(join(dir, 'replica.db'));
  t.after(async () => { source.close(); replica.close(); await rm(dir, { recursive: true, force: true }); });
  source.transaction(() => { for (let index = 0; index < 5000; index++) source.audit({ at: index, actor: 'operator', action: 'seed', target: `${index}:${'x'.repeat(240)}` }); });
  const checkpoint = source.exportSnapshot(); assert.ok(Buffer.byteLength(checkpoint) > 1048576);
  replica.importSnapshot(checkpoint);
  let bytes;
  source.setChangesetHook(value => { bytes = value; replica.applyChangeset(value); });
  source.exportSnapshot = () => { throw new Error('Full export forbidden on small transaction'); };
  source.audit({ at: 6000, actor: 'operator', action: 'small', target: 'one' });
  assert.ok(bytes instanceof Uint8Array); assert.ok(bytes.length < 10000);
  assert.deepEqual(replica.listAudit(1), source.listAudit(1));
  assert.throws(() => replica.applyChangeset(bytes), /conflict/i);
});
test('failed remote precommit leaves local SQLite mutation uncommitted', async t => {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-ha-rollback-'));
  const source = new SqliteRoomStore(join(dir, 'source.db'));
  t.after(async () => { source.close(); await rm(dir, { recursive: true, force: true }); });
  source.setChangesetHook(() => { throw new Error('Quorum unavailable'); });
  assert.throws(() => source.audit({ at: 1, actor: 'operator', action: 'test', target: 'one' }), /Quorum unavailable/);
  assert.deepEqual(source.listAudit(10), []);
});
