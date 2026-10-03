import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { userInfo, tmpdir } from 'node:os';
import { mkdtemp, writeFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { loadConfig } from '../dist/config.js';

function client(env) {
  return spawnSync(process.execPath, ['scripts/client.mjs'], {
    encoding: 'utf8', timeout: 5000,
    env: { ...process.env, BEACON_GAME: 'g-001', ...env },
  });
}

async function fixture(t, mode) {
  const directory = await mkdtemp(join(tmpdir(), 'beacon-cli-test-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const config = await loadConfig('config.yaml', { mockAuth: true, insecureWs: true });
  config.auth.mode = mode;
  config.auth.apiUrl = 'https://auth.example.invalid';
  config.public.domain = 'lobby.example.invalid';
  const path = join(directory, 'config.yaml');
  await writeFile(path, JSON.stringify(config), { mode: 0o600 });
  return path;
}

test('external client rejects mock configuration regardless of token spelling', async t => {
  const path = await fixture(t, 'mock');
  await assert.rejects(loadConfig(path));
  const token = 'opaque-private-token';
  const result = client({ BEACON_CONFIG: path, BEACON_TOKEN: token });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(token), false);
});

test('external client refuses insecure URL with valid production config and hides credentials', async t => {
  const path = await fixture(t, 'remote');
  assert.equal((await loadConfig(path)).auth.mode, 'remote');
  const secret = 'private-token-that-must-not-be-logged';
  const result = client({ BEACON_CONFIG: path, BEACON_URL: 'ws://127.0.0.1:1', BEACON_TOKEN: secret });
  assert.equal(result.status, 1);
  assert.equal((result.stdout + result.stderr).includes(secret), false);
});

test('installer rejects relative binary before build or service changes', () => {
  const result = spawnSync(process.execPath, [
    'scripts/install-launchd.mjs', '--directory', '.', '--user', userInfo().username, '--node', 'node',
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
});

test('installer refuses root application identity before system mutations', () => {
  const result = spawnSync(process.execPath, [
    'scripts/install-launchd.mjs', '--directory', '.', '--user', 'root', '--node', process.execPath,
  ], { encoding: 'utf8', timeout: 5000 });
  assert.equal(result.status, 1);
});
