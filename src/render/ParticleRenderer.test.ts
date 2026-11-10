import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { describe, expect, it } from "vitest";
import { sauerParticleColor, sauerParticleDiameter, sauerParticleOffset, sauerParticlePosition } from "./ParticleRenderer";

describe("Sauerbraten particle entity helpers", () => {
  it("bundles Babylon's particle shaders instead of requesting them as runtime URLs", () => {
    expect(ShaderStore.ShadersStore.particlesVertexShader).toContain("void main");
    expect(ShaderStore.ShadersStore.particlesPixelShader).toContain("void main");
  });

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

  it("converts Sauerbraten half-extents to Babylon particle widths", () => {
    expect(sauerParticleDiameter(0.24)).toBeCloseTo(0.48);
    expect(sauerParticleDiameter(2.4)).toBeCloseTo(4.8);
  });

  it("uses the native analytic velocity and gravity equation", () => {
    const origin = { x: 10, y: 20, z: 30 };
    expect(sauerParticlePosition(origin, { x: 50, y: -25, z: 100 }, -20, 500)).toEqual({ x: 15, y: 17.5, z: 41.25 });
    expect(sauerParticlePosition(origin, { x: 50, y: -25, z: 100 }, 20, 500)).toEqual({ x: 15, y: 17.5, z: 38.75 });
    expect(sauerParticlePosition(origin, { x: 50, y: -25, z: 100 }, 0, 500)).toEqual(origin);
  });
});
