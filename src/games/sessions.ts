import type { Config } from '../config.js';
import type { Admission, GameSessionProvider, MatchAllocation, MatchRequest } from '../types.js';
import { readRules } from '../protocol/index.js';
import { apiEndpoint, requestJson, type JsonRequestOptions } from '../auth/http.js';
import { readSecretFile } from '../auth/secrets.js';
import { GameRegistry } from './index.js';
import { validateGameSettings } from './capabilities.js';

export class GameSessionError extends Error {
  readonly code = 'game_service_unavailable';
  constructor() { super('Game session service unavailable'); this.name = 'GameSessionError'; }
}
function text(value: unknown, max = 128): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\p{Cc}\p{Cs}]/u.test(value);
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new GameSessionError();
  return value as Record<string, unknown>;
}
function admission(value: unknown): Admission {
  const data = object(value);
  if (!text(data.serverUrl, 2048) || !text(data.ticket, 8192) || typeof data.expiresAt !== 'number' || !Number.isSafeInteger(data.expiresAt) || data.expiresAt <= Date.now()) throw new GameSessionError();
  const url = new URL(data.serverUrl);
  if (!['https:', 'wss:'].includes(url.protocol) || url.username || url.password || url.hash) throw new GameSessionError();
  return { serverUrl: data.serverUrl, ticket: data.ticket, expiresAt: data.expiresAt };
}
export class HttpGameSessions implements GameSessionProvider {
  private readonly token: string | undefined;
  private readonly registry: GameRegistry;
  constructor(private readonly config: Config['games']) {
    this.token = config.serviceTokenFile ? readSecretFile(config.serviceTokenFile) : undefined;
    this.registry = new GameRegistry(config);
  }
  private async request(path: string, options: JsonRequestOptions): Promise<unknown> {
    try {
      if (!this.config.sessionApiUrl) throw new GameSessionError();
      return await requestJson(apiEndpoint(this.config.sessionApiUrl, path), this.config.timeoutMs, 262144, this.token, options);
    } catch { throw new GameSessionError(); }
  }
  async create(input: MatchRequest): Promise<MatchAllocation> {
    try {
      if (!text(input.operationId) || !text(input.roomId) || !text(input.gameId) || !Array.isArray(input.players) || !input.players.length || new Set(input.players.map(p => p.id)).size !== input.players.length || !input.players.every(p => text(p.id) && ['player', 'spectator'].includes(p.role)) || ![input.version, input.mode, input.region].every(v => typeof v === 'string' && Buffer.byteLength(v) <= 64 && !/[\p{Cc}\p{Cs}]/u.test(v)) || (input.rules !== undefined && JSON.stringify(readRules(input.rules)) !== JSON.stringify(input.rules))) throw new GameSessionError();
      if (!input.players.every(p => (p.team === undefined || (Number.isSafeInteger(p.team) && p.team >= 0 && p.team < 16)) && (p.gameRole === undefined || text(p.gameRole, 64)))) throw new GameSessionError();
      const game = (await this.registry.list()).find(g => g.gameId === input.gameId);
      if (game?.capabilities) {
        const rules = validateGameSettings(game, { maxPlayers: game.maxPlayersPerRoom, joinPolicy: input.joinPolicy ?? 'closed', ...(input.rules === undefined ? {} : { rules: input.rules }), players: input.players });
        input = { ...input, ...(rules === undefined ? {} : { rules }) };
      }
      const data = object(await this.request('/v1/matches', { method: 'POST', headers: { 'Idempotency-Key': input.operationId }, body: input, statuses: [200, 201] }));
      const tickets = object(data.tickets);
      if (!text(data.matchId) || Object.keys(tickets).length !== input.players.length || !input.players.every(p => text(tickets[p.id], 8192))) throw new GameSessionError();
      const first = input.players[0];
      if (!first) throw new GameSessionError();
      const base = admission({ serverUrl: data.serverUrl, expiresAt: data.expiresAt, ticket: tickets[first.id] });
      const safeTickets: Record<string, string> = Object.create(null) as Record<string, string>;
      for (const player of input.players) safeTickets[player.id] = tickets[player.id] as string;
      return { matchId: data.matchId, serverUrl: base.serverUrl, expiresAt: base.expiresAt, tickets: safeTickets };
    } catch { throw new GameSessionError(); }
  }
  async admit(matchId: string, playerId: string, role: 'player' | 'spectator'): Promise<Admission> {
    try {
      if (!text(matchId) || !text(playerId) || !['player', 'spectator'].includes(role)) throw new GameSessionError();
      return admission(await this.request(`/v1/matches/${encodeURIComponent(matchId)}/admissions`, { method: 'POST', body: { playerId, role }, statuses: [200, 201] }));
    } catch { throw new GameSessionError(); }
  }
  async status(matchId: string): Promise<'starting' | 'in_game' | 'ended' | 'failed'> {
    if (!text(matchId)) throw new GameSessionError();
    const data = object(await this.request(`/v1/matches/${encodeURIComponent(matchId)}`, { method: 'GET' }));
    if (data.state !== 'starting' && data.state !== 'in_game' && data.state !== 'ended' && data.state !== 'failed') throw new GameSessionError();
    return data.state;
  }
  async cancel(matchId: string): Promise<void> {
    if (!text(matchId)) throw new GameSessionError();
    await this.request(`/v1/matches/${encodeURIComponent(matchId)}`, { method: 'DELETE', statuses: [200, 204], empty: true });
  }
}
