import { BinaryReader } from "./binaryreader";
import { collectMaterialVolumes, MATF_CLIP_SHIFT, MATF_FLAG_SHIFT, MATF_VOLUME_SHIFT } from "./material";
import { createFpsEntityRegistry } from "../fpsgame/entities";
import type { Lightmap, MapEntity, MapHeader, MapVariable, OctreeCube, SauerMap, Surface, SurfaceVertex, Vec3, VSlot } from "./octa";

const CURRENT_MAP_VERSION = 33;
const MINIMUM_MAP_VERSION = 32;
const OCTSAV_CHILDREN = 0;
const OCTSAV_EMPTY = 1;
const OCTSAV_SOLID = 2;
const OCTSAV_NORMAL = 3;
const OCTSAV_LOD_CUBE = 4;
const SOLID_EDGES = new Uint8Array(12).fill(0x80);
const EMPTY_EDGES = new Uint8Array(12);
const LIGHTMAP_WIDTH = 512;
const LIGHTMAP_HEIGHT = 512;
const LIGHTMAP_TYPE_MASK = 0x0f;
const LIGHTMAP_ALPHA = 1 << 4;
const LIGHTMAP_BUMPMAP_DIRECTION = 2;

export class SauerMapParser {
  private mapversion = CURRENT_MAP_VERSION;

  parse(buffer: ArrayBuffer, name = "map"): SauerMap {
    return this.load_world(buffer, name);
  }

  // Original: src/engine/worldio.cpp
  // Function: load_world()
  // Sauerbraten reference: SVN r6488
  load_world(buffer: ArrayBuffer, name = "map"): SauerMap {
    const reader = new BinaryReader(buffer);
    const header = this.readHeader(reader);
    this.mapversion = header.version;
    const variables = this.readVariables(reader, header.variableCount);
    const gameType = this.readGameData(reader);
    const textureMru = this.readTextureMru(reader);
    const entities = this.readEntities(reader, header.entityCount, gameType);
    const entityRegistry = createFpsEntityRegistry(entities);
    const vslots = this.loadvslots(reader, header.vslotCount);
    const world = this.loadchildren(reader, { x: 0, y: 0, z: 0 }, header.worldSize / 2);
    const materialVolumes = collectMaterialVolumes(world);
    const bytesConsumedThroughOctree = reader.offset;
    const lightmaps = this.readLightmaps(reader, header.lightmapCount);

    return {
      name, header, variables, gameType, textureMru, entities, entityRegistry, vslots, world, materialVolumes, lightmaps, bytesConsumedThroughOctree,
      bytesConsumed: reader.offset,
    };
  }

  private readLightmaps(reader: BinaryReader, count: number): Lightmap[] {
    if (count < 0 || count > 1_000_000) throw new Error(`Invalid lightmap count ${count}.`);
    return Array.from({ length: count }, (_, index) => {
      const serializedType = reader.uint8(`lightmap ${index} type`);
      const type = serializedType & 0x7f;
      const unlit: [number, number] | undefined = serializedType & 0x80
        ? [reader.uint16(`lightmap ${index} unlit x`), reader.uint16(`lightmap ${index} unlit y`)]
        : undefined;
      const bytesPerPixel: 3 | 4 = type & LIGHTMAP_ALPHA && (type & LIGHTMAP_TYPE_MASK) !== LIGHTMAP_BUMPMAP_DIRECTION ? 4 : 3;
      const data = reader.byteArray(LIGHTMAP_WIDTH * LIGHTMAP_HEIGHT * bytesPerPixel, `lightmap ${index} pixels`);
      return { type, bytesPerPixel, width: LIGHTMAP_WIDTH, height: LIGHTMAP_HEIGHT, unlit, data };
    });
  }

  private readHeader(reader: BinaryReader): MapHeader {
    const magic = reader.text(4, "map magic");
    const version = reader.int32("map version");
    const headerSize = reader.int32("header size");
    const worldSize = reader.int32("world size");
    const entityCount = reader.int32("entity count");
    const pvsCount = reader.int32("PVS count");
    const lightmapCount = reader.int32("lightmap count");

    if (magic !== "OCTA") throw new Error(`Not a Sauerbraten map: expected OCTA header, found ${JSON.stringify(magic)}.`);
    if (version < MINIMUM_MAP_VERSION || version > CURRENT_MAP_VERSION) {
      throw new Error(`Map format ${version} is not supported yet. This viewer currently supports formats ${MINIMUM_MAP_VERSION}–${CURRENT_MAP_VERSION}.`);
    }
    if (headerSize !== 40) throw new Error(`Invalid v${version} header size ${headerSize}; expected 40 bytes.`);
    if (worldSize <= 0 || (worldSize & (worldSize - 1)) !== 0) throw new Error(`Invalid world size ${worldSize}; expected a positive power of two.`);
    if (entityCount < 0 || entityCount > 1_000_000) throw new Error(`Invalid entity count ${entityCount}.`);

    const blendmap = reader.int32("blendmap flag");
    const variableCount = reader.int32("map variable count");
    const vslotCount = reader.int32("VSlot count");
    if (variableCount < 0 || variableCount > 1_000_000) throw new Error(`Invalid map variable count ${variableCount}.`);
    if (vslotCount < 0 || vslotCount > 1_000_000) throw new Error(`Invalid VSlot count ${vslotCount}.`);

    return {
      version,
      headerSize,
      worldSize,
      entityCount,
      pvsCount,
      lightmapCount,
      hasBlendmap: blendmap !== 0,
      variableCount,
      vslotCount,
    };
  }

  private readVariables(reader: BinaryReader, count: number): MapVariable[] {
    const variables: MapVariable[] = [];
    for (let index = 0; index < count; index++) {
      const serializedType = reader.uint8(`variable ${index} type`);
      const nameLength = reader.uint16(`variable ${index} name length`);
      const name = reader.text(nameLength, `variable ${index} name`);
      if (serializedType === 0) variables.push({ name, type: "integer", value: reader.int32(`${name} value`) });
      else if (serializedType === 1) variables.push({ name, type: "float", value: reader.float32(`${name} value`) });
      else if (serializedType === 2) {
        const valueLength = reader.uint16(`${name} string length`);
        variables.push({ name, type: "string", value: reader.text(valueLength, `${name} value`) });
      } else throw new Error(`Unsupported map variable type ${serializedType} for ${JSON.stringify(name)}.`);
    }
    return variables;
  }

  private readGameData(reader: BinaryReader): string {
    const gameNameLength = reader.uint8("game identifier length");
    const gameType = reader.text(gameNameLength, "game identifier");
    const terminator = reader.uint8("game identifier terminator");
    if (terminator !== 0) throw new Error("Game identifier is not null-terminated.");
    const entityExtraSize = reader.uint16("entity extra-info size");
    const gameExtraSize = reader.uint16("game data size");
    if (gameType === "fps" && entityExtraSize !== 0) throw new Error(`FPS map declares an unexpected ${entityExtraSize}-byte entity payload.`);
    reader.skip(gameExtraSize, "game-specific data");
    return gameType;
  }

  private readTextureMru(reader: BinaryReader): number[] {
    const count = reader.uint16("texture MRU count");
    return Array.from({ length: count }, (_, index) => reader.uint16(`texture MRU entry ${index}`));
  }

  private readEntities(reader: BinaryReader, count: number, gameType: string): MapEntity[] {
    if (gameType !== "fps") throw new Error(`Game type ${JSON.stringify(gameType)} is not supported by this viewer.`);
    return Array.from({ length: count }, (_, index) => ({
      position: {
        x: reader.float32(`entity ${index} x`),
        y: reader.float32(`entity ${index} y`),
        z: reader.float32(`entity ${index} z`),
      },
      attributes: [
        reader.int16(`entity ${index} attr1`),
        reader.int16(`entity ${index} attr2`),
        reader.int16(`entity ${index} attr3`),
        reader.int16(`entity ${index} attr4`),
        reader.int16(`entity ${index} attr5`),
      ],
      type: reader.uint8(`entity ${index} type`),
      ...this.skipReservedEntityByte(reader, index),
    }));
  }

  private skipReservedEntityByte(reader: BinaryReader, index: number): Record<never, never> {
    reader.uint8(`entity ${index} reserved byte`);
    return {};
  }

  // Original: src/engine/worldio.cpp
  // Function: loadvslots()
  // Sauerbraten reference: SVN r6488
  private loadvslots(reader: BinaryReader, declaredCount: number): VSlot[] {
    const vslots: VSlot[] = [];
    let remaining = declaredCount;
    while (remaining > 0) {
      const changed = reader.int32("VSlot change mask");
      if (changed < 0) {
        const blankCount = -changed;
        if (blankCount > remaining) throw new Error(`VSlot run of ${blankCount} exceeds ${remaining} remaining slots.`);
        for (let index = 0; index < blankCount; index++) vslots.push(this.createVSlot(0, -1));
        remaining -= blankCount;
        continue;
      }

      const previous = reader.int32("VSlot predecessor");
      const vslot = this.createVSlot(changed, previous);
      if (changed & (1 << 0)) {
        const parameterCount = reader.uint16("VSlot shader parameter count");
        for (let index = 0; index < parameterCount; index++) {
          const nameLength = reader.uint16("shader parameter name length");
          reader.skip(nameLength, "shader parameter name");
          reader.skip(16, "shader parameter values");
        }
      }
      if (changed & (1 << 1)) vslot.scale = reader.float32("VSlot scale");
      if (changed & (1 << 2)) vslot.rotation = reader.int32("VSlot rotation");
      if (changed & (1 << 3)) vslot.offset = [reader.int32("VSlot x offset"), reader.int32("VSlot y offset")];
      if (changed & (1 << 4)) vslot.scroll = [reader.float32("VSlot x scroll"), reader.float32("VSlot y scroll")];
      if (changed & (1 << 5)) vslot.layer = reader.int32("VSlot layer");
      if (changed & (1 << 6)) vslot.alpha = [reader.float32("VSlot front alpha"), reader.float32("VSlot back alpha")];
      if (changed & (1 << 7)) {
        vslot.color = [reader.float32("VSlot red scale"), reader.float32("VSlot green scale"), reader.float32("VSlot blue scale")];
      }
      vslots.push(vslot);
      remaining--;
    }
    return vslots;
  }

  private createVSlot(changed: number, previous: number): VSlot {
    return { changed, previous, scale: 1, rotation: 0, offset: [0, 0], scroll: [0, 0], layer: 0, alpha: [0.5, 0], color: [1, 1, 1] };
  }

  // Original: src/engine/worldio.cpp
  // Function: loadchildren()
  // Sauerbraten reference: SVN r6488
  private loadchildren(reader: BinaryReader, origin: Vec3, size: number): OctreeCube[] {
    if (size < 1) throw new Error("Octree subdivides below one world unit.");
    return Array.from({ length: 8 }, (_, index) => {
      const childOrigin = {
        x: origin.x + (index & 1 ? size : 0),
        y: origin.y + (index & 2 ? size : 0),
        z: origin.z + (index & 4 ? size : 0),
      };
      return this.loadc(reader, childOrigin, size);
    });
  }

  // Original: src/engine/worldio.cpp
  // Function: loadc()
  // Sauerbraten reference: SVN r6488
  private loadc(reader: BinaryReader, origin: Vec3, size: number): OctreeCube {
    const octsav = reader.uint8("octree node flags");
    const nodeType = octsav & 0x07;
    if (nodeType === OCTSAV_CHILDREN) {
      return this.branchCube(origin, size, this.loadchildren(reader, origin, size / 2));
    }
    const hasLodChildren = nodeType === OCTSAV_LOD_CUBE;
    if (![OCTSAV_EMPTY, OCTSAV_SOLID, OCTSAV_NORMAL, OCTSAV_LOD_CUBE].includes(nodeType)) {
      throw new Error(`Invalid octree node type ${nodeType} at byte ${reader.offset - 1}.`);
    }

    const kind = nodeType === OCTSAV_EMPTY ? "empty" : nodeType === OCTSAV_SOLID ? "solid" : "normal";
    const edges = nodeType === OCTSAV_EMPTY
      ? EMPTY_EDGES.slice()
      : nodeType === OCTSAV_SOLID ? SOLID_EDGES.slice() : reader.byteArray(12, "cube edges");
    const textures = Array.from({ length: 6 }, (_, index) => reader.uint16(`face ${index} texture`)) as OctreeCube["textures"];
    const material = octsav & 0x40
      ? this.mapversion <= 32 ? convertoldmaterial(reader.uint8("cube material")) : reader.uint16("cube material")
      : 0;
    const merged = octsav & 0x80 ? reader.uint8("merged-face mask") : 0;
    const surfaces: Array<Surface | undefined> = new Array(6);
    if (octsav & 0x20) this.readSurfaces(reader, { origin, size, kind, edges, textures, material, merged, surfaces }, surfaces);
    const cube: OctreeCube = { origin, size, kind, edges, textures, material, merged, surfaces };
    if (hasLodChildren) cube.children = this.loadchildren(reader, origin, size / 2);
    return cube;
  }

  private branchCube(origin: Vec3, size: number, children: OctreeCube[]): OctreeCube {
    return {
      origin,
      size,
      kind: "empty",
      edges: EMPTY_EDGES.slice(),
      textures: [0, 0, 0, 0, 0, 0],
      material: 0,
      merged: 0,
      surfaces: new Array(6),
      children,
    };
  }

  private readSurfaces(reader: BinaryReader, cube: OctreeCube, surfaces: Array<Surface | undefined>): void {
    const surfaceMask = reader.uint8("surface mask");
    const declaredVertexCount = reader.uint8("surface vertex count");
    let verticesRead = 0;
    for (let orientation = 0; orientation < 6; orientation++) {
      if (!(surfaceMask & (1 << orientation))) continue;
      const lightmapIds: [number, number] = [reader.uint8("primary lightmap ID"), reader.uint8("secondary lightmap ID")];
      const vertexFlags = reader.uint8("surface vertex flags");
      const encodedVertexCount = reader.uint8("surface vertex count and layers");
      const layerVertexCount = encodedVertexCount & 0x0f;
      const totalVertexCount = encodedVertexCount & 0x80 ? layerVertexCount * 2 : layerVertexCount;
      const vertices = this.readSurfaceVertices(reader, cube, orientation, vertexFlags, encodedVertexCount);
      if (vertices.length !== totalVertexCount) throw new Error(`Decoded ${vertices.length} surface vertices; expected ${totalVertexCount}.`);
      verticesRead += totalVertexCount;
      surfaces[orientation] = { lightmapIds, vertexFlags, vertexCount: encodedVertexCount, vertices };
    }
    if (verticesRead !== declaredVertexCount) {
      throw new Error(`Surface block declared ${declaredVertexCount} vertices but decoded ${verticesRead}.`);
    }
  }

  private readSurfaceVertices(reader: BinaryReader, cube: OctreeCube, orientation: number, flags: number, encodedCount: number): SurfaceVertex[] {
    const layerCount = encodedCount & 0x0f;
    const duplicated = (encodedCount & 0x80) !== 0;
    const generated = this.generatedSurfaceVertices(cube, orientation, layerCount, flags);
    let hasPosition = (flags & 0x04) !== 0;
    let hasUv = (flags & 0x40) !== 0;
    let hasNormal = (flags & 0x80) !== 0;

    if (layerCount === 4 && hasPosition && flags & 0x01) {
      this.readRectangularSurfacePositions(reader, cube, orientation, generated);
      hasPosition = false;
    }
    let rectangularDuplicateUvs: Array<[number, number]> | undefined;
    if (layerCount === 4 && hasUv && flags & 0x02) {
      this.readRectangularSurfaceUvs(reader, generated, (flags & 0x30) >> 4);
      if (duplicated) {
        const duplicateLayer = generated.map((vertex) => ({ ...vertex }));
        this.readRectangularSurfaceUvs(reader, duplicateLayer, (flags & 0x30) >> 4);
        rectangularDuplicateUvs = duplicateLayer.map((vertex) => [vertex.u, vertex.v]);
      }
      hasUv = false;
    }
    if (hasNormal && flags & 0x08) {
      const normal = reader.uint16("shared surface normal");
      generated.slice(0, layerCount).forEach((vertex) => { vertex.normal = normal; });
      hasNormal = false;
    }

    for (let index = 0; index < layerCount; index++) {
      const vertex = generated[index];
      if (hasPosition) this.readSurfacePosition(reader, cube, orientation, vertex);
      if (hasUv) [vertex.u, vertex.v] = [reader.uint16("surface u"), reader.uint16("surface v")];
      if (hasNormal) vertex.normal = reader.uint16("surface normal");
    }
    if (duplicated) {
      for (let index = 0; index < layerCount; index++) {
        const source = generated[index];
        const duplicate = { ...source };
        if (hasUv) [duplicate.u, duplicate.v] = [reader.uint16("duplicate surface u"), reader.uint16("duplicate surface v")];
        else if (rectangularDuplicateUvs) [duplicate.u, duplicate.v] = rectangularDuplicateUvs[index];
        generated.push(duplicate);
      }
    }
    return generated;
  }

  private generatedSurfaceVertices(cube: OctreeCube, orientation: number, count: number, flags: number): SurfaceVertex[] {
    const corners = faceCorners(orientation);
    const order = flags & 0x01 ? 1 : 0;
    const visibility = count < 4 ? (flags & 0x02 ? 2 : 1) : 3;
    const selected = [corners[order]];
    if (visibility & 1) selected.push(corners[order + 1]);
    selected.push(corners[order + 2]);
    if (visibility & 2) selected.push(corners[(order + 3) & 3]);
    const vertices = selected.map((corner) => ({ ...this.encodedCorner(cube, corner), u: 0, v: 0, normal: 0 })).slice(0, count);
    const fallback = vertices[0] ?? { ...this.encodedCorner(cube, corners[0]), u: 0, v: 0, normal: 0 };
    while (vertices.length < count) vertices.push({ ...fallback });
    return vertices;
  }

  private encodedCorner(cube: OctreeCube, [x, y, z]: [number, number, number]): Vec3 {
    const edge = (dimension: number, first: number, second: number) => cube.edges[dimension * 4 + second * 2 + first];
    const edgeValue = (value: number, high: number) => high ? value >> 4 : value & 0x0f;
    const local = {
      x: edgeValue(edge(0, y, z), x),
      y: edgeValue(edge(1, z, x), y),
      z: edgeValue(edge(2, x, y), z),
    };
    return {
      x: local.x * cube.size + ((cube.origin.x & 0x0fff) << 3),
      y: local.y * cube.size + ((cube.origin.y & 0x0fff) << 3),
      z: local.z * cube.size + ((cube.origin.z & 0x0fff) << 3),
    };
  }

  private readRectangularSurfacePositions(reader: BinaryReader, cube: OctreeCube, orientation: number, vertices: SurfaceVertex[]): void {
    const firstColumn = reader.uint16("surface column 1");
    const firstRow = reader.uint16("surface row 1");
    const secondColumn = reader.uint16("surface column 2");
    const secondRow = reader.uint16("surface row 2");
    const values = [[firstColumn, firstRow], [firstColumn, secondRow], [secondColumn, secondRow], [secondColumn, firstRow]];
    values.forEach(([column, row], index) => this.setSurfacePosition(cube, orientation, vertices[index], column, row));
  }

  private readSurfacePosition(reader: BinaryReader, cube: OctreeCube, orientation: number, vertex: SurfaceVertex): void {
    this.setSurfacePosition(cube, orientation, vertex, reader.uint16("surface column"), reader.uint16("surface row"));
  }

  private setSurfacePosition(cube: OctreeCube, orientation: number, vertex: SurfaceVertex, column: number, row: number): void {
    const dimension = Math.floor(orientation / 2);
    const columnDimension = [2, 0, 1][dimension];
    const rowDimension = [1, 2, 0][dimension];
    const plane = faceCorners(orientation).map((corner) => this.encodedCorner(cube, corner));
    const first = [plane[1].x - plane[0].x, plane[1].y - plane[0].y, plane[1].z - plane[0].z];
    const second = [plane[2].x - plane[0].x, plane[2].y - plane[0].y, plane[2].z - plane[0].z];
    let normal = [
      first[1] * second[2] - first[2] * second[1],
      first[2] * second[0] - first[0] * second[2],
      first[0] * second[1] - first[1] * second[0],
    ];
    // Match worldio.cpp: a deformed face can have a collapsed leading triangle while its
    // other triangle still defines a plane. This fallback is common in terrain and arches.
    if (normal[0] === 0 && normal[1] === 0 && normal[2] === 0) {
      const third = [plane[3].x - plane[0].x, plane[3].y - plane[0].y, plane[3].z - plane[0].z];
      normal = [
        second[1] * third[2] - second[2] * third[1],
        second[2] * third[0] - second[0] * third[2],
        second[0] * third[1] - second[1] * third[0],
      ];
    }
    const bias = -(normal[0] * plane[0].x + normal[1] * plane[0].y + normal[2] * plane[0].z);
    const coordinates = [vertex.x, vertex.y, vertex.z];
    coordinates[columnDimension] = column;
    coordinates[rowDimension] = row;
    if (normal[dimension] !== 0) {
      // C++ integer division truncates toward zero when rebuilding vertinfo coordinates.
      coordinates[dimension] = Math.trunc(-(bias + normal[columnDimension] * column + normal[rowDimension] * row) / normal[dimension]);
    } else coordinates[dimension] = ([cube.origin.x, cube.origin.y, cube.origin.z][dimension] & 0x0fff) << 3;
    [vertex.x, vertex.y, vertex.z] = coordinates;
  }

  private readRectangularSurfaceUvs(reader: BinaryReader, vertices: SurfaceVertex[], order: number): void {
    const v0 = vertices[order];
    const v1 = vertices[(order + 1) & 3];
    const v2 = vertices[(order + 2) & 3];
    const v3 = vertices[(order + 3) & 3];
    [v0.u, v0.v] = [reader.uint16("surface u0"), reader.uint16("surface v0")];
    [v2.u, v2.v] = [reader.uint16("surface u2"), reader.uint16("surface v2")];
    [v1.u, v1.v] = [v0.u, v2.v];
    [v3.u, v3.v] = [v2.u, v0.v];
  }
}

// Original: src/engine/worldio.cpp
// Function: convertoldmaterial()
function convertoldmaterial(mat: number): number {
  return ((mat & 7) << MATF_VOLUME_SHIFT) | (((mat >> 3) & 3) << MATF_CLIP_SHIFT) | (((mat >> 5) & 7) << MATF_FLAG_SHIFT);
}

function faceCorners(orientation: number): Array<[number, number, number]> {
  return [
    [[0, 1, 1], [0, 1, 0], [0, 0, 0], [0, 0, 1]],
    [[1, 1, 1], [1, 0, 1], [1, 0, 0], [1, 1, 0]],
    [[1, 0, 1], [0, 0, 1], [0, 0, 0], [1, 0, 0]],
    [[0, 1, 0], [0, 1, 1], [1, 1, 1], [1, 1, 0]],
    [[0, 0, 0], [0, 1, 0], [1, 1, 0], [1, 0, 0]],
    [[0, 0, 1], [1, 0, 1], [1, 1, 1], [0, 1, 1]],
  ][orientation] as Array<[number, number, number]>;
}
