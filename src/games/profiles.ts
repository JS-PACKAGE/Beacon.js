import type { Config } from '../config.js';
import { apiEndpoint, requestJson } from '../auth/http.js';
import { readSecretFile } from '../auth/secrets.js';

/** Proposed Beacon provider contract, not an existing upstream API.
 * POST /v1/matchmaking/profiles, service Bearer authentication, body
 * {gameId,playerIds}; response {gameId,profiles:[{playerId,skill,regionRttMs,measuredAt}]}.
 * The trusted game service owns skill and measures RTT independently of clients.
 * Return exactly one fresh profile per requested identity; no client estimates,
 * cached/stale fallback, redirects or anonymous identity substitution are allowed.
 * skill is finite [0,1000000], RTT integer milliseconds [0,60000], measuredAt
 * epoch milliseconds. Deployments must implement this contract explicitly.
 */
export interface TrustedProfile {
  readonly playerId: string;
  readonly skill: number;
  readonly regionRttMs: Readonly<Record<string, number>>;
  readonly measuredAt: number;
}
export class TrustedProfileError extends Error {
  readonly code = 'matchmaking_profiles_unavailable';
  constructor() { super('Trusted matchmaking profiles unavailable'); this.name = 'TrustedProfileError'; }
}
export function parseProfiles(value: unknown, gameId: string, playerIds: readonly string[], now: number, maxAgeMs: number): readonly TrustedProfile[] {
  if (!Number.isSafeInteger(now) || now < 0 || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1 || !playerIds.length || playerIds.length > 256) throw new TrustedProfileError();
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TrustedProfileError();
  const data = value as Record<string, unknown>;
  if (Object.keys(data).some(k => !['gameId', 'profiles'].includes(k)) || data.gameId !== gameId || !Array.isArray(data.profiles) || data.profiles.length !== playerIds.length || new Set(playerIds).size !== playerIds.length) throw new TrustedProfileError();
  const seen = new Set<string>();
  const profiles = data.profiles.map((value: unknown): TrustedProfile => {
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new TrustedProfileError();
    const p = value as Record<string, unknown>;
    if (Object.keys(p).some(k => !['playerId', 'skill', 'regionRttMs', 'measuredAt'].includes(k)) || typeof p.playerId !== 'string' || !playerIds.includes(p.playerId) || seen.has(p.playerId) || typeof p.skill !== 'number' || !Number.isFinite(p.skill) || p.skill < 0 || p.skill > 1000000 || typeof p.measuredAt !== 'number' || !Number.isSafeInteger(p.measuredAt) || p.measuredAt > now || now - p.measuredAt > maxAgeMs || !p.regionRttMs || typeof p.regionRttMs !== 'object' || Array.isArray(p.regionRttMs)) throw new TrustedProfileError();
    seen.add(p.playerId);
    const rtt: Record<string, number> = Object.create(null) as Record<string, number>;
    const entries = Object.entries(p.regionRttMs);
    if (!entries.length || entries.length > 32) throw new TrustedProfileError();
    for (const [region, value] of entries) {
      if (!/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,63}$/.test(region) || typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0 || value > 60000) throw new TrustedProfileError();
      rtt[region] = value;
    }
    return Object.freeze({ playerId: p.playerId, skill: p.skill, measuredAt: p.measuredAt, regionRttMs: Object.freeze(rtt) });
  });
  return Object.freeze(profiles);
}
export class HttpGameProfiles {
  private readonly token: string | undefined;
  constructor(private readonly config: Config['games']) { this.token = config.serviceTokenFile ? readSecretFile(config.serviceTokenFile) : undefined; }
  async profiles(gameId: string, playerIds: readonly string[]): Promise<readonly TrustedProfile[]> {
    try {
      const maxAgeMs = this.config.profileMaxAgeMs;
      if (typeof maxAgeMs !== 'number' || !Number.isSafeInteger(maxAgeMs) || maxAgeMs < 1) throw new TrustedProfileError();
      if (!this.config.profileApiUrl || !this.token || !/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,127}$/.test(gameId) || !playerIds.length || playerIds.length > 256 || !playerIds.every(id => typeof id === 'string' && id.length > 0 && Buffer.byteLength(id) <= 128 && !/[\p{Cc}\p{Cs}]/u.test(id))) throw new TrustedProfileError();
      const data = await requestJson(apiEndpoint(this.config.profileApiUrl, '/v1/matchmaking/profiles'), this.config.timeoutMs, 262144, this.token, { method: 'POST', body: { gameId, playerIds } });
      return parseProfiles(data, gameId, playerIds, Date.now(), maxAgeMs);
    } catch { throw new TrustedProfileError(); }
  }
}
