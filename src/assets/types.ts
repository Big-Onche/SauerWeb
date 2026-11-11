import type { VSlot } from "../engine/octa";

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
  fog?: MapFogOverrides;
  mapModels: MapModelAsset[];
}

export interface HudGunAsset {
  gun: number;
  model: string;
  weapon: MapModelAsset;
  hands: MapModelAsset;
  handsAnimationPath: string;
  weaponAnimationPath: string;
  attachmentBone: string;
  handsAdjustments: HudGunAdjustment[];
  weaponAdjustments: HudGunAdjustment[];
}

export interface HudGunAdjustment {
  bone: string;
  yaw: number;
  pitch: number;
  roll: number;
  translate: [number, number, number];
}

export interface MapModelAsset {
  index: number;
  name: string;
  status: "ready" | "unsupported" | "missing";
  format?: string;
  configPath?: string;
  geometryPath?: string;
  skins?: MapModelSkin[];
  meshSettings?: MapModelMeshSettings[];
  scale?: number;
  translate?: [number, number, number];
  yaw?: number;
  pitch?: number;
  cullFace?: boolean;
  alphaTest?: number;
  alphaBlend?: boolean;
  ambient?: number;
  specular?: number;
  glow?: number;
  collide?: boolean;
  ellipseCollide?: boolean;
  collisionRadius?: number;
  collisionHeight?: number;
  boundingBoxExtend?: [number, number, number];
  reason: string;
}

export interface MapModelSkin {
  mesh: string;
  diffusePath: string;
  masksPath?: string;
}

export interface MapModelMeshSettings {
  mesh: string;
  cullFace?: boolean;
}

export interface PlayerModelAsset {
  index: number;
  name: string;
  ffa: MapModelAsset;
  blueTeam: MapModelAsset;
  redTeam: MapModelAsset;
  animations: Record<string, PlayerModelAnimation>;
}

export interface PlayerModelAnimation {
  path: string;
  speed: number;
  startOffset: number;
  endOffset: number;
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

export interface MapFogOverrides {
  distance?: number;
  color?: number;
  domeColor?: number;
  domeHeight?: number;
  domeMin?: number;
  domeMax?: number;
  domeCap?: number;
  domeClip?: number;
  domeClouds?: number;
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
