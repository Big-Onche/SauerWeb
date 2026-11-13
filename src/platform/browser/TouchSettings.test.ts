import { afterEach, describe, expect, it, vi } from "vitest";
import { sanitizeTouchSettings, touchControlsWanted } from "./TouchSettings";

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("touch control settings", () => {
  it("honors manual control type overrides", () => {
    expect(touchControlsWanted({ controlType: "touch", mouseSensitivity: 100, touchSensitivity: 250 })).toBe(true);
    expect(touchControlsWanted({ controlType: "desktop", mouseSensitivity: 100, touchSensitivity: 250 })).toBe(false);
  });

  it("enables automatic controls for a compact touch viewport", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 5 });
    vi.stubGlobal("window", { innerWidth: 844, innerHeight: 390 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    expect(touchControlsWanted({ controlType: "auto", mouseSensitivity: 100, touchSensitivity: 250 })).toBe(true);
  });

  it("leaves automatic controls off for a large fine-pointer display", () => {
    vi.stubGlobal("navigator", { maxTouchPoints: 0 });
    vi.stubGlobal("window", { innerWidth: 1920, innerHeight: 1080 });
    vi.stubGlobal("matchMedia", () => ({ matches: false }));

    expect(touchControlsWanted({ controlType: "auto", mouseSensitivity: 100, touchSensitivity: 250 })).toBe(false);
  });

  it("sanitizes persisted sensitivity and control type values", () => {
    expect(sanitizeTouchSettings({ controlType: "touch", mouseSensitivity: 999, touchSensitivity: 0 })).toMatchObject({
      controlType: "touch", mouseSensitivity: 300, touchSensitivity: 25,
    });
    expect(sanitizeTouchSettings({ mouseSensitivity: Number.NaN, touchSensitivity: Number.NaN })).toMatchObject({
      controlType: "auto", mouseSensitivity: 100, touchSensitivity: 250,
    });
  });

  it("migrates the old default touch sensitivity to the faster default", () => {
    expect(sanitizeTouchSettings({ controlType: "touch", sensitivity: 100 })).toMatchObject({
      controlType: "touch", mouseSensitivity: 100, touchSensitivity: 250,
    });
    expect(sanitizeTouchSettings({ controlType: "touch", sensitivity: 140 })).toMatchObject({
      controlType: "touch", mouseSensitivity: 100, touchSensitivity: 140,
    });
  });
});
