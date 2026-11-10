import { describe, expect, it } from "vitest";
import type { OctreeCube, SauerMap, Vec3 } from "../map/types";
import { OctreeCollisionWorld } from "./collision";
import { GroundMover } from "./ground";
import { createInputState } from "./input";
import { PhysicsSimulation } from "./simulation";
import { createPlayer, PhysicsState } from "./types";

describe("advanced ground movement", () => {
  it("holds an idle player on decoded octree ground", () => {
    const simulation = new PhysicsSimulation();
    simulation.setMap(mapWith(solid({ x: 0, y: 0, z: 0 }, 16)));
    simulation.spawn({ x: 8, y: 8, z: 30 }, 0, 0);
    for (let time = 5; time <= 1000; time += 5) simulation.update(time, createInputState());
    expect(simulation.player.position.z).toBeCloseTo(30, 5);
    expect(simulation.player.physicsState).toBe(PhysicsState.Floor);
    expect(simulation.player.timeInAir).toBe(0);
  });

  it("steps smoothly up geometry within STAIRHEIGHT", () => {
    const world = new OctreeCollisionWorld(mapWith(
      solid({ x: 0, y: 0, z: 0 }, 16),
      solid({ x: 16, y: 0, z: 4 }, 16),
    ));
    const mover = new GroundMover(world);
    const player = createPlayer({ x: 11.8, y: 8, z: 30 });
    player.physicsState = PhysicsState.Floor;
    player.floor = { x: 0, y: 0, z: 1 };
    expect(mover.move(player, { x: 1, y: 0, z: 0 })).toBe(true);
    expect(player.position.z).toBeGreaterThan(30);
    expect(player.position.z).toBeLessThan(31);
    expect(player.position.x).toBeGreaterThan(11.8);
    expect(player.physicsState).toBe(PhysicsState.StepUp);
  });

  it("preserves tangential speed while projecting velocity along walls", () => {
    const world = new OctreeCollisionWorld(mapWith(
      solid({ x: 0, y: 0, z: 0 }, 16),
      solid({ x: 16, y: 0, z: 8 }, 16),
    ));
    const mover = new GroundMover(world);
    const player = createPlayer({ x: 11.8, y: 8, z: 30 });
    player.physicsState = PhysicsState.Fall;
    player.velocity = { x: 100, y: 20, z: 0 };
    expect(mover.move(player, { x: 1, y: 0.2, z: 0 })).toBe(false);
    expect(player.position.x).toBeCloseTo(11.8);
    expect(player.velocity.x).toBeCloseTo(0);
    expect(player.velocity.y).toBeCloseTo(20);
  });

  it("adheres to a descending stair without an airborne frame", () => {
    const world = new OctreeCollisionWorld(mapWith(
      solid({ x: 0, y: 0, z: 4 }, 16),
      ...Array.from({ length: 12 }, (_, index) => solid({ x: 16 + index * 16, y: 0, z: 0 }, 16)),
    ));
    const mover = new GroundMover(world);
    const player = createPlayer({ x: 20.2, y: 8, z: 34 });
    player.physicsState = PhysicsState.Floor;
    player.floor = { x: 0, y: 0, z: 1 };
    player.move = 1;
    expect(mover.move(player, { x: 0.1, y: 0, z: 0 })).toBe(true);
    expect(player.position.z).toBeLessThan(34);
    expect(player.position.z).toBeGreaterThan(33.9);
    expect(player.physicsState).toBe(PhysicsState.StepDown);
    expect(player.timeInAir).toBe(0);
  });

  it("returns and classifies the original normal of a steep deformed incline", () => {
    const ramp = solid({ x: 0, y: 0, z: 0 }, 16);
    ramp.kind = "normal";
    ramp.edges[8] = 0x80;
    ramp.edges[9] = 0x00;
    ramp.edges[10] = 0x80;
    ramp.edges[11] = 0x00;
    const world = new OctreeCollisionWorld(mapWith(ramp));
    const player = createPlayer({ x: 8, y: 8, z: 20.7 });
    const collision = world.collide(player, { x: 0, y: 0, z: -0.1 }, 0.5);
    expect(collision).toBeDefined();
    expect(collision!.normal.z).toBeCloseTo(Math.SQRT1_2, 5);
    expect(collision!.normal.z).toBeGreaterThan(0.5);
    expect(collision!.normal.z).toBeLessThan(0.867);
  });
});

function solid(origin: Vec3, size: number): OctreeCube {
  return {
    origin,
    size,
    kind: "solid",
    edges: new Uint8Array(12).fill(0x80),
    textures: [0, 0, 0, 0, 0, 0],
    material: 0,
    merged: 0,
    surfaces: [],
  };
}

function mapWith(...world: OctreeCube[]): SauerMap {
  return {
    name: "physics-fixture",
    header: { version: 33, headerSize: 0, worldSize: 64, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 },
    variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [], vslots: [], world, materialVolumes: [], lightmaps: [],
    bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}
