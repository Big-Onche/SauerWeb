import type { SauerMap, VSlot } from "../map/types";
import type { ResolvedTexture, TextureManifest, TextureSlot } from "./types";

const DEFAULT_VSLOT: VSlot = {
  changed: 0, previous: -1, scale: 1, rotation: 0, offset: [0, 0], scroll: [0, 0], layer: 0, alpha: [0.5, 0], color: [1, 1, 1],
};

export async function loadTextureManifest(mapName: string): Promise<TextureManifest> {
  const response = await fetch(`/api/maps/${encodeURIComponent(mapName)}/textures`, { cache: "no-store" });
  if (!response.ok) throw new Error(`Could not resolve texture configuration for ${mapName} (${response.status}).`);
  return response.json() as Promise<TextureManifest>;
}

export function resolveMapTextures(map: SauerMap, manifest: TextureManifest): ResolvedTexture[] {
  const rootSlotByVSlot = new Map<number, TextureSlot>();
  let slotIndex = 0;
  for (let index = 0; index < map.vslots.length; index++) {
    if (map.vslots[index].previous >= 0) continue;
    const slot = manifest.slots[slotIndex++];
    if (slot) rootSlotByVSlot.set(index, slot);
  }

  const resolved = map.vslots.map((serialized, index) => {
    const rootIndex = findRootVSlot(map.vslots, index);
    const slot = rootSlotByVSlot.get(rootIndex) ?? manifest.slots[rootIndex] ?? manifest.slots[0] ?? emptySlot();
    const texture: ResolvedTexture = {
      slot,
      vslot: mergeVSlot(slot.vslot, serialized),
      diffuseUrl: packageAssetUrl(slot.textures.find((item) => item.kind === "diffuse")?.path),
      normalUrl: packageAssetUrl(slot.textures.find((item) => item.kind === "normal")?.path),
      glowUrl: packageAssetUrl(slot.textures.find((item) => item.kind === "glow")?.path),
    };
    return texture;
  });
  resolved.forEach((texture) => {
    if (texture.vslot.layer > 0 && texture.vslot.layer < resolved.length) texture.layer = resolved[texture.vslot.layer];
  });
  return resolved;
}

function findRootVSlot(vslots: VSlot[], index: number): number {
  const visited = new Set<number>();
  while (vslots[index]?.previous >= 0 && !visited.has(index)) {
    visited.add(index);
    index = vslots[index].previous;
  }
  return index;
}

function mergeVSlot(base: VSlot, delta: VSlot): VSlot {
  return {
    changed: delta.changed,
    previous: delta.previous,
    scale: delta.changed & 1 << 1 ? delta.scale : base.scale,
    rotation: delta.changed & 1 << 2 ? delta.rotation : base.rotation,
    offset: delta.changed & 1 << 3 ? delta.offset : base.offset,
    scroll: delta.changed & 1 << 4 ? delta.scroll : base.scroll,
    layer: delta.changed & 1 << 5 ? delta.layer : base.layer,
    alpha: delta.changed & 1 << 6 ? delta.alpha : base.alpha,
    color: delta.changed & 1 << 7 ? delta.color : base.color,
  };
}

export function packageAssetUrl(path: string | undefined): string | undefined {
  return path ? `/api/packages/${path.split("/").map(encodeURIComponent).join("/")}` : undefined;
}

function emptySlot(): TextureSlot {
  return { index: 0, textures: [], vslot: { ...DEFAULT_VSLOT, offset: [0, 0], scroll: [0, 0], alpha: [0.5, 0], color: [1, 1, 1] } };
}
