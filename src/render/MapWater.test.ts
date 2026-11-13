import { describe, expect, it } from "vitest";
import type { SauerMap } from "../engine/octa";
import { animatedWaterSurfaceHeight, resolveMapWater, underwaterFogBlend, WATER_AMPLITUDE, WATER_OFFSET } from "./MapWater";

describe("resolveMapWater", () => {
  it("uses native defaults and indexed OGZ variables", () => {
    const map = emptyMap();
    map.variables.push({ name: "water2colour", type: "integer", value: 0x204060 });
    map.variables.push({ name: "water2fog", type: "integer", value: 35 });
    map.variables.push({ name: "water2spec", type: "integer", value: 200 });

    const water = resolveMapWater(map);

    expect(water[0]).toMatchObject({ color: [linearByte(20), linearByte(70), linearByte(80)], fogDistance: 150, specular: 150 });
    expect(water[1]).toMatchObject({ color: [linearByte(32), linearByte(64), linearByte(96)], fogDistance: 35, specular: 200 });
  });

  it("lets map CFG values override values stored in the OGZ", () => {
    const map = emptyMap();
    map.variables.push({ name: "watercolour", type: "integer", value: 0x102030 });
    map.variables.push({ name: "waterfog", type: "integer", value: 20 });

    expect(resolveMapWater(map, { materials: [{ color: 0xa0b0c0, fogDistance: 80 }] })[0]).toMatchObject({
      color: [linearByte(160), linearByte(176), linearByte(192)],
      fogDistance: 80,
    });
  });

  it("places underwater fog against the rendered offset and animated surface", () => {
    const materialTop = 100;
    const flatSurface = animatedWaterSurfaceHeight(materialTop, 4, 4, 16, 0, false);

    expect(flatSurface).toBe(materialTop - WATER_OFFSET);
    expect(99.5 < flatSurface).toBe(false);
    expect(underwaterFogBlend(flatSurface, flatSurface + 0.01)).toBe(0);
    expect(underwaterFogBlend(flatSurface, flatSurface)).toBe(0);
    expect(underwaterFogBlend(flatSurface, flatSurface - 0.25)).toBeCloseTo(0.25);
    expect(underwaterFogBlend(flatSurface, flatSurface - 1)).toBe(1);
    for (let step = 0; step < 32; step++) {
      const surface = animatedWaterSurfaceHeight(materialTop, 4, 7, 16, step / 10, true);
      expect(surface).toBeGreaterThanOrEqual(materialTop - WATER_OFFSET - WATER_AMPLITUDE);
      expect(surface).toBeLessThanOrEqual(materialTop - WATER_OFFSET + WATER_AMPLITUDE);
    }
  });
});

function linearByte(value: number): number {
  const component = value / 255;
  return component <= 0.04045 ? component / 12.92 : ((component + 0.055) / 1.055) ** 2.4;
}

function emptyMap(): SauerMap {
  return {
    name: "synthetic",
    header: { version: 33, headerSize: 40, worldSize: 64, entityCount: 0, pvsCount: 0, lightmapCount: 0, hasBlendmap: false,
      variableCount: 0, vslotCount: 0 },
    variables: [], gameType: "fps", textureMru: [], entities: [], entityRegistry: [], vslots: [], world: [], materialVolumes: [],
    lightmaps: [], bytesConsumedThroughOctree: 0, bytesConsumed: 0,
  };
}
