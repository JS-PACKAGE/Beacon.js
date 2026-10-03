import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../dist/config.js';

async function hiddenToken() {
  if (!stdin.isTTY) throw new Error('Use a terminal or securely inject BEACON_TOKEN');
  stdout.write('OAuth token (hidden): ');
  emitKeypressEvents(stdin);
  stdin.setRawMode(true);
  stdin.resume();
  return new Promise((resolve, reject) => {
    let text = '';
    function finish(error) {
      stdin.off('keypress', onKey);
      stdin.setRawMode(false);
      stdin.pause();
      stdout.write('\n');
      if (error) reject(error); else resolve(text);
    }
    function onKey(character, key) {
      if (key?.ctrl && key.name === 'c') return finish(new Error('Cancelled'));
      if (key?.name === 'return') return finish();
      if (key?.name === 'backspace') text = text.slice(0, -1);
      else if (character && !key?.ctrl && !/[\r\n\x00-\x1f\x7f]/u.test(character)) text += character;
      if (text.length > 8192) finish(new Error('Token input too long'));
    }
    stdin.on('keypress', onKey);
  });
}

let socket;
try {
  const config = await loadConfig(process.env.BEACON_CONFIG ?? 'config.yaml');
  const url = new URL(process.env.BEACON_URL ?? `wss://${config.public.domain}`);
  if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('External acceptance requires credential-free WSS URL');
  let token = process.env.BEACON_TOKEN ?? await hiddenToken();
  delete process.env.BEACON_TOKEN;
  if (!token) throw new Error('An OAuth token is required');
  const gameId = process.env.BEACON_GAME;
  if (!gameId) throw new Error('Set BEACON_GAME to a real enabled game ID');
  socket = new WebSocket(url);
  const queue = [];
  let pending;
  let closed = false;
  function wake() { pending?.(); }
  socket.addEventListener('message', event => {
    try {
      if (typeof event.data !== 'string' || Buffer.byteLength(event.data) > config.limits.outboundBytes) throw new Error();
      const message = JSON.parse(event.data);
      if (!message || typeof message.type !== 'string' || queue.length >= 128) throw new Error();
      queue.push(message);
      wake();
    } catch { closed = true; socket.close(); wake(); }
  });
  socket.addEventListener('close', () => { closed = true; wake(); });
  socket.addEventListener('error', () => { closed = true; wake(); });
  async function expect(type, predicate = () => true) {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => finish(new Error('Timed out waiting for expected protocol output')), 15000);
      function finish(error, value) {
        clearTimeout(timer); pending = undefined;
        if (error) reject(error); else resolve(value);
      }
      function check() {
        while (queue.length) {
          const message = queue.shift();
          if (message.type === 'error' || message.type === 'auth_fail') return finish(new Error('Server rejected acceptance request'));
          if (message.type === type && predicate(message)) return finish(undefined, message);
        }
        if (closed) finish(new Error('WSS disconnected before expected output'));
      }
      pending = check; check();
    });
  }
  function send(message) {
    if (socket.readyState !== WebSocket.OPEN) throw new Error('Socket is not open');
    socket.send(JSON.stringify(message));
  }
  const hello = await expect('hello');
  if (typeof hello.serverVersion !== 'string' || !(hello.authDeadlineMs > 0)) throw new Error('Invalid hello');
  send({ type: 'auth', token }); token = '';
  const auth = await expect('auth_ok');
  if (typeof auth.player?.id !== 'string') throw new Error('Invalid auth_ok');
  console.log('PASS hello / real-token auth_ok');
  send({ type: 'select_game', gameId });
  const lobby = await expect('lobby_state');
  if (lobby.game?.gameId !== gameId || !Number.isSafeInteger(lobby.game.maxPlayersPerRoom) || lobby.game.maxPlayersPerRoom < 1 || !Array.isArray(lobby.rooms)) throw new Error('Invalid game lobby');
  const name = `Smoke ${Date.now()}`;
  send({ type: 'create_room', name, maxPlayers: Math.min(2, lobby.game.maxPlayersPerRoom) });
  const created = await expect('room_joined');
  const roomId = created.room?.id;
  if (typeof roomId !== 'string' || created.room.name !== name || created.room.playerCount !== 1) throw new Error('Invalid created room');
  console.log('PASS select_game / create_room');
  send({ type: 'leave_room' }); await expect('lobby_state');
  send({ type: 'join_room', roomId });
  const joined = await expect('room_joined');
  if (joined.room?.id !== roomId || joined.room.playerCount !== 1) throw new Error('Invalid joined room');
  console.log('PASS leave_room / join_room');
  send({ type: 'delete_room' });
  await expect('room_closed', message => message.roomId === roomId && message.reason === 'deleted');
  send({ type: 'list_rooms' });
  const listed = await expect('lobby_state');
  if (!Array.isArray(listed.rooms) || listed.rooms.some(room => room.id === roomId)) throw new Error('Deleted room still listed');
  console.log('PASS delete_room / removal');
  console.log('External WSS flow completed; OAuth provenance and other deployment gates still require operator evidence.');
} catch {
  // Arbitrary errors may contain credentials or external response bodies.
  console.error('External WSS acceptance failed. Check endpoint, real-token configuration, game ID and private server diagnostics; no credentials were logged.');
  process.exitCode = 1;
} finally {
  if (socket && socket.readyState < WebSocket.CLOSING) socket.close();
}
