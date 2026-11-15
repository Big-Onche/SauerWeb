import { describe, expect, it } from "vitest";
import type { SauerMap } from "../octa";
import { OctreeCollisionWorld } from "./collision";
import { createPlayer } from "./types";

describe("Sauerbraten dynamic entity collision", () => {
  it("runs plcollide after world collision and blocks two approaching players", () => {
    const world = emptyWorld(), player = createPlayer({ x: 10, y: 10, z: 14 });
    const other = createPlayer({ x: 17, y: 10, z: 14 });
    Object.defineProperty(other, "id", { value: "other" });
    world.setDynamicEntities(() => [player, other]);

    const collision = world.collide(player, { x: 1, y: 0, z: 0 });
    expect(collision?.normal.x).toBeCloseTo(-1);
    expect(collision?.normal.y).toBeCloseTo(0);
    expect(collision?.normal.z).toBeCloseTo(0);
  });

  it("allows an overlapping player to move out, as native direction filtering does", () => {
    const world = emptyWorld(), player = createPlayer({ x: 10, y: 10, z: 14 });
    const other = createPlayer({ x: 17, y: 10, z: 14 });
    Object.defineProperty(other, "id", { value: "other" });
    world.setDynamicEntities(() => [player, other]);

    expect(world.collide(player, { x: -1, y: 0, z: 0 })).toBeUndefined();
  });

  it("ignores dead entities and entities without vertical overlap", () => {
    const world = emptyWorld(), player = createPlayer({ x: 10, y: 10, z: 14 });
    const dead = createPlayer({ x: 17, y: 10, z: 14 }), overhead = createPlayer({ x: 10, y: 10, z: 30 });
    Object.defineProperty(dead, "id", { value: "dead" });
    Object.defineProperty(overhead, "id", { value: "overhead" });
    dead.alive = false;
    world.setDynamicEntities(() => [player, dead, overhead]);

    expect(world.collide(player, { x: 1, y: 0, z: 0 })).toBeUndefined();
  });
});

function emptyWorld(): OctreeCollisionWorld {
  const map: SauerMap = {
    name: "dynamic-collision-fixture",
    header: { version: 33, headerSize: 0, worldSize: 1024, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 },
    variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [], vslots: [], world: [], materialVolumes: [],
    lightmaps: [], bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
  return new OctreeCollisionWorld(map);
}
