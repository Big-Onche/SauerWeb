import type { MaterialVolume, SauerMap } from "../engine/octa";
import { collectWorldFaceOccluders, type WorldFaceOccluder } from "../engine/renderva";

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

type FaceAdjacency = Map<string, MaterialVolume[]>;
type WorldFaceAdjacency = Map<string, FaceRectangle[]>;

export function generateMaterialGeometry(map: SauerMap, waterQuality = 0): MaterialGeometryBatch[] {
  const batches = new Map<string, MaterialGeometryBatch>();
  const adjacency = buildFaceAdjacency(map.materialVolumes);
  const worldAdjacency = buildWorldFaceAdjacency(collectWorldFaceOccluders(map));
  map.materialVolumes.forEach((volume) => {
    if (volume.volume !== "air") appendVolume(batches, volume, volume.volume, false, adjacency, worldAdjacency, waterQuality);
    if (volume.clip !== "none") appendVolume(batches, volume, volume.clip, true);
    if (volume.death) appendVolume(batches, volume, "death", true);
    if (volume.alpha) appendVolume(batches, volume, "alpha", true);
  });
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function appendVolume(batches: Map<string, MaterialGeometryBatch>, volume: MaterialVolume, kind: MaterialRenderKind,
                      debugOnly: boolean, adjacency?: FaceAdjacency, worldAdjacency?: WorldFaceAdjacency, waterQuality = 0): void {
  const materialIndex = kind === "water" || kind === "lava" ? volume.volumeIndex : 0;
  const key = `${kind}:${materialIndex}`;
  let batch = batches.get(key);
  if (!batch) {
    batch = { name: `material-volume-${kind}-${materialIndex}`, kind, debugOnly, positions: [], indices: [], colors: [], uvs: [],
      waveData: [], faceCount: 0, materialIndex };
    batches.set(key, batch);
  }
  for (let orientation = 0; orientation < FACE_CORNERS.length; orientation++) {
    if (kind === "water" && orientation === 4) continue;
    if ((kind === "water" || kind === "lava") && ((volume.solidFaceMask ?? 0) & (1 << orientation))) continue;
    const rectangles = adjacency && worldAdjacency && !debugOnly
      ? exposedFaceRectangles(volume, orientation, adjacency, worldAdjacency)
      : [wholeFace(volume, orientation)];
    for (const rectangle of rectangles) {
      if (kind === "water" && orientation === 5) appendWaterTopFace(batch, volume, rectangle, waterQuality);
      else appendFace(batch, volume, orientation, rectangle, kind === "water");
    }
  }
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
  batch.faceCount++;
}

function buildFaceAdjacency(volumes: MaterialVolume[]): FaceAdjacency {
  const adjacency: FaceAdjacency = new Map();
  for (const volume of volumes) {
    if (volume.volume === "air") continue;
    for (let axis = 0; axis < 3; axis++) {
      addAdjacentFace(adjacency, volume, axis, 0, volume.origin[coordinate(axis)]);
      addAdjacentFace(adjacency, volume, axis, 1, volume.origin[coordinate(axis)] + volume.size);
    }
  }
  return adjacency;
}

function addAdjacentFace(adjacency: FaceAdjacency, volume: MaterialVolume, axis: number, side: number, plane: number): void {
  const key = faceKey(volume.volume, axis, side, plane);
  const faces = adjacency.get(key) ?? [];
  faces.push(volume);
  adjacency.set(key, faces);
}

function buildWorldFaceAdjacency(occluders: WorldFaceOccluder[]): WorldFaceAdjacency {
  const adjacency: WorldFaceAdjacency = new Map();
  for (const occluder of occluders) {
    const key = worldFaceKey(occluder.axis, occluder.plane);
    const rectangles = adjacency.get(key) ?? [];
    rectangles.push(occluder);
    adjacency.set(key, rectangles);
  }
  return adjacency;
}

function exposedFaceRectangles(volume: MaterialVolume, orientation: number, adjacency: FaceAdjacency,
                               worldAdjacency: WorldFaceAdjacency): FaceRectangle[] {
  const axis = Math.floor(orientation / 2);
  const side = orientation & 1;
  const plane = volume.origin[coordinate(axis)] + (side ? volume.size : 0);
  const candidates = adjacency.get(faceKey(volume.volume, axis, side ^ 1, plane)) ?? [];
  let rectangles = [wholeFace(volume, orientation)];
  for (const candidate of candidates) {
    const cover = wholeFace(candidate, orientation);
    rectangles = rectangles.flatMap((rectangle) => subtractRectangle(rectangle, cover));
    if (!rectangles.length) break;
  }
  const worldCovers = worldAdjacency.get(worldFaceKey(axis, plane)) ?? [];
  for (const cover of worldCovers) {
    rectangles = rectangles.flatMap((rectangle) => subtractRectangle(rectangle, cover));
    if (!rectangles.length) break;
  }
  return rectangles;
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

function faceKey(kind: string, axis: number, side: number, plane: number): string {
  return `${kind}:${axis}:${side}:${plane}`;
}

function worldFaceKey(axis: number, plane: number): string {
  return `${axis}:${plane}`;
}
