import { describe, expect, it } from "vitest";
import { hudGunShootAnimationPosition } from "./WeaponRenderer";

describe("Sauerbraten HUD-gun animation", () => {
  it("uses attackdelay / 17 as the native fallback frame time", () => {
    const middle = hudGunShootAnimationPosition(30, 500, 1_000);
    expect(middle.frame).toBe(8);
    expect(middle.nextFrame).toBe(9);
    expect(middle.interpolation).toBeCloseTo(28 / 59);
    const ending = hudGunShootAnimationPosition(30, 999, 1_000);
    expect(ending.frame).toBe(16);
    expect(ending.nextFrame).toBe(17);
    expect(ending.interpolation).toBeCloseTo(55 / 59);
  });

  it("prefers the configured md5anim speed and clamps while the weapon remains in its attack delay", () => {
    expect(hudGunShootAnimationPosition(30, 100, 1_000, 50)).toEqual({ frame: 5, nextFrame: 6, interpolation: 0 });
    expect(hudGunShootAnimationPosition(8, 900, 1_000, 50)).toEqual({ frame: 7, nextFrame: 7, interpolation: 0 });
  });

  it("clamps short non-looping shoot animations at their final frame", () => {
    const ending = hudGunShootAnimationPosition(8, 900, 1_000);
    expect(ending.frame).toBe(7);
    expect(ending.nextFrame).toBe(7);
    expect(ending.interpolation).toBeCloseTo(15 / 59);
  });
});
