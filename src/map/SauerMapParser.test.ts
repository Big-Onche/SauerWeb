import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { generateGeometry } from "../render/geometry";
import { SauerMapParser } from "./SauerMapParser";

describe("SauerMapParser", () => {
  it.each(["aard3c", "triforts"])("decodes bundled v33 map %s through its octree", (mapName) => {
    const filePath = path.resolve(`.Sauerbraten/packages/base/${mapName}.ogz`);
    const bytes = zlib.gunzipSync(fs.readFileSync(filePath));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const map = new SauerMapParser().parse(buffer, mapName);

    expect(map.header.version).toBe(33);
    expect(map.header.worldSize).toBeGreaterThan(0);
    expect(map.world).toHaveLength(8);
    expect(map.bytesConsumedThroughOctree).toBeLessThanOrEqual(bytes.length);
    expect(map.lightmaps).toHaveLength(map.header.lightmapCount);
    expect(map.lightmaps.every((lightmap) => lightmap.width === 512 && lightmap.height === 512)).toBe(true);
    expect(map.bytesConsumed).toBeGreaterThanOrEqual(map.bytesConsumedThroughOctree);
    expect(map.entities.length).toBe(map.header.entityCount);
    visitSurfaces(map.world, (lightmapId) => {
      expect(lightmapId < 6 || lightmapId - 6 < map.lightmaps.length).toBe(true);
    });

    if (mapName === "aard3c") {
      const positions = generateGeometry(map).flatMap((batch) => batch.positions);
      let minimum = Number.POSITIVE_INFINITY;
      let maximum = Number.NEGATIVE_INFINITY;
      for (const coordinate of positions) {
        minimum = Math.min(minimum, coordinate);
        maximum = Math.max(maximum, coordinate);
      }
      expect(minimum).toBeGreaterThanOrEqual(0);
      expect(maximum).toBeLessThanOrEqual(map.header.worldSize);
    }
  });

  it("rejects non-map data with a descriptive error", () => {
    const bytes = new TextEncoder().encode("not a map");
    expect(() => new SauerMapParser().parse(bytes.buffer)).toThrow(/Unexpected end|Not a Sauerbraten map/);
  });
});

function visitSurfaces(cubes: import("./types").OctreeCube[], callback: (lightmapId: number) => void): void {
  cubes.forEach((cube) => {
    cube.surfaces.forEach((surface) => surface?.lightmapIds.forEach(callback));
    if (cube.children) visitSurfaces(cube.children, callback);
  });
}
