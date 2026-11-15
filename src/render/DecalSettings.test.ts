import { beforeEach, describe, expect, it, vi } from "vitest";
import { DECAL_QUALITY_SETTINGS, decalQualityLabel, loadDecalQuality, saveDecalQuality } from "./DecalSettings";

describe("decal quality settings", () => {
  let values: Map<string, string>;

  beforeEach(() => {
    values = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
      clear: () => values.clear(),
    });
  });

  it("defaults to high and persists valid levels", () => {
    expect(loadDecalQuality()).toBe(3);
    saveDecalQuality(1);
    expect(loadDecalQuality()).toBe(1);
  });

  it("uses the requested distance and capacity tiers", () => {
    expect(Object.values(DECAL_QUALITY_SETTINGS).map(({ distance, maximum }) => [distance, maximum])).toEqual([
      [0, 0], [256, 128], [512, 256], [768, 512], [1024, 1024],
    ]);
    expect(decalQualityLabel(0)).toBe("disabled");
    expect(decalQualityLabel(4)).toBe("ultra");
  });

  it("falls back to high for invalid persisted data", () => {
    values.set("sauerweb.decal-quality", "9");
    expect(loadDecalQuality()).toBe(3);
  });
});
