import { BinaryReader } from "./binaryreader";
import { collectMaterialVolumes, MATF_CLIP_SHIFT, MATF_FLAG_SHIFT, MATF_VOLUME_SHIFT } from "./material";
import { createFpsEntityRegistry } from "../fpsgame/entities";
import type { Lightmap, MapEntity, MapHeader, MapVariable, OctreeCube, SauerMap, Surface, SurfaceVertex, Vec3, VSlot } from "./octa";

const CURRENT_MAP_VERSION = 33;
const MINIMUM_MAP_VERSION = 29;
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
const LMID_AMBIENT = 0;
const LMID_RESERVED = 6;
const LAYER_TOP = 1 << 5;
const LAYER_BOTTOM = 1 << 6;
const LAYER_DUP = 1 << 7;
const LAYER_BLEND = LAYER_TOP | LAYER_BOTTOM;
const ET_MAPMODEL = 2;
const ET_PLAYERSTART = 3;
const ET_GAMESPECIFIC = 8;

interface SurfaceCompat {
  texcoords: Uint8Array;
  w: number;
  h: number;
  x: number;
  y: number;
  lmid: number;
  layer: number;
}

type NormalCompat = [number, number, number];

interface MergeCompat {
  u1: number;
  u2: number;
  v1: number;
  v2: number;
}

interface GameData {
  gameType: string;
  entityExtraSize: number;
}

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
    const { gameType, entityExtraSize } = this.readGameData(reader);
    const textureMru = this.readTextureMru(reader);
    const entities = this.readEntities(reader, header.entityCount, gameType, entityExtraSize);
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
      throw new Error(
        `Map format ${version} is not supported yet. This viewer currently supports formats ${MINIMUM_MAP_VERSION}–${CURRENT_MAP_VERSION}.`,
      );
    }
    const expectedHeaderSize = version <= 29 ? 36 : 40;
    if (headerSize !== expectedHeaderSize) {
      throw new Error(`Invalid v${version} header size ${headerSize}; expected ${expectedHeaderSize} bytes.`);
    }
    if (worldSize <= 0 || (worldSize & (worldSize - 1)) !== 0) throw new Error(`Invalid world size ${worldSize}; expected a positive power of two.`);
    if (entityCount < 0 || entityCount > 1_000_000) throw new Error(`Invalid entity count ${entityCount}.`);

    const blendmap = reader.int32("blendmap flag");
    const variableCount = reader.int32("map variable count");
    const vslotCount = version <= 29 ? 0 : reader.int32("VSlot count");
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

  private readGameData(reader: BinaryReader): GameData {
    const gameNameLength = reader.uint8("game identifier length");
    const gameType = reader.text(gameNameLength, "game identifier");
    const terminator = reader.uint8("game identifier terminator");
    if (terminator !== 0) throw new Error("Game identifier is not null-terminated.");
    const entityExtraSize = reader.uint16("entity extra-info size");
    const gameExtraSize = reader.uint16("game data size");
    if (gameType === "fps" && entityExtraSize !== 0) throw new Error(`FPS map declares an unexpected ${entityExtraSize}-byte entity payload.`);
    reader.skip(gameExtraSize, "game-specific data");
    return { gameType, entityExtraSize };
  }

  private readTextureMru(reader: BinaryReader): number[] {
    const count = reader.uint16("texture MRU count");
    return Array.from({ length: count }, (_, index) => reader.uint16(`texture MRU entry ${index}`));
  }

  private readEntities(reader: BinaryReader, count: number, gameType: string, entityExtraSize: number): MapEntity[] {
    const entities: MapEntity[] = [];
    for (let index = 0; index < count; index++) {
      const entity: MapEntity = {
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
      };
      fixent(entity, this.mapversion);
      if (gameType !== "fps") reader.skip(entityExtraSize, `entity ${index} game-specific data`);
      if (gameType === "fps" || entity.type < ET_GAMESPECIFIC) entities.push(entity);
    }
    return entities;
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
    const cube: OctreeCube = { origin, size, kind, edges, textures, material: 0, merged: 0, surfaces: new Array(6) };
    if (this.mapversion <= 31) this.readCompatCube(reader, octsav, cube);
    else {
      cube.material = octsav & 0x40
        ? this.mapversion <= 32 ? convertoldmaterial(reader.uint8("cube material")) : reader.uint16("cube material")
        : 0;
      cube.merged = octsav & 0x80 ? reader.uint8("merged-face mask") : 0;
      if (octsav & 0x20) this.readSurfaces(reader, cube, cube.surfaces);
    }
    if (hasLodChildren) cube.children = this.loadchildren(reader, origin, size / 2);
    return cube;
  }

  private readCompatCube(reader: BinaryReader, octsav: number, cube: OctreeCube): void {
    const mask = reader.uint8("legacy cube mask");
    if (mask & 0x80) cube.material = convertoldmaterial(reader.uint8("legacy cube material"));

    const surfaces: Array<SurfaceCompat | undefined> = new Array(12);
    const normals: Array<NormalCompat[] | undefined> = new Array(6);
    const merges: Array<MergeCompat | undefined> = new Array(6);
    let hassurfs = 0;
    let hasnorms = 0;
    let hasmerges = 0;
    if (mask & 0x3f) {
      let numsurfs = 6;
      for (let index = 0; index < numsurfs; index++) {
        if (index < 6 && !(mask & (1 << index))) continue;
        const surface = this.readSurfaceCompat(reader, index);
        surfaces[index] = surface;
        if (index >= 6) continue;
        if (mask & 0x40) {
          hasnorms |= 1 << index;
          normals[index] = Array.from({ length: 4 }, (_, normalIndex) => [
            reader.uint8(`legacy surface ${index} normal ${normalIndex} x`),
            reader.uint8(`legacy surface ${index} normal ${normalIndex} y`),
            reader.uint8(`legacy surface ${index} normal ${normalIndex} z`),
          ]);
        }
        if (surface.layer !== 0 || surface.lmid !== LMID_AMBIENT) hassurfs |= 1 << index;
        if (surface.layer & 2) numsurfs++;
      }
    }

    if (octsav & 0x80) {
      const merged = reader.uint8("legacy merged-face mask");
      cube.merged = merged & 0x3f;
      if (merged & 0x80) {
        const mergeMask = reader.uint8("legacy merge bounds mask");
        hasmerges = mergeMask & 0x3f;
        for (let orientation = 0; orientation < 6; orientation++) {
          if (!(mergeMask & (1 << orientation))) continue;
          merges[orientation] = {
            u1: reader.uint16(`legacy merge ${orientation} u1`),
            u2: reader.uint16(`legacy merge ${orientation} u2`),
            v1: reader.uint16(`legacy merge ${orientation} v1`),
            v2: reader.uint16(`legacy merge ${orientation} v2`),
          };
        }
      }
    }
    if (hassurfs || hasnorms || hasmerges) this.convertoldsurfaces(cube, surfaces, hassurfs, normals, hasnorms, merges, hasmerges);
  }

  private readSurfaceCompat(reader: BinaryReader, index: number): SurfaceCompat {
    return {
      texcoords: reader.byteArray(8, `legacy surface ${index} texture coordinates`),
      w: reader.uint8(`legacy surface ${index} width`),
      h: reader.uint8(`legacy surface ${index} height`),
      x: reader.uint16(`legacy surface ${index} x`),
      y: reader.uint16(`legacy surface ${index} y`),
      lmid: reader.uint8(`legacy surface ${index} lightmap ID`),
      layer: reader.uint8(`legacy surface ${index} layer`),
    };
  }

  // Original: src/engine/worldio.cpp
  // Function: convertoldsurfaces()
  private convertoldsurfaces(cube: OctreeCube, srcsurfs: Array<SurfaceCompat | undefined>, hassurfs: number,
                             normals: Array<NormalCompat[] | undefined>, hasnorms: number, merges: Array<MergeCompat | undefined>,
                             hasmerges: number): void {
    let numsurfs = 6;
    for (let orientation = 0; orientation < 6; orientation++) {
      if (!((hassurfs | hasnorms | hasmerges) & (1 << orientation))) continue;
      const lightmapIds: [number, number] = [LMID_AMBIENT, LMID_AMBIENT];
      let vertexCount = 0;
      let src: SurfaceCompat | undefined;
      let blend: SurfaceCompat | undefined;
      if (hassurfs & (1 << orientation)) {
        src = srcsurfs[orientation];
        if (!src) throw new Error(`Missing legacy surface ${orientation}.`);
        if (src.layer & 2) {
          blend = srcsurfs[numsurfs++];
          if (!blend) throw new Error(`Missing legacy blend surface for orientation ${orientation}.`);
          lightmapIds[0] = src.lmid;
          lightmapIds[1] = blend.lmid;
          vertexCount |= LAYER_BLEND;
          if (blend.lmid >= LMID_RESERVED && !sameCompatLightmap(src, blend)) vertexCount |= LAYER_DUP;
        } else if (src.layer === 1) {
          lightmapIds[1] = src.lmid;
          vertexCount |= LAYER_BOTTOM;
        } else {
          lightmapIds[0] = src.lmid;
          vertexCount |= LAYER_TOP;
        }
      } else vertexCount |= LAYER_TOP;

      const uselms = !!(hassurfs & (1 << orientation)) &&
        (lightmapIds[0] >= LMID_RESERVED || lightmapIds[1] >= LMID_RESERVED || !!(vertexCount & ~LAYER_TOP));
      const merge = merges[orientation];
      const usemerges = !!(hasmerges & (1 << orientation)) && !!merge && merge.u1 < merge.u2 && merge.v1 < merge.v2;
      const faceNormals = normals[orientation];
      const usenorms = !!(hasnorms & (1 << orientation)) && !!faceNormals && !sameNormal(faceNormals[0], [128, 128, 128]);
      if (!uselms && !usemerges && !usenorms) continue;

      const face = faceCorners(orientation).map((corner) => this.encodedCorner(cube, corner));
      const e1 = subtractVec3(face[1], face[0]);
      const e2 = subtractVec3(face[2], face[0]);
      const normal = crossVec3(e1, e2);
      const positions = usemerges
        ? this.oldMergePositions(cube, orientation, face, normal, merge!)
        : this.oldFacePositions(face, e2, normal);
      const vertices: SurfaceVertex[] = [];
      positions.forEach((position, index) => {
        if (index > 0 && (sameVec3(position, positions[0]) || sameVec3(position, positions[index - 1]))) return;
        vertices.push({
          ...position,
          ...this.oldLightmapCoordinates(src, index, true, uselms),
          normal: usenorms && faceNormals && !sameNormal(faceNormals[index], [128, 128, 128]) ? encodeNormal(faceNormals[index]) : 0,
        });
      });
      vertexCount |= vertices.length;
      if (vertexCount & LAYER_DUP) {
        positions.forEach((position, index) => {
          if (index > 0 && (sameVec3(position, positions[0]) || sameVec3(position, positions[index - 1]))) return;
          vertices.push({
            ...position,
            ...this.oldLightmapCoordinates(blend, index, false, true),
            normal: usenorms && faceNormals && !sameNormal(faceNormals[index], [128, 128, 128]) ? encodeNormal(faceNormals[index]) : 0,
          });
        });
      }
      cube.surfaces[orientation] = { lightmapIds, vertexFlags: 0, vertexCount, vertices };
    }
  }

  private oldMergePositions(cube: OctreeCube, orientation: number, face: Vec3[], normal: Vec3, merge: MergeCompat): Vec3[] {
    const dimension = Math.floor(orientation / 2);
    const columnDimension = [2, 0, 1][dimension];
    const rowDimension = [1, 2, 0][dimension];
    const offset = -dotVec3(normal, face[0]);
    return faceCorners(orientation).map((corner) => {
      const coordinates = [0, 0, 0];
      coordinates[columnDimension] = corner[columnDimension] ? merge.u2 : merge.u1;
      coordinates[rowDimension] = corner[rowDimension] ? merge.v2 : merge.v1;
      coordinates[dimension] = vectorComponent(normal, dimension)
        ? Math.trunc(-(offset + vectorComponent(normal, columnDimension) * coordinates[columnDimension] +
          vectorComponent(normal, rowDimension) * coordinates[rowDimension]) / vectorComponent(normal, dimension))
        : (vectorComponent(cube.origin, dimension) & 0x0fff) << 3;
      return { x: coordinates[0], y: coordinates[1], z: coordinates[2] };
    });
  }

  private oldFacePositions(face: Vec3[], e2: Vec3, normal: Vec3): Vec3[] {
    const e3 = subtractVec3(face[0], face[3]);
    const convex = dotVec3(e3, normal);
    let visibility = 3;
    if (!convex) {
      if (isZeroVec3(crossVec3(e3, e2))) {
        if (!isZeroVec3(normal)) visibility = 1;
      } else if (isZeroVec3(normal)) visibility = 2;
    }
    const order = convex < 0 ? 1 : 0;
    return [
      face[order],
      visibility & 1 ? face[order + 1] : face[order],
      face[order + 2],
      visibility & 2 ? face[(order + 3) & 3] : face[order],
    ].map((position) => ({ ...position }));
  }

  private oldLightmapCoordinates(surface: SurfaceCompat | undefined, index: number, round: boolean,
                                 enabled: boolean): Pick<SurfaceVertex, "u" | "v"> {
    if (!enabled || !surface) return { u: 0, v: 0 };
    const u = surface.x + surface.texcoords[index * 2] / 255 * (surface.w - 1);
    const v = surface.y + surface.texcoords[index * 2 + 1] / 255 * (surface.h - 1);
    return {
      u: clampUshort(Math.floor(u * 65536 / LIGHTMAP_WIDTH + (round ? 0.5 : 0))),
      v: clampUshort(Math.floor(v * 65536 / LIGHTMAP_HEIGHT + (round ? 0.5 : 0))),
    };
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

// Original: src/engine/worldio.cpp
// Function: fixent()
function fixent(entity: MapEntity, version: number): void {
  if (version <= 30 && (entity.type === ET_MAPMODEL || entity.type === ET_PLAYERSTART)) {
    entity.attributes[0] = (entity.attributes[0] + 180) % 360;
  }
  if (version <= 31 && entity.type === ET_MAPMODEL) {
    const yaw = (entity.attributes[0] % 360 + 360) % 360 + 7;
    entity.attributes[0] = yaw - yaw % 15;
  }
}

function sameCompatLightmap(left: SurfaceCompat, right: SurfaceCompat): boolean {
  return left.x === right.x && left.y === right.y && left.w === right.w && left.h === right.h &&
    left.texcoords.every((value, index) => value === right.texcoords[index]);
}

function subtractVec3(left: Vec3, right: Vec3): Vec3 {
  return { x: left.x - right.x, y: left.y - right.y, z: left.z - right.z };
}

function crossVec3(left: Vec3, right: Vec3): Vec3 {
  return {
    x: left.y * right.z - left.z * right.y,
    y: left.z * right.x - left.x * right.z,
    z: left.x * right.y - left.y * right.x,
  };
}

function dotVec3(left: Vec3, right: Vec3): number {
  return left.x * right.x + left.y * right.y + left.z * right.z;
}

function vectorComponent(vector: Vec3, dimension: number): number {
  return dimension === 0 ? vector.x : dimension === 1 ? vector.y : vector.z;
}

function sameVec3(left: Vec3, right: Vec3): boolean {
  return left.x === right.x && left.y === right.y && left.z === right.z;
}

function isZeroVec3(vector: Vec3): boolean {
  return vector.x === 0 && vector.y === 0 && vector.z === 0;
}

function sameNormal(left: NormalCompat, right: NormalCompat): boolean {
  return left[0] === right[0] && left[1] === right[1] && left[2] === right[2];
}

function encodeNormal(normal: NormalCompat): number {
  let x = normal[0] * (2 / 255) - 1;
  let y = normal[1] * (2 / 255) - 1;
  let z = normal[2] * (2 / 255) - 1;
  const magnitude = Math.hypot(x, y, z);
  if (!magnitude) return 0;
  x /= magnitude;
  y /= magnitude;
  z /= magnitude;
  const yaw = Math.trunc(-Math.atan2(x, y) * 180 / Math.PI);
  const pitch = Math.trunc(Math.asin(Math.min(1, Math.max(-1, z))) * 180 / Math.PI);
  return Math.min(180, Math.max(0, pitch + 90)) * 360 + (yaw < 0 ? yaw % 360 + 360 : yaw % 360) + 1;
}

function clampUshort(value: number): number {
  return Math.min(0xffff, Math.max(0, value));
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
