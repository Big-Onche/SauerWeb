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
    expect(map.entities.length).toBe(map.header.entityCount);

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
