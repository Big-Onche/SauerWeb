import { NullEngine } from "@babylonjs/core/Engines/nullEngine";
import { Scene } from "@babylonjs/core/scene";
import { describe, expect, it } from "vitest";
import type { RegisteredMapEntity, SauerMap } from "../engine/octa";
import { computeTangents, MapScene } from "./MapScene";

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
