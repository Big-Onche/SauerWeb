import type { ResolvedTexture } from "../assets/types";
import type { OctreeCube, SauerMap, SurfaceVertex, Vec3, VSlot } from "../map/types";

export interface GeometryBatch {
  name: string;
  textureIndex: number;
  positions: number[];
  indices: number[];
  uvs: number[];
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

export function generateGeometry(map: SauerMap, textures: ResolvedTexture[] = []): GeometryBatch[] {
  const batches = new Map<string, GeometryBatch>();
  map.world.forEach((root, rootIndex) => visitLeaves(root, (cube) => appendCube(map, cube, rootIndex, textures, batches)));
  return [...batches.values()].filter((batch) => batch.indices.length > 0);
}

function visitLeaves(cube: OctreeCube, callback: (cube: OctreeCube) => void): void {
  if (cube.children) cube.children.forEach((child) => visitLeaves(child, callback));
  else if (cube.kind !== "empty") callback(cube);
}

function appendCube(map: SauerMap, cube: OctreeCube, rootIndex: number, textures: ResolvedTexture[], batches: Map<string, GeometryBatch>): void {
  for (let orientation = 0; orientation < 6; orientation++) {
    if (!isFaceVisible(map, cube, orientation)) continue;
    const surface = cube.surfaces[orientation];
    const layerCount = surface ? surface.vertexCount & 0x0f : 4;
    const source = surface?.vertices.slice(0, layerCount) ?? FACE_CORNERS[orientation].map((corner) => generatedVertex(cube, corner));
    if (source.length < 3) continue;
    const textureIndex = cube.textures[orientation];
    const key = `${rootIndex}:${textureIndex}`;
    let batch = batches.get(key);
    if (!batch) {
      batch = { name: `octant-${rootIndex}-texture-${textureIndex}`, textureIndex, positions: [], indices: [], uvs: [], colors: [], faceCount: 0 };
      batches.set(key, batch);
    }
    appendFace(batch, source.map((vertex) => decodeVertex(cube, vertex)), orientation, textures[textureIndex]?.vslot);
  }
}

function isFaceVisible(map: SauerMap, cube: OctreeCube, orientation: number): boolean {
  const normal = FACE_NORMALS[orientation];
  const point = {
    x: cube.origin.x + cube.size / 2 + normal.x * (cube.size / 2 + 0.01),
    y: cube.origin.y + cube.size / 2 + normal.y * (cube.size / 2 + 0.01),
    z: cube.origin.z + cube.size / 2 + normal.z * (cube.size / 2 + 0.01),
  };
  if (point.x < 0 || point.y < 0 || point.z < 0 || point.x >= map.header.worldSize || point.y >= map.header.worldSize || point.z >= map.header.worldSize) return true;
  return findLeaf(map.world, point)?.kind === "empty";
}

function findLeaf(cubes: OctreeCube[], point: Vec3): OctreeCube | undefined {
  const cube = cubes.find((candidate) => point.x >= candidate.origin.x && point.x < candidate.origin.x + candidate.size &&
    point.y >= candidate.origin.y && point.y < candidate.origin.y + candidate.size &&
    point.z >= candidate.origin.z && point.z < candidate.origin.z + candidate.size);
  if (!cube?.children) return cube;
  return findLeaf(cube.children, point);
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

function appendFace(batch: GeometryBatch, vertices: Vec3[], orientation: number, vslot?: VSlot): void {
  const effective = vslot ?? { scale: 1, rotation: 0, offset: [0, 0] as [number, number], color: [1, 1, 1] as [number, number, number] };
  const baseIndex = batch.positions.length / 3;
  for (const vertex of vertices) {
    batch.positions.push(vertex.x, vertex.z, vertex.y);
    batch.colors.push(effective.color[0], effective.color[1], effective.color[2], 1);
    batch.uvs.push(...projectUv(vertex, orientation, effective.scale, effective.rotation, effective.offset));
  }
  for (let index = 1; index < vertices.length - 1; index++) batch.indices.push(baseIndex, baseIndex + index, baseIndex + index + 1);
  batch.faceCount++;
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
