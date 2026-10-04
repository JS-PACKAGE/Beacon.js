import test from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
const exec = promisify(execFile);

test('standalone SDK resolves package ESM exports under Node and browser conditions', async () => {
  for (const conditions of [[], ['--conditions=browser']]) {
    const { stdout } = await exec(process.execPath, [...conditions, '--input-type=module', '-e', `
      import { BeaconClient } from '@js-package/beacon-client';
      import { serverSchema } from '@js-package/beacon-client/schema';
      const client = new BeaconClient({ url:'wss://lobby.example',token:()=>'' });
      if (client.state.queue.queued !== false || !serverSchema.anyOf) throw new Error('Invalid exports');
      client.disconnect(); console.log('imported');
    `], { cwd: new URL('../packages/client/', import.meta.url) });
    assert.equal(stdout.trim(), 'imported');
  }
});

test('SDK executes in a browser-like realm with no Node builtins or service modules', async () => {
  const { stdout } = await exec(process.execPath, ['--experimental-vm-modules', '--input-type=module', '-e', `
    import { SourceTextModule, createContext } from 'node:vm';
    import { readFile } from 'node:fs/promises';
    const root = new URL('./packages/client/dist/', import.meta.url);
    const context = createContext({ URL, TextEncoder, setTimeout, clearTimeout, console });
    const modules = new Map();
    async function load(url) {
      if (!url.href.startsWith(root.href)) throw new Error('Runtime dependency leakage: '+url.href);
      if (modules.has(url.href)) return modules.get(url.href);
      const mod = new SourceTextModule(await readFile(url, 'utf8'), { context, identifier:url.href });
      modules.set(url.href, mod); return mod;
    }
    const entry = await load(new URL('index.js',root));
    await entry.link((specifier,parent) => {
      if (!specifier.startsWith('./')) throw new Error('External SDK runtime dependency: '+specifier);
      return load(new URL(specifier,parent.identifier));
    });
    await entry.evaluate();
    class Socket { readyState=0; addEventListener(){} close(){} send(){} }
    const client = new entry.namespace.BeaconClient({url:'wss://lobby.example',token:()=>'',WebSocket:Socket});
    if (client.state.party !== null) throw new Error('Invalid initial state');
    client.disconnect(); console.log('browser imported');
  `]);
  assert.equal(stdout.trim(), 'browser imported');
});

