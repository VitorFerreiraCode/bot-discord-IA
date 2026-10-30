export interface RoleProtectionInput {
  id: string;
  everyoneId: string;
  managed: boolean;
  administrator: boolean;
  manageGuild: boolean;
  manageRoles: boolean;
  ownerHasRole: boolean;
  name: string;
}

export function isProtectedRole(input: RoleProtectionInput): boolean {
  return input.id === input.everyoneId
    || input.managed
    || input.administrator
    || input.manageGuild
    || input.manageRoles
    || input.ownerHasRole
    || /(?:^|[^a-z0-9])(?:admin(?:istrator|istrador)?|owner|dono|propriet[aá]rio)(?:$|[^a-z0-9])/i.test(input.name);
}

export function hasNegatedDestructiveIntent(text: string): boolean {
  const normalized = text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
  return /\b(?:nunca|cancele|cancela|desisti|deixa pra la|nao precisa|nao quero|nao faca|nao faca isso|nao delete|nao exclu\w*|nao apagu\w*|nao remov\w*|nao recri\w*|nao crie novamente|nao criar novamente|nao apague|nao exclua|nao remova)\b/i.test(normalized);
}

export function isProviderTimeout(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /timed?\s*out|timeout|aborted due to timeout/i.test(message);
}

export function proposalExpiresAt(createdAt: number | Date, ttlMs = 5 * 60_000): Date {
  const timestamp = createdAt instanceof Date ? createdAt.getTime() : createdAt;
  return new Date(timestamp + ttlMs);
}

export function isKnownDiscordEntity(id: string, knownIds: ReadonlySet<string>): boolean {
  return /^\d{17,20}$/.test(id) && knownIds.has(id);
}
