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
  faceCount: number;
}

const FACE_CORNERS: Array<Array<[number, number, number]>> = [
  [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]],
  [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
  [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]],
  [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
  [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
  [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
];

export function generateMaterialGeometry(map: SauerMap): MaterialGeometryBatch[] {
  const batches = new Map<MaterialRenderKind, MaterialGeometryBatch>();
  const exactLeaves = new Set(map.materialVolumes.map((volume) => volumeKey(volume, volume.volume)));
  map.materialVolumes.forEach((volume) => {
    if (volume.volume !== "air") appendVolume(batches, volume, volume.volume, false, exactLeaves);
    if (volume.clip !== "none") appendVolume(batches, volume, volume.clip, true);
    if (volume.death) appendVolume(batches, volume, "death", true);
    if (volume.alpha) appendVolume(batches, volume, "alpha", true);
  });
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function appendVolume(batches: Map<MaterialRenderKind, MaterialGeometryBatch>, volume: MaterialVolume, kind: MaterialRenderKind,
                      debugOnly: boolean, exactLeaves?: Set<string>): void {
  let batch = batches.get(kind);
  if (!batch) {
    batch = { name: `material-volume-${kind}`, kind, debugOnly, positions: [], indices: [], colors: [], uvs: [], faceCount: 0 };
    batches.set(kind, batch);
  }
  for (let orientation = 0; orientation < FACE_CORNERS.length; orientation++) {
    if (exactLeaves?.has(adjacentVolumeKey(volume, kind, orientation))) continue;
    appendFace(batch, volume, orientation);
  }
}

function appendFace(batch: MaterialGeometryBatch, volume: MaterialVolume, orientation: number): void {
  const base = batch.positions.length / 3;
  FACE_CORNERS[orientation].forEach(([x, y, z]) => {
    const worldX = volume.origin.x + x * volume.size;
    const worldY = volume.origin.y + y * volume.size;
    const worldZ = volume.origin.z + z * volume.size;
    batch.positions.push(worldX, worldZ, worldY);
    batch.colors.push(1, 1, 1, 1);
    batch.uvs.push(worldX / 8, (orientation < 4 ? worldZ : worldY) / 8);
  });
  batch.indices.push(base, base + 1, base + 2, base, base + 2, base + 3);
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
