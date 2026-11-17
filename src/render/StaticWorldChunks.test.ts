import { describe, expect, it } from "vitest";
import type { GeometryBatch } from "../engine/renderva";
import { buildStaticWorldChunks, staticChunkId } from "./StaticWorldChunks";

describe("static world chunks", () => {
  it("clips crossing triangles without changing their total visible area", () => {
    const chunks = buildStaticWorldChunks([triangleBatch()], 8, true);

    expect(chunks.map((chunk) => chunk.chunkId).sort()).toEqual(["0:0:0", "1:0:0"]);
    expect(chunks.every((chunk) => chunk.positions.every((value, index) => index % 3 !== 0 ||
      value >= chunk.chunk.x * 8 - 1e-6 && value <= (chunk.chunk.x + 1) * 8 + 1e-6))).toBe(true);
    expect(chunks.reduce((sum, chunk) => sum + batchArea(chunk), 0)).toBeCloseTo(32);
  });

  it("interpolates UV, lightmap and color attributes at chunk planes", () => {
    const chunks = buildStaticWorldChunks([triangleBatch()], 8, true);
    const boundaryVertices = chunks.flatMap((chunk) => chunk.positions.map((x, index) => ({ chunk, x, index }))
      .filter(({ x, index }) => index % 3 === 0 && Math.abs(x - 8) < 1e-6));

    expect(boundaryVertices.length).toBeGreaterThan(0);
    for (const { chunk, index } of boundaryVertices) {
      const vertex = index / 3;
      expect(chunk.uvs[vertex * 2]).toBeCloseTo(0.5);
      expect(chunk.uv2s[vertex * 2]).toBeCloseTo(0.5);
      expect(chunk.colors[vertex * 4]).toBeCloseTo(0.5);
    }
  });

  it("uses native Sauer coordinates when assigning mapmodels", () => {
    expect(staticChunkId({ x: 255, y: 128, z: 0 }, 128)).toBe("1:1:0");
  });
});

function triangleBatch(): GeometryBatch {
  return {
    name: "crossing", textureIndex: 1, cubeMaterial: 0, lightmapId: 2, useLightmapAlpha: false,
    positions: [4, 0, 0, 12, 0, 0, 4, 8, 0], indices: [0, 1, 2],
    uvs: [0, 0, 1, 0, 0, 1], uv2s: [0, 0, 1, 0, 0, 1],
    colors: [0, 1, 1, 1, 1, 1, 1, 1, 0, 1, 1, 1], faceCount: 1,
  };
}

function batchArea(batch: GeometryBatch): number {
  let area = 0;
  for (let index = 0; index < batch.indices.length; index += 3) {
    const a = position(batch, batch.indices[index]), b = position(batch, batch.indices[index + 1]);
    const c = position(batch, batch.indices[index + 2]);
    area += Math.abs((b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])) / 2;
  }
  return area;
}

function position(batch: GeometryBatch, index: number): [number, number] {
  return [batch.positions[index * 3], batch.positions[index * 3 + 1]];
}
