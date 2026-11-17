import type { GeometryBatch } from "../engine/renderva";

export interface StaticChunkCoordinate {
  readonly x: number;
  readonly y: number;
  readonly z: number;
}

export interface StaticGeometryBatch extends GeometryBatch {
  readonly chunk: StaticChunkCoordinate;
  readonly chunkId: string;
}

interface ClipVertex {
  position: [number, number, number];
  uv: [number, number];
  uv2: [number, number];
  color: [number, number, number, number];
}

interface ChunkBuilder {
  batch: StaticGeometryBatch;
  vertices: Map<string, number>;
}

const CLIP_EPSILON = 1e-7;

/**
 * Splits already decoded Sauerbraten surfaces at chunk planes. Attribute interpolation is linear, exactly as it is across the original
 * triangles, so clipping does not alter the rendered surface. The source OGZ octree remains untouched for gameplay and future editing.
 */
export function buildStaticWorldChunks(batches: readonly GeometryBatch[], chunkSize: number, uintIndices: boolean): StaticGeometryBatch[] {
  const result: StaticGeometryBatch[] = [];
  for (let materialIndex = 0; materialIndex < batches.length; materialIndex++) {
    const source = batches[materialIndex];
    const builders = new Map<string, ChunkBuilder>();
    for (let offset = 0; offset < source.indices.length; offset += 3) {
      const triangle = [sourceVertex(source, source.indices[offset]), sourceVertex(source, source.indices[offset + 1]),
        sourceVertex(source, source.indices[offset + 2])];
      const xRange = chunkRange(triangle, 0, chunkSize);
      const yRange = chunkRange(triangle, 2, chunkSize);
      const zRange = chunkRange(triangle, 1, chunkSize);
      for (let x = xRange[0]; x <= xRange[1]; x++) for (let y = yRange[0]; y <= yRange[1]; y++) {
        for (let z = zRange[0]; z <= zRange[1]; z++) {
          const clipped = clipToChunk(triangle, x, y, z, chunkSize);
          if (clipped.length < 3) continue;
          const id = `${x}:${y}:${z}`;
          let builder = builders.get(id);
          if (!builder) {
            builder = createBuilder(source, materialIndex, { x, y, z }, id);
            builders.set(id, builder);
          }
          appendPolygon(builder, clipped);
        }
      }
    }
    for (const builder of builders.values()) {
      if (!builder.batch.indices.length) continue;
      if (uintIndices || builder.batch.positions.length / 3 <= 65_535) result.push(builder.batch);
      else result.push(...splitFor16BitIndices(builder.batch));
    }
  }
  return result;
}

export function staticChunkId(position: { x: number; y: number; z: number }, chunkSize: number): string {
  return `${Math.floor(position.x / chunkSize)}:${Math.floor(position.y / chunkSize)}:${Math.floor(position.z / chunkSize)}`;
}

function sourceVertex(batch: GeometryBatch, index: number): ClipVertex {
  return {
    position: [batch.positions[index * 3], batch.positions[index * 3 + 1], batch.positions[index * 3 + 2]],
    uv: [batch.uvs[index * 2], batch.uvs[index * 2 + 1]],
    uv2: [batch.uv2s[index * 2], batch.uv2s[index * 2 + 1]],
    color: [batch.colors[index * 4], batch.colors[index * 4 + 1], batch.colors[index * 4 + 2], batch.colors[index * 4 + 3]],
  };
}

function chunkRange(vertices: ClipVertex[], axis: number, size: number): [number, number] {
  let minimum = Number.POSITIVE_INFINITY, maximum = Number.NEGATIVE_INFINITY;
  for (const vertex of vertices) {
    minimum = Math.min(minimum, vertex.position[axis]);
    maximum = Math.max(maximum, vertex.position[axis]);
  }
  const first = Math.floor(minimum / size);
  return [first, maximum - minimum <= CLIP_EPSILON ? first : Math.floor((maximum - CLIP_EPSILON) / size)];
}

function clipToChunk(vertices: ClipVertex[], x: number, y: number, z: number, size: number): ClipVertex[] {
  let result = vertices;
  const cells: Array<[number, number]> = [[x, 0], [z, 1], [y, 2]];
  for (const [cell, axis] of cells) {
    result = clipPlane(result, axis, cell * size, true);
    result = clipPlane(result, axis, (cell + 1) * size, false);
    if (result.length < 3) break;
  }
  return result;
}

function clipPlane(vertices: ClipVertex[], axis: number, plane: number, keepAbove: boolean): ClipVertex[] {
  if (!vertices.length) return vertices;
  const result: ClipVertex[] = [];
  let previous = vertices[vertices.length - 1];
  let previousInside = inside(previous.position[axis], plane, keepAbove);
  for (const current of vertices) {
    const currentInside = inside(current.position[axis], plane, keepAbove);
    if (currentInside !== previousInside) {
      const denominator = current.position[axis] - previous.position[axis];
      const amount = denominator === 0 ? 0 : (plane - previous.position[axis]) / denominator;
      result.push(interpolate(previous, current, amount));
    }
    if (currentInside) result.push(current);
    previous = current;
    previousInside = currentInside;
  }
  return result;
}

function inside(value: number, plane: number, keepAbove: boolean): boolean {
  return keepAbove ? value >= plane - CLIP_EPSILON : value <= plane + CLIP_EPSILON;
}

function interpolate(first: ClipVertex, second: ClipVertex, amount: number): ClipVertex {
  const mix = (a: number, b: number): number => a + (b - a) * amount;
  return {
    position: [mix(first.position[0], second.position[0]), mix(first.position[1], second.position[1]),
      mix(first.position[2], second.position[2])],
    uv: [mix(first.uv[0], second.uv[0]), mix(first.uv[1], second.uv[1])],
    uv2: [mix(first.uv2[0], second.uv2[0]), mix(first.uv2[1], second.uv2[1])],
    color: [mix(first.color[0], second.color[0]), mix(first.color[1], second.color[1]), mix(first.color[2], second.color[2]),
      mix(first.color[3], second.color[3])],
  };
}

function createBuilder(source: GeometryBatch, materialIndex: number, chunk: StaticChunkCoordinate, id: string): ChunkBuilder {
  return {
    batch: {
      name: `static-world-${id}-material-${materialIndex}`,
      textureIndex: source.textureIndex,
      cubeMaterial: source.cubeMaterial,
      lightmapId: source.lightmapId,
      useLightmapAlpha: source.useLightmapAlpha,
      positions: [], indices: [], uvs: [], uv2s: [], colors: [], faceCount: 0,
      chunk, chunkId: id,
    },
    vertices: new Map<string, number>(),
  };
}

function appendPolygon(builder: ChunkBuilder, vertices: ClipVertex[]): void {
  const first = appendVertex(builder, vertices[0]);
  for (let index = 1; index < vertices.length - 1; index++) {
    const second = appendVertex(builder, vertices[index]);
    const third = appendVertex(builder, vertices[index + 1]);
    if (first === second || first === third || second === third) continue;
    builder.batch.indices.push(first, second, third);
  }
  builder.batch.faceCount++;
}

function appendVertex(builder: ChunkBuilder, vertex: ClipVertex): number {
  const key = `${vertex.position.join(",")}|${vertex.uv.join(",")}|${vertex.uv2.join(",")}|${vertex.color.join(",")}`;
  const existing = builder.vertices.get(key);
  if (existing !== undefined) return existing;
  const index = builder.batch.positions.length / 3;
  builder.vertices.set(key, index);
  builder.batch.positions.push(...vertex.position);
  builder.batch.uvs.push(...vertex.uv);
  builder.batch.uv2s.push(...vertex.uv2);
  builder.batch.colors.push(...vertex.color);
  return index;
}

function splitFor16BitIndices(source: StaticGeometryBatch): StaticGeometryBatch[] {
  const result: StaticGeometryBatch[] = [];
  let builder = createBuilder(source, 0, source.chunk, source.chunkId);
  let part = 0;
  for (let index = 0; index < source.indices.length; index += 3) {
    const triangle = [sourceVertex(source, source.indices[index]), sourceVertex(source, source.indices[index + 1]),
      sourceVertex(source, source.indices[index + 2])];
    const additional = triangle.reduce((count, vertex) => count + (builder.vertices.has(vertexKey(vertex)) ? 0 : 1), 0);
    if (builder.batch.positions.length / 3 + additional > 65_535) {
      builder.batch.name = `${source.name}-part-${part++}`;
      result.push(builder.batch);
      builder = createBuilder(source, part, source.chunk, source.chunkId);
    }
    appendPolygon(builder, triangle);
  }
  if (builder.batch.indices.length) {
    builder.batch.name = `${source.name}-part-${part}`;
    result.push(builder.batch);
  }
  return result;
}

function vertexKey(vertex: ClipVertex): string {
  return `${vertex.position.join(",")}|${vertex.uv.join(",")}|${vertex.uv2.join(",")}|${vertex.color.join(",")}`;
}
