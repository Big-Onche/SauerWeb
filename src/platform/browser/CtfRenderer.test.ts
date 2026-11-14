import fs from "node:fs";
import path from "node:path";
import { Material } from "@babylonjs/core/Materials/material";
import { describe, expect, it } from "vitest";
import { loadSauerbratenDirectory } from "../../../sauerbratenDirectory";
import { parseMd2 } from "../../engine/rendermodel";
import { FLAG_TRANSPARENCY_MODE, flagModelPositions, flagVisibility } from "./CtfRenderer";

const sauerbratenDirectory = loadSauerbratenDirectory("test");

describe("CTF flag rendering", () => {
  it("keeps the bundled flag upright in Babylon coordinates", () => {
    const bytes = fs.readFileSync(path.join(sauerbratenDirectory, "packages", "models", "flags", "tris.md2"));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const source = parseMd2(buffer).meshes[0];
    const positions = flagModelPositions(source.positions);
    const bounds = [axisExtent(positions, 0), axisExtent(positions, 1), axisExtent(positions, 2)];

    expect(bounds[1]).toBeGreaterThan(18);
    expect(bounds[1]).toBeGreaterThan(bounds[0] * 2);
    expect(bounds[1]).toBeGreaterThan(bounds[2] * 10);
  });

  it("keeps protect flags ghosted while invisible and fades them in like the native client", () => {
    expect(FLAG_TRANSPARENCY_MODE).toBe(Material.MATERIAL_ALPHATESTANDBLEND);
    expect(flagVisibility(true, 1_000, 5_000)).toBe(0.3);
    expect(flagVisibility(false, 5_000, 5_000)).toBe(0.3);
    expect(flagVisibility(false, 5_000, 5_500)).toBeCloseTo(0.65);
    expect(flagVisibility(false, 5_000, 6_000)).toBe(1);
  });
});

function axisExtent(positions: readonly number[], axis: number): number {
  const values: number[] = [];
  for (let index = axis; index < positions.length; index += 3) values.push(positions[index]);
  return Math.max(...values) - Math.min(...values);
}
