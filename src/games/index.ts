import type { Config } from '../config.js';
import type { Game, GameProvider } from '../types.js';
import { log } from '../log/index.js';
import { apiEndpoint, requestJson } from '../auth/http.js';
import { parseCapabilities } from './capabilities.js';
import { HttpGameProfiles, type TrustedProfile } from './profiles.js';

function boundedText(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function games(value: unknown, source: Game['source']): readonly Game[] {
  if (!Array.isArray(value)) throw new Error('Invalid game registry');
  const ids = new Set<string>();
  return Object.freeze(value.map((entry: unknown): Game => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) throw new Error('Invalid game registry');
    const item = entry as Record<string, unknown>;
    if (!boundedText(item.gameId, 128) || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(item.gameId) || !boundedText(item.name, 128) || typeof item.enabled !== 'boolean' || typeof item.maxPlayersPerRoom !== 'number' || !Number.isSafeInteger(item.maxPlayersPerRoom) || item.maxPlayersPerRoom < 1 || ids.has(item.gameId)) throw new Error('Invalid game registry');
    ids.add(item.gameId);
    const result: Game = { gameId: item.gameId, name: item.name, enabled: item.enabled, maxPlayersPerRoom: item.maxPlayersPerRoom, source };
    if (item.serverHint !== undefined) {
      if (!boundedText(item.serverHint, 1024)) throw new Error('Invalid game registry');
      result.serverHint = item.serverHint;
    }
    for (const key of ['versions', 'modes', 'regions'] as const) if (item[key] !== undefined) {
      const values = item[key];
      if (!Array.isArray(values) || values.length > 32 || !values.every(v => boundedText(v, 64))) throw new Error('Invalid game registry');
      result[key] = Object.freeze([...values]) as readonly string[];
    }
    if (item.capabilities !== undefined) result.capabilities = parseCapabilities(item.capabilities, result.maxPlayersPerRoom);
    return Object.freeze(result);
  }));
}

export class GameRegistry implements GameProvider {
  private readonly fallback: readonly Game[];
  private cachedProjection: readonly Game[] | undefined;
  private expiresAt = 0;
  private inFlight: Promise<readonly Game[]> | undefined;
  private profileAdapter: HttpGameProfiles | undefined;
  constructor(private readonly config: Config['games']) {
    this.fallback = games(config.fallback, 'config');
  }
  profiles(gameId: string, playerIds: readonly string[]): Promise<readonly TrustedProfile[]> {
    this.profileAdapter ??= new HttpGameProfiles(this.config);
    return this.profileAdapter.profiles(gameId, playerIds);
  }
  async list(force = false): Promise<readonly Game[]> {
    if (!this.config.apiUrl) return this.fallback;
    if (this.inFlight) return this.inFlight;
    if (!force && Date.now() < this.expiresAt) return this.cachedProjection ?? this.fallback;
    this.inFlight = this.load();
    try { return await this.inFlight; } finally { this.inFlight = undefined; }
  }
  private async load(): Promise<readonly Game[]> {
    try {
      const response = await requestJson(apiEndpoint(this.config.apiUrl, '/v1/games'), this.config.timeoutMs, 262_144);
      const next = games(response, 'api');
      const projection = Object.freeze(next.map(game => Object.freeze({ ...game, source: 'cache' as const })));
      this.cachedProjection = projection;
      this.expiresAt = Date.now() + this.config.cacheTtlSec * 1000;
      return next;
    } catch {
      // Only a fixed event is logged: upstream bodies and errors can contain credentials.
      log('warn', 'games_api_unavailable', { fallback: this.cachedProjection ? 'cache' : 'config' });
      this.expiresAt = Date.now() + this.config.cacheTtlSec * 1000;
      return this.cachedProjection ?? this.fallback;
    }
  }
}
