import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { MapModelAsset, MapModelSkin } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { RegisteredMapEntity } from "../map/types";
import { toBabylonPosition } from "./coordinates";

export interface ModelGeometry {
  meshes: ModelGeometryMesh[];
}

export interface ModelGeometryMesh {
  name: string;
  positions: number[];
  uvs: number[];
  indices: number[];
}

export interface LoadedMapModels {
  meshes: Mesh[];
  issues: string[];
  triangles: number;
  vertices: number;
}

export async function loadMapModels(scene: Scene, entities: RegisteredMapEntity[], assets: MapModelAsset[], wireframe: boolean,
                                    generationIsCurrent: () => boolean): Promise<LoadedMapModels> {
  const meshes: Mesh[] = [];
  const issues: string[] = [];
  let triangles = 0;
  let vertices = 0;
  const referenced = new Map<number, RegisteredMapEntity[]>();
  for (const entity of entities) {
    if (entity.typeName !== "mapmodel") continue;
    const index = entity.mapModelIndex ?? -1;
    const instances = referenced.get(index) ?? [];
    instances.push(entity);
    referenced.set(index, instances);
  }
  await Promise.all([...referenced].map(async ([index, instances]) => {
    const asset = assets[index];
    if (!asset || asset.status !== "ready" || !asset.geometryPath) {
      for (const entity of instances) issues.push(modelIssue(entity, index, asset));
      return;
    }
    try {
      const geometry = await fetchModelGeometry(asset);
      if (!generationIsCurrent()) return;
      const materials = new Map<string, StandardMaterial>();
      for (const entity of instances) {
        for (const source of geometry.meshes) {
          const mesh = createModelMesh(scene, source, asset, entity, materials, wireframe);
          meshes.push(mesh);
          triangles += source.indices.length / 3;
          vertices += source.positions.length / 3;
        }
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      for (const entity of instances) issues.push(`mapmodel entity ${entity.index}: mapmodel ${index} (${asset.name}) — ${reason}`);
    }
  }));
  issues.forEach((issue) => console.warn(issue));
  return { meshes, issues, triangles, vertices };
}

function createModelMesh(scene: Scene, source: ModelGeometryMesh, asset: MapModelAsset, entity: RegisteredMapEntity,
                         materials: Map<string, StandardMaterial>, wireframe: boolean): Mesh {
  const mesh = new Mesh(`mapmodel-${entity.index}-${asset.name}-${source.name}`, scene);
  const data = new VertexData();
  const translated = translateAndScale(source.positions, asset.translate ?? [0, 0, 0], asset.scale ?? 0.25);
  data.positions = translated;
  data.uvs = source.uvs;
  data.indices = source.indices;
  const normals: number[] = [];
  VertexData.ComputeNormals(translated, source.indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh, true);
  const skin = selectSkin(asset.skins ?? [], source.name);
  const materialKey = `${source.name}:${skin?.diffusePath ?? ""}`;
  let material = materials.get(materialKey);
  if (!material) {
    material = createModelMaterial(scene, asset, skin, wireframe, materialKey);
    materials.set(materialKey, material);
  }
  mesh.material = material;
  mesh.position.copyFrom(toBabylonPosition(entity.position));
  const yaw = (entity.orientation?.yawDegrees ?? 0) + (asset.yaw ?? 0);
  mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, -(asset.pitch ?? 0) * Math.PI / 180, 0);
  mesh.metadata = { entityIndex: entity.index, entityType: entity.typeName, mapModelIndex: asset.index, mapModelName: asset.name };
  mesh.isPickable = true;
  mesh.freezeWorldMatrix();
  return mesh;
}

function translateAndScale(positions: number[], translate: [number, number, number], scale: number): number[] {
  const result = new Array<number>(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    result[index] = (positions[index] + translate[0]) * scale;
    result[index + 1] = (positions[index + 1] + translate[2]) * scale;
    result[index + 2] = (positions[index + 2] + translate[1]) * scale;
  }
  return result;
}

function createModelMaterial(scene: Scene, asset: MapModelAsset, skin: MapModelSkin | undefined, wireframe: boolean,
                             key: string): StandardMaterial {
  const material = new StandardMaterial(`mapmodel-material-${asset.index}-${key}`, scene);
  material.backFaceCulling = asset.cullFace ?? true;
  material.wireframe = wireframe;
  material.specularColor = Color3.White().scale(asset.specular ?? 1);
  material.ambientColor = Color3.White().scale(asset.ambient ?? 0.3);
  const diffuseUrl = packageAssetUrl(skin?.diffusePath);
  if (diffuseUrl) {
    const texture = new Texture(diffuseUrl, scene, false, false);
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.emissiveColor = Color3.White().scale(asset.ambient ?? 0.3);
    material.useAlphaFromDiffuseTexture = true;
  }
  const masksUrl = packageAssetUrl(skin?.masksPath);
  if (masksUrl) material.specularTexture = new Texture(masksUrl, scene, false, false);
  if (asset.alphaBlend) material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  else {
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    material.alphaCutOff = asset.alphaTest ?? 0.9;
  }
  return material;
}

function selectSkin(skins: MapModelSkin[], meshName: string): MapModelSkin | undefined {
  return skins.find((skin) => skin.mesh === meshName) ?? skins.find((skin) => skin.mesh === "*") ?? skins[0];
}

function modelIssue(entity: RegisteredMapEntity, index: number, asset: MapModelAsset | undefined): string {
  return asset
    ? `mapmodel entity ${entity.index}: mapmodel ${index} (${asset.name}) — ${asset.reason}`
    : `mapmodel entity ${entity.index}: mapmodel index ${index} is not defined by the map configuration.`;
}

async function fetchModelGeometry(asset: MapModelAsset): Promise<ModelGeometry> {
  const url = packageAssetUrl(asset.geometryPath);
  if (!url) throw new Error("The model geometry path is missing.");
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load ${asset.geometryPath} (${response.status}).`);
  if (asset.format === "OBJ") return parseObj(await response.text());
  const bytes = await response.arrayBuffer();
  if (asset.format === "MD2") return parseMd2(bytes);
  if (asset.format === "MD3") return parseMd3(bytes);
  throw new Error(`${asset.format ?? "Unknown"} model loading is not supported.`);
}

export function parseObj(source: string): ModelGeometry {
  const positions: number[][] = [];
  const texCoords: number[][] = [];
  const groups: Array<{ name: string; faces: string[][] }> = [];
  let group = { name: "mesh", faces: [] as string[][] };
  groups.push(group);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "v") positions.push(fields.slice(1, 4).map(Number));
    else if (fields[0] === "vt") texCoords.push(fields.slice(1, 3).map(Number));
    else if (fields[0] === "g" || fields[0] === "o") {
      if (group.faces.length || groups.length === 1 && group.name !== "mesh") {
        group = { name: fields.slice(1).join(" ") || "mesh", faces: [] };
        groups.push(group);
      } else group.name = fields.slice(1).join(" ") || "mesh";
    } else if (fields[0] === "f" && fields.length >= 4) group.faces.push(fields.slice(1));
  }
  return { meshes: groups.filter((item) => item.faces.length).map((item) => buildObjGroup(item.name, item.faces, positions, texCoords)) };
}

function buildObjGroup(name: string, faces: string[][], sourcePositions: number[][], sourceUvs: number[][]): ModelGeometryMesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertexIndex = (token: string): number => {
    const cached = vertices.get(token);
    if (cached !== undefined) return cached;
    const fields = token.split("/");
    const positionIndex = objIndex(fields[0], sourcePositions.length);
    const uvIndex = objIndex(fields[1], sourceUvs.length);
    const position = sourcePositions[positionIndex] ?? [0, 0, 0];
    const uv = sourceUvs[uvIndex] ?? [0, 0];
    const index = positions.length / 3;
    positions.push(position[2], position[1], -position[0]);
    uvs.push(uv[0], 1 - uv[1]);
    vertices.set(token, index);
    return index;
  };
  for (const face of faces) {
    const faceIndices = face.map(vertexIndex);
    for (let index = 1; index + 1 < faceIndices.length; index++) indices.push(faceIndices[0], faceIndices[index], faceIndices[index + 1]);
  }
  return { name, positions, uvs, indices };
}

function objIndex(value: string | undefined, length: number): number {
  const parsed = Number(value);
  return !Number.isFinite(parsed) || parsed === 0 ? -1 : parsed < 0 ? length + parsed : parsed - 1;
}

export function parseMd2(buffer: ArrayBuffer): ModelGeometry {
  const view = new DataView(buffer);
  if (view.byteLength < 68 || view.getInt32(0, true) !== 844121161 || view.getInt32(4, true) !== 8) throw new Error("Invalid MD2 header.");
  const frameSize = view.getInt32(16, true);
  const vertexCount = view.getInt32(24, true);
  const frameCount = view.getInt32(40, true);
  const commandCount = view.getInt32(44, true);
  const frameOffset = view.getInt32(56, true);
  const commandOffset = view.getInt32(64, true);
  if (frameCount <= 0 || vertexCount <= 0 || commandCount <= 0 || frameOffset + frameSize > view.byteLength) throw new Error("Invalid MD2 dimensions.");
  const scale = [view.getFloat32(frameOffset, true), view.getFloat32(frameOffset + 4, true), view.getFloat32(frameOffset + 8, true)];
  const translate = [view.getFloat32(frameOffset + 12, true), view.getFloat32(frameOffset + 16, true), view.getFloat32(frameOffset + 20, true)];
  const frameVertices: number[][] = [];
  for (let index = 0; index < vertexCount; index++) {
    const offset = frameOffset + 40 + index * 4;
    frameVertices.push([
      view.getUint8(offset) * scale[0] + translate[0],
      view.getUint8(offset + 2) * scale[2] + translate[2],
      -(view.getUint8(offset + 1) * scale[1] + translate[1]),
    ]);
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();
  let offset = commandOffset;
  while (offset + 4 <= view.byteLength) {
    let count = view.getInt32(offset, true);
    offset += 4;
    if (count === 0) break;
    const fan = count < 0;
    count = Math.abs(count);
    const strip: number[] = [];
    for (let index = 0; index < count; index++, offset += 12) {
      if (offset + 12 > view.byteLength) throw new Error("Truncated MD2 command list.");
      const u = view.getFloat32(offset, true);
      const v = view.getFloat32(offset + 4, true);
      const sourceIndex = view.getInt32(offset + 8, true);
      const key = `${sourceIndex}:${u}:${v}`;
      let target = vertexMap.get(key);
      if (target === undefined) {
        target = positions.length / 3;
        positions.push(...(frameVertices[sourceIndex] ?? [0, 0, 0]));
        uvs.push(u, v);
        vertexMap.set(key, target);
      }
      strip.push(target);
    }
    for (let index = 0; index < count - 2; index++) {
      const triangle = fan ? [strip[0], strip[index + 1], strip[index + 2]]
        : index % 2 ? [strip[index], strip[index + 2], strip[index + 1]] : [strip[index], strip[index + 1], strip[index + 2]];
      indices.push(triangle[2], triangle[1], triangle[0]);
    }
  }
  return { meshes: [{ name: "mesh", positions, uvs, indices }] };
}

export function parseMd3(buffer: ArrayBuffer): ModelGeometry {
  const view = new DataView(buffer);
  if (view.byteLength < 108 || readAscii(view, 0, 4) !== "IDP3" || view.getInt32(4, true) !== 15) throw new Error("Invalid MD3 header.");
  const meshCount = view.getInt32(84, true);
  let meshOffset = view.getInt32(100, true);
  const meshes: ModelGeometryMesh[] = [];
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    if (meshOffset + 108 > view.byteLength || readAscii(view, meshOffset, 4) !== "IDP3") throw new Error("Invalid MD3 mesh header.");
    const name = readAscii(view, meshOffset + 4, 64) || `mesh-${meshIndex}`;
    const vertexCount = view.getInt32(meshOffset + 80, true);
    const triangleCount = view.getInt32(meshOffset + 84, true);
    const triangleOffset = meshOffset + view.getInt32(meshOffset + 88, true);
    const uvOffset = meshOffset + view.getInt32(meshOffset + 96, true);
    const vertexOffset = meshOffset + view.getInt32(meshOffset + 100, true);
    const meshSize = view.getInt32(meshOffset + 104, true);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let index = 0; index < vertexCount; index++) {
      positions.push(view.getInt16(vertexOffset + index * 8, true) / 64, view.getInt16(vertexOffset + index * 8 + 4, true) / 64,
        -view.getInt16(vertexOffset + index * 8 + 2, true) / 64);
      uvs.push(view.getFloat32(uvOffset + index * 8, true), view.getFloat32(uvOffset + index * 8 + 4, true));
    }
    for (let index = 0; index < triangleCount; index++) {
      const offset = triangleOffset + index * 12;
      indices.push(view.getInt32(offset + 8, true), view.getInt32(offset + 4, true), view.getInt32(offset, true));
    }
    meshes.push({ name, positions, uvs, indices });
    meshOffset += meshSize;
  }
  return { meshes };
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length && offset + index < view.byteLength; index++) {
    const value = view.getUint8(offset + index);
    if (!value) break;
    result += String.fromCharCode(value);
  }
  return result;
}
