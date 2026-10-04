import test from 'node:test';
import assert from 'node:assert/strict';
import { RequestLedger } from '../dist/protocol/requests.js';
import { loadConfig } from '../dist/config.js';

const config = await loadConfig('config.yaml', { insecureWs: true, mockAuth: true });
function durable() {
  const entries = new Map();
  return {
    entries,
    reserve(player, id, digest) {
      const key = JSON.stringify([player, id]);
      const entry = entries.get(key);
      if (entry) return entry.digest !== digest ? { status: 'conflict' } : entry.replies ? { status: 'complete', replies: entry.replies } : { status: 'indeterminate' };
      entries.set(key, { digest }); return { status: 'reserved' };
    },
    complete(player, id, replies) { entries.get(JSON.stringify([player, id])).replies = structuredClone(replies); },
  };
}
test('durable mutation response is published only after its outcome is committed and replays across ledger replacement', async () => {
  const store = durable(); let committed = false; let calls = 0;
  const complete = store.complete.bind(store);
  store.complete = (...args) => { complete(...args); committed = true; };
  const replies = [];
  const message = { type: 'party_create', requestId: 'durable-one' };
  await new RequestLedger(config, store).execute('alice', message, reply => { assert.equal(committed, true); replies.push(reply); }, async reply => { calls++; reply({ type: 'result', ok: true }); });
  await new RequestLedger(config, store).execute('alice', message, reply => replies.push(reply), async () => { calls++; });
  assert.equal(calls, 1); assert.equal(replies[1].replayed, true);
});
test('interrupted mutation remains indeterminate across restart and is never executed again', async () => {
  const store = durable(); const message = { type: 'party_create', requestId: 'unknown' }; let calls = 0;
  await assert.rejects(new RequestLedger(config, store).execute('alice', message, () => {}, async () => { calls++; throw new Error('Interrupted'); }));
  await assert.rejects(new RequestLedger(config, store).execute('alice', message, () => {}, async () => { calls++; }), error => error.code === 'request_indeterminate');
  assert.equal(calls, 1);
});
test('durable identity binds player, request identifier and canonical payload', async () => {
  const store = durable(); const ledger = new RequestLedger(config, store);
  await ledger.execute('alice', { type: 'ready', ready: true, requestId: 'same' }, () => {}, async reply => reply({ type: 'result', ok: true }));
  await assert.rejects(new RequestLedger(config, store).execute('alice', { type: 'ready', ready: false, requestId: 'same' }, () => {}, async () => {}), error => error.code === 'request_conflict');
  await assert.rejects(ledger.execute('alice', { type: 'party_create' }, () => {}, async () => {}), error => error.code === 'request_id_required');
});
