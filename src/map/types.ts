export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

export type MapVariable =
  | { name: string; type: "integer"; value: number }
  | { name: string; type: "float"; value: number }
  | { name: string; type: "string"; value: string };

export interface MapHeader {
  version: number;
  headerSize: number;
  worldSize: number;
  entityCount: number;
  pvsCount: number;
  lightmapCount: number;
  hasBlendmap: boolean;
  variableCount: number;
  vslotCount: number;
}

export interface MapEntity {
  position: Vec3;
  attributes: [number, number, number, number, number];
  type: number;
}

export interface VSlot {
  changed: number;
  previous: number;
  scale: number;
  rotation: number;
  offset: [number, number];
  scroll: [number, number];
  layer: number;
  alpha: [number, number];
  color: [number, number, number];
}

export interface SurfaceVertex {
  x: number;
  y: number;
  z: number;
  u: number;
  v: number;
  normal: number;
}

export interface Surface {
  lightmapIds: [number, number];
  vertexFlags: number;
  vertexCount: number;
  vertices: SurfaceVertex[];
}

export interface Lightmap {
  type: number;
  bytesPerPixel: 3 | 4;
  width: 512;
  height: 512;
  unlit?: [number, number];
  data: Uint8Array;
}

export type CubeKind = "empty" | "solid" | "normal";

export interface OctreeCube {
  origin: Vec3;
  size: number;
  kind: CubeKind;
  edges: Uint8Array;
  textures: [number, number, number, number, number, number];
  material: number;
  merged: number;
  surfaces: Array<Surface | undefined>;
  children?: OctreeCube[];
}

export interface SauerMap {
  name: string;
  header: MapHeader;
  variables: MapVariable[];
  gameType: string;
  textureMru: number[];
  entities: MapEntity[];
  vslots: VSlot[];
  world: OctreeCube[];
  lightmaps: Lightmap[];
  bytesConsumedThroughOctree: number;
  bytesConsumed: number;
}
