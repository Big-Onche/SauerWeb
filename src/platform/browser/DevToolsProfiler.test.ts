import { afterEach, describe, expect, it, vi } from "vitest";
import { DevToolsProfiler, profileEnabled } from "./DevToolsProfiler";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("DevTools profiler", () => {
  it("is enabled exclusively by profile=1 without disturbing other URL parameters", () => {
    expect(profileEnabled("?map=complex&profile=1&mode=ffa")).toBe(true);
    expect(profileEnabled("?profile=0")).toBe(false);
    expect(profileEnabled("?profile=true")).toBe(false);
    expect(profileEnabled("")).toBe(false);
  });

  it("emits a fixed custom-track duration and closes it when the operation throws", () => {
    const timeStamp = vi.fn();
    vi.stubGlobal("console", { ...console, timeStamp });
    const profiler = new DevToolsProfiler("?profile=1");

    expect(() => profiler.measure("playerPhysics", () => { throw new Error("failure"); })).toThrow("failure");
    expect(timeStamp).toHaveBeenCalledOnce();
    expect(timeStamp).toHaveBeenCalledWith("Player movement / physics", expect.any(Number), expect.any(Number), "Physics", "SauerWeb", "secondary");
  });

  it("does not call timing APIs while disabled", () => {
    const timeStamp = vi.fn();
    vi.stubGlobal("console", { ...console, timeStamp });
    const profiler = new DevToolsProfiler("?profile=0");

    expect(profiler.measure("hud", () => 42)).toBe(42);
    expect(timeStamp).not.toHaveBeenCalled();
  });
});
