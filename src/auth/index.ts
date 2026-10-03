import { createPublicKey, verify as verifySignature, type KeyObject } from 'node:crypto';
import type { Config } from '../config.js';
import type { AuthProvider, Player } from '../types.js';
import { apiEndpoint, requestJson } from './http.js';

export class AuthError extends Error {
  constructor() { super('Authentication failed'); this.name = 'AuthError'; }
}

function object(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new AuthError();
  return value as Record<string, unknown>;
}
function text(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length > 0 && Buffer.byteLength(value) <= max && !/[\u0000-\u001f\u007f-\u009f]/u.test(value);
}
function identity(id: unknown, displayName: unknown): Player {
  if (!text(id, 128) || !text(displayName, 128)) throw new AuthError();
  return { id, displayName, authAt: Date.now() };
}
function validToken(token: string): void {
  if (!text(token, 8192) || /\s/u.test(token)) throw new AuthError();
}

export class MockAuthProvider implements AuthProvider {
  private readonly players = new Map<string, { id: string; displayName: string }>();
  constructor(config: Config['auth']) {
    for (const entry of config.mockPlayers) {
      validToken(entry.token);
      identity(entry.id, entry.displayName);
      if (this.players.has(entry.token)) throw new AuthError();
      this.players.set(entry.token, { id: entry.id, displayName: entry.displayName });
    }
  }
  async verify(token: string): Promise<Player> {
    validToken(token);
    const player = this.players.get(token);
    if (!player) throw new AuthError();
    return identity(player.id, player.displayName);
  }
}

export class RemoteVerifyProvider implements AuthProvider {
  constructor(private readonly config: Config['auth']) {}
  async verify(token: string): Promise<Player> {
    try {
      validToken(token);
      const result = object(await requestJson(apiEndpoint(this.config.apiUrl, '/v1/verify'), this.config.timeoutMs, 16_384, token));
      const player = identity(result.playerId, result.displayName);
      if (result.tokenId !== undefined) {
        if (!text(result.tokenId, 128)) throw new AuthError();
        player.tokenId = result.tokenId;
      }
      for (const field of ['issuedAt', 'expiresAt'] as const) if (result[field] !== undefined) {
        const timestamp = result[field];
        if (typeof timestamp !== 'number' || !Number.isSafeInteger(timestamp) || timestamp < 0 || (field === 'expiresAt' && timestamp <= player.authAt) || (field === 'issuedAt' && timestamp > player.authAt)) throw new AuthError();
        player[field] = timestamp;
      }
      return player;
    } catch { throw new AuthError(); }
  }
}

function decode(segment: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(segment)) throw new AuthError();
  const result = Buffer.from(segment, 'base64url');
  if (result.toString('base64url') !== segment) throw new AuthError();
  return result;
}
function jsonSegment(segment: string): Record<string, unknown> {
  return object(JSON.parse(decode(segment).toString('utf8')) as unknown);
}

export class JwksProvider implements AuthProvider {
  private keys = new Map<string, KeyObject>();
  private expiresAt = 0;
  private lastAttempt = -Infinity;
  private inFlight: Promise<void> | undefined;
  constructor(private readonly config: Config['auth']) {
    if (!config.jwksUrl || !config.issuer || !config.audience) throw new AuthError();
  }

  // A global refresh cooldown prevents attacker-controlled kids from triggering unbounded HTTP requests.
  async refresh(): Promise<void> {
    if (this.inFlight) return this.inFlight;
    if (Date.now() - this.lastAttempt < 1000) {
      if (Date.now() >= this.expiresAt) throw new AuthError();
      return;
    }
    this.lastAttempt = Date.now();
    this.inFlight = this.fetchKeys();
    try { await this.inFlight; } finally { this.inFlight = undefined; }
  }
  private async fetchKeys(): Promise<void> {
    try {
      const data = object(await requestJson(this.config.jwksUrl, this.config.timeoutMs, 262_144));
      if (!Array.isArray(data.keys) || data.keys.length === 0 || data.keys.length > 64) throw new AuthError();
      const next = new Map<string, KeyObject>();
      for (const value of data.keys) {
        const key = object(value);
        if (key.kty !== 'RSA' || (key.alg !== undefined && key.alg !== 'RS256') || (key.use !== undefined && key.use !== 'sig')) continue;
        if (!text(key.kid, 128) || !text(key.n, 2048) || !text(key.e, 16) || next.has(key.kid)) throw new AuthError();
        if (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify'))) continue;
        const modulus = decode(key.n);
        decode(key.e);
        if (modulus.length < 256 || modulus.length > 1024 || key.d !== undefined) throw new AuthError();
        const publicKey = createPublicKey({ key: { kty: 'RSA', n: key.n, e: key.e }, format: 'jwk' });
        const bits = publicKey.asymmetricKeyDetails?.modulusLength;
        if (!bits || bits < 2048 || bits > 8192) throw new AuthError();
        next.set(key.kid, publicKey);
      }
      if (!next.size) throw new AuthError();
      this.keys = next;
      this.expiresAt = Date.now() + this.config.jwksCacheTtlSec * 1000;
    } catch { throw new AuthError(); }
  }
  async verify(token: string): Promise<Player> {
    try {
      validToken(token);
      const parts = token.split('.');
      const [headerPart, payloadPart, signaturePart] = parts;
      if (parts.length !== 3 || !headerPart || !payloadPart || !signaturePart) throw new AuthError();
      const header = jsonSegment(headerPart);
      if (header.alg !== 'RS256' || !text(header.kid, 128) || header.crit !== undefined || header.b64 !== undefined) throw new AuthError();
      const stale = Date.now() >= this.expiresAt;
      if (stale) await this.refresh();
      let key = this.keys.get(header.kid);
      if (!key && !stale) { await this.refresh(); key = this.keys.get(header.kid); }
      if (!key || Date.now() >= this.expiresAt || !verifySignature('RSA-SHA256', Buffer.from(`${headerPart}.${payloadPart}`), key, decode(signaturePart))) throw new AuthError();
      const claims = jsonSegment(payloadPart);
      const now = Date.now() / 1000;
      if (claims.iss !== this.config.issuer || typeof claims.exp !== 'number' || !Number.isSafeInteger(claims.exp) || claims.exp <= now || claims.exp * 1000 > Number.MAX_SAFE_INTEGER) throw new AuthError();
      if (claims.nbf !== undefined && (typeof claims.nbf !== 'number' || !Number.isSafeInteger(claims.nbf) || claims.nbf > now)) throw new AuthError();
      const audience = claims.aud;
      if (audience !== this.config.audience && !(Array.isArray(audience) && audience.length > 0 && audience.length <= 16 && audience.every(a => text(a, 256)) && audience.includes(this.config.audience))) throw new AuthError();
      const player = identity(claims.sub, claims.name);
      player.expiresAt = claims.exp * 1000;
      if (claims.jti !== undefined) {
        if (!text(claims.jti, 128)) throw new AuthError();
        player.tokenId = claims.jti;
      }
      if (claims.iat !== undefined) {
        if (typeof claims.iat !== 'number' || !Number.isSafeInteger(claims.iat) || claims.iat < 0 || claims.iat > now || !Number.isSafeInteger(claims.iat * 1000)) throw new AuthError();
        player.issuedAt = claims.iat * 1000;
      }
      if (player.expiresAt <= player.authAt) throw new AuthError();
      return player;
    } catch { throw new AuthError(); }
  }
}

export function createAuthProvider(config: Config['auth']): AuthProvider {
  switch (config.mode) {
    case 'mock': return new MockAuthProvider(config);
    case 'remote': return new RemoteVerifyProvider(config);
    case 'jwks': return new JwksProvider(config);
  }
}
