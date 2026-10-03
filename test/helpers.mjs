import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import WebSocket from 'ws';
import { loadConfig } from '../dist/config.js';
import { startBeacon } from '../dist/main.js';

export const dev = { mockAuth: true, insecureWs: true };
export async function environment(t, overrides = {}, dependencies = {}) {
  const dir = await mkdtemp(join(tmpdir(), 'beacon-test-'));
  const config = await loadConfig('config.yaml', dev);
  config.server.listenPort = 0;
  config.db.path = join(dir, 'beacon.db');
  Object.assign(config.limits, { messageBurst: 1000, connectionBurst: 1000, maxConnectionsPerIp: 100 });
  for (const [section, values] of Object.entries(overrides)) Object.assign(config[section], values);
  let service = await startBeacon(config, dev, dependencies);
  const clients = [];
  const connect = async (token = 'dev-alice') => {
    const client = await socket(`ws://127.0.0.1:${service.address().port}`);
    clients.push(client);
    if (token) await client.request({ type: 'auth', token }, 'auth_ok');
    return client;
  };
  t.after(async () => {
    for (const client of clients) client.ws.terminate();
    await service.close();
    await rm(dir, { recursive: true, force: true });
  });
  return { config, dir, connect, get service() { return service; }, async restart() { await service.close(); service = await startBeacon(config, dev); } };
}

export async function socket(url, options = {}) {
  const ws = new WebSocket(url, options);
  const messages = [];
  const waiting = new Set();
  ws.on('message', data => { messages.push(JSON.parse(data.toString())); for (const notify of waiting) notify(); });
  await new Promise((resolve, reject) => { ws.once('open', resolve); ws.once('error', reject); });
  const client = {
    ws, messages,
    async wait(predicate, start = 0) {
      const found = () => messages.slice(start).find(predicate);
      if (found()) return found();
      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => { waiting.delete(notify); reject(new Error(`Message timeout: ${JSON.stringify(messages.slice(start))}`)); }, 5000);
        const notify = () => { const message = found(); if (message) { clearTimeout(timeout); waiting.delete(notify); resolve(message); } };
        waiting.add(notify);
      });
    },
    request(message, type, predicate = () => true) {
      const start = messages.length;
      ws.send(JSON.stringify(message));
      return client.wait(result => result.type === type && predicate(result), start);
    },
    async close() {
      if (ws.readyState === WebSocket.CLOSED) return;
      await new Promise(resolve => { ws.once('close', resolve); ws.close(); });
    },
  };
  await client.wait(message => message.type === 'hello');
  return client;
}

export async function select(client, gameId = 'g-001') {
  return client.request({ type: 'select_game', gameId }, 'lobby_state');
}
