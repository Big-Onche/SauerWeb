import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { RegisteredMapEntity, SauerMap } from "../engine/octa";
import { computeTangents, isBotLocallySimulated, MapScene, setSauerCameraOrientation } from "./MapScene";

describe("Sauerbraten camera orientation", () => {
  it.each([[0, 0], [90, 0], [225, 35], [37, -48]])("matches Sauerbraten's right-handed direction at yaw %i pitch %i",
    (yaw, pitch) => {
      const engine = new NullEngine();
      const scene = new Scene(engine);
      scene.useRightHandedSystem = true;
      const camera = new UniversalCamera("camera", Vector3.Zero(), scene);
      const yawRadians = yaw * Math.PI / 180, pitchRadians = pitch * Math.PI / 180;
      const expected = new Vector3(-Math.sin(yawRadians) * Math.cos(pitchRadians), Math.sin(pitchRadians),
        Math.cos(yawRadians) * Math.cos(pitchRadians));

      setSauerCameraOrientation(camera, yaw, pitch);
      camera.getViewMatrix(true);

      expect(camera.getForwardRay().direction.equalsWithEpsilon(expected, 1e-6)).toBe(true);
      engine.dispose();
    });

  it.each([90, -90])("keeps a finite orthogonal camera frame at %i degree pitch", (pitch) => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);

    setSauerCameraOrientation(camera, 37, pitch);
    camera.getViewMatrix(true);
    const forward = camera.getForwardRay().direction;

    expect(forward.asArray().every(Number.isFinite)).toBe(true);
    expect(camera.upVector.asArray().every(Number.isFinite)).toBe(true);
    expect(Math.abs(Vector3.Dot(forward, camera.upVector))).toBeLessThan(1e-6);
    expect(camera.upVector.length()).toBeCloseTo(1, 6);
    engine.dispose();
  });

  it("retains yaw in the camera up axis while looking straight up", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    scene.useRightHandedSystem = true;
    const camera = new UniversalCamera("camera", Vector3.Zero(), scene);

    setSauerCameraOrientation(camera, 0, 90);
    camera.getViewMatrix(true);
    expect(camera.upVector.equalsWithEpsilon(new Vector3(0, 0, -1), 1e-6)).toBe(true);

    setSauerCameraOrientation(camera, 90, 90);
    camera.getViewMatrix(true);
    expect(camera.upVector.equalsWithEpsilon(new Vector3(1, 0, 0), 1e-6)).toBe(true);
    engine.dispose();
  });
});

describe("bot render ownership", () => {
  it("uses the live bot simulation for offline and locally owned bots", () => {
    expect(isBotLocallySimulated(-1, 0)).toBe(true);
    expect(isBotLocallySimulated(3, 3)).toBe(true);
    expect(isBotLocallySimulated(3, 7)).toBe(false);
  });
});

describe("network spawn groups", () => {
  it("does not fall back to another team's starts when the requested group is absent", () => {
    const starts = [1, 2].map((team, index): RegisteredMapEntity => ({
      index,
      position: { x: team * 10, y: 0, z: 0 },
      attributes: [0, team, 0, 0, 0],
      type: 3,
      typeName: "playerstart",
      category: "spawn",
      namedAttributes: {},
      orientation: { yawDegrees: 0 },
    }));
    const mapScene = Object.create(MapScene.prototype) as MapScene;
    Object.assign(mapScene, {
      currentMap: { entityRegistry: starts } as SauerMap,
      fpsClient: { multiplayer: { gameMode: 11, players: new Map(), ctfMode: { flags: [] }, captureMode: { bases: [] } } },
      physics: { player: { eyeHeight: 14 }, raycast: () => undefined },
    });

    const spawn = Reflect.apply(Reflect.get(mapScene, "chooseNetworkSpawn"), mapScene, [{ team: "" }]);

    expect(spawn).toBeUndefined();
  });
});

describe("water render targets", () => {
  it("hides water meshes while their reflection and refraction textures are bound", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const water = new Mesh("water", scene), world = new Mesh("world", scene);
    water.metadata = { materialKind: "water" };
    const mapScene = Object.create(MapScene.prototype) as MapScene;
    Object.assign(mapScene, { volumeMeshes: [water, world], waterRenderTargetHiddenMeshes: [], waterRenderTargetPassDepth: 0 });

    Reflect.apply(Reflect.get(mapScene, "beginWaterRenderTargetPass"), mapScene, []);
    expect(water.isEnabled()).toBe(false);
    expect(world.isEnabled()).toBe(true);

    Reflect.apply(Reflect.get(mapScene, "endWaterRenderTargetPass"), mapScene, []);
    expect(water.isEnabled()).toBe(true);
    expect(world.isEnabled()).toBe(true);
    engine.dispose();
  });
});

describe("computeTangents", () => {
  it("builds a right-handed tangent frame from world UVs", () => {
    const tangents = computeTangents(
      [0, 0, 0, 1, 0, 0, 0, 1, 0],
      [0, 0, 1, 0, 0, 1, 0, 0, 1],
      [0, 0, 1, 0, 0, 1],
      [0, 1, 2],
    );

    expect(tangents).toEqual([1, 0, 0, 1, 1, 0, 0, 1, 1, 0, 0, 1]);
  });
});

describe("entity diagnostics", () => {
  it("creates entity meshes only while the diagnostics are enabled", () => {
    const engine = new NullEngine();
    const scene = new Scene(engine);
    const entity: RegisteredMapEntity = {
      index: 0,
      position: { x: 1, y: 2, z: 3 },
      attributes: [0, 0, 0, 0, 0],
      type: 9,
      typeName: "ammo",
      category: "pickup",
      namedAttributes: {},
      orientation: { yawDegrees: 90 },
    };
    const mapScene = Object.create(MapScene.prototype) as MapScene;
    Object.assign(mapScene, {
      scene,
      entityDebug: false,
      entityMeshes: [],
      entityMaterials: new Map(),
      currentMap: { entityRegistry: [entity] } as SauerMap,
    });
    expect(scene.meshes).toHaveLength(0);
    mapScene.setEntityDebug(true);
    mapScene.setEntityDebug(true);
    expect(scene.meshes).toHaveLength(2);
    expect(scene.materials.some((material) => material.name === "entity-marker-pickup")).toBe(true);

    mapScene.setEntityDebug(false);
    expect(scene.meshes).toHaveLength(0);
    expect(scene.materials.filter((material) => material.name === "entity-marker-pickup" || material.name === "colorShader")).toEqual([]);
    engine.dispose();
  });
});
