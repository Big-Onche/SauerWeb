import { describe, expect, it } from "vitest";
import type { SauerMap } from "../octa";
import { OctreeCollisionWorld, type MapModelCollision } from "./collision";
import { createPlayer } from "./types";

describe("mapmodel collision broad phase", () => {
  it("matches exhaustive collision and raycast results while preserving model order", () => {
    const models = fixtureModels();
    const indexed = worldWith(models);
    const exhaustive = worldWith(models);
    Reflect.set(exhaustive, "mapModelBroadphase", undefined);
    let seed = 0x5A17;
    const random = () => {
      seed = seed * 1664525 + 1013904223 >>> 0;
      return seed / 0x100000000;
    };

    for (let sample = 0; sample < 200; sample++) {
      const player = createPlayer({ x: random() * 640, y: random() * 640, z: 8 + random() * 80 });
      player.yaw = random() * 360;
      player.radius = 1 + random() * 5;
      player.xRadius = 1 + random() * 7;
      player.yRadius = 1 + random() * 7;
      const move = { x: random() * 2 - 1, y: random() * 2 - 1, z: random() * 2 - 1 };
      expect(indexed.collide(player, move)).toEqual(exhaustive.collide(player, move));

      const origin = { x: random() * 640, y: random() * 640, z: random() * 100 };
      const direction = normalized(random() * 2 - 1, random() * 2 - 1, random() * 2 - 1);
      const distance = 16 + random() * 900, radius = random() * 4;
      const expectedRay = exhaustive.raycast(origin, direction, distance, radius, sample % 2 === 0);
      expect(indexed.raycast(origin, direction, distance, radius, sample % 2 === 0),
        JSON.stringify({ sample, origin, direction, distance, radius }))
        .toEqual(expectedRay);
    }
  });

  it("rejects distant mapmodels before the narrow phase", () => {
    const models = fixtureModels();
    const world = worldWith(models);
    const player = createPlayer({ x: 8, y: 8, z: 14 });
    world.collide(player, { x: 1, y: 0, z: 0 });

    const candidates = Reflect.get(world, "mapModelCandidates") as number[];
    expect(candidates.length).toBeLessThan(models.length / 10);
  });
});

function fixtureModels(): MapModelCollision[] {
  return Array.from({ length: 400 }, (_, index) => {
    const x = index % 20, y = Math.floor(index / 20);
    return {
      entityIndex: index,
      origin: { x: x * 32 + 16, y: y * 32 + 16, z: index % 5 },
      yaw: index * 37 % 360,
      center: { x: index % 3 - 1, y: index % 7 / 3 - 1, z: 8 },
      radius: { x: 2 + index % 6, y: 2 + index % 9, z: 4 + index % 5 },
      ellipse: index % 3 === 0,
    };
  });
}

function worldWith(models: MapModelCollision[]): OctreeCollisionWorld {
  const world = new OctreeCollisionWorld(emptyMap());
  world.setMapModels(models);
  return world;
}

function emptyMap(): SauerMap {
  return {
    name: "broadphase-fixture",
    header: { version: 33, headerSize: 0, worldSize: 1024, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 },
    variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [], vslots: [], world: [], materialVolumes: [],
    lightmaps: [], bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}

function normalized(x: number, y: number, z: number): { x: number; y: number; z: number } {
  const length = Math.hypot(x, y, z) || 1;
  return { x: x / length, y: y / length, z: z / length };
}
