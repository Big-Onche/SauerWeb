import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseMd2 } from "../../engine/rendermodel";
import { flagModelPositions } from "./CtfRenderer";

describe("CTF flag rendering", () => {
  it("keeps the bundled flag upright in Babylon coordinates", () => {
    const bytes = fs.readFileSync(path.resolve(".Sauerbraten/packages/models/flags/tris.md2"));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const source = parseMd2(buffer).meshes[0];
    const positions = flagModelPositions(source.positions);
    const bounds = [axisExtent(positions, 0), axisExtent(positions, 1), axisExtent(positions, 2)];

    expect(bounds[1]).toBeGreaterThan(18);
    expect(bounds[1]).toBeGreaterThan(bounds[0] * 2);
    expect(bounds[1]).toBeGreaterThan(bounds[2] * 10);
  });
});

function axisExtent(positions: readonly number[], axis: number): number {
  const values: number[] = [];
  for (let index = axis; index < positions.length; index += 3) values.push(positions[index]);
  return Math.max(...values) - Math.min(...values);
}
