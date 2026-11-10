import type { ResolvedTexture } from "../assets/types";
import type { OctreeCube, SauerMap, SurfaceVertex, Vec3, VSlot } from "../map/types";
import { MAT_ALPHA } from "../map/materials";

export interface GeometryBatch {
  name: string;
  textureIndex: number;
  cubeMaterial: number;
  lightmapId: number;
  useLightmapAlpha: boolean;
  positions: number[];
  indices: number[];
  uvs: number[];
  uv2s: number[];
  colors: number[];
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

const FACE_NORMALS: Vec3[] = [
  { x: -1, y: 0, z: 0 }, { x: 1, y: 0, z: 0 },
  { x: 0, y: -1, z: 0 }, { x: 0, y: 1, z: 0 },
  { x: 0, y: 0, z: -1 }, { x: 0, y: 0, z: 1 },
];

const LIGHTMAP_SIZE = 512;
const LIGHTMAP_COORDINATE_SCALE = 65536;
const DEFAULT_SKY = 0;
const LAYER_TOP = 1 << 5;
const LAYER_BOTTOM = 1 << 6;
const LAYER_DUPLICATED = 1 << 7;

export function generateGeometry(map: SauerMap, textures: ResolvedTexture[] = []): GeometryBatch[] {
  const batches = new Map<string, GeometryBatch>();
  const coincidentFaces = findCoincidentFaces(map.world);
  const emittedTriangles = new Set<string>();
  map.world.forEach((root, rootIndex) => {
    visitLeaves(root, (cube) => appendCube(map, cube, rootIndex, textures, batches, coincidentFaces.get(cube) ?? 0, emittedTriangles));
  });
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function visitLeaves(cube: OctreeCube, callback: (cube: OctreeCube) => void): void {
  if (cube.children) cube.children.forEach((child) => visitLeaves(child, callback));
  else if (cube.kind !== "empty") callback(cube);
}

function appendCube(map: SauerMap, cube: OctreeCube, rootIndex: number, textures: ResolvedTexture[], batches: Map<string, GeometryBatch>,
                    coincidentMask: number, emittedTriangles: Set<string>): void {
  for (let orientation = 0; orientation < 6; orientation++) {
    if (coincidentMask & (1 << orientation)) continue;
    // Slot 0 is Sauerbraten's DEFAULT_SKY portal, not an ordinary world material.
    // Its face limits skybox rendering in the native renderer; our enclosing skybox is
    // already available behind world geometry, so omitting the face exposes it directly.
    if (cube.textures[orientation] === DEFAULT_SKY) continue;
    const surface = cube.surfaces[orientation];
    const layerCount = surface ? surface.vertexCount & 0x0f : 4;
    const merged = (cube.merged & (1 << orientation)) !== 0;
    // Sauerbraten marks all cubes covered by a merged face. Only its origin has explicit vertices;
    // zero-vertex participants must not fall back to ordinary cube quads.
    if (merged && (!surface || layerCount === 0)) continue;
    if (!merged && !isFaceVisible(map, cube, orientation)) continue;
    const primarySource = surface && layerCount > 0
      ? surface.vertices.slice(0, layerCount)
      : FACE_CORNERS[orientation].map((corner) => generatedVertex(cube, corner));
    if (primarySource.length < 3) continue;
    const layerFlags = surface?.vertexCount ?? 0;
    const hasBottom = (layerFlags & LAYER_BOTTOM) !== 0;
    const hasTop = !surface || layerFlags === 0 || (layerFlags & LAYER_TOP) !== 0;
    const primaryTextureIndex = cube.textures[orientation];
    if (hasBottom) {
      const secondarySource = layerFlags & LAYER_DUPLICATED ? surface!.vertices.slice(layerCount, layerCount * 2) : primarySource;
      const secondaryTextureIndex = textures[primaryTextureIndex]?.vslot.layer ?? primaryTextureIndex;
      appendSurface(batches, cube, rootIndex, orientation, secondarySource, secondaryTextureIndex, surface?.lightmapIds[1] ?? 0, false, textures,
        emittedTriangles);
    }
    if (hasTop) {
      appendSurface(batches, cube, rootIndex, orientation, primarySource, primaryTextureIndex, surface?.lightmapIds[0] ?? 0, hasBottom, textures,
        emittedTriangles);
    }
  }
}

function findCoincidentFaces(cubes: OctreeCube[]): WeakMap<OctreeCube, number> {
  const faces = new Map<string, Array<{ cube: OctreeCube; orientation: number }>>();
  cubes.forEach((root) => visitLeaves(root, (cube) => {
    if (cube.material & MAT_ALPHA) return;
    for (let orientation = 0; orientation < 6; orientation++) {
      const surface = cube.surfaces[orientation];
      const layerCount = surface ? surface.vertexCount & 0x0f : 4;
      if (cube.merged & (1 << orientation) && (!surface || layerCount === 0)) continue;
      const source = surface && layerCount > 0
        ? surface.vertices.slice(0, layerCount)
        : FACE_CORNERS[orientation].map((corner) => generatedVertex(cube, corner));
      const key = facePositionKey(cube, source);
      if (!key) continue;
      const entries = faces.get(key) ?? [];
      entries.push({ cube, orientation });
      faces.set(key, entries);
    }
  }));
  const result = new WeakMap<OctreeCube, number>();
  faces.forEach((entries) => entries.forEach((entry) => {
    if (!entries.some((candidate) => candidate !== entry && candidate.orientation === (entry.orientation ^ 1))) return;
    result.set(entry.cube, (result.get(entry.cube) ?? 0) | (1 << entry.orientation));
  }));
  return result;
}

function facePositionKey(cube: OctreeCube, source: SurfaceVertex[]): string | undefined {
  const positions = source.map((vertex) => decodeVertex(cube, vertex));
  if (positions.length < 3 || polygonAreaSquared(positions) === 0) return undefined;
  return positions.map((position) => `${position.x},${position.y},${position.z}`).sort().join("|");
}

function appendSurface(batches: Map<string, GeometryBatch>, cube: OctreeCube, rootIndex: number, orientation: number, source: SurfaceVertex[],
                       textureIndex: number, lightmapId: number, useLightmapAlpha: boolean, textures: ResolvedTexture[],
                       emittedTriangles: Set<string>): void {
  if (source.length < 3) return;
  const surfaceMaterial = cube.material & MAT_ALPHA;
  const key = `${rootIndex}:${textureIndex}:${surfaceMaterial}:${lightmapId}:${useLightmapAlpha ? 1 : 0}`;
  let batch = batches.get(key);
  if (!batch) {
    batch = {
      name: `octant-${rootIndex}-texture-${textureIndex}-material-${surfaceMaterial}-lightmap-${lightmapId}${useLightmapAlpha ? "-blend" : ""}`,
      textureIndex,
      cubeMaterial: surfaceMaterial,
      lightmapId,
      useLightmapAlpha,
      positions: [],
      indices: [],
      uvs: [],
      uv2s: [],
      colors: [],
      faceCount: 0,
    };
    batches.set(key, batch);
  }
  appendFace(batch, source, source.map((vertex) => decodeVertex(cube, vertex)), orientation, textures[textureIndex]?.vslot, emittedTriangles);
}

function isFaceVisible(map: SauerMap, cube: OctreeCube, orientation: number): boolean {
  const normal = FACE_NORMALS[orientation];
  const point = {
    x: cube.origin.x + cube.size / 2 + normal.x * (cube.size / 2 + 0.01),
    y: cube.origin.y + cube.size / 2 + normal.y * (cube.size / 2 + 0.01),
    z: cube.origin.z + cube.size / 2 + normal.z * (cube.size / 2 + 0.01),
  };
  if (point.x < 0 || point.y < 0 || point.z < 0 || point.x >= map.header.worldSize || point.y >= map.header.worldSize ||
      point.z >= map.header.worldSize) return true;
  if (cube.kind !== "solid") return true;
  return solidNeighborCoverage(map.world, cube, orientation) < cube.size * cube.size;
}

function solidNeighborCoverage(cubes: OctreeCube[], source: OctreeCube, orientation: number): number {
  const axis = Math.floor(orientation / 2);
  const firstProjectionAxis = [1, 0, 0][axis];
  const secondProjectionAxis = [2, 2, 1][axis];
  const sourceOrigin = [source.origin.x, source.origin.y, source.origin.z];
  const boundary = sourceOrigin[axis] + (orientation & 1 ? source.size : 0);
  let coveredArea = 0;
  visitTouchingLeaves(cubes, sourceOrigin, source.size, axis, firstProjectionAxis, secondProjectionAxis, boundary, orientation, (neighbor) => {
    if (neighbor.kind !== "solid") return;
    const neighborOrigin = [neighbor.origin.x, neighbor.origin.y, neighbor.origin.z];
    const firstOverlap = intervalOverlap(sourceOrigin[firstProjectionAxis], source.size,
      neighborOrigin[firstProjectionAxis], neighbor.size);
    const secondOverlap = intervalOverlap(sourceOrigin[secondProjectionAxis], source.size,
      neighborOrigin[secondProjectionAxis], neighbor.size);
    coveredArea += firstOverlap * secondOverlap;
  });
  return coveredArea;
}

function visitTouchingLeaves(cubes: OctreeCube[], sourceOrigin: number[], sourceSize: number, axis: number, firstProjectionAxis: number,
                             secondProjectionAxis: number, boundary: number, orientation: number,
                             callback: (cube: OctreeCube) => void): void {
  cubes.forEach((cube) => {
    const origin = [cube.origin.x, cube.origin.y, cube.origin.z];
    if (intervalOverlap(sourceOrigin[firstProjectionAxis], sourceSize, origin[firstProjectionAxis], cube.size) === 0 ||
        intervalOverlap(sourceOrigin[secondProjectionAxis], sourceSize, origin[secondProjectionAxis], cube.size) === 0) return;
    const crossesBoundary = orientation & 1
      ? origin[axis] <= boundary && origin[axis] + cube.size > boundary
      : origin[axis] < boundary && origin[axis] + cube.size >= boundary;
    if (!crossesBoundary) return;
    if (cube.children) {
      visitTouchingLeaves(cube.children, sourceOrigin, sourceSize, axis, firstProjectionAxis, secondProjectionAxis, boundary, orientation, callback);
      return;
    }
    const touchesBoundary = orientation & 1 ? origin[axis] === boundary : origin[axis] + cube.size === boundary;
    if (touchesBoundary) callback(cube);
  });
}

function intervalOverlap(firstOrigin: number, firstSize: number, secondOrigin: number, secondSize: number): number {
  return Math.max(0, Math.min(firstOrigin + firstSize, secondOrigin + secondSize) - Math.max(firstOrigin, secondOrigin));
}

function generatedVertex(cube: OctreeCube, [x, y, z]: [number, number, number]): SurfaceVertex {
  const edge = (dimension: number, first: number, second: number) => cube.edges[dimension * 4 + second * 2 + first];
  const edgeValue = (value: number, high: number) => high ? value >> 4 : value & 0x0f;
  return {
    x: edgeValue(edge(0, y, z), x) * cube.size + ((cube.origin.x & 0x0fff) << 3),
    y: edgeValue(edge(1, z, x), y) * cube.size + ((cube.origin.y & 0x0fff) << 3),
    z: edgeValue(edge(2, x, y), z) * cube.size + ((cube.origin.z & 0x0fff) << 3),
    u: 0, v: 0, normal: 0,
  };
}

function decodeVertex(cube: OctreeCube, vertex: SurfaceVertex): Vec3 {
  return {
    x: (vertex.x + ((cube.origin.x & ~0x0fff) << 3)) / 8,
    y: (vertex.y + ((cube.origin.y & ~0x0fff) << 3)) / 8,
    z: (vertex.z + ((cube.origin.z & ~0x0fff) << 3)) / 8,
  };
}

function appendFace(batch: GeometryBatch, source: SurfaceVertex[], vertices: Vec3[], orientation: number, vslot: VSlot | undefined,
                    emittedTriangles: Set<string>): void {
  const effective = vslot ?? { scale: 1, rotation: 0, offset: [0, 0] as [number, number], color: [1, 1, 1] as [number, number, number] };
  const baseIndex = batch.positions.length / 3;
  for (let index = 0; index < vertices.length; index++) {
    const vertex = vertices[index];
    batch.positions.push(vertex.x, vertex.z, vertex.y);
    batch.colors.push(effective.color[0], effective.color[1], effective.color[2], 1);
    batch.uvs.push(...projectUv(vertex, orientation, effective.scale, effective.rotation, effective.offset));
    // Serialized coordinates point at lumel corners. Sauerbraten samples their centers.
    batch.uv2s.push(
      source[index].u / LIGHTMAP_COORDINATE_SCALE + 0.5 / LIGHTMAP_SIZE,
      source[index].v / LIGHTMAP_COORDINATE_SCALE + 0.5 / LIGHTMAP_SIZE,
    );
  }
  const firstIndex = batch.indices.length;
  for (let index = 1; index < vertices.length - 1; index++) {
    const triangle = [vertices[0], vertices[index], vertices[index + 1]];
    if (triangleAreaSquared(triangle[0], triangle[1], triangle[2]) === 0) continue;
    const key = `${batch.useLightmapAlpha ? 1 : 0}:${triangle.map((vertex) => `${vertex.x},${vertex.y},${vertex.z}`).sort().join("|")}`;
    if (emittedTriangles.has(key)) continue;
    emittedTriangles.add(key);
    batch.indices.push(baseIndex, baseIndex + index, baseIndex + index + 1);
  }
  if (batch.indices.length > firstIndex) batch.faceCount++;
}

function polygonAreaSquared(vertices: Vec3[]): number {
  let area = 0;
  for (let index = 1; index < vertices.length - 1; index++) area += triangleAreaSquared(vertices[0], vertices[index], vertices[index + 1]);
  return area;
}

function triangleAreaSquared(first: Vec3, second: Vec3, third: Vec3): number {
  const ab = { x: second.x - first.x, y: second.y - first.y, z: second.z - first.z };
  const ac = { x: third.x - first.x, y: third.y - first.y, z: third.z - first.z };
  const cross = {
    x: ab.y * ac.z - ab.z * ac.y,
    y: ab.z * ac.x - ab.x * ac.z,
    z: ab.x * ac.y - ab.y * ac.x,
  };
  return cross.x * cross.x + cross.y * cross.y + cross.z * cross.z;
}

export function projectUv(position: Vec3, orientation: number, scale: number, rotation: number, offset: [number, number]): [number, number] {
  const dimension = Math.floor(orientation / 2);
  const sDimension = [1, 0, 0][dimension];
  const tDimension = [2, 2, 1][dimension];
  const coordinates = [position.x, position.y, position.z];
  const swap = rotation === 1 || rotation === 3 || rotation === 6 || rotation === 7;
  const flipX = rotation === 2 || rotation === 3 || rotation === 4 || rotation === 7;
  const flipY = rotation === 1 || rotation === 2 || rotation === 5 || rotation === 7;
  const factor = 8 / (scale > 0 ? scale : 1);
  const sOffset = -(swap ? offset[1] : offset[0]);
  const tOffset = -(swap ? offset[0] : offset[1]);
  if (swap) {
    return [
      coordinates[tDimension] * factor * (dimension <= 1 ? -1 : 1) * (flipX ? -1 : 1) + sOffset,
      coordinates[sDimension] * factor * (flipY ? -1 : 1) + tOffset,
    ];
  }
  return [
    coordinates[sDimension] * factor * (flipX ? -1 : 1) + sOffset,
    coordinates[tDimension] * factor * (dimension <= 1 ? -1 : 1) * (flipY ? -1 : 1) + tOffset,
  ];
}
