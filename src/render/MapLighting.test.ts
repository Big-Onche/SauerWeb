import { describe, expect, it } from "vitest";
import type { SauerMap } from "../map/types";
import { DEFAULT_MAP_LIGHTING, expandSauerColor, resolveMapLighting, sauerColorBytes } from "./MapLighting";

describe("map lighting", () => {
  it("resolves defaults, then OGZ variables, then CFG overrides", () => {
    const map = emptyMap();
    expect(resolveMapLighting(map)).toEqual(DEFAULT_MAP_LIGHTING);

    map.variables.push({ name: "ambient", type: "integer", value: 0x102030 });
    map.variables.push({ name: "skylight", type: "integer", value: 0x405060 });
    expect(resolveMapLighting(map)).toEqual({ ambient: 0x102030, skylight: 0x405060 });
    expect(resolveMapLighting(map, { ambient: 0x708090, skylight: 0xa0b0c0 })).toEqual({
      ambient: 0x708090,
      skylight: 0xa0b0c0,
    });
  });

  it("expands scalar colors exactly like Sauerbraten's HVAR callbacks", () => {
    expect(expandSauerColor(25)).toBe(0x191919);
    expect(sauerColorBytes(0x123456)).toEqual([0x12, 0x34, 0x56]);
  });
});

function emptyMap(): SauerMap {
  return {
    name: "test",
    header: {
      version: 33, headerSize: 40, worldSize: 1024, entityCount: 0, pvsCount: 0, lightmapCount: 0, hasBlendmap: false,
      variableCount: 0, vslotCount: 0,
    },
    variables: [],
    gameType: "fps",
    textureMru: [],
    entities: [],
    vslots: [],
    world: [],
    lightmaps: [],
    bytesConsumedThroughOctree: 0,
    bytesConsumed: 0,
  };
}
