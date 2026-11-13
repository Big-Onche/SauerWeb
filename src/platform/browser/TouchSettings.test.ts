import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeTouchSettings, touchControlsWanted } from "./TouchSettings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("touch control settings", () => {
  it("honors manual control type overrides", () => {
    expect(touchControlsWanted({ controlType: "touch", sensitivity: 100 })).toBe(true);
    expect(touchControlsWanted({ controlType: "desktop", sensitivity: 100 })).toBe(false);
  });

  it("enables automatic controls for a compact touch viewport", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 5 });
    vi.stubGlobal("window", { innerWidth: 844, innerHeight: 390 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    expect(touchControlsWanted({ controlType: "auto", sensitivity: 100 })).toBe(true);
  });

  it("leaves automatic controls off for a large fine-pointer display", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 1080 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    expect(touchControlsWanted({ controlType: "auto", sensitivity: 100 })).toBe(false);
  });

  it("sanitizes persisted sensitivity and control type values", () => {
    expect(sanitizeTouchSettings({ controlType: "touch", sensitivity: 999 })).toEqual({ controlType: "touch", sensitivity: 200 });
    expect(sanitizeTouchSettings({ sensitivity: Number.NaN })).toEqual({ controlType: "auto", sensitivity: 100 });
  });
});
