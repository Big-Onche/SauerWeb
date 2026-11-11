import type { MaterialClipType, MaterialVolume, MaterialVolumeType, OctreeCube } from "./octa";

export const MATF_INDEX = 3;
export const MATF_VOLUME = 7 << 2;
export const MATF_CLIP = 7 << 5;
export const MAT_WATER = 1 << 2;
export const MAT_LAVA = 2 << 2;
export const MAT_GLASS = 3 << 2;
export const MAT_NOCLIP = 1 << 5;
export const MAT_CLIP = 2 << 5;
export const MAT_GAMECLIP = 3 << 5;
export const MAT_DEATH = 1 << 8;
export const MAT_ALPHA = 4 << 8;

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
