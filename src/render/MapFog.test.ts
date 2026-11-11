import { describe, expect, it } from "vitest";
import type { SauerMap } from "../map/types";
import { createFogDomeGeometry, resolveMapFog } from "./MapFog";

describe("map fog", () => {
  it("resolves defaults, then OGZ variables, then CFG overrides", () => {
    const map = emptyMap();
    expect(resolveMapFog(map)).toMatchObject({ distance: 4000, start: 508, color: [128 / 255, 153 / 255, 179 / 255], domeMax: 0 });
    map.variables.push({ name: "fog", type: "integer", value: 800 });
    map.variables.push({ name: "fogcolour", type: "integer", value: 0x204060 });
    map.variables.push({ name: "fogdomemax", type: "float", value: 0.75 });
    map.variables.push({ name: "fogdomecolour", type: "integer", value: 0 });
    expect(resolveMapFog(map)).toMatchObject({ distance: 800, start: 108, color: [32 / 255, 64 / 255, 96 / 255],
      domeColor: [32 / 255, 64 / 255, 96 / 255], domeMax: 0.75 });
    expect(resolveMapFog(map, { distance: 1600, color: 0xffffff, domeMax: 1 })).toMatchObject({
      distance: 1600, start: 208, color: [1, 1, 1], domeMax: 1,
    });
  });

  it("builds a clipped, vertex-alpha dome and optional bottom cap", () => {
    const fog = resolveMapFog(emptyMap(), { domeMax: 1, domeMin: 0.25, domeClip: 0.5, domeHeight: 0, domeCap: 1 });
    const geometry = createFogDomeGeometry(fog, 2048, 8, 2);
    expect(geometry.positions).toHaveLength((3 * 8 + 1) * 3);
    expect(geometry.colors.slice(3, 4)).toEqual([0.25]);
    expect(geometry.colors.slice(2 * 8 * 4 + 3, 2 * 8 * 4 + 4)).toEqual([1]);
    expect(Math.min(...geometry.positions.filter((_value, index) => index % 3 === 1))).toBe(-1024);
  });
});

function emptyMap(): SauerMap {
  return {
    name: "test", header: { version: 33, headerSize: 40, worldSize: 1024, entityCount: 0, pvsCount: 0, lightmapCount: 0,
      hasBlendmap: false, variableCount: 0, vslotCount: 0 }, variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [],
    vslots: [], world: [], materialVolumes: [], lightmaps: [], bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}
