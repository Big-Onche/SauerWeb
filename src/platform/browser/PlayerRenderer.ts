import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { MapModelAsset, PlayerModelAsset } from "../../assets/types";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { modelAnimationPosition, type ModelAnimationPosition } from "../../engine/modelanimation";
import { interpolateModelGeometry, iqmAnimationInfo, md5AnimationInfo, parseIqm, parseMd5, type ModelGeometry,
  type ModelGeometryMesh } from "../../engine/rendermodel";
import type { Vec3 } from "../../engine/octa";
import { getplayermodelinfo, playerSkin, renderclient, type RenderClientState } from "../../fpsgame/render";
import { toBabylonPosition } from "../../render/coordinates";
import { selectModelSkin } from "../../render/modelSkin";

export interface RenderPlayer extends RenderClientState {
  id: number;
  model: number;
  team: string;
  local: boolean;
  visible: boolean;
  position: Vec3;
  yaw: number;
  pitch: number;
}

interface PlayerModelInstance {
  root: TransformNode;
  meshes: Mesh[];
  visualKey: string;
  animation: string;
  frame: number;
  updateToken: number;
  positioned: boolean;
}

// Browser counterpart of src/fpsgame/render.cpp's model batching. Ragdoll state is deliberately not represented yet.
export class PlayerRenderer {
  private readonly instances = new Map<number, PlayerModelInstance>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly textSources = new Map<string, Promise<string>>();
  private readonly binarySources = new Map<string, Promise<ArrayBuffer>>();
  private readonly geometryFrames = new Map<string, ModelGeometry>();
  private assets?: Promise<PlayerModelAsset[]>;

  constructor(private readonly scene: Scene) {}

  rendergame(players: readonly RenderPlayer[], gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    const active = new Set<number>();
    for (const player of players) {
      active.add(player.id);
      this.renderplayer(player, gameMode, teamskins, localTeam, nowMilliseconds);
    }
    for (const [id, instance] of this.instances) {
      if (active.has(id)) continue;
      this.disposeInstance(instance);
      this.instances.delete(id);
    }
  }

  clear(): void {
    this.instances.forEach((instance) => this.disposeInstance(instance));
    this.instances.clear();
    this.materials.forEach((material) => material.dispose(true, true));
    this.materials.clear();
  }

  private renderplayer(player: RenderPlayer, gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    let instance = this.instances.get(player.id);
    if (!instance) {
      instance = { root: new TransformNode(`player-${player.id}`, this.scene), meshes: [], visualKey: "", animation: "", frame: -1, updateToken: 0,
        positioned: false };
      this.instances.set(player.id, instance);
    }
    instance.root.setEnabled(player.visible);
    const targetPosition = toBabylonPosition(player.position);
    if (!player.local && instance.positioned) Vector3.LerpToRef(instance.root.position, targetPosition, 0.35, instance.root.position);
    else instance.root.position.copyFrom(targetPosition);
    instance.positioned = true;
    if (!player.visible) return;
    const model = getplayermodelinfo(player.model);
    const skin = playerSkin(gameMode, teamskins, localTeam, player.team, player.local);
    const visualKey = `${model.index}:${skin}`;
    const animation = renderclient(player, nowMilliseconds);
    const animationMilliseconds = animation === "dying" ? Math.max(0, nowMilliseconds - (player.deadAt ?? nowMilliseconds))
      : animation === "pain" ? Math.max(0, nowMilliseconds - (player.lastPain ?? nowMilliseconds))
        : animation === "jump" ? player.timeInAir ?? 0 : nowMilliseconds;
    const loop = animation !== "dying" && animation !== "pain" && animation !== "jump";
    void this.updateModel(instance, model.index, skin, visualKey, animation, animationMilliseconds, loop, player.yaw);
  }

  private async updateModel(instance: PlayerModelInstance, modelIndex: number, skin: "ffa" | "blueTeam" | "redTeam", visualKey: string,
                            animation: string, animationMilliseconds: number, loop: boolean, yaw: number): Promise<void> {
    const assets = await (this.assets ??= fetch("/api/playermodels", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load player model manifest (${response.status}).`);
      return response.json() as Promise<PlayerModelAsset[]>;
    }));
    const definition = assets[modelIndex] ?? assets[0];
    const asset = definition?.[skin] ?? definition?.ffa;
    if (!definition || !asset || asset.status !== "ready" || !asset.geometryPath) return;
    const animationSpec = definition.animations[animation] ?? definition.animations.idle;
    const animationPath = animationSpec?.path;
    let position: ModelAnimationPosition = { frame: 0, nextFrame: 0, interpolation: 0 };
    let animationSource: string | undefined;
    let animationBuffer: ArrayBuffer | undefined;
    if (asset.format === "MD5" && animationPath) {
      animationSource = await this.fetchText(animationPath);
      const info = md5AnimationInfo(animationSource);
      position = modelAnimationPosition(info.frameCount, animationSpec.speed, animationMilliseconds, loop, animationSpec.startOffset,
        animationSpec.endOffset);
    } else if (asset.format === "IQM" && animationPath) {
      animationBuffer = await this.fetchBinary(animationPath);
      const info = iqmAnimationInfo(animationBuffer);
      position = modelAnimationPosition(info.frameCount, animationSpec.speed, animationMilliseconds, loop, animationSpec.startOffset,
        animationSpec.endOffset);
    }
    instance.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(-(yaw + 90 + (asset.yaw ?? 0)) * Math.PI / 180,
      -(asset.pitch ?? 0) * Math.PI / 180, 0);
    const frame = position.frame + (position.nextFrame !== position.frame ? position.interpolation : 0);
    if (instance.visualKey === visualKey && instance.animation === animation && instance.frame === frame) return;
    const token = ++instance.updateToken;
    const geometry = await this.geometry(asset, animationPath, animationSource, animationBuffer, position);
    if (token !== instance.updateToken) return;
    if (instance.visualKey !== visualKey || instance.meshes.length !== geometry.meshes.length) {
      this.createMeshes(instance, definition, asset, geometry);
    }
    else this.updateMeshes(instance.meshes, geometry.meshes, asset);
    instance.visualKey = visualKey;
    instance.animation = animation;
    instance.frame = frame;
  }

  private async geometry(asset: MapModelAsset, animationPath: string | undefined, animationSource: string | undefined,
                         animationBuffer: ArrayBuffer | undefined, position: ModelAnimationPosition): Promise<ModelGeometry> {
    const current = await this.geometryFrame(asset, animationPath, animationSource, animationBuffer, position.frame);
    if (position.interpolation <= 0 || position.nextFrame === position.frame) return current;
    const next = await this.geometryFrame(asset, animationPath, animationSource, animationBuffer, position.nextFrame);
    return interpolateModelGeometry(current, next, position.interpolation);
  }

  private async geometryFrame(asset: MapModelAsset, animationPath: string | undefined, animationSource: string | undefined,
                              animationBuffer: ArrayBuffer | undefined, frame: number): Promise<ModelGeometry> {
    const key = `${asset.geometryPath}:${animationPath ?? "bind"}:${frame}`;
    const cached = this.geometryFrames.get(key);
    if (cached) return cached;
    let geometry: ModelGeometry;
    if (asset.format === "MD5") geometry = parseMd5(await this.fetchText(asset.geometryPath!), animationSource, [], frame);
    else if (asset.format === "IQM") geometry = parseIqm(await this.fetchBinary(asset.geometryPath!), animationBuffer, frame);
    else throw new Error(`Player model format ${asset.format ?? "unknown"} is not supported.`);
    this.geometryFrames.set(key, geometry);
    return geometry;
  }

  private createMeshes(instance: PlayerModelInstance, definition: PlayerModelAsset, asset: MapModelAsset, geometry: ModelGeometry): void {
    instance.meshes.forEach((mesh) => mesh.dispose());
    instance.meshes = geometry.meshes.map((source) => {
      const mesh = new Mesh(`${instance.root.name}-${definition.name}-${source.name}`, this.scene);
      mesh.parent = instance.root;
      mesh.material = this.material(definition, asset, source.name);
      mesh.isPickable = false;
      return mesh;
    });
    this.updateMeshes(instance.meshes, geometry.meshes, asset);
  }

  private updateMeshes(meshes: Mesh[], sources: ModelGeometryMesh[], asset: MapModelAsset): void {
    sources.forEach((source, index) => {
      const positions = translateAndScale(source.positions, asset.translate ?? [0, 0, 0], asset.scale ?? 0.25);
      const normals: number[] = [];
      VertexData.ComputeNormals(positions, source.indices, normals);
      const data = new VertexData();
      data.positions = positions;
      data.indices = source.indices;
      data.uvs = source.uvs;
      data.normals = normals;
      data.applyToMesh(meshes[index], true);
    });
  }

  private material(definition: PlayerModelAsset, asset: MapModelAsset, meshName: string): StandardMaterial {
    const skin = selectModelSkin(asset.skins ?? [], meshName);
    const key = `${definition.index}:${asset.name}:${meshName}:${skin?.diffusePath ?? ""}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const material = new StandardMaterial(`player-material-${key}`, this.scene);
    material.backFaceCulling = asset.cullFace ?? true;
    material.diffuseColor = Color3.White();
    material.ambientColor = Color3.White().scale(asset.ambient ?? 0.3);
    material.specularColor = Color3.White().scale(asset.specular ?? 1);
    const url = packageAssetUrl(skin?.diffusePath);
    if (url) {
      const texture = new Texture(url, this.scene, false, false);
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.emissiveColor = Color3.White().scale(Math.max(asset.ambient ?? 0.3, Math.min(asset.glow ?? 0, 1)));
    }
    this.materials.set(key, material);
    return material;
  }

  private fetchText(path: string): Promise<string> {
    let source = this.textSources.get(path);
    if (!source) {
      source = fetch(packageAssetUrl(path)!, { cache: "no-cache" }).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
        return response.text();
      });
      this.textSources.set(path, source);
    }
    return source;
  }

  private fetchBinary(path: string): Promise<ArrayBuffer> {
    let source = this.binarySources.get(path);
    if (!source) {
      source = fetch(packageAssetUrl(path)!, { cache: "no-cache" }).then((response) => {
        if (!response.ok) throw new Error(`Could not load ${path} (${response.status}).`);
        return response.arrayBuffer();
      });
      this.binarySources.set(path, source);
    }
    return source;
  }

  private disposeInstance(instance: PlayerModelInstance): void {
    instance.meshes.forEach((mesh) => mesh.dispose());
    instance.root.dispose();
  }
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

export function thirdpersoncamera(position: Vec3, yaw: number, pitch: number, distance = 20, up = 0, side = 0): Vector3 {
  const yawRadians = yaw * Math.PI / 180;
  const pitchRadians = pitch * Math.PI / 180;
  const direction = new Vector3(
    Math.sin(yawRadians) * Math.cos(pitchRadians),
    -Math.sin(pitchRadians),
    -Math.cos(yawRadians) * Math.cos(pitchRadians),
  );
  const camera = toBabylonPosition(position).add(direction.scale(distance));
  camera.y += up;
  camera.x += Math.cos(yawRadians) * side;
  camera.z += Math.sin(yawRadians) * side;
  return camera;
}
