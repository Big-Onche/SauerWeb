import type { MaterialVolume, SauerMap } from "../engine/octa";
import { worldFaceOccluder } from "../engine/renderva";
import { cubeSolidFaceMask, materialVolumeType } from "../engine/material";
import { WATER_OFFSET } from "./MapWater";

export type MaterialRenderKind = "water" | "lava" | "glass" | "clip" | "noclip" | "gameclip" | "death" | "alpha";

export interface MaterialGeometryBatch {
  name: string;
  kind: MaterialRenderKind;
  debugOnly: boolean;
  positions: number[];
  indices: number[];
  colors: number[];
  uvs: number[];
  waveData: number[];
  faceCount: number;
  materialIndex: number;
  /** Babylon-space Y coordinate of the planar reflection shared by this water batch. */
  reflectionHeight?: number;
  waterLod?: WaterLodGeometry;
}

export interface WaterLodGeometry {
  fixedIndices: number[];
  patches: WaterTopPatch[];
}

interface WaterTopPatch {
  firstVertex: number;
  xSegments: number;
  ySegments: number;
  u0: number;
  u1: number;
  v0: number;
  v1: number;
  worldZ: number;
  volumeSize: number;
}

export interface WaterLodIndices {
  indices: number[];
  signature: string;
}

const FACE_CORNERS: Array<Array<[number, number, number]>> = [
  [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]],
  [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
  [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
];
const WATERFALL_SURFACE_OFFSET = 0.1;

interface FaceRectangle {
  u0: number;
  u1: number;
  v0: number;
  v1: number;
}

export function generateMaterialGeometry(map: SauerMap, waterQuality = 0, includeDebug = false): MaterialGeometryBatch[] {
  const batches = new Map<string, MaterialGeometryBatch>();
  const coveredFaces = new WeakMap<MaterialVolume, number>();
  for (const volume of map.materialVolumes) {
    if (volume.volume === "air") continue;
    let mask = 0;
    for (let orientation = 0; orientation < FACE_CORNERS.length; orientation++) {
      if ((volume.solidFaceMask ?? 0) & (1 << orientation)) {
        mask |= 1 << orientation;
        continue;
      }
      if (faceFullyCoveredByNeighbor(map, volume, orientation)) mask |= 1 << orientation;
    }
    coveredFaces.set(volume, mask);
  }
  map.materialVolumes.forEach((volume) => {
    if (volume.volume !== "air") {
      appendVolume(batches, volume, volume.volume, false, waterQuality, map, coveredFaces.get(volume) ?? 0);
    }
    if (includeDebug && volume.clip !== "none") appendVolume(batches, volume, volume.clip, true);
    if (includeDebug && volume.death) appendVolume(batches, volume, "death", true);
    if (includeDebug && volume.alpha) appendVolume(batches, volume, "alpha", true);
  });
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function appendVolume(batches: Map<string, MaterialGeometryBatch>, volume: MaterialVolume, kind: MaterialRenderKind,
                      debugOnly: boolean, waterQuality = 0, map?: SauerMap, coveredFaceMask = 0): void {
  const materialIndex = kind === "water" || kind === "lava" ? volume.volumeIndex : 0;
  const reflectionHeight = kind === "water" ? volume.origin.z + volume.size - WATER_OFFSET : undefined;
  const key = `${kind}:${materialIndex}${reflectionHeight === undefined ? "" : `:${reflectionHeight}`}`;
  let batch = batches.get(key);
  if (!batch) {
    batch = { name: `material-volume-${kind}-${materialIndex}`, kind, debugOnly, positions: [], indices: [], colors: [], uvs: [],
      waveData: [], faceCount: 0, materialIndex, reflectionHeight,
      waterLod: kind === "water" && waterQuality >= 3 ? { fixedIndices: [], patches: [] } : undefined };
    batches.set(key, batch);
  }
  for (let orientation = 0; orientation < FACE_CORNERS.length; orientation++) {
    if (kind === "water" && orientation === 4) continue;
    if (!debugOnly && (volume.solidFaceMask ?? 0) & (1 << orientation)) continue;
    if (!debugOnly && coveredFaceMask & (1 << orientation)) continue;
    const rectangles = map && !debugOnly
      ? exposedFaceRectangles(volume, orientation, map)
      : [wholeFace(volume, orientation)];
    for (const rectangle of rectangles) {
      if (kind === "water" && orientation === 5) appendWaterTopFace(batch, volume, rectangle, waterQuality);
      else appendFace(batch, volume, orientation, rectangle, kind === "water");
    }
  }
}

function faceFullyCoveredByNeighbor(map: SauerMap, volume: MaterialVolume, orientation: number): boolean {
  const axis = Math.floor(orientation / 2);
  const side = orientation & 1;
  const [uAxis, vAxis] = faceAxes(axis);
  const coordinates = [volume.origin.x, volume.origin.y, volume.origin.z];
  coordinates[axis] += side ? volume.size + 0.001 : -0.001;
  coordinates[uAxis] += volume.size / 2;
  coordinates[vAxis] += volume.size / 2;
  const neighbor = findLeafAt(map.world, coordinates[0], coordinates[1], coordinates[2]);
  if (!neighbor || neighbor.size < volume.size) return false;
  if (materialVolumeType(neighbor.material) === volume.volume) return true;
  return (cubeSolidFaceMask(neighbor) & (1 << (orientation ^ 1))) !== 0;
}

function findLeafAt(cubes: SauerMap["world"], x: number, y: number, z: number): SauerMap["world"][number] | undefined {
  if (cubes.length === 8 && cubes.every((cube) => cube.size === cubes[0].size)) {
    const origin = cubes[0].origin;
    const size = cubes[0].size;
    if (x < origin.x || y < origin.y || z < origin.z || x >= origin.x + size * 2 || y >= origin.y + size * 2 ||
        z >= origin.z + size * 2) return undefined;
    const index = (x >= origin.x + size ? 1 : 0) | (y >= origin.y + size ? 2 : 0) | (z >= origin.z + size ? 4 : 0);
    const cube = cubes[index];
    return cube.children ? findLeafAt(cube.children, x, y, z) : cube;
  }
  for (const cube of cubes) {
    if (x < cube.origin.x || y < cube.origin.y || z < cube.origin.z || x >= cube.origin.x + cube.size || y >= cube.origin.y + cube.size ||
        z >= cube.origin.z + cube.size) continue;
    return cube.children ? findLeafAt(cube.children, x, y, z) : cube;
  }
  return undefined;
}

function appendFace(batch: MaterialGeometryBatch, volume: MaterialVolume, orientation: number, rectangle: FaceRectangle,
                    animatedWater = false): void {
  const base = batch.positions.length / 3;
  FACE_CORNERS[orientation].forEach(([x, y, z]) => {
    const coordinates = faceCoordinates(volume, orientation, rectangle, x, y, z);
    let worldX = coordinates[0], worldY = coordinates[1];
    const worldZ = coordinates[2];
    if (animatedWater) {
      if (orientation === 0) worldX += WATERFALL_SURFACE_OFFSET;
      else if (orientation === 1) worldX -= WATERFALL_SURFACE_OFFSET;
      else if (orientation === 2) worldY += WATERFALL_SURFACE_OFFSET;
      else if (orientation === 3) worldY -= WATERFALL_SURFACE_OFFSET;
    }
    batch.positions.push(worldX, worldZ, worldY);
    batch.colors.push(1, 1, 1, 1);
    batch.uvs.push(worldX / 8, (orientation < 4 ? worldZ : worldY) / 8);
    batch.waveData.push(volume.size, animatedWater ? z : 0);
  });
  batch.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  batch.waterLod?.fixedIndices.push(base, base + 1, base + 2, base, base + 2, base + 3);
  batch.faceCount++;
}

function appendWaterTopFace(batch: MaterialGeometryBatch, volume: MaterialVolume, rectangle: FaceRectangle, quality: number): void {
  const cellSize = quality >= 3 ? 4 : quality >= 2 ? 8 : quality >= 1 ? 16 : volume.size;
  const xSegments = Math.max(1, Math.min(16, Math.ceil((rectangle.u1 - rectangle.u0) / cellSize)));
  const ySegments = Math.max(1, Math.min(16, Math.ceil((rectangle.v1 - rectangle.v0) / cellSize)));
  const firstVertex = batch.positions.length / 3;
  for (let y = 0; y <= ySegments; y++) {
    for (let x = 0; x <= xSegments; x++) {
      const worldX = rectangle.u0 + (rectangle.u1 - rectangle.u0) * x / xSegments;
      const worldY = rectangle.v0 + (rectangle.v1 - rectangle.v0) * y / ySegments;
      const worldZ = volume.origin.z + volume.size;
      batch.positions.push(worldX, worldZ, worldY);
      batch.colors.push(1, 1, 1, 1);
      batch.uvs.push(worldX / 8, worldY / 8);
      batch.waveData.push(volume.size, 1);
    }
  }
  const rowSize = xSegments + 1;
  for (let y = 0; y < ySegments; y++) {
    for (let x = 0; x < xSegments; x++) {
      const first = firstVertex + y * rowSize + x;
      const nextRow = first + rowSize;
      batch.indices.push(first, nextRow + 1, first + 1, first, nextRow, nextRow + 1);
    }
  }
  batch.waterLod?.patches.push({ firstVertex, xSegments, ySegments, u0: rectangle.u0, u1: rectangle.u1, v0: rectangle.v0,
    v1: rectangle.v1, worldZ: volume.origin.z + volume.size, volumeSize: volume.size });
  batch.faceCount++;
}

// Original: src/engine/water.cpp, calcwatersubdiv(). Native water starts with a 4-unit subdivision and doubles it for every 64 units of
// camera distance. The web port retains the dense vertex buffer so changing LOD only replaces indices instead of rebuilding map geometry.
export function buildWaterLodIndices(batch: MaterialGeometryBatch, camera: { x: number; y: number; z: number }): WaterLodIndices {
  const lod = batch.waterLod;
  if (!lod) return { indices: batch.indices, signature: "static" };
  const indices = [...lod.fixedIndices];
  const signature: string[] = [];
  for (const patch of lod.patches) {
    const subdivision = waterSubdivision(patch, camera);
    const xStep = segmentStep(patch.u1 - patch.u0, patch.xSegments, subdivision);
    const yStep = segmentStep(patch.v1 - patch.v0, patch.ySegments, subdivision);
    signature.push(`${xStep}:${yStep}`);
    const xs = segmentStops(patch.xSegments, xStep), ys = segmentStops(patch.ySegments, yStep);
    const rowSize = patch.xSegments + 1;
    for (let y = 0; y + 1 < ys.length; y++) {
      for (let x = 0; x + 1 < xs.length; x++) {
        const first = patch.firstVertex + ys[y] * rowSize + xs[x];
        const right = patch.firstVertex + ys[y] * rowSize + xs[x + 1];
        const next = patch.firstVertex + ys[y + 1] * rowSize + xs[x];
        const nextRight = patch.firstVertex + ys[y + 1] * rowSize + xs[x + 1];
        indices.push(first, nextRight, right, first, next, nextRight);
      }
    }
  }
  return { indices, signature: signature.join(",") };
}

function waterSubdivision(patch: WaterTopPatch, camera: { x: number; y: number; z: number }): number {
  let distance: number;
  if (camera.x >= patch.u0 && camera.x < patch.u1 && camera.y >= patch.v0 && camera.y < patch.v1) {
    distance = Math.abs(camera.z - patch.worldZ);
  } else {
    const width = patch.u1 - patch.u0, height = patch.v1 - patch.v0;
    const dx = camera.x - (patch.u0 + patch.u1) / 2, dy = camera.y - (patch.v0 + patch.v1) / 2;
    const dz = camera.z - (patch.worldZ - patch.volumeSize / 2);
    distance = Math.max(0, Math.hypot(dx, dy, dz) - Math.max(width, height) * 1.42 / 2);
  }
  const exponent = Math.min(30, 2 + Math.floor(distance / 64));
  return 2 ** exponent;
}

function segmentStep(length: number, segments: number, subdivision: number): number {
  const cellSize = length / segments;
  let step = 1;
  while (step < segments && cellSize * step < subdivision) step *= 2;
  return Math.min(step, segments);
}

function segmentStops(segments: number, step: number): number[] {
  const stops: number[] = [];
  for (let segment = 0; segment < segments; segment += step) stops.push(segment);
  if (stops.at(-1) !== segments) stops.push(segments);
  return stops;
}

function exposedFaceRectangles(volume: MaterialVolume, orientation: number, map: SauerMap): FaceRectangle[] {
  const face = wholeFace(volume, orientation);
  const candidates = collectAdjacentFaceCovers(map.world, volume, orientation, face);
  let rectangles = [face];
  for (const cover of candidates) {
    rectangles = rectangles.flatMap((rectangle) => subtractRectangle(rectangle, cover));
    if (!rectangles.length) break;
  }
  return rectangles;
}

function collectAdjacentFaceCovers(cubes: SauerMap["world"], volume: MaterialVolume, orientation: number,
                                   face: FaceRectangle): FaceRectangle[] {
  const axis = Math.floor(orientation / 2);
  const [uAxis, vAxis] = faceAxes(axis);
  const plane = volume.origin[coordinate(axis)] + (orientation & 1 ? volume.size : 0);
  const covers: FaceRectangle[] = [];
  visitAdjacentLeaves(cubes, axis, uAxis, vAxis, plane, orientation, face, (cube) => {
    if (materialVolumeType(cube.material) === volume.volume) covers.push(volumeRectangle(cube, axis));
    const occluder = worldFaceOccluder(cube, orientation ^ 1);
    if (occluder) covers.push(occluder);
  });
  return covers;
}

function visitAdjacentLeaves(cubes: SauerMap["world"], axis: number, uAxis: number, vAxis: number, plane: number, orientation: number,
                             face: FaceRectangle, callback: (cube: SauerMap["world"][number]) => void): void {
  for (const cube of cubes) {
    const origin = [cube.origin.x, cube.origin.y, cube.origin.z];
    if (origin[uAxis] >= face.u1 || origin[uAxis] + cube.size <= face.u0 || origin[vAxis] >= face.v1 ||
        origin[vAxis] + cube.size <= face.v0) continue;
    const crossesPlane = orientation & 1 ? origin[axis] <= plane && origin[axis] + cube.size > plane : origin[axis] < plane &&
      origin[axis] + cube.size >= plane;
    if (!crossesPlane) continue;
    if (cube.children) {
      visitAdjacentLeaves(cube.children, axis, uAxis, vAxis, plane, orientation, face, callback);
      continue;
    }
    const touchesPlane = orientation & 1 ? origin[axis] === plane : origin[axis] + cube.size === plane;
    if (touchesPlane) callback(cube);
  }
}

function volumeRectangle(volume: Pick<MaterialVolume, "origin" | "size">, axis: number): FaceRectangle {
  const [uAxis, vAxis] = faceAxes(axis);
  return {
    u0: volume.origin[coordinate(uAxis)],
    u1: volume.origin[coordinate(uAxis)] + volume.size,
    v0: volume.origin[coordinate(vAxis)],
    v1: volume.origin[coordinate(vAxis)] + volume.size,
  };
}

function wholeFace(volume: MaterialVolume, orientation: number): FaceRectangle {
  const axis = Math.floor(orientation / 2);
  const [uAxis, vAxis] = faceAxes(axis);
  return {
    u0: volume.origin[coordinate(uAxis)],
    u1: volume.origin[coordinate(uAxis)] + volume.size,
    v0: volume.origin[coordinate(vAxis)],
    v1: volume.origin[coordinate(vAxis)] + volume.size,
  };
}

function subtractRectangle(source: FaceRectangle, cover: FaceRectangle): FaceRectangle[] {
  const u0 = Math.max(source.u0, cover.u0), u1 = Math.min(source.u1, cover.u1);
  const v0 = Math.max(source.v0, cover.v0), v1 = Math.min(source.v1, cover.v1);
  if (u0 >= u1 || v0 >= v1) return [source];
  return [
    { u0: source.u0, u1: source.u1, v0: source.v0, v1: v0 },
    { u0: source.u0, u1: source.u1, v0: v1, v1: source.v1 },
    { u0: source.u0, u1: u0, v0, v1 },
    { u0: u1, u1: source.u1, v0, v1 },
  ].filter((rectangle) => rectangle.u0 < rectangle.u1 && rectangle.v0 < rectangle.v1);
}

function faceCoordinates(volume: MaterialVolume, orientation: number, rectangle: FaceRectangle, x: number, y: number,
                         z: number): [number, number, number] {
  const axis = Math.floor(orientation / 2);
  const [uAxis, vAxis] = faceAxes(axis);
  const normalized = [x, y, z];
  const result = [0, 0, 0];
  result[axis] = volume.origin[coordinate(axis)] + (orientation & 1 ? volume.size : 0);
  result[uAxis] = normalized[uAxis] ? rectangle.u1 : rectangle.u0;
  result[vAxis] = normalized[vAxis] ? rectangle.v1 : rectangle.v0;
  return result as [number, number, number];
}

function faceAxes(axis: number): [number, number] {
  return axis === 0 ? [1, 2] : axis === 1 ? [0, 2] : [0, 1];
}

function coordinate(axis: number): "x" | "y" | "z" {
  return (["x", "y", "z"] as const)[axis];
}
