import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import { WeaponEvents } from "../fpsgame/weapon/WeaponEvents";
import { Gun } from "../fpsgame/weapon/WeaponDefinitions";
import { explosionTexgenBasis, ParticleRenderer, sauerParticleColor, sauerParticleDiameter, sauerParticleOffset,
  sauerParticlePosition } from "./ParticleRenderer";

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

  it.each([
    [Gun.Rocket, "explosion.png"],
    [Gun.Grenade, "plasma.png"],
  ])("renders %s explosions as native-style shader spheres using %s", (gun, textureName) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const events = new WeaponEvents();
    const camera = new FreeCamera("camera", new Vector3(0, 0, -100), scene);
    scene.activeCamera = camera;
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);

    events.emit({ type: "explosion", gun, position: { x: 0, y: 0, z: 0 }, radius: 40 });
    const fireball = scene.getMeshByName("weapon-explosion-fireball");
    expect(fireball).not.toBeNull();
    expect(fireball!.billboardMode).toBe(0);
    expect(fireball!.getTotalVertices()).toBe(91);
    expect(fireball!.getTotalIndices()).toBe(360);
    expect(fireball!.scaling.asArray()).toEqual([4, 4, 4]);
    expect(fireball!.material).toBeInstanceOf(ShaderMaterial);
    expect(fireball!.material!.getActiveTextures()[0].name).toContain(textureName);
    expect((fireball!.material as ShaderMaterial).alphaMode).toBe(1);
    expect(() => scene.render()).not.toThrow();

    renderer.clear();
    engine.dispose();
  });

  it("builds explosion texture coordinates around the camera-to-fireball direction", () => {
    const center = new Vector3(8, 3, 12);
    const camera = new Vector3(-4, 7, -2);
    const basis = explosionTexgenBasis(center, camera, Vector3.Right(), Vector3.Up());
    const view = center.subtract(camera).normalize();

    expect(Vector3.Dot(basis.right, view)).toBeCloseTo(0);
    expect(Vector3.Dot(basis.up, view)).toBeCloseTo(0);
    expect(Vector3.Dot(basis.right, basis.up)).toBeCloseTo(0);
    expect(basis.right.length()).toBeCloseTo(1);
    expect(basis.up.length()).toBeCloseTo(1);
  });
});
