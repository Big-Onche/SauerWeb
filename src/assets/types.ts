import type { VSlot } from "../map/types";

export type TextureKind = "diffuse" | "normal" | "glow" | "specular" | "depth" | "alpha" | "decal" | "environment" | "unknown";

export interface SlotTexture {
  kind: TextureKind;
  path: string;
}

export interface TextureSlot {
  index: number;
  textures: SlotTexture[];
  vslot: VSlot;
  layerMask?: { path: string; mode: number; scale: number };
}

export interface UnsupportedConfigCommand {
  command: string;
  source: string;
  line: number;
  reason: string;
}

export interface TextureManifest {
  slots: TextureSlot[];
  unsupported: UnsupportedConfigCommand[];
  sources: string[];
}

export interface ResolvedTexture {
  slot: TextureSlot;
  vslot: VSlot;
  diffuseUrl?: string;
  normalUrl?: string;
  glowUrl?: string;
  layer?: ResolvedTexture;
}
