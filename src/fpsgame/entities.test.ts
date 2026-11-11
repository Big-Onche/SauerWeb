import { describe, expect, it } from "vitest";
import type { MapEntity } from "../engine/octa";
import { PhysicsSimulation } from "../engine/physics";
import { PhysicsState } from "../engine/physics/types";
import { createFpsEntityRegistry, FpsEntities, fpsEntityDefinition, type EntityEffect } from "./entities";

describe("FPS entity registry", () => {
  it("contains every native Sauerbraten FPS entity definition", () => {
    expect(Array.from({ length: 31 }, (_, type) => fpsEntityDefinition(type)?.name)).toEqual([
      "empty", "light", "mapmodel", "playerstart", "envmap", "particles", "sound", "spotlight",
      "shells", "bullets", "rockets", "riflerounds", "grenades", "cartridges", "health", "healthboost", "greenarmour",
      "yellowarmour", "quaddamage", "teleport", "teledest", "monster", "carrot", "jumppad", "base", "respawnpoint", "box", "barrel",
      "platform", "elevator", "flag",
    ]);
  });

  it("names attributes while preserving raw values and orientation", () => {
    const [model, spawn] = createFpsEntityRegistry([entity(2, [135, 17, 4, 9, 1]), entity(3, [270, 2, 0, 0, 0])]);

    expect(model).toMatchObject({
      index: 0,
      typeName: "mapmodel",
      category: "mapmodel",
      mapModelIndex: 17,
      namedAttributes: { yaw: 135, modelIndex: 17, triggerType: 4, triggerTag: 9, attr5: 1 },
      orientation: { yawDegrees: 135 },
    });
    expect(model.attributes).toEqual([135, 17, 4, 9, 1]);
    expect(spawn.orientation?.yawDegrees).toBe(270);
  });

  it("decodes the signed jumppad push direction", () => {
    const [jumpPad] = createFpsEntityRegistry([entity(23, [8, -4, 3, 0, 0])]);

    expect(jumpPad.typeName).toBe("jumppad");
    expect(jumpPad.orientation?.direction).toBeDefined();
    expect(Math.hypot(...Object.values(jumpPad.orientation!.direction!))).toBeCloseTo(1);
  });
});

describe("FPS movement entities", () => {
  it("teleports to the matching tag and redirects horizontal speed when requested", () => {
    const physics = new PhysicsSimulation(), effects: EntityEffect[] = [];
    const entities = new FpsEntities(physics, { effect: (effect) => effects.push(effect) });
    entities.setMap(createFpsEntityRegistry([
      entity(19, [7, 0, 0, 0, 0], { x: 10, y: 20, z: 0 }),
      entity(20, [90, 7, 1, 0, 0], { x: 100, y: 200, z: 0 }),
    ]));
    physics.player.position = { x: 10, y: 20, z: physics.player.eyeHeight };
    physics.player.velocity = { x: 30, y: 40, z: 5 };

    entities.checkitems(1000);

    expect(physics.player.position).toEqual({ x: 100, y: 200, z: physics.player.eyeHeight });
    expect(physics.player.yaw).toBe(90);
    expect(physics.player.velocity.x).toBeCloseTo(-50);
    expect(physics.player.velocity.y).toBeCloseTo(0);
    expect(physics.player.velocity.z).toBe(5);
    expect(effects).toEqual([{ type: "teleport", teleport: 0, teledest: 1 }]);
  });

  it("applies the native signed jumppad vector and 300ms retrigger guard", () => {
    const physics = new PhysicsSimulation(), effects: EntityEffect[] = [];
    const entities = new FpsEntities(physics, { effect: (effect) => effects.push(effect) });
    entities.setMap(createFpsEntityRegistry([entity(23, [8, -4, 255, 0, 0], { x: 1, y: 2, z: 3 })]));
    physics.player.position = { x: 1, y: 2, z: 3 + physics.player.eyeHeight };
    physics.player.falling = { x: 1, y: 2, z: -30 };

    entities.checkitems(1000);
    entities.checkitems(1200);

    expect(physics.player.velocity).toEqual({ x: -10, y: -40, z: 100 });
    expect(physics.player.falling).toEqual({ x: 0, y: 0, z: 0 });
    expect(physics.player.physicsState).toBe(PhysicsState.Fall);
    expect(physics.player.timeInAir).toBe(1);
    expect(effects).toEqual([{ type: "jumppad", jumppad: 0 }]);
  });
});

function entity(type: number, attributes: MapEntity["attributes"], position = { x: 1, y: 2, z: 3 }): MapEntity {
  return { position, attributes, type };
}
