import type { Config } from '../config.js';
import type { Revocation } from '../types.js';
import { requestJson } from './http.js';

export class RevocationError extends Error {
  constructor() { super('Authentication revocation service unavailable'); this.name = 'RevocationError'; }
}
export class RevocationRegistry {
  constructor(private readonly config: Config['auth']) {}
  async refresh(): Promise<readonly Revocation[]> {
    if (!this.config.revocationUrl) return Object.freeze([]);
    try {
      const data = await requestJson(this.config.revocationUrl, this.config.timeoutMs, 262144);
      if (!Array.isArray(data) || data.length > 4096) throw new RevocationError();
      return Object.freeze(data.map((value: unknown) => {
        if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RevocationError();
        const item = value as Record<string, unknown>;
        if (Object.keys(item).some(k => !['playerId', 'tokenId', 'revokedBefore'].includes(k)) || (item.playerId === undefined && item.tokenId === undefined)) throw new RevocationError();
        const result: Revocation = {};
        for (const key of ['playerId', 'tokenId'] as const) if (item[key] !== undefined) {
          const id = item[key];
          if (typeof id !== 'string' || !id.length || Buffer.byteLength(id) > 128 || /[\p{Cc}\p{Cs}]/u.test(id)) throw new RevocationError();
          result[key] = id;
        }
        if (item.revokedBefore !== undefined) {
          if (typeof item.revokedBefore !== 'number' || !Number.isSafeInteger(item.revokedBefore) || item.revokedBefore < 0 || result.playerId === undefined) throw new RevocationError();
          result.revokedBefore = item.revokedBefore;
        }
        return Object.freeze(result);
      }));
    } catch { throw new RevocationError(); }
  }
}
