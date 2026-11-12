import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { WeaponEvents } from "../fpsgame/weapon/WeaponEvents";
import { Gun } from "../fpsgame/weapon/WeaponDefinitions";
import { ParticleRenderer, sauerParticleColor, sauerParticleDiameter, sauerParticleOffset, sauerParticlePosition } from "./ParticleRenderer";

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

  it("shares textures and material configurations across repeated weapon effects", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);
    const shot = {
      type: "shot-effect" as const,
      gun: Gun.Pistol,
      from: { x: 0, y: 0, z: 0 },
      to: { x: 10, y: 0, z: 0 },
      rays: [],
    };

    events.emit(shot);
    const textureCount = scene.textures.length;
    const materialCount = scene.materials.length;
    events.emit(shot);

    expect(textureCount).toBeGreaterThan(0);
    expect(scene.textures).toHaveLength(textureCount);
    expect(scene.materials).toHaveLength(materialCount);

    renderer.clear();
    expect(scene.textures).toHaveLength(0);
    expect(scene.materials.every((material) => material.name === "default material")).toBe(true);
    engine.dispose();
  });
});
