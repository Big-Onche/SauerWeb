import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import type { MapModelAsset, PlayerModelAsset, ViewWeaponAsset } from "../../assets/types";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { modelAnimationPosition, type ModelAnimationPosition } from "../../engine/modelanimation";
import { parseRagdoll, RAGDOLL_FADE, RAGDOLL_MILLIS, RagdollSimulation, type RagdollCollider,
  type RagdollSkeleton } from "../../engine/ragdoll";
import { interpolateModelGeometry, iqmAnimationInfo, md5AnimationInfo, parseIqm, prepareMd5Animation, prepareMd5Model, skinMd5Model,
  type ModelGeometry, type ModelGeometryMesh, type ModelJointPose, type PreparedMd5Animation,
  type PreparedMd5Model } from "../../engine/rendermodel";
import type { Vec3 } from "../../engine/octa";
import { ClientState } from "../../engine/physics/types";
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
  muzzle?: Vector3;
  visualKey: string;
  animation: string;
  frame: number;
  updateToken: number;
  updating: boolean;
  pendingUpdate?: ModelUpdateRequest;
  interpolatedGeometry?: ModelGeometry;
  ragdoll?: PlayerRagdollState;
}

interface ModelUpdateRequest {
  token: number;
  modelIndex: number;
  skin: "ffa" | "blueTeam" | "redTeam";
  visualKey: string;
  animation: string;
  animationMilliseconds: number;
  loop: boolean;
  yaw: number;
  selectedGun: number;
  deadAt?: number;
  nowMilliseconds: number;
  velocity: Vec3;
}

interface MeshVertexBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: number[];
}

interface RagdollMeshBinding {
  positions: number[];
  animatedPositions: Float32Array;
  joints: number[];
  jointPositions: number[];
}

interface RagdollJointTransform {
  origin: Vector3;
  axes: [Vector3, Vector3, Vector3];
}

interface PlayerRagdollState {
  deadAt: number;
  simulation: RagdollSimulation;
  bindings: RagdollMeshBinding[];
  inverseWorld: ReturnType<TransformNode["computeWorldMatrix"]>;
}

interface SavedRagdoll {
  instance: PlayerModelInstance;
  expiresAt: number;
}

// Keep only the current visual working set. MD5 source topology and compact animation channels are prepared separately, so an evicted
// frame only needs inexpensive skinning rather than reparsing the mesh and animation files.
const MAX_GEOMETRY_FRAME_CACHE = 64;

// Browser counterpart of src/fpsgame/render.cpp's model batching and src/engine/ragdoll.h's death simulation.
export class PlayerRenderer {
  private readonly instances = new Map<number, PlayerModelInstance>();
  private readonly savedRagdolls: SavedRagdoll[] = [];
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly textSources = new Map<string, Promise<string>>();
  private readonly binarySources = new Map<string, Promise<ArrayBuffer>>();
  private readonly geometryFrames = new Map<string, ModelGeometry>();
  private readonly md5Models = new Map<string, PreparedMd5Model>();
  private readonly md5Animations = new Map<string, PreparedMd5Animation>();
  private readonly ragdollSkeletons = new Map<string, Promise<RagdollSkeleton>>();
  private readonly meshVertexBuffers = new WeakMap<Mesh, MeshVertexBuffers>();
  private assets?: Promise<PlayerModelAsset[]>;
  private viewWeapons?: Promise<ViewWeaponAsset[]>;
  private geometryGeneration = 0;

  constructor(private readonly scene: Scene, private readonly ragdollCollider?: RagdollCollider,
              private readonly performanceRecorder?: (milliseconds: number) => void, private readonly profilingEnabled?: () => boolean) {}

  rendergame(players: readonly RenderPlayer[], gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    const active = new Set<number>();
    for (const player of players) {
      active.add(player.id);
      const existing = this.instances.get(player.id);
      if (existing?.ragdoll && (player.state !== ClientState.Dead || existing.ragdoll.deadAt !== (player.deadAt ?? 0))) {
        this.saveRagdoll(player.id, existing, nowMilliseconds);
      }
      this.renderplayer(player, gameMode, teamskins, localTeam, nowMilliseconds);
    }
    for (const [id, instance] of this.instances) {
      if (active.has(id)) continue;
      if (instance.ragdoll) this.saveRagdoll(id, instance, nowMilliseconds);
      else this.disposeInstance(instance);
      this.instances.delete(id);
    }
    for (let index = this.savedRagdolls.length - 1; index >= 0; index--) {
      const saved = this.savedRagdolls[index];
      if (nowMilliseconds >= saved.expiresAt) {
        this.disposeInstance(saved.instance);
        this.savedRagdolls.splice(index, 1);
        continue;
      }
      saved.instance.ragdoll?.simulation.move(nowMilliseconds);
      this.applyRagdoll(saved.instance);
      const visibility = Math.min(1, (saved.expiresAt - nowMilliseconds) / RAGDOLL_FADE);
      saved.instance.meshes.forEach((mesh) => mesh.visibility = visibility);
    }
  }

  clear(): void {
    this.geometryGeneration++;
    this.instances.forEach((instance) => this.disposeInstance(instance));
    this.instances.clear();
    this.savedRagdolls.forEach((saved) => this.disposeInstance(saved.instance));
    this.savedRagdolls.length = 0;
    this.materials.forEach((material) => material.dispose(true, true));
    this.materials.clear();
    this.geometryFrames.clear();
    this.md5Models.clear();
    this.md5Animations.clear();
  }

  private saveRagdoll(id: number, instance: PlayerModelInstance, nowMilliseconds: number): void {
    const deadAt = instance.ragdoll?.deadAt ?? nowMilliseconds;
    const fadeStart = deadAt + Math.max(RAGDOLL_MILLIS - RAGDOLL_FADE, 0);
    const expiresAt = nowMilliseconds > fadeStart ? nowMilliseconds + Math.min(RAGDOLL_MILLIS, RAGDOLL_FADE) : deadAt + RAGDOLL_MILLIS;
    this.instances.delete(id);
    instance.root.name = `ragdoll-${id}-${deadAt}`;
    this.savedRagdolls.push({ instance, expiresAt });
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
    if (!instance?.muzzle || !instance.root.isEnabled()) return undefined;
    const position = Vector3.TransformCoordinates(instance.muzzle, instance.root.computeWorldMatrix(true));
    return { x: position.x, y: position.z, z: position.y };
  }

  private renderplayer(player: RenderPlayer, gameMode: number, teamskins: boolean, localTeam: string, nowMilliseconds: number): void {
    let instance = this.instances.get(player.id);
    if (!instance) {
      instance = { root: new TransformNode(`player-${player.id}`, this.scene), meshes: [], weaponMeshes: [], weaponKey: "", visualKey: "",
        animation: "", frame: -1, updateToken: 0, updating: false };
      this.instances.set(player.id, instance);
    }
    instance.root.setEnabled(player.visible);
    const targetPosition = toBabylonPosition(player.position);
    if (!instance.ragdoll || player.state !== ClientState.Dead || instance.ragdoll.deadAt !== (player.deadAt ?? 0)) {
      instance.root.position.copyFrom(targetPosition);
    }
    if (!player.visible) return;
    const model = getplayermodelinfo(player.model);
    const skin = playerSkin(gameMode, teamskins, localTeam, player.team, player.local);
    const visualKey = `${model.index}:${skin}:${player.selectedGun}`;
    const baseAnimation = renderclient(player, nowMilliseconds);
    const attacking = player.lastAttackGun === player.selectedGun && nowMilliseconds - player.lastAction < player.gunWait + 50;
    const animation = attacking ? `attack ${player.selectedGun + 1}` : baseAnimation === "idle" ? `hold ${player.selectedGun + 1}` : baseAnimation;
    const animationMilliseconds = animation === "dying" ? Math.max(0, nowMilliseconds - (player.deadAt ?? nowMilliseconds))
      : animation === "pain" ? Math.max(0, nowMilliseconds - (player.lastPain ?? nowMilliseconds))
        : animation === "jump" ? player.timeInAir ?? 0 : attacking ? Math.max(0, nowMilliseconds - player.lastAction) : nowMilliseconds;
    const loop = !attacking && animation !== "dying" && animation !== "pain" && animation !== "jump";
    if (player.state !== ClientState.Dead) instance.ragdoll = undefined;
    this.requestModelUpdate(instance, {
      modelIndex: model.index,
      skin,
      visualKey,
      animation,
      animationMilliseconds,
      loop,
      yaw: player.yaw,
      selectedGun: player.selectedGun,
      deadAt: player.state === ClientState.Dead ? player.deadAt ?? 0 : undefined,
      nowMilliseconds,
      velocity: player.velocity ?? { x: 0, y: 0, z: player.velocityZ ?? 0 },
    });
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
        await this.updateModel(instance, request.modelIndex, request.skin, request.visualKey, request.animation,
          request.animationMilliseconds, request.loop, request.yaw, request.selectedGun, request.deadAt, request.nowMilliseconds,
          request.velocity, request.token);
      }
    } finally {
      instance.updating = false;
      if (instance.pendingUpdate) this.requestModelUpdate(instance, instance.pendingUpdate);
    }
  }

  private async updateModel(instance: PlayerModelInstance, modelIndex: number, skin: "ffa" | "blueTeam" | "redTeam", visualKey: string,
                            animation: string, animationMilliseconds: number, loop: boolean, yaw: number, selectedGun: number,
                            deadAt: number | undefined, nowMilliseconds: number, velocity: Vec3, token: number): Promise<void> {
    const assets = await (this.assets ??= fetch("/api/playermodels", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`Could not load player model manifest (${response.status}).`);
      return response.json() as Promise<PlayerModelAsset[]>;
    }));
    if (token !== instance.updateToken) return;
    const definition = assets[modelIndex] ?? assets[0];
    const asset = definition?.[skin] ?? definition?.ffa;
    if (!definition || !asset || asset.status !== "ready" || !asset.geometryPath) return;
    if (deadAt !== undefined && instance.ragdoll?.deadAt === deadAt) {
      instance.ragdoll.simulation.move(nowMilliseconds);
      this.applyRagdoll(instance);
      return;
    }
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
    const geometry = await this.geometry(asset, animationPath, animationSource, animationBuffer, position, instance);
    if (token !== instance.updateToken) return;
    if (instance.visualKey !== visualKey || instance.meshes.length !== geometry.meshes.length) {
      this.createMeshes(instance, definition, asset, geometry);
    }
    else this.updateMeshes(instance.meshes, geometry.meshes, asset);
    await this.updateViewWeapon(instance, asset, geometry, selectedGun);
    if (token !== instance.updateToken) return;
    if (deadAt !== undefined && definition.ragdollPath) {
      await this.startRagdoll(instance, definition.ragdollPath, geometry, asset, deadAt, velocity, nowMilliseconds, token);
      if (token !== instance.updateToken) return;
      this.disposeWeapon(instance);
    }
    instance.visualKey = visualKey;
    instance.animation = animation;
    instance.frame = frame;
  }

  private async startRagdoll(instance: PlayerModelInstance, path: string, geometry: ModelGeometry, asset: MapModelAsset, deadAt: number,
                             velocity: Vec3, nowMilliseconds: number, token: number): Promise<void> {
    const skeleton = await this.ragdollSkeleton(path);
    if (token !== instance.updateToken || !skeleton.vertices.length || instance.ragdoll?.deadAt === deadAt) return;
    instance.root.computeWorldMatrix(true);
    const initialLocalVertices = skeleton.vertices.map((vertex) => new Vector3((vertex.x + (asset.translate?.[0] ?? 0)) * (asset.scale ?? 0.25),
      (vertex.z + (asset.translate?.[2] ?? 0)) * (asset.scale ?? 0.25),
      (vertex.y + (asset.translate?.[1] ?? 0)) * (asset.scale ?? 0.25)));
    const worldVertices = initialLocalVertices.map((vertex) => {
      const point = Vector3.TransformCoordinates(vertex, instance.root.getWorldMatrix());
      return { x: point.x, y: point.y, z: point.z };
    });
    const simulation = new RagdollSimulation(skeleton, worldVertices, { x: velocity.x, y: velocity.z, z: velocity.y }, nowMilliseconds,
      this.ragdollCollider, asset.scale ?? 0.25);
    const inverseWorld = instance.root.getWorldMatrix().clone().invert();
    instance.ragdoll = {
      deadAt,
      simulation,
      inverseWorld,
      bindings: geometry.meshes.map((mesh) => this.bindRagdollMesh(mesh, asset, skeleton, initialLocalVertices)),
    };
  }

  private bindRagdollMesh(mesh: ModelGeometryMesh, asset: MapModelAsset, skeleton: RagdollSkeleton,
                          particles: readonly Vector3[]): RagdollMeshBinding {
    const positions = translateAndScale(mesh.positions, asset.translate ?? [0, 0, 0], asset.scale ?? 0.25);
    const transforms = this.ragdollJointTransforms(skeleton, particles);
    const joints: number[] = [];
    const jointPositions: number[] = [];
    for (let index = 0; index < positions.length; index += 3) {
      const vertex = new Vector3(positions[index], positions[index + 1], positions[index + 2]);
      const bone = mesh.bones?.[index / 3];
      let closest = bone === undefined ? -1 : skeleton.joints.findIndex((joint) => joint.bone === bone);
      let closestDistance = Number.POSITIVE_INFINITY;
      if (closest < 0) transforms.forEach((transform, jointIndex) => {
        const distance = Vector3.DistanceSquared(vertex, transform.origin);
        if (distance < closestDistance) {
          closest = jointIndex;
          closestDistance = distance;
        }
      });
      closest = Math.max(closest, 0);
      const transform = transforms[closest];
      const relative = vertex.subtract(transform.origin);
      joints.push(closest);
      jointPositions.push(Vector3.Dot(relative, transform.axes[0]), Vector3.Dot(relative, transform.axes[1]),
        Vector3.Dot(relative, transform.axes[2]));
    }
    return { positions, animatedPositions: new Float32Array(positions.length), joints, jointPositions };
  }

  private applyRagdoll(instance: PlayerModelInstance): void {
    const profiling = this.performanceRecorder && this.profilingEnabled?.();
    const startedAt = profiling ? performance.now() : 0;
    try {
      this.applyRagdollGeometry(instance);
    } finally {
      if (profiling) this.performanceRecorder!(performance.now() - startedAt);
    }
  }

  private applyRagdollGeometry(instance: PlayerModelInstance): void {
    const ragdoll = instance.ragdoll;
    if (!ragdoll) return;
    const currentLocalVertices = ragdoll.simulation.vertices.map((vertex) => Vector3.TransformCoordinates(
      new Vector3(vertex.position.x, vertex.position.y, vertex.position.z), ragdoll.inverseWorld));
    const currentJoints = this.ragdollJointTransforms(ragdoll.simulation.skeleton, currentLocalVertices);
    instance.meshes.forEach((mesh, meshIndex) => {
      const binding = ragdoll.bindings[meshIndex];
      if (!binding) return;
      const positions = binding.animatedPositions;
      positions.set(binding.positions);
      for (let vertexIndex = 0; vertexIndex < binding.joints.length; vertexIndex++) {
        const transform = currentJoints[binding.joints[vertexIndex]];
        const localOffset = vertexIndex * 3;
        const point = transform.origin.add(transform.axes[0].scale(binding.jointPositions[localOffset]))
          .addInPlace(transform.axes[1].scale(binding.jointPositions[localOffset + 1]))
          .addInPlace(transform.axes[2].scale(binding.jointPositions[localOffset + 2]));
        const offset = vertexIndex * 3;
        positions[offset] = point.x;
        positions[offset + 1] = point.y;
        positions[offset + 2] = point.z;
      }
      this.updateMeshVertices(mesh, positions);
    });
  }

  private ragdollJointTransforms(skeleton: RagdollSkeleton, vertices: readonly Vector3[]): RagdollJointTransform[] {
    if (!skeleton.joints.length) {
      return vertices.map((origin) => ({ origin, axes: [Vector3.Right(), Vector3.Up(), Vector3.Forward()] }));
    }
    return skeleton.joints.map((joint) => {
      const triangle = skeleton.triangles[joint.triangle];
      const first = vertices[triangle?.vertices[0] ?? 0] ?? Vector3.Zero();
      const second = vertices[triangle?.vertices[1] ?? 0] ?? first.add(Vector3.Right());
      const third = vertices[triangle?.vertices[2] ?? 0] ?? first.add(Vector3.Up());
      const firstAxis = second.subtract(first).normalize();
      const thirdAxis = Vector3.Cross(firstAxis, third.subtract(first)).normalize();
      const secondAxis = Vector3.Cross(thirdAxis, firstAxis).normalize();
      const jointVertices = joint.vertices.filter((index) => index >= 0).map((index) => vertices[index]).filter(Boolean);
      const origin = jointVertices.length ? jointVertices.reduce((sum, vertex) => sum.addInPlace(vertex), Vector3.Zero())
        .scaleInPlace(1 / jointVertices.length) : first.add(second).addInPlace(third).scaleInPlace(1 / 3);
      return { origin, axes: [firstAxis, secondAxis, thirdAxis] };
    });
  }

  private ragdollSkeleton(path: string): Promise<RagdollSkeleton> {
    let skeleton = this.ragdollSkeletons.get(path);
    if (!skeleton) {
      skeleton = this.fetchText(path).then(parseRagdoll);
      this.ragdollSkeletons.set(path, skeleton);
    }
    return skeleton;
  }

  private async updateViewWeapon(instance: PlayerModelInstance, playerAsset: MapModelAsset, playerGeometry: ModelGeometry,
                                 selectedGun: number): Promise<void> {
    const assets = await (this.viewWeapons ??= fetch("/api/viewweapons", { cache: "no-store" }).then(async (response) => {
      if (!response.ok) throw new Error(`View-weapon manifest request failed (${response.status}).`);
      return response.json() as Promise<ViewWeaponAsset[]>;
    }));
    const asset = assets[selectedGun];
    const attachmentBone = playerAsset.tags?.tag_weapon;
    const attachment = playerGeometry.joints?.find((joint) => joint.name === attachmentBone);
    if (!asset || asset.status !== "ready" || !asset.geometryPath || !attachment) {
      this.disposeWeapon(instance);
      return;
    }
    const geometry = await this.geometryFrame(asset, undefined, undefined, undefined, 0);
    if (instance.weaponKey !== asset.name || instance.weaponMeshes.length !== geometry.meshes.length) {
      this.disposeWeapon(instance);
      instance.weaponMeshes = geometry.meshes.map((source) => {
        const mesh = new Mesh(`${instance.root.name}-${asset.name}-${source.name}`, this.scene);
        mesh.parent = instance.root;
        mesh.material = this.assetMaterial(`vwep:${asset.gun}`, asset, source.name);
        mesh.isPickable = false;
        return mesh;
      });
      instance.weaponKey = asset.name;
    }
    const playerScale = playerAsset.scale ?? 0.25;
    const playerTranslate = playerAsset.translate ?? [0, 0, 0];
    geometry.meshes.forEach((source, index) => {
      const local = translateAndScale(source.positions, asset.translate ?? [0, 0, 0], asset.scale ?? 0.25);
      const positions = attachModelPositions(local, attachment, playerTranslate, playerScale);
      this.applyMesh(instance.weaponMeshes[index], source, positions);
    });
    const muzzleBone = asset.tags?.tag_muzzle;
    const muzzle = geometry.joints?.find((joint) => joint.name === muzzleBone);
    instance.muzzle = muzzle ? attachModelPosition(translateAndScalePosition(muzzle.position, asset.translate ?? [0, 0, 0],
      asset.scale ?? 0.25), attachment, playerTranslate, playerScale) : undefined;
  }

  private async geometry(asset: MapModelAsset, animationPath: string | undefined, animationSource: string | undefined,
                         animationBuffer: ArrayBuffer | undefined, position: ModelAnimationPosition,
                         instance?: PlayerModelInstance): Promise<ModelGeometry> {
    const current = await this.geometryFrame(asset, animationPath, animationSource, animationBuffer, position.frame);
    if (position.interpolation <= 0 || position.nextFrame === position.frame) return current;
    const next = await this.geometryFrame(asset, animationPath, animationSource, animationBuffer, position.nextFrame);
    const geometry = this.profile(() => interpolateModelGeometry(current, next, position.interpolation, instance?.interpolatedGeometry));
    if (instance) instance.interpolatedGeometry = geometry;
    return geometry;
  }

  private async geometryFrame(asset: MapModelAsset, animationPath: string | undefined, animationSource: string | undefined,
                              animationBuffer: ArrayBuffer | undefined, frame: number): Promise<ModelGeometry> {
    const generation = this.geometryGeneration;
    const key = `${asset.geometryPath}:${animationPath ?? "bind"}:${frame}`;
    const cached = this.cachedGeometryFrame(key);
    if (cached) return cached;
    let geometry: ModelGeometry;
    if (asset.format === "MD5") {
      const source = await this.fetchText(asset.geometryPath!);
      const shared = this.cachedGeometryFrame(key);
      if (shared) return shared;
      let model = this.md5Models.get(asset.geometryPath!);
      if (!model) {
        model = this.profile(() => prepareMd5Model(source));
        if (generation === this.geometryGeneration) this.md5Models.set(asset.geometryPath!, model);
      }
      let animation = animationPath ? this.md5Animations.get(animationPath) : undefined;
      if (animationPath && animationSource && !animation) {
        animation = this.profile(() => prepareMd5Animation(animationSource));
        if (generation === this.geometryGeneration) this.md5Animations.set(animationPath, animation);
      }
      geometry = this.profile(() => skinMd5Model(model!, animation, frame));
    } else if (asset.format === "IQM") {
      const source = await this.fetchBinary(asset.geometryPath!);
      const shared = this.cachedGeometryFrame(key);
      if (shared) return shared;
      geometry = this.profile(() => parseIqm(source, animationBuffer, frame));
    }
    else throw new Error(`Player model format ${asset.format ?? "unknown"} is not supported.`);
    if (generation !== this.geometryGeneration) return geometry;
    this.geometryFrames.set(key, geometry);
    while (this.geometryFrames.size > MAX_GEOMETRY_FRAME_CACHE) {
      const oldest = this.geometryFrames.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.geometryFrames.delete(oldest);
    }
    return geometry;
  }

  private cachedGeometryFrame(key: string): ModelGeometry | undefined {
    const cached = this.geometryFrames.get(key);
    if (!cached) return undefined;
    this.geometryFrames.delete(key);
    this.geometryFrames.set(key, cached);
    return cached;
  }

  private createMeshes(instance: PlayerModelInstance, definition: PlayerModelAsset, asset: MapModelAsset, geometry: ModelGeometry): void {
    instance.meshes.forEach((mesh) => mesh.dispose());
    instance.meshes = geometry.meshes.map((source) => {
      const mesh = new Mesh(`${instance.root.name}-${definition.name}-${source.name}`, this.scene);
      mesh.parent = instance.root;
      mesh.material = this.assetMaterial(`player:${definition.index}`, asset, source.name);
      mesh.isPickable = false;
      return mesh;
    });
    this.updateMeshes(instance.meshes, geometry.meshes, asset);
  }

  private updateMeshes(meshes: Mesh[], sources: ModelGeometryMesh[], asset: MapModelAsset): void {
    this.profile(() => {
      sources.forEach((source, index) => {
        const mesh = meshes[index];
        const translate = asset.translate ?? [0, 0, 0];
        const scale = asset.scale ?? 0.25;
        const existing = this.meshVertexBuffers.get(mesh);
        const created = !existing || existing.positions.length !== source.positions.length;
        const buffers = created
          ? { positions: new Float32Array(source.positions.length), normals: new Float32Array(source.positions.length), indices: source.indices }
          : existing;
        for (let offset = 0; offset < buffers.positions.length; offset += 3) {
          buffers.positions[offset] = (source.positions[offset] + translate[0]) * scale;
          buffers.positions[offset + 1] = (source.positions[offset + 1] + translate[2]) * scale;
          buffers.positions[offset + 2] = (source.positions[offset + 2] + translate[1]) * scale;
        }
        VertexData.ComputeNormals(buffers.positions, buffers.indices, buffers.normals);
        if (created) {
          const data = new VertexData();
          data.positions = buffers.positions;
          data.indices = source.indices;
          data.uvs = source.uvs;
          data.normals = buffers.normals;
          data.applyToMesh(mesh, true);
          this.meshVertexBuffers.set(mesh, buffers);
        } else {
          mesh.updateVerticesData(VertexBuffer.PositionKind, buffers.positions, true);
          mesh.updateVerticesData(VertexBuffer.NormalKind, buffers.normals, false);
        }
      });
    });
  }

  private applyMesh(mesh: Mesh, source: ModelGeometryMesh, positions: number[]): void {
    let buffers = this.meshVertexBuffers.get(mesh);
    if (buffers && buffers.positions.length === positions.length) {
      this.updateMeshVertices(mesh, positions);
      return;
    }
    buffers = { positions: Float32Array.from(positions), normals: new Float32Array(positions.length), indices: source.indices };
    VertexData.ComputeNormals(buffers.positions, source.indices, buffers.normals);
    const data = new VertexData();
    data.positions = buffers.positions;
    data.indices = source.indices;
    data.uvs = source.uvs;
    data.normals = buffers.normals;
    data.applyToMesh(mesh, true);
    this.meshVertexBuffers.set(mesh, buffers);
  }

  private updateMeshVertices(mesh: Mesh, positions: ArrayLike<number>): void {
    const buffers = this.meshVertexBuffers.get(mesh);
    if (!buffers || buffers.positions.length !== positions.length) return;
    buffers.positions.set(positions);
    VertexData.ComputeNormals(buffers.positions, buffers.indices, buffers.normals);
    mesh.updateVerticesData(VertexBuffer.PositionKind, buffers.positions, true);
    mesh.updateVerticesData(VertexBuffer.NormalKind, buffers.normals, false);
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
    instance.updateToken++;
    instance.pendingUpdate = undefined;
    instance.meshes.forEach((mesh) => mesh.dispose());
    this.disposeWeapon(instance);
    instance.root.dispose();
  }

  private disposeWeapon(instance: PlayerModelInstance): void {
    instance.weaponMeshes.forEach((mesh) => mesh.dispose());
    instance.weaponMeshes = [];
    instance.weaponKey = "";
    instance.muzzle = undefined;
  }

  private profile<T>(operation: () => T): T {
    if (!this.performanceRecorder || !this.profilingEnabled?.()) return operation();
    const startedAt = performance.now();
    try {
      return operation();
    } finally {
      this.performanceRecorder(performance.now() - startedAt);
    }
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

function translateAndScalePosition(position: [number, number, number], translate: [number, number, number], scale: number): Vector3 {
  return new Vector3((position[0] + translate[0]) * scale, (position[2] + translate[2]) * scale,
    (position[1] + translate[1]) * scale);
}

function attachModelPositions(positions: number[], attachment: ModelJointPose, playerTranslate: [number, number, number],
                              playerScale: number): number[] {
  const result = new Array<number>(positions.length);
  for (let index = 0; index < positions.length; index += 3) {
    const attached = attachModelPosition(new Vector3(positions[index], positions[index + 1], positions[index + 2]), attachment,
      playerTranslate, playerScale);
    result.splice(index, 3, attached.x, attached.y, attached.z);
  }
  return result;
}

function attachModelPosition(position: Vector3, attachment: ModelJointPose, playerTranslate: [number, number, number],
                             playerScale: number): Vector3 {
  const point = rotateModelPosition(position, attachment.orientation);
  return point.add(new Vector3((attachment.position[0] + playerTranslate[0]) * playerScale,
    (attachment.position[2] + playerTranslate[2]) * playerScale, (attachment.position[1] + playerTranslate[1]) * playerScale));
}

function rotateModelPosition(position: Vector3, orientation: [number, number, number, number]): Vector3 {
  const point: [number, number, number] = [position.x, position.z, position.y];
  const [x, y, z, w] = orientation;
  const tx = 2 * (y * point[2] - z * point[1]);
  const ty = 2 * (z * point[0] - x * point[2]);
  const tz = 2 * (x * point[1] - y * point[0]);
  return new Vector3(point[0] + w * tx + y * tz - z * ty, point[2] + w * tz + x * ty - y * tx,
    point[1] + w * ty + z * tx - x * tz);
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
