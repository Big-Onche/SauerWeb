export const TEAMKILL_PROTECTION_MESSAGE =
  "Abnormally high teamkill rate detected. SauerWeb disconnected you to protect other players and prevent server bans.";

export interface TeamkillProtectionConfig {
  warningThreshold: number;
  disconnectThreshold: number;
  windowMilliseconds: number;
  cooldownMilliseconds: number;
}

export const DEFAULT_TEAMKILL_PROTECTION: Readonly<TeamkillProtectionConfig> = {
  warningThreshold: 2,
  disconnectThreshold: 3,
  windowMilliseconds: 5 * 60_000,
  cooldownMilliseconds: 10 * 60_000,
};

interface StoredTeamkillState {
  events: number[];
  cooldownUntil: number;
}

export interface TeamkillProtectionResult {
  count: number;
  warn: boolean;
  disconnect: boolean;
  cooldownUntil: number;
}

interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
}

const STORAGE_KEY = "sauerweb.teamkill-protection.v1";

export class TeamkillProtection {
  private readonly states = new Map<string, StoredTeamkillState>();

  constructor(readonly config: TeamkillProtectionConfig = DEFAULT_TEAMKILL_PROTECTION, private readonly storage?: StorageLike) {
    if (config.warningThreshold < 1 || config.disconnectThreshold <= config.warningThreshold || config.windowMilliseconds <= 0 ||
        config.cooldownMilliseconds <= 0) throw new Error("Invalid teamkill protection configuration.");
    this.load();
  }

  record(target: string, now = Date.now()): TeamkillProtectionResult {
    const state = this.state(target, now);
    state.events.push(now);
    const disconnect = state.events.length >= this.config.disconnectThreshold;
    if (disconnect) state.cooldownUntil = Math.max(state.cooldownUntil, now + this.config.cooldownMilliseconds);
    this.save();
    return {
      count: state.events.length,
      warn: state.events.length >= this.config.warningThreshold,
      disconnect,
      cooldownUntil: state.cooldownUntil,
    };
  }

  enforceCooldown(target: string, now = Date.now(), duration = this.config.cooldownMilliseconds): number {
    const state = this.state(target, now);
    state.cooldownUntil = Math.max(state.cooldownUntil, now + Math.max(1, duration));
    this.save();
    return state.cooldownUntil;
  }

  cooldownRemaining(target: string, now = Date.now()): number {
    return Math.max(0, this.state(target, now).cooldownUntil - now);
  }

  count(target: string, now = Date.now()): number {
    return this.state(target, now).events.length;
  }

  private state(target: string, now: number): StoredTeamkillState {
    const state = this.states.get(target) ?? { events: [], cooldownUntil: 0 };
    state.events = state.events.filter((timestamp) => timestamp > now - this.config.windowMilliseconds && timestamp <= now);
    if (state.cooldownUntil <= now) state.cooldownUntil = 0;
    this.states.set(target, state);
    return state;
  }

  private load(): void {
    if (!this.storage) return;
    try {
      const stored = JSON.parse(this.storage.getItem(STORAGE_KEY) ?? "{}") as Record<string, StoredTeamkillState>;
      for (const [target, state] of Object.entries(stored)) {
        if (!Array.isArray(state.events) || !state.events.every(Number.isFinite) || !Number.isFinite(state.cooldownUntil)) continue;
        this.states.set(target, { events: [...state.events], cooldownUntil: state.cooldownUntil });
      }
    } catch {}
  }

  private save(): void {
    if (!this.storage) return;
    try { this.storage.setItem(STORAGE_KEY, JSON.stringify(Object.fromEntries(this.states))); } catch {}
  }
}

export function browserTeamkillProtection(config: TeamkillProtectionConfig = DEFAULT_TEAMKILL_PROTECTION): TeamkillProtection {
  let storage: StorageLike | undefined;
  try { storage = globalThis.localStorage; } catch {}
  return new TeamkillProtection(config, storage);
}
