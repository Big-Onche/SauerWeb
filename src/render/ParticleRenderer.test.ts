import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera";
import { Constants } from "@babylonjs/core/Engines/constants";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it, vi } from "vitest";
import { WeaponEvents } from "../fpsgame/weapon/WeaponEvents";
import { Gun } from "../fpsgame/weapon/WeaponDefinitions";
import { combatGunsForMode, decalCapacityOpacity, explosionTexgenBasis, ParticleRenderer, sauerParticleColor, sauerParticleDiameter,
  sauerParticleOffset, sauerParticlePosition } from "./ParticleRenderer";

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

  it("fades oldest decals before the capacity limit evicts them", () => {
    expect(decalCapacityOpacity(0, 96, 128)).toBe(1);
    expect(decalCapacityOpacity(0, 128, 128)).toBe(0);
    expect(decalCapacityOpacity(13, 128, 128)).toBeCloseTo(13 / 25.6);
    expect(decalCapacityOpacity(26, 128, 128)).toBe(1);
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
    expect(scene.particleSystems).toHaveLength(0);
    expect(() => scene.render()).not.toThrow();

    renderer.clear();
    engine.dispose();
  });

  it("selects only mode-relevant combat shader variants", () => {
    expect(combatGunsForMode(3, true)).toEqual([Gun.Rifle]);
    expect(combatGunsForMode(-2, false)).toContain(Gun.Fireball);
    expect(combatGunsForMode(0, true)).not.toContain(Gun.Fireball);
  });

  it("shares one prepared explosion material across concurrent fireballs", () => {
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", new Vector3(0, 0, -100), scene);
    scene.activeCamera = camera;
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);

    events.emit({ type: "explosion", gun: Gun.Rocket, position: { x: 0, y: 0, z: 0 }, radius: 40 });
    events.emit({ type: "explosion", gun: Gun.Rocket, position: { x: 20, y: 0, z: 0 }, radius: 40 });
    const fireballs = scene.meshes.filter((mesh) => mesh.name === "weapon-explosion-fireball");
    expect(fireballs).toHaveLength(2);
    expect(fireballs[0].material).toBe(fireballs[1].material);
    expect(scene.materials.filter((material) => material.name === "weapon-explosion-red-material")).toHaveLength(1);

    renderer.clear();
    engine.dispose();
  });

  it("uses native gravity for gun-impact sparks", () => {
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);
    const splash = vi.spyOn(renderer as unknown as {
      splash: (position: { x: number; y: number; z: number }, texture: string, color: number, size: number, count: number,
               fadeMs: number, velocityRadius: number, gravity: number, additive?: boolean) => void;
    }, "splash");

    events.emit({
      type: "shot-effect", gun: Gun.Pistol, from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, rays: [],
    });

    expect(splash).toHaveBeenCalledWith({ x: 10, y: 0, z: 0 }, "spark.png", 0xb49b4b, 0.24, 200, 250, 150, 2, true);
    renderer.clear();
    engine.dispose();
  });

  it("projects bullet decals onto the map collision surface", () => {
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    scene.activeCamera = camera;
    const resolveSurface = vi.fn((_from, to) => ({ position: { ...to }, normal: { x: 0, y: 0, z: 1 } }));
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined, resolveSurface);

    events.emit({
      type: "shot-effect", gun: Gun.Pistol, from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, rays: [],
    });

    expect(resolveSurface).toHaveBeenCalledWith({ x: 0, y: 0, z: 0 }, { x: 10, y: 0, z: 0 });
    const decal = scene.getMeshByName("weapon-decal-bullet.png");
    expect(decal).not.toBeNull();
    expect(decal!.material!.getActiveTextures()[0].name).toContain("bullet.png");
    const material = decal!.material as ShaderMaterial;
    expect(material).toBeInstanceOf(ShaderMaterial);
    expect(material.alphaMode).toBe(Constants.ALPHA_MULTIPLY);
    expect(material.zOffset).toBe(-1);
    expect(material.zOffsetUnits).toBe(-4);
    renderer.clear();
    engine.dispose();
  });

  it("does not create decals when the setting is disabled", () => {
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    scene.activeCamera = camera;
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined,
      (_from, to) => ({ position: { ...to }, normal: { x: 0, y: 0, z: 1 } }));
    renderer.setDecalQuality(0);

    events.emit({
      type: "shot-effect", gun: Gun.Rifle, from: { x: 0, y: 0, z: 0 }, to: { x: 10, y: 0, z: 0 }, rays: [],
    });

    expect(scene.getMeshByName("weapon-decal-bullet.png")).toBeNull();
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

  it("renders rockets as keyed 3D model instances and disposes only the exact projectile", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/bouncers") return new Response(JSON.stringify([{
        index: 12, name: "projectiles/rocket", status: "ready", format: "OBJ", geometryPath: "rocket.obj", skins: [],
        scale: 1, reason: "",
      }]));
      if (url.includes("rocket.obj")) return new Response("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n");
      return new Response("not found", { status: 404 });
    });
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);
    const spawn = (key: string, y: number): void => events.emit({
      type: "projectile-spawned", key, gun: Gun.Rocket, id: 42, ownerId: key, local: false,
      position: { x: 0, y, z: 0 }, destination: { x: 64, y, z: 0 }, direction: { x: 1, y: 0, z: 0 },
      offset: { x: 0, y: 0, z: 0 }, offsetMillis: 0,
    });

    try {
      spawn("first:3:42", 0);
      spawn("second:3:42", 10);
      await vi.waitFor(() => expect(scene.meshes.filter((mesh) => mesh.name.startsWith("weapon-projectile-")).length).toBe(2));
      const first = scene.meshes.find((mesh) => mesh.name.startsWith("weapon-projectile-first:3:42"));
      expect(first?.billboardMode).toBe(0);
      expect(first?.position.asArray()).toEqual([3, 0, 0]);

      events.emit({ type: "explosion", gun: Gun.Rocket, position: { x: 0, y: 10, z: 0 }, radius: 40 });
      expect(scene.meshes.filter((mesh) => mesh.name.startsWith("weapon-projectile-")).length).toBe(2);
      events.emit({ type: "projectile-removed", key: "second:3:42" });
      expect(scene.meshes.filter((mesh) => mesh.name.startsWith("weapon-projectile-")).length).toBe(1);
    } finally {
      renderer.clear();
      engine.dispose();
      fetchMock.mockRestore();
    }
  });

  it("reuses pooled bouncer instances with shared geometry and reset transforms", async () => {
    const fetchMock = vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input);
      if (url === "/api/bouncers") return new Response(JSON.stringify([{
        index: 1, name: "gibs/gib01", status: "ready", format: "OBJ", geometryPath: "gib.obj", skins: [], scale: 1, reason: "",
      }]));
      if (url.includes("gib.obj")) return new Response("v 0 0 0\nv 1 0 0\nv 0 1 0\nvt 0 0\nvt 1 0\nvt 0 1\nf 1/1 2/2 3/3\n");
      return new Response("not found", { status: 404 });
    });
    const engine = new NullEngine(), scene = new Scene(engine), events = new WeaponEvents();
    const camera = new FreeCamera("camera", Vector3.Zero(), scene);
    const renderer = new ParticleRenderer(scene, events, camera, () => undefined);
    renderer.loadMap([]);
    const spawn = (key: string, position: { x: number; y: number; z: number }): void => events.emit({
      type: "bouncer-spawned", key, id: 1, ownerId: "owner", bouncerType: 1, position,
      velocity: { x: 0, y: 0, z: 0 }, variant: 0,
    });

    try {
      spawn("first", { x: 1, y: 2, z: 3 });
      await vi.waitFor(() => expect(scene.meshes.some((mesh) => mesh.name.startsWith("bouncer-first"))).toBe(true));
      events.emit({
        type: "bouncer-moved", key: "first", position: { x: 4, y: 5, z: 6 }, velocity: { x: 0, y: 0, z: 0 },
        yaw: 20, roll: 30, smoke: false, fade: 0.5,
      });
      scene.render();
      const first = scene.meshes.find((mesh) => mesh.name.startsWith("bouncer-first"))!;
      const firstId = first.uniqueId;
      expect(first.getClassName()).toBe("InstancedMesh");
      expect(first.position.asArray()).toEqual([4, 6, 5]);
      expect(first.instancedBuffers.color.a).toBe(0.5);

      events.emit({ type: "bouncer-removed", key: "first" });
      spawn("second", { x: 8, y: 9, z: 10 });
      await vi.waitFor(() => expect(scene.meshes.some((mesh) => mesh.name.startsWith("bouncer-second"))).toBe(true));
      scene.render();
      const second = scene.meshes.find((mesh) => mesh.name.startsWith("bouncer-second"))!;
      expect(second.uniqueId).toBe(firstId);
      expect(second.scaling.asArray()).toEqual([1, 1, 1]);
      expect(second.instancedBuffers.color.a).toBe(1);
    } finally {
      renderer.clear();
      engine.dispose();
      fetchMock.mockRestore();
    }
  });
});
