import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadSauerbratenDirectory } from "../../../sauerbratenDirectory";
import { parseMd3, parseObj } from "../../engine/rendermodel";
import {
  COLLECT_BASE_MODEL_SCALE,
  COLLECT_SKULL_MODEL_SCALE,
  collectModelPositions,
} from "./CollectRenderer";

const sauerbratenDirectory = loadSauerbratenDirectory("test");

describe("Collect model rendering", () => {
  it("applies SauerWeb's world-unit conversion to the native base scale", () => {
    const bytes = fs.readFileSync(path.join(sauerbratenDirectory, "packages", "models", "base", "base.md3"));
    const buffer = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer;
    const source = parseMd3(buffer).meshes[0].positions;
    const positions = collectModelPositions(source, COLLECT_BASE_MODEL_SCALE);

    expect(axisExtent(positions, 1)).toBeCloseTo(axisExtent(source, 1) * 0.25 * 0.75);
    expect(axisExtent(positions, 1)).toBeGreaterThan(9);
    expect(axisExtent(positions, 1)).toBeLessThan(11);
  });

  it("applies the native skull scale and translated origin inside that scale", () => {
    const source = parseObj(fs.readFileSync(path.join(sauerbratenDirectory, "packages", "models", "skull", "skull.obj"), "utf8"))
      .meshes[0].positions;
    const positions = collectModelPositions(source, COLLECT_SKULL_MODEL_SCALE, 3.25);

    expect(axisExtent(positions, 1)).toBeCloseTo(axisExtent(source, 1) * 0.25 * 2.5);
    expect(axisMinimum(positions, 1)).toBeCloseTo((axisMinimum(source, 1) + 3.25) * 0.25 * 2.5);
  });
});

function axisExtent(positions: readonly number[], axis: number): number {
  const values = axisValues(positions, axis);
  return Math.max(...values) - Math.min(...values);
}

function axisMinimum(positions: readonly number[], axis: number): number { return Math.min(...axisValues(positions, axis)); }

function axisValues(positions: readonly number[], axis: number): number[] {
  const values: number[] = [];
  for (let index = axis; index < positions.length; index += 3) values.push(positions[index]);
  return values;
}
