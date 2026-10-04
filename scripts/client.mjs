import { emitKeypressEvents } from 'node:readline';
import { stdin, stdout } from 'node:process';
import { loadConfig } from '../dist/config.js';
import { BeaconClient } from '../dist/client/index.js';

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

let client;
try {
  const config = await loadConfig(process.env.BEACON_CONFIG ?? 'config.yaml');
  if (config.auth.mode === 'mock') throw new Error('External acceptance requires real authentication');
  const url = new URL(process.env.BEACON_URL ?? `wss://${config.public.domain}`);
  if (url.protocol !== 'wss:' || url.username || url.password) throw new Error('External acceptance requires credential-free WSS URL');
  let token = process.env.BEACON_TOKEN ?? await hiddenToken();
  delete process.env.BEACON_TOKEN;
  if (!token) throw new Error('An OAuth token is required');
  const gameId = process.env.BEACON_GAME;
  if (!gameId) throw new Error('Set BEACON_GAME to a real enabled game ID');
  client = new BeaconClient({ url: url.href, token: () => token, reconnect: false, maxMessageBytes: config.limits.outboundBytes });
  let hello;
  client.on('hello', message => { hello = message; });
  function response(result, type, predicate = () => true) {
    const message = result.messages.find(item => item.type === type && predicate(item));
    if (!message) throw new Error('Missing expected protocol output');
    return message;
  }
  await client.connect();
  token = '';
  if (typeof hello?.serverVersion !== 'string' || !(hello.authDeadlineMs > 0)) throw new Error('Invalid hello');
  if (typeof client.state.player?.id !== 'string') throw new Error('Invalid auth_ok');
  console.log('PASS hello / real-token auth_ok / protocol v3 sync');
  const selected = await client.selectGame(gameId);
  const lobby = response(selected, 'lobby_state');
  if (lobby.game?.gameId !== gameId || !Number.isSafeInteger(lobby.game.maxPlayersPerRoom) || lobby.game.maxPlayersPerRoom < 1 || !Array.isArray(lobby.rooms)) throw new Error('Invalid game lobby');
  const name = `Smoke ${Date.now()}`;
  const created = response(await client.createRoom({ name, maxPlayers: Math.min(2, lobby.game.maxPlayersPerRoom) }), 'room_joined');
  const roomId = created.room?.id;
  if (typeof roomId !== 'string' || created.room.name !== name || created.room.playerCount !== 1) throw new Error('Invalid created room');
  console.log('PASS select_game / create_room');
  await client.leaveRoom();
  const joined = response(await client.joinRoom(roomId), 'room_joined');
  if (joined.room?.id !== roomId || joined.room.playerCount !== 1) throw new Error('Invalid joined room');
  console.log('PASS leave_room / join_room');
  await client.deleteRoom();
  if (client.state.room !== null) throw new Error('Deleted room remains in SDK state');
  const listed = response(await client.listRooms(), 'lobby_state');
  if (!Array.isArray(listed.rooms) || listed.rooms.some(room => room.id === roomId)) throw new Error('Deleted room still listed');
  console.log('PASS delete_room / removal');
  console.log('External WSS flow completed; OAuth provenance and other deployment gates still require operator evidence.');
} catch {
  // Arbitrary errors may contain credentials or external response bodies.
  console.error('External WSS acceptance failed. Check endpoint, real-token configuration, game ID and private server diagnostics; no credentials were logged.');
  process.exitCode = 1;
} finally {
  client?.disconnect();
}
