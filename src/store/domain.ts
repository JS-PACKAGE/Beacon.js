import type { DurableDomain } from '../types.js';
import { readRules } from '../protocol/index.js';
import { parseCapabilities } from '../games/capabilities.js';

export const domainKinds = ['matches', 'results', 'chat', 'reports', 'mutes', 'queue', 'proposals'] as const;
export type DomainKind = typeof domainKinds[number];
function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !fields.includes(key))) throw new Error('Invalid durable record');
  return value as Record<string, unknown>;
}
function text(value: unknown, max = 128, empty = false): value is string {
  return typeof value === 'string' && (empty || value.length > 0) && Buffer.byteLength(value) <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function number(value: unknown, min = 0): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min; }
function names(value: unknown, nonempty = true): value is string[] {
  return Array.isArray(value) && (!nonempty || value.length > 0) && value.every(item => text(item)) && new Set(value).size === value.length;
}
function require(valid: boolean): void { if (!valid) throw new Error('Invalid durable record'); }
function compatibility(value: unknown): void {
  const item = record(value, ['version', 'mode', 'region']);
  require(['version', 'mode', 'region'].every(key => text(item[key], 64, true)));
}
function chat(value: unknown): Record<string, unknown> {
  const item = record(value, ['id', 'scope', 'scopeId', 'senderId', 'text', 'createdAt', 'recipients']);
  require(text(item.id) && ['room', 'party'].includes(String(item.scope)) && text(item.scopeId) && text(item.senderId) && text(item.text, 8000) && [...String(item.text)].length <= 2000 && number(item.createdAt) && names(item.recipients));
  return item;
}
function queue(value: unknown): Record<string, unknown> {
  const item = record(value, ['id', 'members', 'partyId', 'gameId', 'compatibility', 'min', 'max', 'at', 'matching', 'profiles', 'rolePreferences']);
  require(text(item.id) && names(item.members) && (item.partyId === undefined || text(item.partyId)) && text(item.gameId) && number(item.min, 1) && number(item.max, 1) && Number(item.min) <= Number(item.max) && number(item.at) && ['basic', 'advanced'].includes(String(item.matching)));
  compatibility(item.compatibility);
  const members = item.members as string[];
  if (item.profiles !== undefined) {
    require(Array.isArray(item.profiles) && item.profiles.length === members.length);
    const seen = new Set<string>();
    for (const value of item.profiles as unknown[]) {
      const profile = record(value, ['playerId', 'skill', 'regionRttMs', 'measuredAt']);
      require(text(profile.playerId) && members.includes(profile.playerId) && !seen.has(profile.playerId) && typeof profile.skill === 'number' && Number.isFinite(profile.skill) && number(profile.measuredAt));
      seen.add(profile.playerId as string);
      const rtts = record(profile.regionRttMs, Object.keys(profile.regionRttMs as object));
      require(Object.entries(rtts).every(([region, latency]) => text(region, 64) && typeof latency === 'number' && Number.isFinite(latency) && latency >= 0));
    }
  }
  if (item.rolePreferences !== undefined) {
    const preferences = record(item.rolePreferences, members);
    require(Object.values(preferences).every(value => names(value, false) && value.length <= 32));
  }
  return item;
}
export function domainId(kind: DomainKind, value: unknown): string {
  let item: Record<string, unknown>;
  if (kind === 'matches') {
    item = record(value, ['matchId', 'roomId', 'gameId', 'roster', 'createdAt', 'finishedAt', 'state']);
    require(text(item.matchId) && text(item.roomId) && text(item.gameId) && names(item.roster) && number(item.createdAt) && (item.finishedAt === undefined || number(item.finishedAt)) && ['starting', 'in_game', 'ended', 'failed'].includes(String(item.state)));
    return item.matchId as string;
  }
  if (kind === 'results') {
    item = record(value, ['resultId', 'matchId', 'playerId', 'roomId', 'result', 'createdAt', 'acknowledgedAt']);
    require(text(item.resultId) && text(item.matchId) && text(item.playerId) && text(item.roomId) && number(item.createdAt) && (item.acknowledgedAt === undefined || number(item.acknowledgedAt)));
    readRules(item.result); return item.resultId as string;
  }
  if (kind === 'chat') return chat(value).id as string;
  if (kind === 'reports') {
    item = record(value, ['id', 'reporterId', 'message', 'reason', 'createdAt', 'status', 'reviewedAt']);
    require(text(item.id) && text(item.reporterId) && text(item.reason, 2048) && [...String(item.reason)].length <= 512 && number(item.createdAt) && ['pending', 'dismiss', 'mute', 'ban'].includes(String(item.status)) && (item.reviewedAt === undefined || number(item.reviewedAt)));
    const evidence = chat(item.message); require((evidence.recipients as string[]).includes(item.reporterId as string));
    return item.id as string;
  }
  if (kind === 'mutes') {
    item = record(value, ['scope', 'scopeId', 'playerId', 'until']);
    require(['room', 'party'].includes(String(item.scope)) && text(item.scopeId) && text(item.playerId) && number(item.until));
    return JSON.stringify([item.scope, item.scopeId, item.playerId]);
  }
  if (kind === 'queue') return queue(value).id as string;
  item = record(value, ['id', 'entries', 'game', 'deadline', 'accepted', 'players']);
  require(text(item.id) && Array.isArray(item.entries) && item.entries.length > 0 && number(item.deadline) && names(item.accepted, false) && Array.isArray(item.players));
  const members: string[] = [];
  for (const entry of item.entries as unknown[]) members.push(...queue(entry).members as string[]);
  require(new Set(members).size === members.length && (item.accepted as string[]).every(id => members.includes(id)));
  const game = record(item.game, ['gameId', 'name', 'maxPlayersPerRoom', 'enabled', 'source', 'serverHint', 'versions', 'modes', 'regions', 'capabilities']);
  require(text(game.gameId) && text(game.name) && number(game.maxPlayersPerRoom, 1) && typeof game.enabled === 'boolean' && ['api', 'cache', 'config'].includes(String(game.source)) && (game.serverHint === undefined || text(game.serverHint, 1024)));
  for (const key of ['versions', 'modes', 'regions']) if (game[key] !== undefined) require(names(game[key], false) && (game[key] as string[]).length <= 32 && (game[key] as string[]).every(value => text(value, 64)));
  if (game.capabilities !== undefined) parseCapabilities(game.capabilities, Number(game.maxPlayersPerRoom));
  const players = new Set<string>();
  for (const value of item.players as unknown[]) {
    const player = record(value, ['id', 'role', 'team', 'gameRole']);
    require(text(player.id) && members.includes(player.id) && !players.has(player.id) && player.role === 'player' && (player.team === undefined || number(player.team)) && (player.gameRole === undefined || text(player.gameRole, 64)));
    players.add(player.id as string);
  }
  require(players.size === members.length);
  return item.id as string;
}
export function emptyDomain(): DurableDomain { return { matches: [], results: [], chat: [], reports: [], mutes: [], queue: [], proposals: [] }; }
