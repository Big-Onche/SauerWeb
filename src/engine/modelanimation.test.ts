import { describe, expect, it } from "vitest";
import { modelAnimationFrame, modelAnimationSpeed } from "./modelanimation";

describe("model animation timing", () => {
  it("uses Sauerbraten's 10 FPS default when config speed is zero or omitted", () => {
    expect(modelAnimationSpeed(0)).toBe(10);
    expect(modelAnimationSpeed(-1)).toBe(10);
    expect(modelAnimationFrame(30, 0, 500, true)).toBe(5);
  });

  it("uses the configured player animation speed as FPS", () => {
    expect(modelAnimationFrame(200, 125, 500, true)).toBe(62);
    expect(modelAnimationFrame(200, 115, 500, true)).toBe(57);
  });

  it("loops and clamps frames like animpos::setframes", () => {
    expect(modelAnimationFrame(10, 20, 600, true)).toBe(2);
    expect(modelAnimationFrame(10, 20, 600, false)).toBe(9);
  });

  it("applies the configured frame offsets before looping", () => {
    expect(modelAnimationFrame(10, 10, 900, true, 0, -1)).toBe(0);
    expect(modelAnimationFrame(10, 10, 0, true, 2, -1)).toBe(2);
    expect(modelAnimationFrame(10, 10, 700, false, 2, -1)).toBe(8);
  });
});
