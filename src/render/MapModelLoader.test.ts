import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMd2 } from "./MapModelLoader";

describe("MD2 mapmodel loading", () => {
  it.each(["dcp/palmtree", "objects/well_roof", "objects/well_base"])('decodes the bundled model "%s"', (name) => {
    const bytes = fs.readFileSync(path.resolve(`.Sauerbraten/packages/models/${name}/tris.md2`));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const geometry = parseMd2(buffer);

    expect(geometry.meshes).toHaveLength(1);
    expect(geometry.meshes[0].positions.length).toBeGreaterThan(0);
    expect(geometry.meshes[0].uvs.length).toBe(geometry.meshes[0].positions.length / 3 * 2);
    expect(geometry.meshes[0].indices.length).toBeGreaterThan(0);
    expect(geometry.meshes[0].indices.length % 3).toBe(0);
  });
});
