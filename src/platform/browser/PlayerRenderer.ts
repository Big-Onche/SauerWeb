import type { AnimationGroup } from "@babylonjs/core/Animations/animationGroup";
import { AnimationGroupMask, AnimationGroupMaskMode } from "@babylonjs/core/Animations/animationGroupMask";
import type { AssetContainer, InstantiatedEntries } from "@babylonjs/core/assetContainer";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { loadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/loaders/glTF/glTFFileLoader";
import "@babylonjs/loaders/glTF/2.0/glTFLoader";
import type { MapModelAsset, PlayerModelAnimation, PlayerModelAsset, ViewWeaponAsset } from "../../assets/types";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { modelAnimationPosition } from "../../engine/modelanimation";
import type { RagdollCollider } from "../../engine/ragdoll";
import { ensureModelGeometryNormals, prepareMd5Model, skinMd5Model, type ModelGeometry } from "../../engine/rendermodel";
import type { Vec3 } from "../../engine/octa";
import { ClientState } from "../../engine/physics/types";
import { getplayermodelinfo, playerSkin, renderclient, renderclientLocomotion, type RenderClientState } from "../../fpsgame/render";
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
  selectedGun: number;
  lastAction: number;
  lastAttackGun: number;
  gunWait: number;
}

interface PlayerModelInstance {
  root: TransformNode;
  meshes: Mesh[];
  weaponMeshes: Mesh[];
  weaponKey: string;
  visualKey: string;
  animation: string;
  glbFrameKey: string;
  updateToken: number;
  updating: boolean;
  pendingUpdate?: ModelUpdateRequest;
  glb?: GlbPlayerInstance;
}

interface GlbPlayerInstance {
  modelName: string;
  entries: InstantiatedEntries;
  holder: TransformNode;
  groups: Map<string, AnimationGroup>;
  activeGroups: AnimationGroup[];
  activeKey: string;
  attachment?: TransformNode;
  muzzleLocal?: Vector3;
}

interface ModelUpdateRequest {
  token: number;
  modelIndex: number;
  skin: "ffa" | "blueTeam" | "redTeam";
  visualKey: string;
  animation: string;
  secondaryAnimation?: string;
  secondaryAnimationMilliseconds?: number;
  animationMilliseconds: number;
  loop: boolean;
  yaw: number;
  selectedGun: number;
}

interface MeshVertexBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: number[];
}

// Player bodies use native glTF skeletons and GPU skinning. MD5 below is intentionally limited to the separate, static vwep assets.
export class PlayerRenderer {
  private readonly instances = new Map<number, PlayerModelInstance>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly textSources = new Map<string, Promise<string>>();
  private readonly weaponGeometry = new Map<string, Promise<ModelGeometry>>();
  private readonly glbContainers = new Map<string, Promise<AssetContainer>>();
  private readonly meshVertexBuffers = new WeakMap<Mesh, MeshVertexBuffers>();
  private assets?: Promise<PlayerModelAsset[]>;
  private viewWeapons?: Promise<ViewWeaponAsset[]>;

  constructor(private readonly scene: Scene, _ragdollCollider?: RagdollCollider, _performanceRecorder?: (milliseconds: number) => void,
              _profilingEnabled?: () => boolean) {}

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
  }

  // Original: src/fpsgame/render.cpp
  // Functions: preloadplayermodel(), preloadweapons()
  // Sauerbraten reference: SVN r6488
  async preload(modelIndex: number, teamMode: boolean, multiplayer: boolean,
                progress?: (complete: number, total: number, label: string) => void): Promise<void> {
    const assets = await this.playerAssets();
    const definitions = multiplayer ? assets : [assets[modelIndex] ?? assets[0]].filter(Boolean);
    const work = definitions.flatMap((definition) => {
      const skins: Array<"ffa" | "blueTeam" | "redTeam"> = teamMode ? ["blueTeam", "redTeam"] : ["ffa"];
      return skins.map((skin) => ({ definition, skin, asset: definition[skin] }));
    }).filter((item) => item.definition.glbPath && item.asset?.status === "ready");
    if (!work.length || work.length !== definitions.length * (teamMode ? 2 : 1)) {
      throw new Error("A required GLB player model is missing or unsupported.");
    }
    let complete = 0;
    for (const { definition, skin } of work) {
      const instance = this.createInstance(`preload-player-${definition.index}-${skin}`);
      try {
        for (let gun = 0; gun <= 6; gun++) {
          const token = ++instance.updateToken;
          await this.updateModel(instance, definition.index, skin, `${definition.index}:${skin}:${gun}`, "idle", undefined, undefined, 0, true,
            0, gun, token);
        }
      } finally {
        this.disposeInstance(instance);
      }
      progress?.(++complete, work.length, definition.name);
      await yieldToBrowser();
    }
  }

  flagAttachmentPosition(playerId: number, eyeHeight = 14, aboveEye = 1): Vector3 | undefined {
    const instance = this.instances.get(playerId);
    if (!instance || !instance.root.isEnabled()) return undefined;
    const position = instance.root.position.clone();
    position.y += eyeHeight + aboveEye + 5;
    return position;
  }

  muzzlePosition(playerId: number): Vec3 | undefined {
    const instance = this.instances.get(playerId);
    if (!instance?.glb?.attachment || !instance.glb.muzzleLocal || !instance.root.isEnabled()) return undefined;
    const position = Vector3.TransformCoordinates(instance.glb.muzzleLocal, instance.glb.attachment.computeWorldMatrix(true));
    return { x: position.x, y: position.z, z: position.y };
  }

  private renderplayer(player: RenderPlayer, gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    let instance = this.instances.get(player.id);
    if (!instance) {
      instance = this.createInstance(`player-${player.id}`);
      this.instances.set(player.id, instance);
    }
    instance.root.setEnabled(player.visible);
    instance.root.position.copyFrom(toBabylonPosition(player.position));
    if (!player.visible) return;
    const model = getplayermodelinfo(player.model);
    const skin = playerSkin(gameMode, teamskins, localTeam, player.team, player.local);
    const visualKey = `${model.index}:${skin}:${player.selectedGun}`;
    const baseAnimation = renderclient(player, nowMilliseconds);
    const locomotionAnimation = renderclientLocomotion(player);
    const attacking = player.lastAttackGun === player.selectedGun && nowMilliseconds - player.lastAction < player.gunWait + 50;
    const canAttack = baseAnimation !== "pain" && player.state === ClientState.Alive;
    const animation = attacking && canAttack ? `attack ${player.selectedGun + 1}`
      : baseAnimation === "idle" ? `hold ${player.selectedGun + 1}` : baseAnimation;
    const secondaryAnimation = attacking && canAttack || baseAnimation === "pain" ? locomotionAnimation : undefined;
    const secondaryAnimationMilliseconds = locomotionAnimation === "jump" ? player.timeInAir ?? 0 : nowMilliseconds;
    const animationMilliseconds = animation === "dying" ? Math.max(0, nowMilliseconds - (player.deadAt ?? nowMilliseconds))
      : animation === "pain" ? Math.max(0, nowMilliseconds - (player.lastPain ?? nowMilliseconds))
        : animation === "jump" ? player.timeInAir ?? 0 : attacking ? Math.max(0, nowMilliseconds - player.lastAction) : nowMilliseconds;
    const loop = !attacking && animation !== "dying" && animation !== "pain" && animation !== "jump";
    this.requestModelUpdate(instance, {
      modelIndex: model.index, skin, visualKey, animation, secondaryAnimation, secondaryAnimationMilliseconds, animationMilliseconds, loop,
      yaw: player.yaw, selectedGun: player.selectedGun,
    });
  }

  private createInstance(name: string): PlayerModelInstance {
    return {
      root: new TransformNode(name, this.scene), meshes: [], weaponMeshes: [], weaponKey: "", visualKey: "", animation: "", glbFrameKey: "",
      updateToken: 0, updating: false,
    };
  }

  private requestModelUpdate(instance: PlayerModelInstance, request: Omit<ModelUpdateRequest, "token">): void {
    instance.pendingUpdate = { ...request, token: ++instance.updateToken };
    if (instance.updating) return;
    instance.updating = true;
    void this.processModelUpdates(instance);
  }

  private async processModelUpdates(instance: PlayerModelInstance): Promise<void> {
    try {
      while (instance.pendingUpdate) {
        const request = instance.pendingUpdate;
        instance.pendingUpdate = undefined;
        await this.updateModel(instance, request.modelIndex, request.skin, request.visualKey, request.animation, request.secondaryAnimation,
          request.secondaryAnimationMilliseconds, request.animationMilliseconds, request.loop, request.yaw, request.selectedGun, request.token);
      }
    } finally {
      instance.updating = false;
      if (instance.pendingUpdate) this.requestModelUpdate(instance, instance.pendingUpdate);
    }
  }

  private async updateModel(instance: PlayerModelInstance, modelIndex: number, skin: "ffa" | "blueTeam" | "redTeam", visualKey: string,
                            animation: string, secondaryAnimation: string | undefined, secondaryAnimationMilliseconds: number | undefined,
                            animationMilliseconds: number, loop: boolean, yaw: number, selectedGun: number, token: number): Promise<void> {
    const assets = await this.playerAssets();
    if (token !== instance.updateToken) return;
    const definition = assets[modelIndex] ?? assets[0];
    const asset = definition?.[skin] ?? definition?.ffa;
    if (!definition?.glbPath || !asset || asset.status !== "ready") return;
    await this.updateGlbModel(instance, definition, asset, visualKey, animation, secondaryAnimation, secondaryAnimationMilliseconds,
      animationMilliseconds, loop, yaw, selectedGun, token);
  }

  private async updateGlbModel(instance: PlayerModelInstance, definition: PlayerModelAsset, asset: MapModelAsset, visualKey: string,
                               animation: string, secondaryAnimation: string | undefined,
                               secondaryAnimationMilliseconds: number | undefined, animationMilliseconds: number, loop: boolean, yaw: number,
                               selectedGun: number, token: number): Promise<void> {
    if (!definition.glbPath) return;
    if (!instance.glb || instance.glb.modelName !== definition.name) {
      this.disposeGlb(instance);
      const container = await this.glbContainer(definition.glbPath);
      if (token !== instance.updateToken) return;
      const entries = container.instantiateModelsToScene((name) => name, false);
      const holder = new TransformNode(`${instance.root.name}-glb`, this.scene);
      holder.parent = instance.root;
      entries.rootNodes.forEach((node) => node.parent = holder);
      const meshes = entries.rootNodes.flatMap((node) => node instanceof Mesh ? [node, ...node.getChildMeshes(false)] : node.getChildMeshes(false));
      meshes.forEach((mesh) => {
        mesh.material = this.assetMaterial(`player:${definition.index}`, asset, glbSourceName(mesh.name));
        mesh.isPickable = false;
      });
      const groups = new Map(entries.animationGroups.map((group) => [group.name.toLowerCase(), group]));
      instance.glb = { modelName: definition.name, entries, holder, groups, activeGroups: [], activeKey: "" };
      instance.meshes = meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh);
      instance.visualKey = "";
      instance.animation = "";
      instance.glbFrameKey = "";
    }
    const glb = instance.glb;
    const translate = asset.translate ?? [0, 0, 0];
    glb.holder.position.set(translate[0], translate[2], translate[1]);
    instance.root.scaling.setAll(asset.scale ?? 0.25);
    instance.root.rotationQuaternion = Quaternion.RotationYawPitchRoll(-(yaw + 90 + (asset.yaw ?? 0)) * Math.PI / 180,
      -(asset.pitch ?? 0) * Math.PI / 180, 0);
    const primary = definition.animations[animation] ?? definition.animations.idle;
    if (!primary) return;
    const selectedParts = secondaryAnimation ? definition.animationParts.map((part) => {
      const primaryPart = part.animations[animation];
      const secondaryPart = part.animations[secondaryAnimation];
      const spec = primaryPart && (!secondaryPart || primaryPart.priority >= secondaryPart.priority)
        ? primaryPart : secondaryPart ?? primaryPart ?? primary;
      return { spec, roots: part.roots, milliseconds: spec === primaryPart ? animationMilliseconds
        : secondaryAnimationMilliseconds ?? animationMilliseconds, loop: spec === primaryPart ? loop : secondaryAnimation !== "jump" };
    }) : [{ spec: primary, roots: [] as string[], milliseconds: animationMilliseconds, loop }];
    const frameKey = selectedParts.map((part) => `${part.spec.path}:${glbAnimationFrame(glb.groups, part.spec, part.milliseconds, part.loop)}`)
      .join("|");
    if (instance.visualKey !== visualKey) {
      instance.meshes.forEach((mesh) => mesh.material = this.assetMaterial(`player:${definition.index}`, asset, glbSourceName(mesh.name)));
    }
    if (instance.visualKey !== visualKey || instance.animation !== animation || instance.glbFrameKey !== frameKey) {
      this.applyGlbAnimations(glb, selectedParts);
      instance.visualKey = visualKey;
      instance.animation = animation;
      instance.glbFrameKey = frameKey;
    }
    await this.updateGlbViewWeapon(instance, asset, selectedGun);
  }

  private applyGlbAnimations(glb: GlbPlayerInstance,
                             parts: Array<{ spec: PlayerModelAnimation; roots: string[]; milliseconds: number; loop: boolean }>): void {
    const partTargetNames = parts.map((part) => glbTargetNames(glb, part.roots));
    const upperNames = [...new Set(partTargetNames.slice(1).flat())];
    const selected = parts.map((part) => glb.groups.get(animationClipName(part.spec.path)))
      .filter((group): group is AnimationGroup => Boolean(group));
    if (selected.length !== parts.length) throw new Error(`GLB ${glb.modelName} is missing a requested animation group.`);
    const overlayTargetNames = new Map<AnimationGroup, Set<string>>();
    selected.slice(1).forEach((group, index) => {
      const names = overlayTargetNames.get(group) ?? new Set<string>();
      partTargetNames[index + 1].forEach((name) => names.add(name));
      overlayTargetNames.set(group, names);
    });
    const activeKey = parts.map((part, index) => `${animationClipName(part.spec.path)}:${index}:${part.roots.join(",")}`).join("|");
    if (activeKey !== glb.activeKey) {
      glb.activeGroups.forEach((group) => group.stop(true));
      glb.activeGroups = selected;
      glb.activeKey = activeKey;
      selected.forEach((group, index) => {
        const names = index === 0 ? upperNames : [...(overlayTargetNames.get(group) ?? [])];
        group.mask = names.length
          ? new AnimationGroupMask(names, index === 0 ? AnimationGroupMaskMode.Exclude : AnimationGroupMaskMode.Include) : null;
        group.start(parts[index].loop, 0);
        group.pause();
      });
    }
    glb.activeGroups.forEach((group, index) => {
      const part = parts[index];
      if (part) goToMaskedAnimationFrame(group, glbAnimationFrame(glb.groups, part.spec, part.milliseconds, part.loop));
    });
  }

  private glbContainer(path: string): Promise<AssetContainer> {
    let container = this.glbContainers.get(path);
    if (!container) {
      container = loadAssetContainerAsync(path, this.scene, { pluginOptions: { gltf: { skipMaterials: true } } });
      this.glbContainers.set(path, container);
    }
    return container;
  }

  private async updateGlbViewWeapon(instance: PlayerModelInstance, playerAsset: MapModelAsset, selectedGun: number): Promise<void> {
    const glb = instance.glb;
    if (!glb) return;
    const attachmentName = playerAsset.tags?.tag_weapon;
    glb.attachment = attachmentName ? findGlbTransform(glb, attachmentName) : undefined;
    const asset = (await this.weaponAssets())[selectedGun];
    if (!glb.attachment || !asset || asset.status !== "ready" || !asset.geometryPath) {
      this.disposeWeapon(instance);
      return;
    }
    const attachment = glb.attachment;
    const geometry = await this.staticWeaponGeometry(asset);
    if (instance.weaponKey !== asset.name || instance.weaponMeshes.length !== geometry.meshes.length) {
      this.disposeWeapon(instance);
      instance.weaponMeshes = geometry.meshes.map((source) => {
        const mesh = new Mesh(`${instance.root.name}-${asset.name}-${source.name}`, this.scene);
        mesh.parent = attachment;
        mesh.material = this.assetMaterial(`vwep:${asset.gun}`, asset, source.name);
        mesh.isPickable = false;
        return mesh;
      });
      instance.weaponKey = asset.name;
    }
    const scale = (asset.scale ?? 0.25) / (playerAsset.scale ?? 0.25);
    geometry.meshes.forEach((source, index) => this.applyMesh(instance.weaponMeshes[index], source,
      translateAndScale(source.positions, asset.translate ?? [0, 0, 0], scale), source.normals));
    const muzzle = geometry.joints?.find((joint) => joint.name === asset.tags?.tag_muzzle);
    glb.muzzleLocal = muzzle ? new Vector3((muzzle.position[0] + (asset.translate?.[0] ?? 0)) * scale,
      (muzzle.position[2] + (asset.translate?.[2] ?? 0)) * scale,
      (muzzle.position[1] + (asset.translate?.[1] ?? 0)) * scale) : undefined;
  }

  private staticWeaponGeometry(asset: MapModelAsset): Promise<ModelGeometry> {
    let geometry = this.weaponGeometry.get(asset.geometryPath!);
    if (!geometry) {
      geometry = this.fetchText(asset.geometryPath!).then((source) => {
        const result = skinMd5Model(prepareMd5Model(source));
        ensureModelGeometryNormals(result);
        return result;
      });
      this.weaponGeometry.set(asset.geometryPath!, geometry);
    }
    return geometry;
  }

  private applyMesh(mesh: Mesh, source: ModelGeometry["meshes"][number], positions: number[], normals?: number[]): void {
    let buffers = this.meshVertexBuffers.get(mesh);
    if (buffers && buffers.positions.length === positions.length) {
      buffers.positions.set(positions);
      if (normals?.length === buffers.normals.length) buffers.normals.set(normals);
      else VertexData.ComputeNormals(buffers.positions, buffers.indices, buffers.normals);
      mesh.updateVerticesData(VertexBuffer.PositionKind, buffers.positions, false);
      mesh.updateVerticesData(VertexBuffer.NormalKind, buffers.normals, false);
      return;
    }
    buffers = { positions: Float32Array.from(positions), normals: new Float32Array(positions.length), indices: source.indices };
    if (normals?.length === buffers.normals.length) buffers.normals.set(normals);
    else VertexData.ComputeNormals(buffers.positions, source.indices, buffers.normals);
    const data = new VertexData();
    data.positions = buffers.positions;
    data.indices = source.indices;
    data.uvs = source.uvs;
    data.normals = buffers.normals;
    data.applyToMesh(mesh, true);
    this.meshVertexBuffers.set(mesh, buffers);
  }

  private assetMaterial(prefix: string, asset: MapModelAsset, meshName: string): StandardMaterial {
    const skin = selectModelSkin(asset.skins ?? [], meshName);
    const key = `${prefix}:${asset.name}:${meshName}:${skin?.diffusePath ?? ""}`;
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

  private playerAssets(): Promise<PlayerModelAsset[]> {
    return this.assets ??= fetch("/api/playermodels", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load player model manifest (${response.status}).`);
      return response.json() as Promise<PlayerModelAsset[]>;
    });
  }

  private weaponAssets(): Promise<ViewWeaponAsset[]> {
    return this.viewWeapons ??= fetch("/api/viewweapons", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`View-weapon manifest request failed (${response.status}).`);
      return response.json() as Promise<ViewWeaponAsset[]>;
    });
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

  private disposeInstance(instance: PlayerModelInstance): void {
    instance.updateToken++;
    instance.pendingUpdate = undefined;
    this.disposeWeapon(instance);
    this.disposeGlb(instance);
    instance.root.dispose();
  }

  private disposeGlb(instance: PlayerModelInstance): void {
    instance.glb?.activeGroups.forEach((group) => group.stop(true));
    instance.glb?.entries.dispose();
    instance.glb?.holder.dispose();
    instance.glb = undefined;
    instance.meshes = [];
  }

  private disposeWeapon(instance: PlayerModelInstance): void {
    instance.weaponMeshes.forEach((mesh) => mesh.dispose());
    instance.weaponMeshes = [];
    instance.weaponKey = "";
  }
}

function animationClipName(path: string): string {
  return path.replaceAll("\\", "/").split("/").pop()!.replace(/\.(?:md5anim|iqm)$/i, "").toLowerCase();
}

function glbAnimationFrame(groups: Map<string, AnimationGroup>, spec: PlayerModelAnimation, milliseconds: number, loop: boolean): number {
  const group = groups.get(animationClipName(spec.path));
  if (!group) return 0;
  const frameCount = Math.max(1, Math.round(group.to - group.from + 1));
  const position = modelAnimationPosition(frameCount, spec.speed, milliseconds, loop, spec.startOffset, spec.endOffset);
  return group.from + position.frame + (position.nextFrame !== position.frame ? position.interpolation : 0);
}

function glbTargetNames(glb: GlbPlayerInstance, roots: readonly string[]): string[] {
  if (!roots.length) return [];
  const selected = new Set<string>();
  const rootNames = new Set(roots.map((root) => root.toLowerCase()));
  for (const group of glb.groups.values()) {
    for (const targeted of group.targetedAnimations) {
      let target = targeted.target as { name?: string; parent?: unknown } | undefined;
      while (target) {
        if (target.name && rootNames.has(target.name.toLowerCase())) {
          const name = (targeted.target as { name?: string }).name;
          if (name) selected.add(name);
          break;
        }
        target = target.parent as typeof target;
      }
    }
  }
  return [...selected];
}

export function goToMaskedAnimationFrame(group: AnimationGroup, frame: number): void {
  for (const animatable of group.animatables) {
    if (!group.mask || group.mask.disabled || group.mask.retainsTarget(animatable.target.name)) animatable.goToFrame(frame);
  }
}

function findGlbTransform(glb: GlbPlayerInstance, name: string): TransformNode | undefined {
  for (const root of glb.entries.rootNodes) {
    if (root instanceof TransformNode && root.name === name) return root;
    const match = root.getDescendants(false).find((node) => node instanceof TransformNode && node.name === name);
    if (match instanceof TransformNode) return match;
  }
  return undefined;
}

function glbSourceName(name: string): string {
  return name.replace(/\.\d+$/, "");
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

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
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
