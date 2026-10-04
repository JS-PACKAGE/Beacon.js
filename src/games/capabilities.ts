import type { Game, Rules } from '../types.js';
import { readRules } from '../protocol/index.js';

export type RuleDescriptor =
  | { type: 'boolean'; default?: boolean }
  | { type: 'number'; min?: number; max?: number; integer?: boolean; default?: number }
  | { type: 'string'; enum?: readonly string[]; maxLength?: number; default?: string };
export interface GameCapabilities {
  rules: Readonly<Record<string, RuleDescriptor>>;
  joinPolicies: readonly ('closed' | 'fill' | 'spectate')[];
  minPlayers: number;
  roles?: readonly string[];
  teams?: { count: number; size: number; requiredRoles: Readonly<Record<string, number>> };
}
export class GameCapabilityError extends Error {
  readonly code = 'unsupported_game_feature';
  constructor() { super('Unsupported game settings'); this.name = 'GameCapabilityError'; }
}
function fail(): never { throw new GameCapabilityError(); }
function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return fail();
  return value as Record<string, unknown>;
}
function keys(value: Record<string, unknown>, allowed: readonly string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) fail();
}
function count(value: unknown, min: number, max: number): value is number { return typeof value === 'number' && Number.isSafeInteger(value) && value >= min && value <= max; }
function name(value: unknown): value is string { return typeof value === 'string' && /^[a-zA-Z][a-zA-Z0-9_-]{0,63}$/.test(value); }
function validRule(value: unknown, rule: RuleDescriptor): boolean {
  if (rule.type === 'boolean') return typeof value === 'boolean';
  if (rule.type === 'number') return typeof value === 'number' && Number.isFinite(value) && Math.abs(value) <= Number.MAX_SAFE_INTEGER && (!rule.integer || Number.isSafeInteger(value)) && (rule.min === undefined || value >= rule.min) && (rule.max === undefined || value <= rule.max);
  return typeof value === 'string' && !/[\p{Cc}\p{Cs}]/u.test(value) && [...value].length <= (rule.maxLength ?? 128) && (rule.enum === undefined || rule.enum.includes(value));
}
export function parseCapabilities(value: unknown, maxPlayers: number): GameCapabilities {
  const item = record(value); keys(item, ['rules', 'joinPolicies', 'minPlayers', 'roles', 'teams']);
  if (!count(item.minPlayers, 1, maxPlayers) || !Array.isArray(item.joinPolicies) || !item.joinPolicies.length || new Set(item.joinPolicies).size !== item.joinPolicies.length || !item.joinPolicies.every(p => ['closed', 'fill', 'spectate'].includes(String(p)))) fail();
  const rules: Record<string, RuleDescriptor> = Object.create(null) as Record<string, RuleDescriptor>;
  const input = record(item.rules);
  if (Object.keys(input).length > 16) fail();
  for (const [key, value] of Object.entries(input)) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,31}$/.test(key) || /password|token|ticket|secret|authorization/i.test(key)) fail();
    const rule = record(value);
    if (rule.type === 'boolean') keys(rule, ['type', 'default']);
    else if (rule.type === 'number') {
      keys(rule, ['type', 'min', 'max', 'integer', 'default']);
      for (const key of ['min', 'max']) if (rule[key] !== undefined && (typeof rule[key] !== 'number' || !Number.isFinite(rule[key]) || Math.abs(rule[key]) > Number.MAX_SAFE_INTEGER)) fail();
      if (rule.min !== undefined && rule.max !== undefined && Number(rule.min) > Number(rule.max)) fail();
      if (rule.integer !== undefined && typeof rule.integer !== 'boolean') fail();
    } else if (rule.type === 'string') {
      keys(rule, ['type', 'enum', 'maxLength', 'default']);
      if (rule.maxLength !== undefined && !count(rule.maxLength, 1, 128)) fail();
      if (rule.enum !== undefined && (!Array.isArray(rule.enum) || !rule.enum.length || rule.enum.length > 32 || new Set(rule.enum).size !== rule.enum.length || !rule.enum.every(v => typeof v === 'string' && [...v].length <= (Number(rule.maxLength) || 128) && !/[\p{Cc}\p{Cs}]/u.test(v)))) fail();
    } else fail();
    const parsed = rule as unknown as RuleDescriptor;
    if (rule.default !== undefined && !validRule(rule.default, parsed)) fail();
    rules[key] = Object.freeze({ ...parsed, ...(parsed.type === 'string' && parsed.enum ? { enum: Object.freeze([...parsed.enum]) } : {}) });
  }
  const defaults: Rules = Object.create(null) as Rules;
  for (const [key, rule] of Object.entries(rules)) if (rule.default !== undefined) defaults[key] = rule.default;
  try { readRules(defaults); } catch { fail(); }
  const result: GameCapabilities = { rules: Object.freeze(rules), minPlayers: item.minPlayers as number, joinPolicies: Object.freeze([...(item.joinPolicies as GameCapabilities['joinPolicies'])]) };
  if (item.roles !== undefined) {
    if (!Array.isArray(item.roles) || !item.roles.length || item.roles.length > 16 || new Set(item.roles).size !== item.roles.length || !item.roles.every(name)) fail();
    result.roles = Object.freeze([...item.roles]) as readonly string[];
  }
  if (item.teams !== undefined) {
    const teams = record(item.teams); keys(teams, ['count', 'size', 'requiredRoles']);
    if (!count(teams.count, 2, 16) || !count(teams.size, 1, maxPlayers) || teams.count * teams.size > maxPlayers || teams.count * teams.size < result.minPlayers) fail();
    const required: Record<string, number> = Object.create(null) as Record<string, number>;
    for (const [role, amount] of Object.entries(record(teams.requiredRoles))) {
      if (!result.roles?.includes(role) || !count(amount, 1, teams.size)) fail();
      required[role] = amount;
    }
    if (Object.values(required).reduce((a, b) => a + b, 0) > teams.size) fail();
    result.teams = Object.freeze({ count: teams.count, size: teams.size, requiredRoles: Object.freeze(required) });
  }
  return Object.freeze(result);
}
export function validateGameSettings(game: Game, settings: { maxPlayers: number; joinPolicy: string; rules?: Rules; players?: readonly { id: string; role: 'player' | 'spectator'; team?: number; gameRole?: string }[] }): Rules | undefined {
  const caps = game.capabilities;
  if (!caps) return settings.rules;
  if (!count(settings.maxPlayers, caps.minPlayers, game.maxPlayersPerRoom) || !caps.joinPolicies.includes(settings.joinPolicy as 'closed' | 'fill' | 'spectate')) fail();
  const output: Rules = Object.create(null) as Rules;
  for (const [key, rule] of Object.entries(caps.rules)) if (rule.default !== undefined) output[key] = rule.default;
  for (const [key, value] of Object.entries(settings.rules ?? {})) {
    const rule = caps.rules[key]; if (!rule || !validRule(value, rule)) fail(); output[key] = value;
  }
  if (settings.players) {
    const players = settings.players.filter(p => p.role === 'player');
    if (players.length < caps.minPlayers || players.length > settings.maxPlayers) fail();
    for (const player of players) if (player.gameRole !== undefined && !caps.roles?.includes(player.gameRole)) fail();
    if (caps.teams) {
      if (players.length !== caps.teams.count * caps.teams.size) fail();
      for (const player of players) if (!count(player.team, 0, caps.teams.count - 1)) fail();
      for (let team = 0; team < caps.teams.count; team++) {
        const roster = players.filter(p => p.team === team);
        if (roster.length !== caps.teams.size) fail();
        for (const [role, amount] of Object.entries(caps.teams.requiredRoles)) if (roster.filter(p => p.gameRole === role).length < amount) fail();
      }
    } else if (players.some(p => p.team !== undefined)) fail();
  }
  try { return Object.keys(output).length ? readRules(output) : undefined; } catch { return fail(); }
}
/** Explicit allowlist: registry metadata must never project provider credentials. */
export function projectGame(game: Game): Game {
  return { gameId: game.gameId, name: game.name, enabled: game.enabled, maxPlayersPerRoom: game.maxPlayersPerRoom, source: game.source,
    ...(game.serverHint === undefined ? {} : { serverHint: game.serverHint }), ...(game.versions ? { versions: game.versions } : {}),
    ...(game.modes ? { modes: game.modes } : {}), ...(game.regions ? { regions: game.regions } : {}), ...(game.capabilities ? { capabilities: game.capabilities } : {}) };
}
