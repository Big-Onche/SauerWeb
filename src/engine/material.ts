import type { MaterialClipType, MaterialVolume, MaterialVolumeType, OctreeCube } from "./octa";

export const MATF_INDEX_SHIFT = 0;
export const MATF_VOLUME_SHIFT = 2;
export const MATF_CLIP_SHIFT = 5;
export const MATF_FLAG_SHIFT = 8;

export const MATF_INDEX = 3 << MATF_INDEX_SHIFT;
export const MATF_VOLUME = 7 << MATF_VOLUME_SHIFT;
export const MATF_CLIP = 7 << MATF_CLIP_SHIFT;
export const MAT_WATER = 1 << MATF_VOLUME_SHIFT;
export const MAT_LAVA = 2 << MATF_VOLUME_SHIFT;
export const MAT_GLASS = 3 << MATF_VOLUME_SHIFT;
export const MAT_NOCLIP = 1 << MATF_CLIP_SHIFT;
export const MAT_CLIP = 2 << MATF_CLIP_SHIFT;
export const MAT_GAMECLIP = 3 << MATF_CLIP_SHIFT;
export const MAT_DEATH = 1 << MATF_FLAG_SHIFT;
export const MAT_ALPHA = 4 << MATF_FLAG_SHIFT;

export function collectMaterialVolumes(world: OctreeCube[]): MaterialVolume[] {
  const volumes: MaterialVolume[] = [];
  world.forEach((cube) => visitMaterialLeaves(cube, volumes));
  return volumes;
}

export function materialVolumeType(material: number): MaterialVolumeType {
  const volume = material & MATF_VOLUME;
  if (volume === MAT_WATER) return "water";
  if (volume === MAT_LAVA) return "lava";
  if (volume === MAT_GLASS) return "glass";
  return "air";
}

export function materialClipType(material: number): MaterialClipType {
  const clip = material & MATF_CLIP;
  if (clip === MAT_NOCLIP) return "noclip";
  if (clip === MAT_CLIP) return "clip";
  if (clip === MAT_GAMECLIP) return "gameclip";
  return "none";
}

function visitMaterialLeaves(cube: OctreeCube, volumes: MaterialVolume[]): void {
  if (cube.children) {
    cube.children.forEach((child) => visitMaterialLeaves(child, volumes));
    return;
  }
  if (cube.material === 0) return;
  volumes.push({
    origin: { ...cube.origin },
    size: cube.size,
    cubeKind: cube.kind,
    rawMaterial: cube.material,
    volume: materialVolumeType(cube.material),
    volumeIndex: cube.material & MATF_INDEX,
    clip: materialClipType(cube.material),
    death: (cube.material & MAT_DEATH) !== 0,
    alpha: (cube.material & MAT_ALPHA) !== 0,
  });
}
