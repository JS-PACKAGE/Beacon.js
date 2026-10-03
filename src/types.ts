export interface Player {
  id: string;
  displayName: string;
  authAt: number;
  expiresAt?: number;
}

export interface Game {
  gameId: string;
  name: string;
  maxPlayersPerRoom: number;
  enabled: boolean;
  source: 'api' | 'cache' | 'config';
  serverHint?: string;
}

export interface AuthProvider {
  verify(token: string): Promise<Player>;
}

export interface GameProvider {
  list(force?: boolean): Promise<readonly Game[]>;
}

export interface Peer {
  readonly id: string;
  readonly ip: string;
  readonly closed: boolean;
  send(message: Record<string, unknown>): void;
  close(code?: number, reason?: string): void;
}

export interface Session {
  peer: Peer;
  player?: Player;
  gameId?: string;
  roomId?: string;
  active: boolean;
}

export interface StoredRoom {
  id: string;
  gameId: string;
  name: string;
  hostId: string;
  passwordHash: string | null;
  maxPlayers: number;
  state: 'open' | 'closed';
  createdAt: number;
  updatedAt: number;
}

export interface RoomStore {
  load(): StoredRoom[];
  insert(room: StoredRoom): void;
  setHost(id: string, hostId: string, updatedAt: number): void;
  delete(id: string): void;
  close(): void;
}
