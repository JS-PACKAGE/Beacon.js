import type { Game } from '../types.js';
import { GameCapabilityError } from '../games/capabilities.js';
import { TrustedProfileError, type TrustedProfile } from '../games/profiles.js';

export interface MatchParty {
  id: string;
  playerIds: readonly string[];
  queuedAt: number;
  rolePreferences?: Readonly<Record<string, readonly string[]>>;
  profiles?: readonly TrustedProfile[];
}
export interface MatchingPolicy {
  skillSpread: number; maxSkillSpread: number;
  teamSkillDelta: number; maxTeamSkillDelta: number;
  latencyMs: number; maxLatencyMs: number;
  relaxAfterMs: number; relaxEveryMs: number; skillStep: number; latencyStep: number;
}
export interface MatchOptions {
  mode: 'basic' | 'advanced'; game: Game; now: number; playerCount: number; region: string;
  blocked: (a: string, b: string) => boolean;
  policy: MatchingPolicy;
  profileMaxAgeMs: number;
  /** Hard bound on visited search states; exhaustion is explicit, not no-match. */
  searchLimit: number;
}
export interface MatchSelection {
  partyIds: string[];
  players: { id: string; role: 'player'; team?: number; gameRole?: string }[];
}
export class MatchSearchLimitError extends Error {
  readonly code = 'matchmaking_search_exhausted';
  constructor() { super('Matchmaking search work limit reached'); this.name = 'MatchSearchLimitError'; }
}
/** FIFO chooses the oldest feasible complete roster. Advanced mode adds trusted
 * constraints, never changes party boundaries, and assigns a whole party to one
 * team. Relaxation uses the youngest roster wait: no newcomer is forced into an
 * older player's expanded budget. Caps remain hard even after indefinite wait. */
export function selectMatch(input: readonly MatchParty[], options: MatchOptions): MatchSelection | undefined {
  const { game, now, playerCount, region, blocked } = options;
  const caps = game.capabilities;
  const teams = caps?.teams;
  if (!['basic', 'advanced'].includes(options.mode) || !Number.isSafeInteger(playerCount) || playerCount < (caps?.minPlayers ?? 1) || playerCount > game.maxPlayersPerRoom || !Number.isSafeInteger(now) || (teams && playerCount !== teams.count * teams.size)) throw new GameCapabilityError();
  const policy = options.policy;
  if (!policy || !Object.values(policy).every(v => Number.isSafeInteger(v) && v >= 0) || policy.relaxEveryMs < 1 || policy.maxSkillSpread < policy.skillSpread || policy.maxTeamSkillDelta < policy.teamSkillDelta || policy.maxLatencyMs < policy.latencyMs || !Number.isSafeInteger(options.profileMaxAgeMs) || options.profileMaxAgeMs < 1 || (options.mode === 'advanced' && !region)) throw new GameCapabilityError();
  const searchLimit = options.searchLimit;
  if (!Number.isSafeInteger(searchLimit) || searchLimit < 1 || searchLimit > 1000000) throw new GameCapabilityError();
  let work = 0;
  function visit(): void {
    if (++work > searchLimit) throw new MatchSearchLimitError();
  }
  const parties = [...input].sort((a, b) => a.queuedAt - b.queuedAt || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  const ids = new Set<string>(); const partyIds = new Set<string>();
  const profiles = new Map<string, TrustedProfile>();
  for (const party of parties) {
    if (!party.id || partyIds.has(party.id) || !party.playerIds.length || !Number.isSafeInteger(party.queuedAt) || party.queuedAt > now) throw new GameCapabilityError();
    partyIds.add(party.id);
    for (const id of party.playerIds) {
      if (!id || ids.has(id)) throw new GameCapabilityError(); ids.add(id);
      const preferences = party.rolePreferences?.[id];
      if (preferences && (!preferences.length || new Set(preferences).size !== preferences.length || preferences.some(role => !caps?.roles?.includes(role)))) throw new GameCapabilityError();
    }
    if (party.rolePreferences && Object.keys(party.rolePreferences).some(id => !party.playerIds.includes(id))) throw new GameCapabilityError();
    if (options.mode === 'advanced') {
      if (!party.profiles || party.profiles.length !== party.playerIds.length) throw new TrustedProfileError();
      for (const profile of party.profiles) {
        if (!party.playerIds.includes(profile.playerId) || profiles.has(profile.playerId) || !Number.isFinite(profile.skill) || profile.skill < 0 || profile.skill > 1000000 || !Number.isSafeInteger(profile.measuredAt) || profile.measuredAt > now || now - profile.measuredAt > options.profileMaxAgeMs) throw new TrustedProfileError();
        profiles.set(profile.playerId, profile);
      }
    }
  }
  const remaining = new Array<number>(parties.length + 1).fill(0);
  for (let index = parties.length - 1; index >= 0; index--) {
    const length = parties[index]!.playerIds.length;
    remaining[index] = remaining[index + 1]! + (teams && length > teams.size ? 0 : length);
  }
  // Necessary role supply across the entire queue rejects impossible queues
  // before selecting subsets or partitioning teams.
  for (const [role, amount] of Object.entries(teams?.requiredRoles ?? {})) {
    let available = 0;
    for (const party of parties) for (const id of party.playerIds) {
      if ((party.rolePreferences?.[id] ?? caps?.roles ?? []).includes(role)) available++;
    }
    if (available < amount * (teams?.count ?? 1)) return undefined;
  }
  function allocate(roster: readonly MatchParty[]): MatchSelection | undefined {
    const players = roster.flatMap(p => p.playerIds);
    const wait = Math.min(...roster.map(p => now - p.queuedAt));
    const steps = wait < policy.relaxAfterMs ? 0 : 1 + Math.floor((wait - policy.relaxAfterMs) / policy.relaxEveryMs);
    const skillLimit = Math.min(policy.maxSkillSpread, policy.skillSpread + steps * policy.skillStep);
    const deltaLimit = Math.min(policy.maxTeamSkillDelta, policy.teamSkillDelta + steps * policy.skillStep);
    const rttLimit = Math.min(policy.maxLatencyMs, policy.latencyMs + steps * policy.latencyStep);
    if (options.mode === 'advanced') {
      const skills = players.map(id => profiles.get(id)!.skill);
      if (Math.max(...skills) - Math.min(...skills) > skillLimit) return undefined;
      for (const id of players) {
        const rtt = profiles.get(id)!.regionRttMs[region];
        if (rtt === undefined || !Number.isSafeInteger(rtt) || rtt < 0 || rtt > rttLimit) return undefined;
      }
    }
    const count = teams?.count ?? 1;
    const size = teams?.size ?? playerCount;
    for (const [role, amount] of Object.entries(teams?.requiredRoles ?? {})) {
      let available = 0;
      for (const party of roster) for (const id of party.playerIds) if ((party.rolePreferences?.[id] ?? caps?.roles ?? []).includes(role)) available++;
      if (available < amount * count) return undefined;
    }
    const requiredRoles = Object.entries(teams?.requiredRoles ?? {});
    const preferences = new Map<string, readonly string[]>();
    for (const party of roster) for (const id of party.playerIds) preferences.set(id, party.rolePreferences?.[id] ?? caps?.roles ?? []);
    // Assign scarce mandatory-role candidates first, preserving FIFO roster
    // selection while making late specialist arrivals feasible within the bound.
    const priority = new Map<MatchParty, number>();
    for (const party of roster) priority.set(party, party.playerIds.filter(id => requiredRoles.some(([role]) => preferences.get(id)!.includes(role))).length);
    const ordered = [...roster].sort((a, b) => priority.get(b)! - priority.get(a)!);
    const bins: string[][] = Array.from({ length: count }, () => []);
    let best: MatchSelection | undefined; let bestDelta = Infinity;
    function assignRoles(bin: readonly string[]): Record<string, string> | undefined {
      if (!caps?.roles) return {};
      const assigned: Record<string, string> = Object.create(null) as Record<string, string>;
      const allowed = bin.map(id => preferences.get(id)!);
      const slots = Object.entries(teams?.requiredRoles ?? {}).flatMap(([role, amount]) => Array<string>(amount).fill(role));
      const owner = new Array<number>(bin.length).fill(-1);
      // Bipartite augmenting paths assign mandatory role slots without the
      // exponential enumeration of each player's optional roles.
      function fill(slot: number, seen: boolean[]): boolean {
        visit();
        for (let player = 0; player < bin.length; player++) {
          if (seen[player] || !allowed[player]!.includes(slots[slot]!)) continue;
          seen[player] = true;
          if (owner[player] === -1 || fill(owner[player]!, seen)) { owner[player] = slot; return true; }
        }
        return false;
      }
      for (let slot = 0; slot < slots.length; slot++) if (!fill(slot, new Array<boolean>(bin.length).fill(false))) return undefined;
      for (let player = 0; player < bin.length; player++) assigned[bin[player]!] = owner[player] === -1 ? allowed[player]![0]! : slots[owner[player]!]!;
      return assigned;
    }
    function assignTeams(index: number): void {
      if (bestDelta === 0) return;
      visit();
      for (const bin of bins) {
        for (const [role, amount] of requiredRoles) {
          const existing = bin.filter(id => preferences.get(id)!.includes(role)).length;
          let available = 0;
          for (let next = index; next < ordered.length; next++) for (const id of ordered[next]!.playerIds) if (preferences.get(id)!.includes(role)) available++;
          if (existing + Math.min(size - bin.length, available) < amount) return;
        }
        if (bin.length === size && assignRoles(bin) === undefined) return;
      }
      if (index === ordered.length) {
        if (bins.some(bin => bin.length !== size)) return;
        const means = bins.map(bin => options.mode === 'advanced' ? bin.reduce((sum, id) => sum + profiles.get(id)!.skill, 0) / size : 0);
        const delta = Math.max(...means) - Math.min(...means);
        if ((options.mode === 'advanced' && delta > deltaLimit) || delta >= bestDelta) return;
        const roles = bins.map(assignRoles); if (roles.some(role => role === undefined)) return;
        bestDelta = delta;
        best = { partyIds: roster.map(p => p.id), players: bins.flatMap((bin, team) => bin.map(id => ({ id, role: 'player' as const, ...(teams ? { team } : {}), ...(roles[team]?.[id] ? { gameRole: roles[team]![id]! } : {}) }))) };
        return;
      }
      const party = ordered[index]!;
      // Empty teams are interchangeable. Avoid factorial permutations without
      // discarding any meaningful balancing or role assignment.
      for (let team = 0; team < count; team++) {
        const bin = bins[team]!;
        if (bin.length + party.playerIds.length > size) continue;
        const empty = bin.length === 0;
        bin.push(...party.playerIds); assignTeams(index + 1); bin.splice(bin.length - party.playerIds.length);
        if (empty) break;
      }
    }
    try { assignTeams(0); } catch (error) {
      // A bounded search may return an already validated balanced roster,
      // never an unchecked candidate. With no candidate, exhaustion is explicit.
      if (!(error instanceof MatchSearchLimitError) || best === undefined) throw error;
    }
    return best;
  }
  function choose(start: number, roster: MatchParty[], size: number): MatchSelection | undefined {
    visit();
    if (size + remaining[start]! < playerCount) return undefined;
    if (size === playerCount) return allocate(roster);
    for (let index = start; index < parties.length; index++) {
      visit();
      const candidate = parties[index]!;
      if (size + candidate.playerIds.length > playerCount || (teams && candidate.playerIds.length > teams.size)) continue;
      const existing = roster.flatMap(p => p.playerIds);
      const all = [...existing, ...candidate.playerIds];
      if (all.some((a, i) => all.slice(i + 1).some(b => blocked(a, b) || blocked(b, a)))) continue;
      roster.push(candidate); const selected = choose(index + 1, roster, size + candidate.playerIds.length); roster.pop();
      if (selected) return selected;
    }
    return undefined;
  }
  return choose(0, [], 0);
}
