import { describe, expect, it } from "vitest";
import { MAT_CLIP, MAT_DEATH, MAT_GAMECLIP, MAT_GLASS, MAT_LAVA, MAT_NOCLIP, MAT_WATER } from "../material";
import type { OctreeCube, SauerMap, Vec3 } from "../octa";
import { OctreeCollisionWorld } from "./collision";
import { createInputState } from "./input";
import { PhysicsSimulation } from "../physics";
import { ClientState, createPlayer, PhysicsEntityType } from "./types";

describe("materials and mapmodel physics", () => {
  it("looks up indexed volumes and applies native water entry damping", () => {
    const map = mapWith(cube({ x: 0, y: 0, z: 0 }, 64, "empty", MAT_WATER + 2));
    const world = new OctreeCollisionWorld(map);
    expect(world.lookupMaterial({ x: 5, y: 5, z: 5 })).toBe(MAT_WATER + 2);
    const simulation = new PhysicsSimulation();
    simulation.setMap(map);
    simulation.spawn({ x: 8, y: 8, z: 20 }, 0, 0);
    simulation.player.velocity = { x: 80, y: 0, z: 0 };
    simulation.update(5, createInputState());
    expect(simulation.player.inWater).toBe(MAT_WATER);
    expect(simulation.player.velocity.x).toBeLessThan(10);
  });

  it("treats lava as liquid and death volumes as lethal", () => {
    const simulation = new PhysicsSimulation();
    simulation.setMap(mapWith(cube({ x: 0, y: 0, z: 0 }, 64, "empty", MAT_LAVA | MAT_DEATH)));
    simulation.spawn({ x: 8, y: 8, z: 20 }, 0, 0);
    simulation.update(5, createInputState());
    expect(simulation.player.inWater).toBe(MAT_LAVA);
    expect(simulation.player.clientState).toBe(ClientState.Dead);
  });

  it("filters noclip, clip, and gameclip like the native entity rules", () => {
    const direction = { x: 1, y: 0, z: 0 };
    const probe = (material: number, type = PhysicsEntityType.Player) => {
      const world = new OctreeCollisionWorld(mapWith(cube({ x: 8, y: 0, z: 0 }, 8, "empty", material)));
      const player = createPlayer({ x: 5, y: 4, z: 14 });
      player.entityType = type;
      return world.collide(player, direction);
    };
    expect(probe(MAT_NOCLIP)).toBeUndefined();
    expect(probe(MAT_CLIP)).toBeDefined();
    expect(probe(MAT_GAMECLIP)).toBeUndefined();
    expect(probe(MAT_GAMECLIP, PhysicsEntityType.Ai)).toBeDefined();
    expect(probe(MAT_CLIP, PhysicsEntityType.Camera)).toBeUndefined();
    expect(probe(MAT_GLASS | MAT_CLIP, PhysicsEntityType.Camera)).toBeDefined();
  });

  it("collides with native-style elliptical mapmodel definitions", () => {
    const world = new OctreeCollisionWorld(mapWith());
    world.setMapModels([{ entityIndex: 0, origin: { x: 10, y: 10, z: 0 }, yaw: 0, center: { x: 0, y: 0, z: 4 },
      radius: { x: 3, y: 3, z: 4 }, ellipse: true }]);
    const player = createPlayer({ x: 5, y: 10, z: 14 });
    const collision = world.collide(player, { x: 1, y: 0, z: 0 });
    expect(collision?.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("uses entity and model ellipse radii in their native yaw frames", () => {
    const world = new OctreeCollisionWorld(mapWith());
    world.setMapModels([{ entityIndex: 0, origin: { x: 10, y: 10, z: 0 }, yaw: 0, center: { x: 0, y: 0, z: 4 },
      radius: { x: 2, y: 5, z: 4 }, ellipse: true }]);
    const player = createPlayer({ x: 1.5, y: 10, z: 14 });
    player.radius = 1;
    player.xRadius = 1;
    player.yRadius = 4;

    expect(world.collide(player, { x: 1, y: 0, z: 0 })?.normal).toEqual({ x: -1, y: 0, z: 0 });
  });

  it("marks negative-Z positions out of world like moveplayer", () => {
    const simulation = new PhysicsSimulation();
    simulation.setMap(mapWith());
    simulation.spawn({ x: 0, y: 0, z: -1 }, 0, 0);
    simulation.update(5, createInputState());
    expect(simulation.player.clientState).toBe(ClientState.Dead);
  });
});

function cube(origin: Vec3, size: number, kind: OctreeCube["kind"], material: number): OctreeCube {
  return { origin, size, kind, material, edges: new Uint8Array(12), textures: [0, 0, 0, 0, 0, 0], merged: 0, surfaces: [] };
}

function mapWith(...world: OctreeCube[]): SauerMap {
  return {
    name: "material-fixture",
    header: { version: 33, headerSize: 0, worldSize: 64, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 },
    variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [], vslots: [], world, materialVolumes: [], lightmaps: [],
    bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}
