import { BANNED_CHAT_WORDS } from "./bannedChatWords";

export interface ChatModerationConfig {
  maxMessages: number;
  windowMilliseconds: number;
  bannedWords: readonly string[];
  showRemainingCooldown: boolean;
}

export const DEFAULT_CHAT_MODERATION_CONFIG: Readonly<ChatModerationConfig> = Object.freeze({
  maxMessages: 3,
  windowMilliseconds: 5_000,
  bannedWords: BANNED_CHAT_WORDS,
  showRemainingCooldown: true,
});

export type ChatValidationResult =
  | { accepted: true; message: string }
  | { accepted: false; reason: "empty" | "prohibited-language" | "rate-limit"; feedback: string; cooldownMilliseconds?: number };

const CHAT_WORD = /[\p{L}\p{M}\p{N}](?:[\p{L}\p{M}\p{N}@!$|]*[\p{L}\p{M}\p{N}])?/gu;
const COMBINING_MARK = /\p{M}/gu;
const OBFUSCATION_CHARACTERS: Readonly<Record<string, string>> = Object.freeze({
  "0": "o", "1": "i", "3": "e", "4": "a", "5": "s", "7": "t", "@": "a", "!": "i", "$": "s", "|": "i",
  "а": "a", "е": "e", "і": "i", "о": "o", "с": "c", "х": "x",
});

export function normalizeChatWord(word: string): string {
  let normalized = "";
  for (const character of word.normalize("NFKD").toLocaleLowerCase("und").replace(COMBINING_MARK, "")) {
    normalized += OBFUSCATION_CHARACTERS[character] ?? character;
  }
  return normalized;
}

export function containsBannedChatWord(message: string, bannedWords: readonly string[]): boolean {
  const prohibited = new Set(bannedWords.map(normalizeChatWord).filter(Boolean));
  const words = [...message.matchAll(CHAT_WORD)].map((match) => normalizeChatWord(match[0]));
  if (words.some((word) => prohibited.has(word))) return true;

  // Also catch deliberately separated spellings such as "h.i.t.l.e.r" without collapsing normal multi-letter words.
  const longestProhibitedWord = Math.max(0, ...Array.from(prohibited, (word) => word.length));
  for (let start = 0; start < words.length; start++) {
    let joined = "";
    for (let index = start; index < words.length && words[index].length === 1 && joined.length < longestProhibitedWord; index++) {
      joined += words[index];
      if (prohibited.has(joined)) return true;
    }
  }
  return false;
}

export class ChatModeration {
  readonly config: Readonly<ChatModerationConfig>;
  private readonly sentAtByPlayer = new Map<string, number[]>();
  private readonly bannedWords: readonly string[];
  private readonly now: () => number;

  constructor(config: Partial<ChatModerationConfig> = {}, now: () => number = Date.now) {
    this.config = Object.freeze({
      ...DEFAULT_CHAT_MODERATION_CONFIG,
      ...config,
      maxMessages: Math.max(1, Math.trunc(config.maxMessages ?? DEFAULT_CHAT_MODERATION_CONFIG.maxMessages)),
      windowMilliseconds: Math.max(1, Math.trunc(config.windowMilliseconds ?? DEFAULT_CHAT_MODERATION_CONFIG.windowMilliseconds)),
    });
    this.bannedWords = this.config.bannedWords.map(normalizeChatWord).filter(Boolean);
    this.now = now;
  }

  validate(message: string, playerKey: string): ChatValidationResult {
    const trimmed = message.trim();
    if (!trimmed) return { accepted: false, reason: "empty", feedback: "Message not sent: empty message." };
    if (containsBannedChatWord(trimmed, this.bannedWords)) {
      return { accepted: false, reason: "prohibited-language", feedback: "Message not sent: prohibited language." };
    }

    const now = this.now(), cutoff = now - Math.max(0, this.config.windowMilliseconds);
    this.prune(cutoff);
    const sentAt = this.sentAtByPlayer.get(playerKey) ?? [];
    if (sentAt.length >= Math.max(0, this.config.maxMessages)) {
      const cooldownMilliseconds = Math.max(0, sentAt[0] + this.config.windowMilliseconds - now);
      const suffix = this.config.showRemainingCooldown ? ` Try again in ${Math.max(1, Math.ceil(cooldownMilliseconds / 1000))}s.` : "";
      return { accepted: false, reason: "rate-limit", feedback: `Message not sent: chat rate limit exceeded.${suffix}`, cooldownMilliseconds };
    }

    sentAt.push(now);
    this.sentAtByPlayer.set(playerKey, sentAt);
    return { accepted: true, message: trimmed };
  }

  private prune(cutoff: number): void {
    for (const [playerKey, sentAt] of this.sentAtByPlayer) {
      const firstCurrent = sentAt.findIndex((timestamp) => timestamp > cutoff);
      if (firstCurrent < 0) this.sentAtByPlayer.delete(playerKey);
      else if (firstCurrent > 0) sentAt.splice(0, firstCurrent);
    }
  }
}
