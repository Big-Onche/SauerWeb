import { describe, expect, it } from "vitest";
import type { OctreeCube, SauerMap, Surface } from "../map/types";
import { generateGeometry } from "./geometry";

describe("generateGeometry", () => {
  it("generates a regular face for a surface record with no explicit vertices", () => {
    const cube = solidCube(0, 0, 0, 2);
    cube.surfaces[0] = emptySurface();
    const batches = generateGeometry(mapWith([cube], 2));
    expect(totalFaces(batches)).toBe(6);
  });

  it("does not hide a whole face behind a smaller neighboring leaf", () => {
    const large = solidCube(0, 0, 0, 2);
    const partialNeighbor = solidCube(2, 1, 1, 1);
    const batches = generateGeometry(mapWith([large, partialNeighbor], 4));
    expect(totalFaces(batches)).toBe(11);
  });
});

function solidCube(x: number, y: number, z: number, size: number): OctreeCube {
  return {
    origin: { x, y, z },
    size,
    kind: "solid",
    edges: new Uint8Array(12).fill(0x80),
    textures: [0, 0, 0, 0, 0, 0],
    material: 0,
    merged: 0,
    surfaces: new Array(6),
  };
}

function emptySurface(): Surface {
  return { lightmapIds: [0, 0], vertexFlags: 0, vertexCount: 0, vertices: [] };
}

function mapWith(world: OctreeCube[], worldSize: number): SauerMap {
  return {
    name: "synthetic",
    header: {
      version: 33,
      headerSize: 40,
      worldSize,
      entityCount: 0,
      pvsCount: 0,
      lightmapCount: 0,
      hasBlendmap: false,
      variableCount: 0,
      vslotCount: 0,
    },
    variables: [],
    gameType: "fps",
    textureMru: [],
    entities: [],
    vslots: [],
    world,
    bytesConsumedThroughOctree: 0,
  };
}

function totalFaces(batches: ReturnType<typeof generateGeometry>): number {
  return batches.reduce((total, batch) => total + batch.faceCount, 0);
}
