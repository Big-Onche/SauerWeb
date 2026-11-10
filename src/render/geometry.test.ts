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

  it("does not generate fallback quads for zero-vertex merged-face participants", () => {
    const cube = solidCube(0, 0, 0, 2);
    cube.merged = 1;
    cube.surfaces[0] = emptySurface();
    const batches = generateGeometry(mapWith([cube], 2));

    expect(totalFaces(batches)).toBe(5);
  });

  it("does not hide a whole face behind a smaller neighboring leaf", () => {
    const large = solidCube(0, 0, 0, 2);
    const partialNeighbor = solidCube(2, 1, 1, 1);
    const batches = generateGeometry(mapWith([large, partialNeighbor], 4));
    expect(totalFaces(batches)).toBe(11);
  });

  it("hides a large face fully tiled by smaller solid neighbors", () => {
    const large = solidCube(0, 0, 0, 2);
    const neighbors = [
      solidCube(2, 0, 0, 1), solidCube(2, 1, 0, 1),
      solidCube(2, 0, 1, 1), solidCube(2, 1, 1, 1),
    ];
    const batches = generateGeometry(mapWith([large, ...neighbors], 4));

    expect(totalFaces(batches)).toBe(17);
  });

  it("uses secondary lightmaps and duplicated UVs for bottom layers", () => {
    const cube = solidCube(0, 0, 0, 2);
    const vertices = [
      vertex(0, 16, 16, 0, 0), vertex(0, 16, 0, 128, 0), vertex(0, 0, 0, 128, 128), vertex(0, 0, 16, 0, 128),
      vertex(0, 16, 16, 256, 256), vertex(0, 16, 0, 384, 256), vertex(0, 0, 0, 384, 384), vertex(0, 0, 16, 256, 384),
    ];
    cube.surfaces[0] = { lightmapIds: [6, 7], vertexFlags: 0, vertexCount: 0x80 | 0x40 | 4, vertices };
    const batches = generateGeometry(mapWith([cube], 2));
    const bottom = batches.find((batch) => batch.lightmapId === 7);

    expect(bottom?.uv2s[0]).toBeCloseTo(256 / 65536 + 0.5 / 512);
    expect(bottom?.useLightmapAlpha).toBe(false);
    expect(batches.some((batch) => batch.lightmapId === 6)).toBe(false);
  });

  it("marks the primary atlas alpha as the mask for blended top layers", () => {
    const cube = solidCube(0, 0, 0, 2);
    cube.surfaces[0] = { ...emptySurface(), lightmapIds: [6, 7], vertexCount: 0x60 | 4,
      vertices: [
        vertex(0, 16, 16, 0, 0), vertex(0, 16, 0, 128, 0), vertex(0, 0, 0, 128, 128), vertex(0, 0, 16, 0, 128),
      ] };
    const batches = generateGeometry(mapWith([cube], 2));

    expect(batches.find((batch) => batch.lightmapId === 6)?.useLightmapAlpha).toBe(true);
    expect(batches.find((batch) => batch.lightmapId === 7)?.useLightmapAlpha).toBe(false);
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

function vertex(x: number, y: number, z: number, u: number, v: number) {
  return { x, y, z, u, v, normal: 0 };
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
    materialVolumes: [],
    lightmaps: [],
    bytesConsumedThroughOctree: 0,
    bytesConsumed: 0,
  };
}

function totalFaces(batches: ReturnType<typeof generateGeometry>): number {
  return batches.reduce((total, batch) => total + batch.faceCount, 0);
}
