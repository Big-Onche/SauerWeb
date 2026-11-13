import type { MaterialVolume, SauerMap } from "../engine/octa";

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

export function generateMaterialGeometry(map: SauerMap, waterQuality = 0): MaterialGeometryBatch[] {
  const batches = new Map<string, MaterialGeometryBatch>();
  const exactLeaves = new Set(map.materialVolumes.map((volume) => volumeKey(volume, volume.volume)));
  map.materialVolumes.forEach((volume) => {
    if (volume.volume !== "air") appendVolume(batches, volume, volume.volume, false, exactLeaves, waterQuality);
    if (volume.clip !== "none") appendVolume(batches, volume, volume.clip, true);
    if (volume.death) appendVolume(batches, volume, "death", true);
    if (volume.alpha) appendVolume(batches, volume, "alpha", true);
  });
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function appendVolume(batches: Map<string, MaterialGeometryBatch>, volume: MaterialVolume, kind: MaterialRenderKind,
                      debugOnly: boolean, exactLeaves?: Set<string>, waterQuality = 0): void {
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
    if (exactLeaves?.has(adjacentVolumeKey(volume, kind, orientation))) continue;
    if (kind === "water" && orientation === 5) appendWaterTopFace(batch, volume, waterQuality);
    else appendFace(batch, volume, orientation, kind === "water");
  }
}

function appendFace(batch: MaterialGeometryBatch, volume: MaterialVolume, orientation: number, animatedWater = false): void {
  const base = batch.positions.length / 3;
  FACE_CORNERS[orientation].forEach(([x, y, z]) => {
    let worldX = volume.origin.x + x * volume.size;
    let worldY = volume.origin.y + y * volume.size;
    const worldZ = volume.origin.z + z * volume.size;
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

function appendWaterTopFace(batch: MaterialGeometryBatch, volume: MaterialVolume, quality: number): void {
  const cellSize = quality >= 3 ? 4 : quality >= 2 ? 8 : quality >= 1 ? 16 : volume.size;
  const segments = Math.max(1, Math.min(16, Math.ceil(volume.size / cellSize)));
  const firstVertex = batch.positions.length / 3;
  for (let y = 0; y <= segments; y++) {
    for (let x = 0; x <= segments; x++) {
      const worldX = volume.origin.x + volume.size * x / segments;
      const worldY = volume.origin.y + volume.size * y / segments;
      const worldZ = volume.origin.z + volume.size;
      batch.positions.push(worldX, worldZ, worldY);
      batch.colors.push(1, 1, 1, 1);
      batch.uvs.push(worldX / 8, worldY / 8);
      batch.waveData.push(volume.size, 1);
    }
  }
  const rowSize = segments + 1;
  for (let y = 0; y < segments; y++) {
    for (let x = 0; x < segments; x++) {
      const first = firstVertex + y * rowSize + x;
      const nextRow = first + rowSize;
      batch.indices.push(first, nextRow + 1, first + 1, first, nextRow, nextRow + 1);
    }
  }
  batch.faceCount++;
}

function volumeKey(volume: MaterialVolume, kind: string): string {
  return `${kind}:${volume.origin.x},${volume.origin.y},${volume.origin.z}:${volume.size}`;
}

function adjacentVolumeKey(volume: MaterialVolume, kind: string, orientation: number): string {
  const origin = { ...volume.origin };
  const axis = Math.floor(orientation / 2) as 0 | 1 | 2;
  const coordinate = ["x", "y", "z"] as const;
  origin[coordinate[axis]] += (orientation & 1 ? 1 : -1) * volume.size;
  return `${kind}:${origin.x},${origin.y},${origin.z}:${volume.size}`;
}
