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

function normalizeIntentText(text: string): string {
  return text.normalize('NFD').replace(/\p{Diacritic}/gu, '').toLowerCase();
}

/** Exclusão de mensagem só é aceita quando a mensagem atual pede explicitamente para apagar uma mensagem. */
export function explicitlyRequestsMessageDeletion(text: string): boolean {
  const normalized = normalizeIntentText(text);
  return /\b(?:apag\w*|exclu\w*|delet\w*|remov\w*)\b/.test(normalized)
    && /\b(?:mensage\w*|msg\w*|aviso\w*|anuncio\w*|post\w*)\b|discord(?:app)?\.com\/channels\//.test(normalized)
    && !hasNegatedDestructiveIntent(text);
}

/** Extrai links de mensagens do Discord (https://discord.com/channels/<servidor>/<canal>/<mensagem>). */
export function parseDiscordMessageLinks(text: string): Array<{ guildId: string; channelId: string; messageId: string }> {
  const links = [...text.matchAll(/https?:\/\/(?:(?:ptb|canary)\.)?discord(?:app)?\.com\/channels\/(\d{17,20})\/(\d{17,20})\/(\d{17,20})/g)]
    .map((match) => ({ guildId: match[1]!, channelId: match[2]!, messageId: match[3]! }));
  return links.filter((link, index) => links.findIndex((other) => other.messageId === link.messageId) === index);
}

/** Indica se o pedido fala de mensagens, para só então anexar conteúdo de mensagens recentes ao retrato enviado à IA. */
export function requestMentionsMessages(text: string): boolean {
  return /\b(?:mensage\w*|msg\w*|fix\w*|desfix\w*|pin\w*|anunci\w*|aviso\w*|post\w*|envi\w*|mand\w*|escrev\w*|public\w*|embed\w*)\b/.test(normalizeIntentText(text))
    || parseDiscordMessageLinks(text).length > 0;
}

export const MESSAGE_CONTENT_LIMIT = 2000;
export const EMBED_TITLE_LIMIT = 256;
export const EMBED_DESCRIPTION_LIMIT = 4096;

export function containsMassMention(text: string): boolean {
  return /@(?:everyone|here)\b/.test(text);
}
