import { describe, expect, it } from "vitest";
import { sauerParticleColor, sauerParticleOffset } from "./ParticleRenderer";

describe("Sauerbraten particle entity helpers", () => {
  it("expands packed entity colors exactly like colorfromattr", () => {
    expect(sauerParticleColor(0x000)).toBe(0x0f0f0f);
    expect(sauerParticleColor(0xf00)).toBe(0xff0f0f);
    expect(sauerParticleColor(0x0f0)).toBe(0x0fff0f);
    expect(sauerParticleColor(0x00f)).toBe(0x0f0fff);
    expect(sauerParticleColor(0xabc)).toBe(0xafbfcf);
  });

  it("uses Sauerbraten's six directional offsets", () => {
    const origin = { x: 10, y: 20, z: 30 };
    expect(sauerParticleOffset(origin, 0, 5)).toEqual({ x: 10, y: 20, z: 35 });
    expect(sauerParticleOffset(origin, 1, 5)).toEqual({ x: 15, y: 20, z: 30 });
    expect(sauerParticleOffset(origin, 2, 5)).toEqual({ x: 10, y: 25, z: 30 });
    expect(sauerParticleOffset(origin, 3, 5)).toEqual({ x: 10, y: 20, z: 25 });
    expect(sauerParticleOffset(origin, 4, 5)).toEqual({ x: 5, y: 20, z: 30 });
    expect(sauerParticleOffset(origin, 5, 5)).toEqual({ x: 10, y: 15, z: 30 });
  });
});
