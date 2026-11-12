import { describe, expect, it } from "vitest";
import { hudGunShootAnimationPosition } from "./WeaponRenderer";

describe("Sauerbraten HUD-gun animation", () => {
  it("plays seventeen shoot-animation frames across the weapon attack delay", () => {
    expect(hudGunShootAnimationPosition(30, 500, 1_000)).toEqual({ frame: 8, nextFrame: 9, interpolation: 0.5 });
    const ending = hudGunShootAnimationPosition(30, 999, 1_000);
    expect(ending.frame).toBe(16);
    expect(ending.nextFrame).toBe(17);
    expect(ending.interpolation).toBeCloseTo(0.983);
  });

  it("clamps short non-looping shoot animations at their final frame", () => {
    const ending = hudGunShootAnimationPosition(8, 900, 1_000);
    expect(ending.frame).toBe(7);
    expect(ending.nextFrame).toBe(7);
    expect(ending.interpolation).toBeCloseTo(0.3);
  });
});
