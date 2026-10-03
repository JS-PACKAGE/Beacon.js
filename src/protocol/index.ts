export const ERROR_MESSAGES = {
  auth_required: 'Authentication is required',
  auth_failed: 'Authentication failed',
  auth_expired: 'Authentication expired',
  game_not_found: 'Game is unavailable',
  not_in_lobby: 'Select a game first',
  room_not_found: 'Room is unavailable',
  room_full: 'Room is full',
  room_password_required: 'Room password is required',
  room_password_incorrect: 'Room password is incorrect',
  already_in_room: 'Leave the current room first',
  wrong_game: 'Room belongs to another game',
  host_only: 'Only the current host may perform this action',
  session_replaced: 'Session replaced by a newer connection',
  storage_error: 'Room storage operation failed',
  rate_limited: 'Rate limit exceeded',
  bad_request: 'Invalid request',
  unknown_type: 'Unknown message type',
  server_error: 'Server operation failed',
} as const;
export type ErrorCode = keyof typeof ERROR_MESSAGES;
export function errorMessage(code: ErrorCode): Record<string, unknown> {
  return { type: 'error', code, message: ERROR_MESSAGES[code] };
}
export class ProtocolError extends Error {
  constructor(public readonly code: ErrorCode) { super(ERROR_MESSAGES[code]); }
}
export type ClientMessage =
  | { type: 'auth'; token: string }
  | { type: 'select_game' | 'switch_game'; gameId: string }
  | { type: 'list_rooms'; page?: number; pageSize?: number }
  | { type: 'create_room'; name: string; password?: string; maxPlayers?: number }
  | { type: 'join_room'; roomId: string; password?: string }
  | { type: 'leave_room' | 'delete_room' | 'ping' };

const fields: Record<ClientMessage['type'], readonly string[]> = {
  auth: ['type', 'token'], select_game: ['type', 'gameId'], switch_game: ['type', 'gameId'],
  list_rooms: ['type', 'page', 'pageSize'], create_room: ['type', 'name', 'password', 'maxPlayers'],
  join_room: ['type', 'roomId', 'password'], leave_room: ['type'], delete_room: ['type'], ping: ['type'],
};
function text(value: unknown, max: number, min = 1): value is string {
  return typeof value === 'string' && [...value].length >= min && [...value].length <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function identifier(value: unknown): value is string {
  return typeof value === 'string' && /^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(value);
}
function positive(value: unknown, max = Number.MAX_SAFE_INTEGER): boolean {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 1 && value <= max;
}
export function parseClient(input: string, maxPageSize: number): ClientMessage {
  const raw: unknown = JSON.parse(input);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new ProtocolError('bad_request');
  const data = raw as Record<string, unknown>;
  if (typeof data.type !== 'string') throw new ProtocolError('bad_request');
  if (!Object.hasOwn(fields, data.type)) throw new ProtocolError('unknown_type');
  const type = data.type as ClientMessage['type'];
  if (Object.keys(data).some(key => !fields[type].includes(key))) throw new ProtocolError('bad_request');
  const bad = (): never => { throw new ProtocolError('bad_request'); };
  switch (type) {
    case 'auth': if (!text(data.token, 3500)) bad(); break;
    case 'select_game': case 'switch_game': if (!identifier(data.gameId)) bad(); break;
    case 'list_rooms':
      if (data.page !== undefined && !positive(data.page)) bad();
      if (data.pageSize !== undefined && !positive(data.pageSize, maxPageSize)) bad();
      break;
    case 'create_room':
      if (!text(data.name, 32)) bad();
      if (data.maxPlayers !== undefined && !positive(data.maxPlayers)) bad();
      if (data.password !== undefined && !text(data.password, 128)) bad();
      break;
    case 'join_room':
      if (!identifier(data.roomId)) bad();
      if (data.password !== undefined && !text(data.password, 128)) bad();
      break;
    case 'leave_room': case 'delete_room': case 'ping': break;
  }
  return data as ClientMessage;
}
