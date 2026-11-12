import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { describe, expect, it } from "vitest";
import { loadSauerbratenDirectory } from "../../sauerbratenDirectory";
import type { OctreeCube, Surface } from "./octa";
import { SauerMapParser } from "./worldio";

const sauerbratenDirectory = loadSauerbratenDirectory("test");

describe("surface reconstruction", () => {
  it.each([["triforts", 1661], ["flagstone", 99]] as const)("uses the second triangle's plane for collapsed faces in %s", (name, expectedCount) => {
    const compressed = fs.readFileSync(path.join(sauerbratenDirectory, "packages", "base", `${name}.ogz`));
    const bytes = zlib.gunzipSync(compressed);
    const map = new SauerMapParser().parse(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength), name);
    let matches = 0;
    visit(map.world, (cube) => cube.surfaces.forEach((surface, orientation) => {
      if (!surface || !(surface.vertexFlags & 0x04) || !(surface.vertexCount & 0x0f)) return;
      const corners = faceCorners(orientation).map((corner) => encodedCorner(cube, corner));
      const first = subtract(corners[1], corners[0]);
      const second = subtract(corners[2], corners[0]);
      const normal = cross(first, second);
      const fallback = cross(second, subtract(corners[3], corners[0]));
      if (normal.every((value) => value === 0) && fallback.some((value) => value !== 0)) {
        matches++;
        expectReconstructedOnFallbackPlane(surface, orientation, corners[0], fallback);
      }
    }));
    expect(matches).toBe(expectedCount);
  });
});

function expectReconstructedOnFallbackPlane(surface: Surface, orientation: number, planePoint: number[], normal: number[]): void {
  const dimension = Math.floor(orientation / 2);
  const columnDimension = [2, 0, 1][dimension];
  const rowDimension = [1, 2, 0][dimension];
  const bias = -dot(normal, planePoint);
  const count = surface.vertexCount & 0x0f;
  surface.vertices.slice(0, count).forEach((vertex) => {
    const coordinates = [vertex.x, vertex.y, vertex.z];
    const expected = Math.trunc(-(bias + normal[columnDimension] * coordinates[columnDimension] +
      normal[rowDimension] * coordinates[rowDimension]) / normal[dimension]);
    expect(coordinates[dimension]).toBe(expected);
  });
}

function visit(cubes: OctreeCube[], callback: (cube: OctreeCube) => void): void {
  cubes.forEach((cube) => cube.children ? visit(cube.children, callback) : callback(cube));
}

function encodedCorner(cube: OctreeCube, [x, y, z]: [number, number, number]): number[] {
  const edge = (dimension: number, first: number, second: number) => cube.edges[dimension * 4 + second * 2 + first];
  const value = (edgeValue: number, high: number) => high ? edgeValue >> 4 : edgeValue & 0x0f;
  return [
    value(edge(0, y, z), x) * cube.size + ((cube.origin.x & 0x0fff) << 3),
    value(edge(1, z, x), y) * cube.size + ((cube.origin.y & 0x0fff) << 3),
    value(edge(2, x, y), z) * cube.size + ((cube.origin.z & 0x0fff) << 3),
  ];
}

function subtract(left: number[], right: number[]): number[] {
  return left.map((value, index) => value - right[index]);
}

function cross(left: number[], right: number[]): number[] {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2], left[0] * right[1] - left[1] * right[0]];
}

function dot(left: number[], right: number[]): number {
  return left.reduce((total, value, index) => total + value * right[index], 0);
}

function faceCorners(orientation: number): Array<[number, number, number]> {
  return [
    [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]], [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
    [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]], [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]], [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  ][orientation] as Array<[number, number, number]>;
}
