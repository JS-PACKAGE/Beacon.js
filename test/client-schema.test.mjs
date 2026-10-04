import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { matchesSchema, isServerMessage } from '../dist/client/validation.js';
import { clientSchema, serverSchema } from '../dist/client/schema.js';

test('published JSON Schema validates both wire directions and rejects malformed fields and extras', async () => {
  const schema = JSON.parse(await readFile(new URL('../protocol.schema.json', import.meta.url), 'utf8'));
  const commands = [
    { type: 'auth', token: 'access', protocolVersion: 3 },
    { type: 'party_join_room', roomId: 'room', invitationToken: 'invitation' },
    { type: 'match_accept', proposalId: 'proposal', requestId: 'request' },
    { type: 'list_match_results', limit: 20 },
    { type: 'chat_send', scope: 'party', text: 'Hello' },
  ];
  for (const command of commands) {
    assert.equal(matchesSchema(command, schema.$defs.client), true);
    assert.equal(matchesSchema(command, clientSchema), true);
    assert.equal(matchesSchema({ ...command, admin: true }, clientSchema), false);
  }
  for (const command of [
    { type: 'auth', token: 'access', protocolVersion: 2 }, { type: 'auth' },
    { type: 'match_accept', proposalId: 4 }, { type: 'party_kick' },
    { type: 'create_room', name: 'Room', maxPlayers: 2.5 }, { type: 'list_match_results', limit: 0 },
    { type: 'chat_send', scope: 'global', text: 'Hello' },
  ]) assert.equal(matchesSchema(command, clientSchema), false);
  const messages = [
    { type: 'result', requestId: 'request', ok: true, replayed: true, resyncRequired: true },
    { type: 'error', requestId: 'request', code: 'forbidden', message: 'Not permitted', ok: false },
    { type: 'match_proposal', proposalId: 'proposal', deadline: 100, members: ['player'], accepted: [] },
    { type: 'match_result', resultId: 'result', matchId: 'match', playerId: 'player', roomId: 'room', createdAt: 1, result: { score: 0, won: false } },
    { type: 'snapshot_chunk', snapshotType: 'friends', snapshotId: 'snapshot', revision: 0, chunkIndex: 0, chunkCount: 1, payload: '{"type":"friends","friends":[]}' },
  ];
  for (const message of messages) {
    assert.equal(matchesSchema(message, schema.$defs.server), true);
    assert.equal(matchesSchema(message, serverSchema), true);
    assert.equal(isServerMessage(message), true);
    assert.equal(isServerMessage({ ...message, secret: 'not-public' }), false);
  }
  assert.equal(isServerMessage({ type: 'future_message' }), false);
  assert.equal(isServerMessage({ type: 'friends', friends: [{ playerId: 'player', status: 'invented', requestedBy: 'player' }] }), false);
  assert.equal(isServerMessage({ type: 'snapshot_chunk', snapshotType: 'friends', snapshotId: 'snapshot', revision: 0, chunkIndex: -1, chunkCount: 1, payload: '' }), false);
});

test('client schema preserves valid maximum-length chat and report commands', () => {
  for (const [type, field, size, scope] of [
    ['chat_send', 'text', 2000, { scope: 'room' }],
    ['chat_report', 'reason', 512, { messageId: 'message' }],
  ]) {
    assert.equal(matchesSchema({ type, ...scope, [field]: 'a'.repeat(size) }, clientSchema), true);
    assert.equal(matchesSchema({ type, ...scope, [field]: 'a'.repeat(size + 1) }, clientSchema), false);
  }
});
