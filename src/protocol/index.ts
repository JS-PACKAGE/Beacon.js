import type { Rules } from '../types.js';
export const PROTOCOL_VERSION = 2;
export const ERROR_MESSAGES = {
  auth_required: 'Authentication is required', auth_failed: 'Authentication failed', auth_expired: 'Authentication expired',
  game_not_found: 'Game is unavailable', not_in_lobby: 'Select a game first', room_not_found: 'Room is unavailable',
  room_full: 'Room is full', room_password_required: 'Room password is required', room_password_incorrect: 'Room password is incorrect',
  already_in_room: 'Leave the current room first', wrong_game: 'Room belongs to another game', host_only: 'Only the current host may perform this action',
  session_replaced: 'Session replaced by a newer connection', storage_error: 'Room storage operation failed', rate_limited: 'Rate limit exceeded',
  bad_request: 'Invalid request', unknown_type: 'Unknown message type', server_error: 'Server operation failed',
  forbidden: 'Operation is not permitted', not_ready: 'Players are not ready', invalid_state: 'Operation is invalid in this state',
  game_service_unavailable: 'Game session service is unavailable', incompatible_version: 'Game compatibility does not match',
  invitation_required: 'An invitation is required', invitation_expired: 'Invitation is invalid or expired', player_banned: 'Player is banned',
  maintenance: 'Server is in maintenance', request_conflict: 'Request identifier was reused with different input',
  not_in_party: 'Join a party first', party_full: 'Party is full', queue_timeout: 'Matchmaking timed out',
  token_revoked: 'Authentication was revoked', unsupported_protocol: 'Unsupported protocol version', snapshot_expired: 'Snapshot expired; request a new snapshot',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export function errorMessage(code: ErrorCode): Record<string, unknown> { return { type: 'error', code, message: ERROR_MESSAGES[code] }; }
export class ProtocolError extends Error { constructor(public readonly code: ErrorCode) { super(ERROR_MESSAGES[code]); } }

export interface Compatibility { version?: string; mode?: string; region?: string }
export interface RoomFilters extends Compatibility { query?: string; availableOnly?: boolean; sort?: 'created' | 'name' | 'players' }
export interface RoomSettings {
  name?: string; password?: string; maxPlayers?: number; visibility?: 'public' | 'unlisted' | 'invite';
  locked?: boolean; joinPolicy?: 'closed' | 'fill' | 'spectate'; maxSpectators?: number;
  rules?: Rules;
}
const secretKey = /password|token|ticket|secret|authorization/i;
/** Flat, bounded room rules. `map` is the conventional key when a game needs a map id. */
export function readRules(value: unknown): Rules {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid rules');
  const entries = Object.entries(value as Record<string, unknown>);
  if (entries.length > 16) throw new Error('Invalid rules');
  const rules: Rules = {};
  for (const [key, item] of entries) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$/.test(key) || secretKey.test(key)) throw new Error('Invalid rules');
    if (typeof item === 'string') {
      if ([...item].length > 128 || /[\p{Cc}\p{Cs}]/u.test(item)) throw new Error('Invalid rules');
      rules[key] = item;
    } else if (typeof item === 'boolean' || (typeof item === 'number' && Number.isSafeInteger(item))) rules[key] = item;
    else throw new Error('Invalid rules');
  }
  if (Buffer.byteLength(JSON.stringify(rules)) > 1024) throw new Error('Invalid rules');
  return rules;
}
type Command =
  | { type: 'auth'; token: string; protocolVersion?: number }
  | { type: 'refresh_auth'; token: string }
  | ({ type: 'select_game' | 'switch_game'; gameId: string } & Compatibility)
  | ({ type: 'list_rooms'; page?: number; pageSize?: number; cursor?: string } & RoomFilters)
  | ({ type: 'create_room'; name: string } & RoomSettings & Compatibility)
  | { type: 'join_room'; roomId: string; password?: string; role?: 'player' | 'spectator'; invitationToken?: string }
  | { type: 'ready'; ready: boolean }
  | ({ type: 'update_room' } & RoomSettings)
  | { type: 'kick_player'; playerId: string; ban?: boolean }
  | { type: 'unban_player' | 'transfer_host' | 'invite_player' | 'party_invite' | 'friend_request' | 'friend_remove' | 'block_player' | 'unblock_player'; playerId: string }
  | { type: 'party_accept'; invitationToken: string }
  | { type: 'friend_respond'; playerId: string; accept: boolean }
  | ({ type: 'quick_join'; password?: string } & RoomFilters)
  | ({ type: 'queue_join'; minPlayers?: number; maxPlayers?: number } & Compatibility)
  | { type: 'leave_room' | 'delete_room' | 'ping' | 'start_game' | 'sync_state' | 'queue_leave' | 'party_create' | 'party_leave' | 'list_friends' | 'list_games' | 'list_blocks' };
export type ClientMessage = Command & { requestId?: string };

const compatibility = ['version', 'mode', 'region'];
const filters = [...compatibility, 'query', 'availableOnly', 'sort'];
const settings = ['name', 'password', 'maxPlayers', 'visibility', 'locked', 'joinPolicy', 'maxSpectators', 'rules'];
export const CLIENT_FIELDS: Record<ClientMessage['type'], readonly string[]> = {
  auth: ['token', 'protocolVersion'], refresh_auth: ['token'], select_game: ['gameId', ...compatibility], switch_game: ['gameId', ...compatibility],
  list_rooms: ['page', 'pageSize', 'cursor', ...filters], create_room: [...settings, ...compatibility], join_room: ['roomId', 'password', 'role', 'invitationToken'],
  ready: ['ready'], start_game: [], update_room: settings, kick_player: ['playerId', 'ban'], unban_player: ['playerId'], transfer_host: ['playerId'],
  invite_player: ['playerId'], quick_join: [...filters, 'password'], queue_join: ['minPlayers', 'maxPlayers', ...compatibility], queue_leave: [],
  party_create: [], party_invite: ['playerId'], party_accept: ['invitationToken'], party_leave: [], friend_request: ['playerId'],
  friend_respond: ['playerId', 'accept'], friend_remove: ['playerId'], list_friends: [], list_games: [], sync_state: [], leave_room: [], delete_room: [], ping: [],
  block_player: ['playerId'], unblock_player: ['playerId'], list_blocks: [],
};
const fields = CLIENT_FIELDS;
function text(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && [...value].length >= min && [...value].length <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function identifier(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value); }
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER, min = 1): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max;
}
export function parseClient(input: string, maxPageSize: number): ClientMessage {
  const raw: unknown = JSON.parse(input);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProtocolError('bad_request');
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string') throw new ProtocolError('bad_request');
  if (!Object.hasOwn(fields, data.type)) throw new ProtocolError('unknown_type');
  const type = data.type as ClientMessage['type'];
  if (Object.keys(data).some(key => key !== 'type' && key !== 'requestId' && !fields[type].includes(key))) throw new ProtocolError('bad_request');
  const bad = (): never => { throw new ProtocolError('bad_request'); };
  if (data.requestId !== undefined && !identifier(data.requestId)) bad();
  if (data.protocolVersion !== undefined && data.protocolVersion !== PROTOCOL_VERSION) throw new ProtocolError('unsupported_protocol');
  for (const key of compatibility) if (data[key] !== undefined && (!text(data[key], 64, 0) || Buffer.byteLength(data[key] as string) > 64)) bad();
  for (const key of ['locked', 'ready', 'ban', 'accept', 'availableOnly']) if (data[key] !== undefined && typeof data[key] !== 'boolean') bad();
  for (const key of ['maxPlayers', 'minPlayers']) if (data[key] !== undefined && !positive(data[key])) bad();
  if (data.maxSpectators !== undefined && !positive(data.maxSpectators, Number.MAX_SAFE_INTEGER, 0)) bad();
  if (data.name !== undefined && !text(data.name, 32)) bad();
  if (data.password !== undefined && !text(data.password, 128, type === 'update_room' ? 0 : 1)) bad();
  if (data.visibility !== undefined && !['public', 'unlisted', 'invite'].includes(String(data.visibility))) bad();
  if (data.joinPolicy !== undefined && !['closed', 'fill', 'spectate'].includes(String(data.joinPolicy))) bad();
  if (data.role !== undefined && !['player', 'spectator'].includes(String(data.role))) bad();
  if (data.sort !== undefined && !['created', 'name', 'players'].includes(String(data.sort))) bad();
  if (data.query !== undefined && !text(data.query, 64, 0)) bad();
  if (data.cursor !== undefined && !text(data.cursor, 256)) bad();
  if (data.invitationToken !== undefined && !identifier(data.invitationToken)) bad();
  if (data.page !== undefined && !positive(data.page)) bad();
  if (data.pageSize !== undefined && !positive(data.pageSize, maxPageSize)) bad();
  if (data.cursor !== undefined && data.page !== undefined) bad();
  if (data.minPlayers !== undefined && data.maxPlayers !== undefined && Number(data.minPlayers) > Number(data.maxPlayers)) bad();
  switch (type) {
    case 'auth': case 'refresh_auth': if (!text(data.token, 3500)) bad(); break;
    case 'select_game': case 'switch_game': if (!identifier(data.gameId)) bad(); break;
    case 'create_room': if (!text(data.name, 32)) bad(); break;
    case 'join_room': if (!identifier(data.roomId)) bad(); break;
    case 'ready': if (typeof data.ready !== 'boolean') bad(); break;
    case 'friend_respond': if (typeof data.accept !== 'boolean' || !text(data.playerId, 128) || Buffer.byteLength(data.playerId as string) > 128) bad(); break;
    case 'party_accept': if (!identifier(data.invitationToken)) bad(); break;
    case 'kick_player': case 'unban_player': case 'transfer_host': case 'invite_player': case 'party_invite': case 'friend_request': case 'friend_remove': case 'block_player': case 'unblock_player':
      if (!text(data.playerId, 128) || Buffer.byteLength(data.playerId as string) > 128) bad(); break;
    case 'update_room': if (Object.keys(data).every(key => key === 'type' || key === 'requestId')) bad(); break;
  }
  if (data.rules !== undefined) { try { data.rules = readRules(data.rules); } catch { bad(); } }
  return data as ClientMessage;
}
