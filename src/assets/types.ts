import type { VSlot } from "../map/types";

export type TextureKind = "diffuse" | "normal" | "glow" | "specular" | "depth" | "alpha" | "decal" | "environment" | "unknown";

export interface SlotTexture {
  kind: TextureKind;
  path: string;
}

export interface SauerShaderMetadata {
  name: string;
  parameters: Record<string, number[]>;
}

export interface TextureSlot {
  index: number;
  textures: SlotTexture[];
  vslot: VSlot;
  /** Optional while connecting to a dev server that predates shader-aware manifests. */
  shader?: SauerShaderMetadata;
  alphaConfigured?: boolean;
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
  skybox?: MapSkyOverrides;
  lighting?: MapLightingOverrides;
  mapModels: MapModelAsset[];
}

export interface MapModelAsset {
  index: number;
  name: string;
  status: "unsupported" | "missing";
  format?: string;
  configPath?: string;
  reason: string;
}

export interface MapLightingOverrides {
  ambient?: number;
  skylight?: number;
}

export interface MapSkyOverrides {
  basePath?: string;
  yaw?: number;
  spin?: number;
  color?: number;
}

export interface ResolvedTexture {
  slot: TextureSlot;
  vslot: VSlot;
  diffuseUrl?: string;
  normalUrl?: string;
  glowUrl?: string;
  specularUrl?: string;
  depthUrl?: string;
  alphaUrl?: string;
  environmentUrl?: string;
  layer?: ResolvedTexture;
}
