export type BeaconRules = Record<string, string | number | boolean>;
export interface BeaconPlayer { id: string; displayName: string }
export interface BeaconPresence { playerId: string; online: boolean; gameId?: string }
export interface BeaconFriend { playerId: string; status: 'pending' | 'accepted'; requestedBy: string; online?: boolean; gameId?: string }
export interface BeaconParty { id: string; leaderId: string; members: BeaconPresence[] }
export interface BeaconInvitation { invitationToken: string; target: string; sender?: string; status?: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'; createdAt?: number; resolvedAt?: number; expiresAt: number; roomId?: string; partyId?: string }
export interface BeaconInvitationRecord extends BeaconInvitation { sender: string; status: 'pending' | 'accepted' | 'declined' | 'revoked' | 'expired'; createdAt: number }
export interface BeaconMatchResult { resultId: string; matchId: string; playerId: string; roomId: string; result: BeaconRules; createdAt: number; acknowledgedAt?: number }
export interface BeaconProposal { proposalId: string; deadline: number; members: string[]; accepted: string[] }
export interface BeaconQueue { queued: boolean; queueId?: string; expiresAt?: number; reason?: string }
export interface BeaconChatMessage { id: string; scope: 'room' | 'party'; scopeId: string; senderId: string; text: string; createdAt: number }
export interface BeaconMember extends BeaconPlayer { isHost: boolean; ready: boolean; role: 'player' | 'spectator'; connected: boolean }
export interface BeaconRoom {
  id: string; gameId: string; name: string; ownerId: string; hostId: string; playerCount: number; spectatorCount: number;
  maxPlayers: number; maxSpectators: number; hasPassword: boolean; state: 'open' | 'starting' | 'in_game' | 'closed';
  visibility: 'public' | 'unlisted' | 'invite'; locked: boolean; version: string; mode: string; region: string;
  joinPolicy: 'closed' | 'fill' | 'spectate'; revision: number; createdAt: number; rules?: BeaconRules; matchId?: string;
}
export type BeaconRuleDescriptor = { type: 'boolean'; default?: boolean } | { type: 'number'; min?: number; max?: number; integer?: boolean; default?: number } | { type: 'string'; enum?: readonly string[]; maxLength?: number; default?: string };
export interface BeaconCapabilities { rules: Readonly<Record<string, BeaconRuleDescriptor>>; joinPolicies: readonly ('closed' | 'fill' | 'spectate')[]; minPlayers: number; roles?: readonly string[]; teams?: { count: number; size: number; requiredRoles: Readonly<Record<string, number>> } }
export interface BeaconGame { gameId: string; name: string; maxPlayersPerRoom: number; enabled: boolean; source: 'api' | 'cache' | 'config'; serverHint?: string; versions?: readonly string[]; modes?: readonly string[]; regions?: readonly string[]; capabilities?: BeaconCapabilities }
export interface BeaconEnvelope { requestId?: string; replayed?: boolean; resyncRequired?: boolean; snapshotId?: string; revision?: number; lobbyRevision?: number; chunkIndex?: number; chunkCount?: number }
export interface BeaconPayloads {
  hello: { serverVersion: string; protocolVersion: number; capabilities: string[]; authDeadlineMs: number };
  server_draining: { deadline: number };
  auth_ok: { player: BeaconPlayer; expiresAt?: number; protocolVersion?: number };
  auth_refreshed: { player: BeaconPlayer; expiresAt?: number; protocolVersion?: number };
  auth_fail: { code?: string; message?: string; ok?: boolean };
  error: { code: string; message?: string; ok?: false };
  result: { requestId: string; ok: true; resyncRequired?: boolean } | { requestId: string; ok: false; code: string };
  pong: {};
  session_state: { gameId?: string; room: BeaconRoom | null; ready: boolean; role: 'player' | 'spectator'; members: BeaconMember[] };
  lobby_state: { game: BeaconGame; rooms: BeaconRoom[]; total: number; live?: boolean; nextCursor?: string; nextPage?: number };
  lobby_update: { change: string; room: BeaconRoom };
  room_joined: { room: BeaconRoom; members: BeaconMember[] };
  room_state: { roomId: string; room: BeaconRoom; playerCount: number; change: string; members: BeaconMember[] };
  room_closed: { roomId: string; reason: string };
  room_left: { roomId?: string };
  games: { games: BeaconGame[] };
  owned_rooms: { rooms: BeaconRoom[] };
  friends: { friends: BeaconFriend[] };
  friend_presence: BeaconPresence;
  party_state: { party: BeaconParty | null };
  party_left: { partyId?: string };
  blocks: { playerIds: string[] };
  room_invitation: { roomId: string; playerId: string; invitationToken: string; expiresAt: number; sender?: string; createdAt?: number };
  party_invitation: { partyId: string; playerId: string; invitationToken: string; expiresAt: number; sender?: string; createdAt?: number };
  invitations: { invitations: BeaconInvitationRecord[] };
  invitation_resolved: { invitationToken: string; status: 'accepted' | 'declined' | 'revoked' | 'expired' };
  queue_state: BeaconQueue;
  match_proposal: BeaconProposal;
  match_proposal_resolved: { proposalId: string; reason: string };
  match_found: { room: BeaconRoom };
  match_result: BeaconMatchResult;
  match_results: { results: BeaconMatchResult[]; nextCursor?: string };
  match_result_acked: { resultId: string };
  game_started: { roomId: string; matchId: string; serverUrl: string; ticket: string; expiresAt: number };
  game_admission: { roomId: string; matchId: string; serverUrl: string; ticket: string; expiresAt: number };
  chat_message: { message: BeaconChatMessage };
  chat_history: { messages: BeaconChatMessage[]; nextCursor?: string };
  chat_muted: { scope: 'room' | 'party'; playerId: string; until: number };
  chat_reported: { reportId: string };
  snapshot_chunk: { snapshotType: string; snapshotId: string; revision: number; chunkIndex: number; chunkCount: number; payload: string };
}
export type ServerMessage = { [K in keyof BeaconPayloads]: BeaconEnvelope & { type: K } & BeaconPayloads[K] }[keyof BeaconPayloads];
export type BeaconMessageOf<K extends ServerMessage['type']> = Extract<ServerMessage, { type: K }>;
