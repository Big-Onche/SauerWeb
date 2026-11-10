import { describe, expect, it } from "vitest";
import type { MapEntity } from "./types";
import { createFpsEntityRegistry, fpsEntityDefinition } from "./entities";

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

function entity(type: number, attributes: MapEntity["attributes"]): MapEntity {
  return { position: { x: 1, y: 2, z: 3 }, attributes, type };
}
