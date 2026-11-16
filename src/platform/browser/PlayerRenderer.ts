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
  modelIndex: number;
  skin?: PlayerSkin;
  selectedGun: number;
  requestedModelIndex: number;
  requestedSkin: PlayerSkin;
  requestedGun: number;
  animation: string;
  secondaryAnimation?: string;
  animationMilliseconds: number;
  secondaryAnimationMilliseconds: number;
  loop: boolean;
  updateToken: number;
  weaponUpdateToken: number;
  loadingModelName: string;
  glb?: GlbPlayerInstance;
}

interface GlbPlayerInstance {
  modelName: string;
  definition: PlayerModelAsset;
  asset: MapModelAsset;
  entries: InstantiatedEntries;
  holder: TransformNode;
  groups: Map<string, AnimationGroup>;
  clips: Map<PlayerModelAnimation, GlbAnimationClip>;
  lowerBodyMask: AnimationGroupMask | null;
  includeMasks: Array<AnimationGroupMask | null>;
  transitions: Map<string, GlbAnimationTransition>;
  activeTransition?: GlbAnimationTransition;
  activeAnimation: string;
  activeSecondaryAnimation?: string;
  activeLoop: boolean;
  lastFrames: Float64Array;
  transformsByName: Map<string, TransformNode>;
  attachment?: TransformNode;
  muzzleLocal?: Vector3;
}

interface GlbAnimationClip {
  group: AnimationGroup;
  frameCount: number;
}

interface GlbAnimationSlot {
  clip: GlbAnimationClip;
  spec: PlayerModelAnimation;
  usesPrimaryTime: boolean;
  loop: boolean;
}

interface GlbAnimationTransition {
  slots: GlbAnimationSlot[];
  masks: Array<AnimationGroupMask | null>;
}

type PlayerSkin = "ffa" | "blueTeam" | "redTeam";

interface MeshVertexBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: number[];
}

// Player bodies use native glTF skeletons and GPU skinning. MD5 below is intentionally limited to the separate, static vwep assets.
export class PlayerRenderer {
  private readonly instances = new Map<number, PlayerModelInstance>();
  private readonly activePlayerIds = new Set<number>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly textSources = new Map<string, Promise<string>>();
  private readonly weaponGeometry = new Map<string, Promise<ModelGeometry>>();
  private readonly glbContainers = new Map<string, Promise<AssetContainer>>();
  private readonly meshVertexBuffers = new WeakMap<Mesh, MeshVertexBuffers>();
  private assets?: Promise<PlayerModelAsset[]>;
  private assetDefinitions?: PlayerModelAsset[];
  private viewWeapons?: Promise<ViewWeaponAsset[]>;

  constructor(private readonly scene: Scene, _ragdollCollider?: RagdollCollider, _performanceRecorder?: (milliseconds: number) => void,
              _profilingEnabled?: () => boolean) {}

  rendergame(players: readonly RenderPlayer[], gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    const active = this.activePlayerIds;
    active.clear();
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
          instance.animation = "idle";
          instance.requestedModelIndex = definition.index;
          instance.requestedSkin = skin;
          instance.requestedGun = gun;
          if (!instance.glb) await this.updateGlbModel(instance, definition);
          this.updateModel(instance, definition.index, skin, gun);
          if (instance.glb) await this.updateGlbViewWeapon(instance, definition[skin], gun, instance.weaponUpdateToken);
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
    instance.root.position.set(player.position.x, player.position.z, player.position.y);
    if (!player.visible) return;
    const model = getplayermodelinfo(player.model);
    const skin = playerSkin(gameMode, teamskins, localTeam, player.team, player.local);
    const baseAnimation = renderclient(player, nowMilliseconds);
    const locomotionAnimation = renderclientLocomotion(player);
    const attacking = player.lastAttackGun === player.selectedGun && nowMilliseconds - player.lastAction < player.gunWait + 50;
    const canAttack = baseAnimation !== "pain" && player.state === ClientState.Alive;
    const animation = attacking && canAttack ? ATTACK_ANIMATIONS[player.selectedGun]
      : baseAnimation === "idle" ? HOLD_ANIMATIONS[player.selectedGun] : baseAnimation;
    const secondaryAnimation = attacking && canAttack || baseAnimation === "pain" ? locomotionAnimation : undefined;
    const secondaryAnimationMilliseconds = locomotionAnimation === "jump" ? player.timeInAir ?? 0 : nowMilliseconds;
    const animationMilliseconds = animation === "dying" ? Math.max(0, nowMilliseconds - (player.deadAt ?? nowMilliseconds))
      : animation === "pain" ? Math.max(0, nowMilliseconds - (player.lastPain ?? nowMilliseconds))
        : animation === "jump" ? player.timeInAir ?? 0 : attacking ? Math.max(0, nowMilliseconds - player.lastAction) : nowMilliseconds;
    const loop = !attacking && animation !== "dying" && animation !== "pain" && animation !== "jump";
    instance.animation = animation;
    instance.secondaryAnimation = secondaryAnimation;
    instance.animationMilliseconds = animationMilliseconds;
    instance.secondaryAnimationMilliseconds = secondaryAnimationMilliseconds;
    instance.loop = loop;
    this.updateModel(instance, model.index, skin, player.selectedGun);
    const asset = instance.glb?.asset;
    if (asset) {
      const rotation = instance.root.rotationQuaternion ??= new Quaternion();
      Quaternion.RotationYawPitchRollToRef(-(player.yaw + 90 + (asset.yaw ?? 0)) * Math.PI / 180,
        -(asset.pitch ?? 0) * Math.PI / 180, 0, rotation);
    }
  }

  private createInstance(name: string): PlayerModelInstance {
    return {
      root: new TransformNode(name, this.scene), meshes: [], weaponMeshes: [], weaponKey: "", modelIndex: -1, selectedGun: -1,
      requestedModelIndex: -1, requestedSkin: "ffa", requestedGun: -1, animation: "", animationMilliseconds: 0,
      secondaryAnimationMilliseconds: 0, loop: true, updateToken: 0, weaponUpdateToken: 0, loadingModelName: "",
    };
  }

  private updateModel(instance: PlayerModelInstance, modelIndex: number, skin: PlayerSkin, selectedGun: number): void {
    instance.requestedModelIndex = modelIndex;
    instance.requestedSkin = skin;
    instance.requestedGun = selectedGun;
    const assets = this.assetDefinitions;
    if (!assets) {
      if (!this.assets) void this.playerAssets().catch(() => undefined);
      return;
    }
    const definition = assets[modelIndex] ?? assets[0];
    const asset = definition?.[skin] ?? definition?.ffa;
    if (!definition?.glbPath || !asset || asset.status !== "ready") return;
    if (!instance.glb || instance.glb.modelName !== definition.name) {
      if (instance.loadingModelName !== definition.name) void this.updateGlbModel(instance, definition);
      return;
    }
    this.updateGlbAppearance(instance, definition, asset, skin, selectedGun);
    this.applyGlbAnimations(instance.glb, instance.animation, instance.secondaryAnimation, instance.animationMilliseconds,
      instance.secondaryAnimationMilliseconds, instance.loop);
  }

  private async updateGlbModel(instance: PlayerModelInstance, definition: PlayerModelAsset): Promise<void> {
    if (!definition.glbPath) return;
    instance.loadingModelName = definition.name;
    const token = ++instance.updateToken;
    const container = await this.glbContainer(definition.glbPath);
    if (token !== instance.updateToken || instance.requestedModelIndex !== definition.index) return;
    instance.weaponUpdateToken++;
    this.disposeWeapon(instance);
    this.disposeGlb(instance);
    const entries = container.instantiateModelsToScene((name) => name, false);
    const holder = new TransformNode(`${instance.root.name}-glb`, this.scene);
    holder.parent = instance.root;
    entries.rootNodes.forEach((node) => node.parent = holder);
    const meshes = entries.rootNodes.flatMap((node) => node instanceof Mesh ? [node, ...node.getChildMeshes(false)] : node.getChildMeshes(false));
    meshes.forEach((mesh) => mesh.isPickable = false);
    const groups = new Map(entries.animationGroups.map((group) => [group.name.toLowerCase(), group]));
    const metadata = createGlbAnimationMetadata(entries, groups, definition);
    const asset = definition[instance.requestedSkin] ?? definition.ffa;
    instance.glb = {
      modelName: definition.name, definition, asset, entries, holder, groups, ...metadata, transitions: new Map(), activeAnimation: "",
      activeLoop: false, lastFrames: new Float64Array(Math.max(1, definition.animationParts.length)),
    };
    instance.meshes = meshes.filter((mesh): mesh is Mesh => mesh instanceof Mesh);
    instance.modelIndex = -1;
    instance.skin = undefined;
    instance.selectedGun = -1;
    instance.loadingModelName = "";
    this.updateModel(instance, instance.requestedModelIndex, instance.requestedSkin, instance.requestedGun);
  }

  private updateGlbAppearance(instance: PlayerModelInstance, definition: PlayerModelAsset, asset: MapModelAsset, skin: PlayerSkin,
                              selectedGun: number): void {
    const glb = instance.glb!;
    const appearanceChanged = instance.modelIndex !== definition.index || instance.skin !== skin;
    if (appearanceChanged) {
      glb.asset = asset;
      instance.meshes.forEach((mesh) => mesh.material = this.assetMaterial(`player:${definition.index}`, asset, glbSourceName(mesh.name)));
      glb.attachment = asset.tags?.tag_weapon ? glb.transformsByName.get(asset.tags.tag_weapon) : undefined;
      const translate = asset.translate ?? [0, 0, 0];
      glb.holder.position.set(translate[0], translate[2], translate[1]);
      instance.root.scaling.setAll(asset.scale ?? 0.25);
      instance.modelIndex = definition.index;
      instance.skin = skin;
    }
    if (appearanceChanged || instance.selectedGun !== selectedGun) {
      instance.selectedGun = selectedGun;
      const weaponToken = ++instance.weaponUpdateToken;
      void this.updateGlbViewWeapon(instance, asset, selectedGun, weaponToken);
    }
  }

  private applyGlbAnimations(glb: GlbPlayerInstance, animation: string, secondaryAnimation: string | undefined,
                             animationMilliseconds: number, secondaryAnimationMilliseconds: number, loop: boolean): void {
    if (glb.activeAnimation !== animation || glb.activeSecondaryAnimation !== secondaryAnimation || glb.activeLoop !== loop) {
      const previous = glb.activeTransition;
      if (previous) previous.slots.forEach((slot) => slot.clip.group.stop(true));
      const key = `${animation}|${secondaryAnimation ?? ""}|${loop ? 1 : 0}`;
      const transition = glb.transitions.get(key) ?? createGlbAnimationTransition(glb, animation, secondaryAnimation, loop);
      glb.transitions.set(key, transition);
      glb.activeTransition = transition;
      glb.activeAnimation = animation;
      glb.activeSecondaryAnimation = secondaryAnimation;
      glb.activeLoop = loop;
      glb.lastFrames.fill(Number.NaN);
      transition.slots.forEach((slot, index) => {
        const group = slot.clip.group;
        group.mask = transition.masks[index];
        group.start(slot.loop, 0);
        group.pause();
      });
    }
    const slots = glb.activeTransition?.slots;
    if (!slots) return;
    for (let index = 0; index < slots.length; index++) {
      const slot = slots[index];
      const milliseconds = slot.usesPrimaryTime ? animationMilliseconds : secondaryAnimationMilliseconds;
      const frame = glbAnimationFrame(slot.clip, slot.spec, milliseconds, slot.loop);
      if (frame === glb.lastFrames[index]) continue;
      goToMaskedAnimationFrame(slot.clip.group, frame);
      glb.lastFrames[index] = frame;
    }
  }

  private glbContainer(path: string): Promise<AssetContainer> {
    let container = this.glbContainers.get(path);
    if (!container) {
      container = loadAssetContainerAsync(path, this.scene, { pluginOptions: { gltf: { skipMaterials: true } } });
      this.glbContainers.set(path, container);
    }
    return container;
  }

  private async updateGlbViewWeapon(instance: PlayerModelInstance, playerAsset: MapModelAsset, selectedGun: number,
                                    token: number): Promise<void> {
    const glb = instance.glb;
    if (!glb) return;
    const asset = (await this.weaponAssets())[selectedGun];
    if (token !== instance.weaponUpdateToken || instance.glb !== glb) return;
    if (!glb.attachment || !asset || asset.status !== "ready" || !asset.geometryPath) {
      this.disposeWeapon(instance);
      return;
    }
    const attachment = glb.attachment;
    const geometry = await this.staticWeaponGeometry(asset);
    if (token !== instance.weaponUpdateToken || instance.glb !== glb) return;
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
      const definitions = await response.json() as PlayerModelAsset[];
      this.assetDefinitions = definitions;
      return definitions;
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
    instance.weaponUpdateToken++;
    this.disposeWeapon(instance);
    this.disposeGlb(instance);
    instance.root.dispose();
  }

  private disposeGlb(instance: PlayerModelInstance): void {
    instance.glb?.activeTransition?.slots.forEach((slot) => slot.clip.group.stop(true));
    instance.glb?.entries.dispose();
    instance.glb?.holder.dispose();
    instance.glb = undefined;
    instance.meshes = [];
    instance.modelIndex = -1;
    instance.skin = undefined;
    instance.selectedGun = -1;
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

function glbAnimationFrame(clip: GlbAnimationClip, spec: PlayerModelAnimation, milliseconds: number, loop: boolean): number {
  const position = modelAnimationPosition(clip.frameCount, spec.speed, milliseconds, loop, spec.startOffset, spec.endOffset);
  return clip.group.from + position.frame + (position.nextFrame !== position.frame ? position.interpolation : 0);
}

function createGlbAnimationMetadata(entries: InstantiatedEntries, groups: Map<string, AnimationGroup>, definition: PlayerModelAsset):
  Pick<GlbPlayerInstance, "clips" | "lowerBodyMask" | "includeMasks" | "transformsByName"> {
  const clips = new Map<PlayerModelAnimation, GlbAnimationClip>();
  const animationSets = [definition.animations, ...definition.animationParts.map((part) => part.animations)];
  for (const animations of animationSets) {
    for (const spec of Object.values(animations)) {
      if (clips.has(spec)) continue;
      const group = groups.get(animationClipName(spec.path));
      if (group) clips.set(spec, { group, frameCount: Math.max(1, Math.round(group.to - group.from + 1)) });
    }
  }
  const rootNames = definition.animationParts.map((part) => new Set(part.roots.map((root) => root.toLowerCase())));
  const targetNames = definition.animationParts.map(() => new Set<string>());
  const visitedTargets = new Set<unknown>();
  for (const group of groups.values()) {
    for (const targeted of group.targetedAnimations) {
      const original = targeted.target as { name?: string; parent?: unknown } | undefined;
      if (!original?.name || visitedTargets.has(original)) continue;
      visitedTargets.add(original);
      let target = original;
      while (target) {
        const name = target.name?.toLowerCase();
        if (name) {
          for (let index = 1; index < rootNames.length; index++) {
            if (rootNames[index].has(name)) targetNames[index].add(original.name);
          }
        }
        target = target.parent as typeof target;
      }
    }
  }
  const upperNames = new Set<string>();
  for (let index = 1; index < targetNames.length; index++) targetNames[index].forEach((name) => upperNames.add(name));
  const lowerBodyMask = upperNames.size ? new AnimationGroupMask([...upperNames], AnimationGroupMaskMode.Exclude) : null;
  const includeMasks = new Array<AnimationGroupMask | null>(1 << targetNames.length).fill(null);
  for (let bits = 1; bits < includeMasks.length; bits++) {
    const names = new Set<string>();
    for (let index = 1; index < targetNames.length; index++) {
      if (bits & (1 << index)) targetNames[index].forEach((name) => names.add(name));
    }
    if (names.size) includeMasks[bits] = new AnimationGroupMask([...names], AnimationGroupMaskMode.Include);
  }
  const transformsByName = new Map<string, TransformNode>();
  for (const root of entries.rootNodes) {
    if (root instanceof TransformNode) transformsByName.set(root.name, root);
    for (const descendant of root.getDescendants(false)) {
      if (descendant instanceof TransformNode) transformsByName.set(descendant.name, descendant);
    }
  }
  return { clips, lowerBodyMask, includeMasks, transformsByName };
}

function createGlbAnimationTransition(glb: GlbPlayerInstance, animation: string, secondaryAnimation: string | undefined,
                                      loop: boolean): GlbAnimationTransition {
  const primary = glb.definition.animations[animation] ?? glb.definition.animations.idle;
  if (!primary) return { slots: [], masks: [] };
  if (!secondaryAnimation) return { slots: [glbAnimationSlot(glb, primary, true, loop)], masks: [null] };
  const slots: GlbAnimationSlot[] = [];
  const groupParts = new Map<AnimationGroup, number>();
  for (let index = 0; index < glb.definition.animationParts.length; index++) {
    const part = glb.definition.animationParts[index];
    const primaryPart = part.animations[animation];
    const secondaryPart = part.animations[secondaryAnimation];
    const spec = primaryPart && (!secondaryPart || primaryPart.priority >= secondaryPart.priority)
      ? primaryPart : secondaryPart ?? primaryPart ?? primary;
    const usesPrimaryTime = spec === primaryPart;
    const slot = glbAnimationSlot(glb, spec, usesPrimaryTime, usesPrimaryTime ? loop : secondaryAnimation !== "jump");
    slots.push(slot);
    if (index) groupParts.set(slot.clip.group, (groupParts.get(slot.clip.group) ?? 0) | (1 << index));
  }
  const masks = slots.map((slot, index) => index ? glb.includeMasks[groupParts.get(slot.clip.group) ?? 0] : glb.lowerBodyMask);
  return { slots, masks };
}

function glbAnimationSlot(glb: GlbPlayerInstance, spec: PlayerModelAnimation, usesPrimaryTime: boolean, loop: boolean): GlbAnimationSlot {
  const clip = glb.clips.get(spec);
  if (!clip) throw new Error(`GLB ${glb.modelName} is missing animation group ${animationClipName(spec.path)}.`);
  return { clip, spec, usesPrimaryTime, loop };
}

export function goToMaskedAnimationFrame(group: AnimationGroup, frame: number): void {
  for (const animatable of group.animatables) {
    if (!group.mask || group.mask.disabled || group.mask.retainsTarget(animatable.target.name)) animatable.goToFrame(frame);
  }
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

const ATTACK_ANIMATIONS = ["attack 1", "attack 2", "attack 3", "attack 4", "attack 5", "attack 6", "attack 7"] as const;
const HOLD_ANIMATIONS = ["hold 1", "hold 2", "hold 3", "hold 4", "hold 5", "hold 6", "hold 7"] as const;

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
