import { describe, expect, it } from "vitest";
import { DEFAULT_TEAMKILL_PROTECTION, TeamkillProtection } from "./teamkillProtection";

class MemoryStorage {
  private readonly values = new Map<string, string>();

  getItem(key: string): string | null { return this.values.get(key) ?? null; }
  setItem(key: string, value: string): void { this.values.set(key, value); }
}

describe("TeamkillProtection", () => {
  it("warns at two and disconnects at three confirmed teamkills in five minutes", () => {
    const protection = new TeamkillProtection();
    const target = "play.example:28785";

    expect(protection.record(target, 1_000)).toMatchObject({ count: 1, warn: false, disconnect: false });
    expect(protection.record(target, 2_000)).toMatchObject({ count: 2, warn: true, disconnect: false });
    expect(protection.record(target, 3_000)).toMatchObject({ count: 3, warn: true, disconnect: true });
    expect(protection.cooldownRemaining(target, 3_000)).toBe(DEFAULT_TEAMKILL_PROTECTION.cooldownMilliseconds);
  });

  it("uses a rolling window without resetting for map, team, or connection lifecycle events", () => {
    const protection = new TeamkillProtection();
    const target = "play.example:28785", window = DEFAULT_TEAMKILL_PROTECTION.windowMilliseconds;

    protection.record(target, 1_000);
    protection.record(target, 1_000 + window - 1);

    expect(protection.count(target, 1_000 + window)).toBe(1);
    expect(protection.record(target, 1_000 + window + 1)).toMatchObject({ count: 2, warn: true, disconnect: false });
  });

  it("persists events and reconnect cooldowns across client recreation", () => {
    const storage = new MemoryStorage(), target = "play.example:28785";
    const first = new TeamkillProtection(DEFAULT_TEAMKILL_PROTECTION, storage);
    first.record(target, 1_000);
    first.record(target, 2_000);
    first.record(target, 3_000);

    const restored = new TeamkillProtection(DEFAULT_TEAMKILL_PROTECTION, storage);

    expect(restored.count(target, 3_000)).toBe(3);
    expect(restored.cooldownRemaining(target, 3_000)).toBe(DEFAULT_TEAMKILL_PROTECTION.cooldownMilliseconds);
  });
});
