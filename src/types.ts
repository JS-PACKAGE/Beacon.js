import type { GameCapabilities } from './games/capabilities.js';
import type { TrustedProfile } from './games/profiles.js';
export interface Player {
  id: string;
  displayName: string;
  authAt: number;
  expiresAt?: number;
  tokenId?: string;
  issuedAt?: number;
}
export interface Game {
  gameId: string;
  name: string;
  maxPlayersPerRoom: number;
  enabled: boolean;
  source: 'api' | 'cache' | 'config';
  serverHint?: string;
  versions?: readonly string[];
  modes?: readonly string[];
  regions?: readonly string[];
  capabilities?: GameCapabilities;
}
export interface AuthProvider { verify(token: string): Promise<Player> }
export interface GameProvider { list(force?: boolean): Promise<readonly Game[]>; profiles?(gameId: string, playerIds: readonly string[]): Promise<readonly TrustedProfile[]> }
export interface Peer {
  readonly id: string;
  readonly ip: string;
  readonly closed: boolean;
  send(message: Record<string, unknown>): void;
  reply?(message: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
}
export interface Session {
  peer: Peer;
  player?: Player;
  gameId?: string;
  roomId?: string;
  active: boolean;
  disconnectedAt?: number;
  ready?: boolean;
  role?: 'player' | 'spectator';
  compatibility?: { version: string; mode: string; region: string };
}
export type Rules = Record<string, string | number | boolean>;
export interface ReconnectSeat {
  playerId: string;
  role: 'player' | 'spectator';
  ready: boolean;
  gameId: string;
  version: string;
  mode: string;
  region: string;
  displayName: string;
  expiresAt: number;
  pendingResult?: { matchId: string; result: Rules };
}
export interface StoredRoom {
  id: string;
  gameId: string;
  name: string;
  ownerId: string;
  hostId: string;
  passwordHash: string | null;
  maxPlayers: number;
  state: 'open' | 'starting' | 'in_game' | 'closed';
  visibility: 'public' | 'unlisted' | 'invite';
  locked: boolean;
  version: string;
  mode: string;
  region: string;
  joinPolicy: 'closed' | 'fill' | 'spectate';
  maxSpectators: number;
  revision: number;
  bannedIds: string[];
  invitedIds: string[];
  matchId: string | null;
  matchRequest?: MatchRequest;
  assignments?: MatchRequest['players'];
  rules?: Rules;
  seats?: ReconnectSeat[];
  createdAt: number;
  updatedAt: number;
}
export interface Moderation { playerId: string; bannedUntil: number; revokedBefore: number; reason: string }
export interface SocialLink { a: string; b: string; status: 'pending' | 'accepted'; requestedBy: string }
export interface StoredParty { id: string; leaderId: string; members: string[] }
export interface StoredInvitation { token: string; target: string; expiresAt: number; roomId?: string; partyId?: string }
export interface PlayerBlock { playerId: string; targetId: string }
export interface AuditEvent { at: number; actor: string; action: string; target: string }
export interface RoomStore {
  load(): StoredRoom[];
  insert(room: StoredRoom): void;
  update(room: StoredRoom): void;
  setHost(id: string, hostId: string, updatedAt: number): void;
  delete(id: string): void;
  listModeration(): Moderation[];
  saveModeration(record: Moderation): void;
  listSocial(): SocialLink[];
  saveSocial(link: SocialLink): void;
  deleteSocial(a: string, b: string): void;
  listParties(): StoredParty[];
  saveParty(party: StoredParty): void;
  deleteParty(id: string): void;
  listInvitations(): StoredInvitation[];
  saveInvitation(invitation: StoredInvitation): void;
  deleteInvitation(token: string): void;
  listBlocks(): PlayerBlock[];
  saveBlock(block: PlayerBlock): void;
  deleteBlock(playerId: string, targetId: string): void;
  audit(event: AuditEvent): void;
  listAudit(limit: number): AuditEvent[];
  close(): void;
}
export interface MatchRequest {
  operationId: string;
  roomId: string;
  gameId: string;
  players: { id: string; role: 'player' | 'spectator'; team?: number; gameRole?: string }[];
  version: string;
  joinPolicy?: 'closed' | 'fill' | 'spectate';
  mode: string;
  region: string;
  rules?: Rules;
}
export interface Admission { serverUrl: string; ticket: string; expiresAt: number }
export interface MatchAllocation { matchId: string; serverUrl: string; expiresAt: number; tickets: Record<string, string> }
export interface GameSessionProvider {
  create(input: MatchRequest): Promise<MatchAllocation>;
  admit(matchId: string, playerId: string, role: 'player' | 'spectator'): Promise<Admission>;
  status(matchId: string): Promise<'starting' | 'in_game' | 'ended' | 'failed'>;
  cancel(matchId: string): Promise<void>;
}
export interface Revocation { playerId?: string; tokenId?: string; revokedBefore?: number }
