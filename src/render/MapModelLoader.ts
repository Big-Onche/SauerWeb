import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion } from "@babylonjs/core/Maths/math.vector";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import type { MapModelAsset, MapModelMeshSettings, MapModelSkin } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { RegisteredMapEntity } from "../engine/octa";
import { toBabylonPosition } from "./coordinates";
import { selectModelSkin } from "./modelSkin";
import type { MapModelCollision } from "../engine/physics/collision";
import { parseIqm, parseMd2, parseMd3, parseMd5, parseObj, type ModelGeometry, type ModelGeometryMesh } from "../engine/rendermodel";

export interface LoadedMapModels {
  meshes: Mesh[];
  issues: string[];
  triangles: number;
  vertices: number;
  collisions: MapModelCollision[];
  animations: EntityModelAnimation[];
  resources: MapModelResources;
}

export class MapModelResources {
  private readonly materials = new Set<StandardMaterial>();
  private readonly textures = new Set<Texture>();

  ownMaterial(material: StandardMaterial): StandardMaterial {
    this.materials.add(material);
    return material;
  }

  ownTexture(texture: Texture): Texture {
    this.textures.add(texture);
    return texture;
  }

  dispose(): void {
    this.materials.forEach((material) => material.dispose(false, false));
    this.textures.forEach((texture) => texture.dispose());
    this.materials.clear();
    this.textures.clear();
  }
}

export interface EntityModelAnimation {
  meshes: Mesh[];
  entity: RegisteredMapEntity;
  asset: MapModelAsset;
}
export async function loadMapModels(scene: Scene, entities: RegisteredMapEntity[], assets: MapModelAsset[], wireframe: boolean,
                                    generationIsCurrent: () => boolean, teleporter?: MapModelAsset,
                                    pickupModels: MapModelAsset[] = []): Promise<LoadedMapModels> {
  const meshes: Mesh[] = [];
  const issues: string[] = [];
  let triangles = 0;
  let vertices = 0;
  const collisions: MapModelCollision[] = [];
  const animations: EntityModelAnimation[] = [];
  const resources = new MapModelResources();
  const referenced = new Map<number, RegisteredMapEntity[]>();
  for (const entity of entities) {
    if (entity.typeName !== "mapmodel") continue;
    const index = entity.mapModelIndex ?? -1;
    const instances = referenced.get(index) ?? [];
    instances.push(entity);
    referenced.set(index, instances);
  }
  const teleports = new Map<number, RegisteredMapEntity[]>();
  for (const entity of entities) {
    if (entity.typeName !== "teleport" || (entity.attributes[1] ?? 0) < 0) continue;
    const index = entity.attributes[1] ?? 0;
    const instances = teleports.get(index) ?? [];
    instances.push(entity);
    teleports.set(index, instances);
  }
  const jobs: Array<{ index: number; instances: RegisteredMapEntity[]; asset: MapModelAsset | undefined; animated: boolean }> =
    [...referenced].map(([index, instances]) => ({ index, instances, asset: assets[index], animated: false }));
  jobs.push(...[...teleports].map(([index, instances]) => ({
    index, instances, asset: index > 0 ? assets[index] : teleporter, animated: true,
  })));
  for (let type = 8; type <= 18; type++) {
    const instances = entities.filter((entity) => entity.type === type);
    if (instances.length) jobs.push({ index: type, instances, asset: pickupModels[type - 8], animated: true });
  }
  await Promise.all(jobs.map(async ({ index, instances, asset, animated }) => {
    if (!asset || asset.status !== "ready" || !asset.geometryPath) {
      for (const entity of instances) issues.push(modelIssue(entity, index, asset));
      return;
    }
    try {
      const geometry = await fetchModelGeometry(asset);
      if (!generationIsCurrent()) return;
      const materials = new Map<string, StandardMaterial>();
      if (!animated && asset.collide !== false) {
        const bounds = collisionBounds(geometry, asset);
        for (const entity of instances) {
          if (!mapModelInitiallyCollides(entity.attributes[2])) continue;
          collisions.push({
            entityIndex: entity.index,
            origin: { ...entity.position },
            yaw: entity.orientation?.yawDegrees ?? 0,
            center: bounds.center,
            radius: bounds.radius,
            ellipse: asset.ellipseCollide === true,
          });
        }
      }
      for (const entity of instances) {
        const animation: EntityModelAnimation = { meshes: [], entity, asset };
        for (const source of geometry.meshes) {
          const mesh = createModelMesh(scene, source, asset, entity, materials, resources, wireframe, animated);
          meshes.push(mesh);
          animation.meshes.push(mesh);
          triangles += source.indices.length / 3;
          vertices += source.positions.length / 3;
        }
        if (animated) animations.push(animation);
      }
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      for (const entity of instances) issues.push(`mapmodel entity ${entity.index}: mapmodel ${index} (${asset.name}) — ${reason}`);
    }
  }));
  issues.forEach((issue) => console.warn(issue));
  return { meshes, issues, triangles, vertices, collisions, animations, resources };
}

// Original: src/fpsgame/entities.cpp
// Function: renderentities()
// Sauerbraten reference: SVN r6488
export function animateEntityModels(animations: readonly EntityModelAnimation[], lastmillis: number,
                                    visible: (entity: RegisteredMapEntity) => boolean = () => true): void {
  for (const animation of animations) {
    const position = { ...animation.entity.position,
      z: animation.entity.position.z + 1 + Math.sin(lastmillis / 100 + animation.entity.position.x + animation.entity.position.y) / 20 };
    const yaw = lastmillis / 10 + (animation.asset.yaw ?? 0);
    for (const mesh of animation.meshes) {
      mesh.setEnabled(visible(animation.entity));
      mesh.position.copyFrom(toBabylonPosition(position));
      mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, -(animation.asset.pitch ?? 0) * Math.PI / 180, 0);
    }
  }
}

function mapModelInitiallyCollides(triggerType: number): boolean {
  const type = triggerType & 31;
  const valid = type >= 1 && type <= 14 || type === 29;
  return !valid || type === 9 || type === 10 || type === 11 || type === 14;
}

function collisionBounds(geometry: ModelGeometry, asset: MapModelAsset): {
  center: RegisteredMapEntity["position"];
  radius: RegisteredMapEntity["position"];
} {
  const minimum = { x: Infinity, y: Infinity, z: Infinity };
  const maximum = { x: -Infinity, y: -Infinity, z: -Infinity };
  for (const mesh of geometry.meshes) {
    const positions = translateAndScale(mesh.positions, asset.translate ?? [0, 0, 0], asset.scale ?? 0.25);
    for (let index = 0; index < positions.length; index += 3) {
      minimum.x = Math.min(minimum.x, positions[index]); maximum.x = Math.max(maximum.x, positions[index]);
      minimum.y = Math.min(minimum.y, positions[index + 2]); maximum.y = Math.max(maximum.y, positions[index + 2]);
      minimum.z = Math.min(minimum.z, positions[index + 1]); maximum.z = Math.max(maximum.z, positions[index + 1]);
    }
  }
  const extend = asset.boundingBoxExtend ?? [0, 0, 0];
  const center = { x: (minimum.x + maximum.x) / 2, y: (minimum.y + maximum.y) / 2, z: (minimum.z + maximum.z) / 2 };
  const radius = {
    x: (maximum.x - minimum.x) / 2 + extend[0],
    y: (maximum.y - minimum.y) / 2 + extend[1],
    z: (maximum.z - minimum.z) / 2 + extend[2],
  };
  if (asset.collisionRadius) { center.x = center.y = 0; radius.x = radius.y = asset.collisionRadius; }
  if (asset.collisionHeight) { center.z = radius.z = asset.collisionHeight / 2; }
  return { center, radius };
}

function createModelMesh(scene: Scene, source: ModelGeometryMesh, asset: MapModelAsset, entity: RegisteredMapEntity,
                         materials: Map<string, StandardMaterial>, resources: MapModelResources, wireframe: boolean,
                         animated = false): Mesh {
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
  const skin = selectModelSkin(asset.skins ?? [], source.name);
  const meshSettings = selectMeshSettings(asset.meshSettings ?? [], source.name);
  const materialKey = `${source.name}:${skin?.diffusePath ?? ""}:${meshSettings?.cullFace ?? asset.cullFace ?? true}`;
  let material = materials.get(materialKey);
  if (!material) {
    material = createModelMaterial(scene, asset, skin, meshSettings, resources, wireframe, materialKey);
    materials.set(materialKey, material);
  }
  mesh.material = material;
  mesh.position.copyFrom(toBabylonPosition(entity.position));
  const yaw = (entity.orientation?.yawDegrees ?? 0) + (asset.yaw ?? 0);
  mesh.rotationQuaternion = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, -(asset.pitch ?? 0) * Math.PI / 180, 0);
  mesh.metadata = { entityIndex: entity.index, entityType: entity.typeName, mapModelIndex: asset.index, mapModelName: asset.name };
  mesh.isPickable = true;
  if (!animated) mesh.freezeWorldMatrix();
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

function createModelMaterial(scene: Scene, asset: MapModelAsset, skin: MapModelSkin | undefined,
                             meshSettings: MapModelMeshSettings | undefined, resources: MapModelResources, wireframe: boolean,
                             key: string): StandardMaterial {
  const material = resources.ownMaterial(new StandardMaterial(`mapmodel-material-${asset.index}-${key}`, scene));
  material.backFaceCulling = meshSettings?.cullFace ?? asset.cullFace ?? true;
  material.wireframe = wireframe;
  material.specularColor = Color3.White().scale(asset.specular ?? 1);
  material.ambientColor = Color3.White().scale(asset.ambient ?? 0.3);
  const diffuseUrl = packageAssetUrl(skin?.diffusePath);
  if (diffuseUrl) {
    const texture = resources.ownTexture(new Texture(diffuseUrl, scene, false, false));
    texture.hasAlpha = true;
    material.diffuseTexture = texture;
    material.emissiveTexture = texture;
    material.emissiveColor = Color3.White().scale(Math.max(asset.ambient ?? 0.3, Math.min(asset.glow ?? 0, 1)));
    material.useAlphaFromDiffuseTexture = true;
  }
  const masksUrl = packageAssetUrl(skin?.masksPath);
  if (masksUrl) material.specularTexture = resources.ownTexture(new Texture(masksUrl, scene, false, false));
  if (asset.alphaBlend) material.transparencyMode = Material.MATERIAL_ALPHABLEND;
  else {
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    material.alphaCutOff = asset.alphaTest ?? 0.9;
  }
  return material;
}

function selectMeshSettings(settings: MapModelMeshSettings[], meshName: string): MapModelMeshSettings | undefined {
  return settings.find((item) => item.mesh === meshName) ?? settings.find((item) => item.mesh === "*");
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
  if (asset.format === "MD5") return parseMd5(await response.text());
  const bytes = await response.arrayBuffer();
  if (asset.format === "MD2") return parseMd2(bytes);
  if (asset.format === "MD3") return parseMd3(bytes);
  if (asset.format === "IQM") return parseIqm(bytes);
  throw new Error(`${asset.format ?? "Unknown"} model loading is not supported.`);
}
