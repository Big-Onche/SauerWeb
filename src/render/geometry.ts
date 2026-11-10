import type { OctreeCube, SauerMap, SurfaceVertex, Vec3 } from "../map/types";

export interface GeometryBatch {
  name: string;
  positions: number[];
  indices: number[];
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

export function generateGeometry(map: SauerMap): GeometryBatch[] {
  return map.world.map((root, index) => {
    const batch: GeometryBatch = { name: `octant-${index}`, positions: [], indices: [], colors: [], faceCount: 0 };
    visitLeaves(root, (cube) => appendCube(map, cube, batch));
    return batch;
  }).filter((batch) => batch.indices.length > 0);
}

function visitLeaves(cube: OctreeCube, callback: (cube: OctreeCube) => void): void {
  if (cube.children) cube.children.forEach((child) => visitLeaves(child, callback));
  else if (cube.kind !== "empty") callback(cube);
}

function appendCube(map: SauerMap, cube: OctreeCube, batch: GeometryBatch): void {
  for (let orientation = 0; orientation < 6; orientation++) {
    if (!isFaceVisible(map, cube, orientation)) continue;
    const surface = cube.surfaces[orientation];
    const layerCount = surface ? surface.vertexCount & 0x0f : 4;
    const source = surface?.vertices.slice(0, layerCount) ?? FACE_CORNERS[orientation].map((corner) => generatedVertex(cube, corner));
    if (source.length < 3) continue;
    appendFace(batch, source.map((vertex) => decodeVertex(cube, vertex)), cube.textures[orientation]);
  }
}

function isFaceVisible(map: SauerMap, cube: OctreeCube, orientation: number): boolean {
  const normal = FACE_NORMALS[orientation];
  const point = {
    x: cube.origin.x + cube.size / 2 + normal.x * (cube.size / 2 + 0.01),
    y: cube.origin.y + cube.size / 2 + normal.y * (cube.size / 2 + 0.01),
    z: cube.origin.z + cube.size / 2 + normal.z * (cube.size / 2 + 0.01),
  };
  if (point.x < 0 || point.y < 0 || point.z < 0 || point.x >= map.header.worldSize || point.y >= map.header.worldSize || point.z >= map.header.worldSize) {
    return true;
  }
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
    u: 0,
    v: 0,
    normal: 0,
  };
}

function decodeVertex(cube: OctreeCube, vertex: SurfaceVertex): Vec3 {
  return {
    x: (vertex.x + ((cube.origin.x & ~0x0fff) << 3)) / 8,
    y: (vertex.y + ((cube.origin.y & ~0x0fff) << 3)) / 8,
    z: (vertex.z + ((cube.origin.z & ~0x0fff) << 3)) / 8,
  };
}

function appendFace(batch: GeometryBatch, vertices: Vec3[], texture: number): void {
  const baseIndex = batch.positions.length / 3;
  const [red, green, blue] = textureColor(texture);
  for (const vertex of vertices) {
    batch.positions.push(vertex.x, vertex.z, vertex.y);
    batch.colors.push(red, green, blue, 1);
  }
  for (let index = 1; index < vertices.length - 1; index++) batch.indices.push(baseIndex, baseIndex + index, baseIndex + index + 1);
  batch.faceCount++;
}

function textureColor(texture: number): [number, number, number] {
  if (texture === 0) return [0.32, 0.5, 0.72];
  const hue = (texture * 0.61803398875) % 1;
  return hslToRgb(hue, 0.23, 0.49 + (texture % 5) * 0.025);
}

function hslToRgb(hue: number, saturation: number, lightness: number): [number, number, number] {
  const channel = (offset: number) => {
    const k = (offset + hue * 12) % 12;
    const amount = saturation * Math.min(lightness, 1 - lightness);
    return lightness - amount * Math.max(-1, Math.min(k - 3, 9 - k, 1));
  };
  return [channel(0), channel(8), channel(4)];
}
