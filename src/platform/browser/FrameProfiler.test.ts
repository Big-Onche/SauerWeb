import { describe, expect, it } from "vitest";
import { FrameProfiler } from "./FrameProfiler";

describe("frame profiler", () => {
  it("records enabled phase and nested raycast samples, then resets at the frame boundary", () => {
    const profiler = new FrameProfiler();
    profiler.enabled = true;
    profiler.record("botAi", 4.5);
    profiler.recordRaycast(1.25);

    const frame = profiler.finishFrame();
    expect(frame.timings.botAi).toBe(4.5);
    expect(frame.timings.raycasts).toBe(1.25);
    expect(frame.raycastCount).toBe(1);
    expect(profiler.finishFrame().timings.botAi).toBe(0);
  });

  it("does not record or allocate mutable samples while disabled", () => {
    const profiler = new FrameProfiler();
    profiler.record("hud", 5);
    profiler.recordRaycast(2);

    const first = profiler.finishFrame();
    const second = profiler.finishFrame();
    expect(first).toBe(second);
    expect(first.timings.hud).toBe(0);
    expect(first.raycastCount).toBe(0);
  });
});
