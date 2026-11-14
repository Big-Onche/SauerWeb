import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Matrix, Vector2, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Plane } from "@babylonjs/core/Maths/math.plane";
import { Frustum } from "@babylonjs/core/Maths/math.frustum";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { RenderTargetTexture } from "@babylonjs/core/Materials/Textures/renderTargetTexture";
import { MirrorTexture } from "@babylonjs/core/Materials/Textures/mirrorTexture";
import { Material } from "@babylonjs/core/Materials/material";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import type { AbstractMesh } from "@babylonjs/core/Meshes/abstractMesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { DepthRenderer } from "@babylonjs/core/Rendering/depthRenderer";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import "@babylonjs/core/Rendering/depthRendererSceneComponent";
import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/postprocess.vertex";
import type { RegisteredMapEntity, SauerMap } from "../engine/octa";
import type { MapFogOverrides, MapLightingOverrides, MapModelAsset, MapSkyOverrides, MapSoundAsset, MapWaterOverrides,
  ResolvedTexture } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import { generateGeometry, type GeometryBatch } from "../engine/renderva";
import { generateMaterialGeometry, type MaterialGeometryBatch, type MaterialRenderKind } from "./materialGeometry";
import { describeSauerMaterial, MaterialCache } from "./MaterialCache";
import { toBabylonDirection, toBabylonPosition, toBabylonYawDirection } from "./coordinates";
import { resolveMapLighting } from "./MapLighting";
import { animateEntityModels, loadMapModels, type EntityModelAnimation, type MapModelResources } from "./MapModelLoader";
import { resolveMapSky, skyFaceCandidates, skyTextureRotationRadians, type MapSky } from "./MapSky";
import { createFogDomeGeometry, resolveMapFog, type MapFog } from "./MapFog";
import { animatedWaterSurfaceHeight, resolveMapWater, underwaterFogBlend, type MapWaterMaterial } from "./MapWater";
import { loadWaterQuality, waterReflectionSize, WATER_QUALITY_CHANGED, type WaterQuality } from "./WaterSettings";
import { createMapCausticResources, shouldUseCaustics, StandardMaterialCaustics, type MapCausticResources } from "./MapCaustics";
import { installSauerFogDistance } from "./SauerFogShader";
import { BrowserFreeCameraInput, BrowserPhysicsInput } from "../platform/browser/PhysicsInput";
import { PhysicsSimulation, type PhysicsDebugSnapshot } from "../engine/physics";
import { createClient, type MultiplayerEvent, type NetworkPlayer, type ServerEndpoint } from "../fpsgame/client";
import { BrowserWeaponInput } from "../platform/browser/WeaponInput";
import { WeaponHUD } from "../platform/browser/WeaponHUD";
import { CrosshairHUD } from "../platform/browser/CrosshairHUD";
import { WeaponRenderer } from "../platform/browser/WeaponRenderer";
import { WeaponAudio } from "../platform/browser/WeaponAudio";
import { ParticleRenderer } from "./ParticleRenderer";
import { MultiplayerHUD } from "../platform/browser/MultiplayerHUD";
import { SpectatorHUD } from "../platform/browser/SpectatorHUD";
import { PlayerRenderer, thirdpersoncamera, type RenderPlayer } from "../platform/browser/PlayerRenderer";
import { CtfRenderer } from "../platform/browser/CtfRenderer";
import { CollectRenderer } from "../platform/browser/CollectRenderer";
import { ITEM_ICONS } from "../fpsgame/entities";
import { ClientState, PhysicsState } from "../engine/physics/types";
import { ctfTeamFlag } from "../fpsgame/ctf";
import { COLLECT_TOKEN_LIMIT, collectTeamBase } from "../fpsgame/collect";
import { interpolateNetworkEntity } from "../fpsgame/networkInterpolation";
import type { RuntimeMode } from "../runtime";
import { lineCylinderIntersection } from "../fpsgame/weapon/HitscanSystem";
import type { Damageable } from "../fpsgame/weapon/DamageSystem";
import { magnitude, normalize, subtract } from "../engine/physics/vector";
import { AiStateType, AiTargetType, BotManager, type AiInterest, type BotActor } from "../fpsgame/ai";
import { MATF_INDEX, MATF_VOLUME, MAT_WATER } from "../engine/material";
import { GameModeFlag, gameModeHas } from "../fpsgame/game";
import { SIGHTMIN } from "../fpsgame/waypoint";
import { RendererPerformanceOverlay, type RendererDiagnosticState, type RendererResourceCounters,
  type RendererResourceOwner } from "../platform/browser/RendererPerformanceOverlay";
import { FrameProfiler } from "../platform/browser/FrameProfiler";
import { TouchControls } from "../platform/browser/TouchControls";
import { KillFeed } from "../platform/browser/KillFeed";

export type CameraMode = "free" | "player";

export function isBotLocallySimulated(ownerNumber: number, localClientNumber: number): boolean {
  return ownerNumber < 0 || ownerNumber === localClientNumber;
}

export interface SceneStats {
  meshes: number;
  faces: number;
  triangles: number;
  vertices: number;
  materialVolumes: number;
  mapModelIssues: string[];
}

export interface ViewportTuning {
  contrast: number;
  gamma: number;
  vibrance: number;
}

export const DEFAULT_VIEWPORT_TUNING: Readonly<ViewportTuning> = { contrast: 1.3, gamma: 1.85, vibrance: 1.65 };

interface WaterReflectionPlane {
  readonly height: number;
  readonly texture: MirrorTexture;
  readonly meshes: Set<Mesh>;
  readonly projectiveMatrix: Matrix;
  readonly renderMeshes: AbstractMesh[];
  readonly frustumPlanes: Plane[];
  initialized: boolean;
  distanceSquared: number;
}

export class MapScene {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly canvas: HTMLCanvasElement;
  private readonly freeCamera: UniversalCamera;
  private readonly playerCamera: UniversalCamera;
  private readonly physics = new PhysicsSimulation();
  private readonly fpsClient = createClient(this.physics);
  private readonly physicsInput: BrowserPhysicsInput;
  private readonly weapons = this.fpsClient.weapons;
  private readonly bots = new BotManager(this.physics, this.physics.player, {
    event: (event, bot) => {
      if (event.type === "shot") {
        this.weapons.events.emit({ type: "shot-effect", gun: event.gun, from: event.from, to: event.to, rays: event.rays,
          clientNumber: bot.clientNumber });
      }
      if (event.type === "bouncer-spawned" || event.type === "bouncer-moved" || event.type === "bouncer-removed" ||
          event.type === "bouncer-impact" || event.type === "explosion" || event.type === "projectile-spawned" ||
          event.type === "projectile-moved" || event.type === "projectile-removed") this.weapons.events.emit(event);
      if (event.type === "death" && event.target === this.physics.player) {
        if (bot.ownerNumber < 0 && this.fpsClient.multiplayer.clientNumber >= 0) {
          const victim = this.fpsClient.multiplayer.players.get(this.fpsClient.multiplayer.clientNumber);
          bot.frags += bot.team && bot.team === victim?.team ? -1 : 1;
          this.fpsClient.multiplayer.localDied(this.fpsClient.multiplayer.clientNumber, bot.clientNumber);
        } else this.fpsClient.multiplayer.notifyLocalStateChange();
      } else if (event.type === "death" && bot.ownerNumber < 0 && "clientNumber" in event.target) {
        const victim = event.target as BotActor;
        if (victim.ownerNumber < 0 && this.fpsClient.multiplayer.clientNumber >= 0) {
          if (bot.team && bot.team === victim.team) bot.frags -= 2;
          this.fpsClient.multiplayer.localDied(victim.clientNumber, bot.clientNumber);
        }
      }
      if (bot.ownerNumber === this.fpsClient.multiplayer.clientNumber) this.fpsClient.multiplayer.sendOwnedBotEvent(bot.clientNumber, event);
    },
    spawnRequest: (bot) => this.fpsClient.multiplayer.requestOwnedBotSpawn(bot.clientNumber),
    changed: () => this.syncBotTargets(),
    objective: (bot, _state, interests) => this.gameModeAiObjective(bot, interests),
    itemPickup: (bot, entityIndex, now) => this.fpsClient.multiplayer.tryBotItemPickup(bot, entityIndex, now),
    itemAvailable: (bot, entityIndex) => this.fpsClient.multiplayer.isBotItemAvailable(bot, entityIndex),
    quadExpired: (bot) => this.fpsClient.multiplayer.notifyQuadExpired(bot.position),
  });
  private readonly weaponInput: BrowserWeaponInput;
  private readonly touchControls: TouchControls;
  private readonly weaponHUD: WeaponHUD;
  private readonly crosshairHUD: CrosshairHUD;
  private readonly weaponRenderer: WeaponRenderer;
  private readonly particleRenderer: ParticleRenderer;
  private readonly multiplayerHUD: MultiplayerHUD;
  private readonly spectatorHUD: SpectatorHUD;
  private readonly killFeed: KillFeed;
  private readonly playerRenderer: PlayerRenderer;
  private readonly ctfRenderer: CtfRenderer;
  private readonly collectRenderer: CollectRenderer;
  private readonly gameAudio: WeaponAudio;
  private cameraMode: CameraMode = "free";
  private thirdperson = false;
  private teamskins = false;
  private materialCache: MaterialCache;
  private fallbackMaterial?: StandardMaterial;
  private skyboxMaterial?: StandardMaterial;
  private fogDomeMaterial?: Material;
  private skyboxObjectUrls: string[] = [];
  private loadGeneration = 0;
  private wireframe = false;
  private materialDebug = false;
  private readonly volumeMeshes: Mesh[] = [];
  private readonly volumeMaterials = new Map<string, Material>();
  private readonly waterMaterials = new Map<string, ShaderMaterial>();
  private readonly waterDepthRenderers = new Map<Camera, DepthRenderer>();
  private waterRefractionTexture?: RenderTargetTexture;
  private waterNormalTexture?: Texture;
  private waterDistortionTexture?: Texture;
  private readonly waterReflections = new Map<number, WaterReflectionPlane>();
  private readonly activeWaterReflections = new Set<WaterReflectionPlane>();
  private readonly waterReflectionCandidates: WaterReflectionPlane[] = [];
  private selectedWaterReflection?: WaterReflectionPlane;
  private mapCaustics?: MapCausticResources;
  private waterParameters: MapWaterMaterial[] = [];
  private mapFog?: MapFog;
  private waterQuality: WaterQuality = loadWaterQuality();
  private fogWaterIndex = -2;
  private fogWaterBlend = -1;
  private entityDebug = false;
  private readonly entityMeshes: Mesh[] = [];
  private readonly entityMaterials = new Map<string, StandardMaterial>();
  private readonly mapModelMeshes: Mesh[] = [];
  private mapModelResources?: MapModelResources;
  private readonly waypointMeshes: Mesh[] = [];
  private lastWaypointDebugUpdate = 0;
  private readonly entityModelAnimations: EntityModelAnimation[] = [];
  private currentMap?: SauerMap;
  private viewportTuning: ViewportTuning = { ...DEFAULT_VIEWPORT_TUNING };
  private debugLoadout = false;
  private playerModel = 0;
  private localGameMode = 0;
  private localDeadAt = 0;
  private following = -1;
  private followDirection = 0;
  private spectatorYawOffset = 0;
  private spectatorPitchOffset = 0;
  private lastBotNetworkUpdate = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly performanceOverlay: RendererPerformanceOverlay;
  private readonly frameProfiler = new FrameProfiler();
  private readonly renderDiagnostics: RendererDiagnosticState = { particles: true, bots: true, world: true };
  private particleUpdateStartedAt = 0;
  private readonly botUpdatePlayers: Damageable[] = [];
  private readonly onWaterQualityChanged = (event: Event): void => {
    const quality = (event as CustomEvent<WaterQuality>).detail;
    if (quality >= 0 && quality <= 3) this.setWaterQuality(quality);
  };

  constructor(canvas: HTMLCanvasElement, readonly runtimeMode: RuntimeMode) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
    installSauerFogDistance();
    this.scene = new Scene(this.engine);
    this.materialCache = new MaterialCache(this.scene);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.055, 0.067, 0.06, 1);
    window.addEventListener(WATER_QUALITY_CHANGED, this.onWaterQualityChanged);

    this.freeCamera = this.createCamera("free-camera");
    this.freeCamera.speed = 4;
    this.freeCamera.angularSensibility = 2200;
    this.freeCamera.inputs.removeByType("FreeCameraKeyboardMoveInput");
    this.freeCamera.inputs.add(new BrowserFreeCameraInput());
    if (runtimeMode === "debug") this.freeCamera.attachControl(canvas, true);
    this.playerCamera = this.createCamera("player-camera");
    this.createViewportTuningPostProcess(this.freeCamera);
    this.createViewportTuningPostProcess(this.playerCamera);
    this.cameraMode = runtimeMode === "debug" ? "free" : "player";
    this.scene.activeCamera = runtimeMode === "debug" ? this.freeCamera : this.playerCamera;
    if (this.waterQuality >= 1) this.initializeWaterRenderTargets();
    this.physicsInput = new BrowserPhysicsInput(canvas);
    this.weaponInput = new BrowserWeaponInput(canvas, this.weapons.controller);
    const viewport = canvas.parentElement;
    if (!viewport) throw new Error("The weapon HUD requires a viewport parent.");
    this.touchControls = new TouchControls(viewport, this.physicsInput, this.weaponInput);
    this.performanceOverlay = new RendererPerformanceOverlay(viewport, this.engine, this.scene, this.frameProfiler,
      () => this.resourceCounters(), () => ({ ...this.renderDiagnostics }), (diagnostic) => this.toggleRenderDiagnostic(diagnostic));
    this.physics.raycastPerformanceRecorder = (milliseconds) => this.frameProfiler.recordRaycast(milliseconds);
    this.physics.raycastPerformanceEnabled = () => this.frameProfiler.enabled;
    this.bots.performanceRecorder = (phase, operation) => {
      const key = phase === "ai" ? "botAi" : phase === "physics" ? "botPhysics" : "weaponSimulation";
      this.frameProfiler.measure(key, operation);
    };
    this.weaponHUD = new WeaponHUD(viewport, this.weapons.controller, this.weapons.events, this.fpsClient.multiplayer);
    this.crosshairHUD = new CrosshairHUD(viewport, this.weapons.controller, this.weapons.events);
    this.multiplayerHUD = new MultiplayerHUD(viewport, this.fpsClient.multiplayer);
    this.spectatorHUD = new SpectatorHUD(viewport);
    this.killFeed = new KillFeed(viewport, this.fpsClient.multiplayer);
    this.playerRenderer = new PlayerRenderer(this.scene, (from, to, radius) => {
      const direction = { x: to.x - from.x, y: to.z - from.z, z: to.y - from.y };
      const distance = Math.hypot(direction.x, direction.y, direction.z);
      if (!distance) return undefined;
      const hit = this.physics.raycast({ x: from.x, y: from.z, z: from.y }, {
        x: direction.x / distance, y: direction.y / distance, z: direction.z / distance,
      }, distance, radius, false);
      if (hit && hit.distance <= 1e-5 && direction.x * hit.normal.x + direction.y * hit.normal.y + direction.z * hit.normal.z >= -1e-6) {
        return undefined;
      }
      return hit ? { position: { x: hit.position.x, y: hit.position.z, z: hit.position.y },
        normal: { x: hit.normal.x, y: hit.normal.z, z: hit.normal.y } } : undefined;
    }, (milliseconds) => this.frameProfiler.record("playerGeometry", milliseconds), () => this.frameProfiler.enabled);
    this.ctfRenderer = new CtfRenderer(this.scene);
    this.collectRenderer = new CollectRenderer(this.scene);
    this.physicsInput.enabled = runtimeMode === "game";
    this.weaponInput.enabled = runtimeMode === "game";
    this.touchControls.setGameplayEnabled(runtimeMode === "game");
    this.weaponHUD.setVisible(runtimeMode === "game");
    this.crosshairHUD.setVisible(runtimeMode === "game");
    this.weaponRenderer = new WeaponRenderer(this.scene, this.weapons.events, this.playerCamera, this.weapons.controller);
    this.weapons.controller.projectileVisualOrigin = () => {
      const firstPerson = this.cameraMode === "player" && !this.thirdperson;
      const clientNumber = this.fpsClient.multiplayer.clientNumber;
      const position = firstPerson ? this.weaponRenderer.muzzlePosition()
        : clientNumber < 0 ? undefined : this.playerRenderer.muzzlePosition(clientNumber);
      return { position, firstPerson };
    };
    this.particleRenderer = new ParticleRenderer(this.scene, this.weapons.events, this.playerCamera, (event) => {
      if (event.type === "shot") return this.weaponRenderer.muzzlePosition();
      if (event.type !== "shot-effect") return undefined;
      if (event.clientNumber === this.fpsClient.multiplayer.clientNumber) return this.weaponRenderer.muzzlePosition();
      return event.clientNumber === undefined ? undefined : this.playerRenderer.muzzlePosition(event.clientNumber);
    });
    this.scene.onBeforeParticlesRenderingObservable.add(() => {
      if (this.frameProfiler.enabled) this.particleUpdateStartedAt = performance.now();
    });
    this.scene.onAfterParticlesRenderingObservable.add(() => {
      if (this.frameProfiler.enabled) this.frameProfiler.record("particleUpdates", performance.now() - this.particleUpdateStartedAt);
    });
    this.weaponRenderer.setHudGunVisible(this.cameraMode === "player" && !this.thirdperson);
    this.gameAudio = new WeaponAudio(this.weapons.events, this.fpsClient.multiplayer, this.physics.player);
    this.physics.soundEvent = (event, player) => this.gameAudio.physicsSound(event, player);
    this.fpsClient.multiplayer.addEventListener("multiplayer", (event) =>
      this.handleMultiplayerEvent((event as CustomEvent<MultiplayerEvent>).detail));
    this.weapons.events.on((event) => {
      if (event.type !== "damage" && event.type !== "death") return;
      const bot = [...this.bots.bots.values()].find((candidate) => candidate === event.target);
      if (!bot) return;
      if (event.type === "damage") this.bots.damaged(bot, this.physics.player);
      else {
        this.bots.killed(bot, this.physics.player);
        if (bot.ownerNumber < 0 && this.fpsClient.multiplayer.clientNumber >= 0) {
          this.fpsClient.multiplayer.localDied(bot.clientNumber, this.fpsClient.multiplayer.clientNumber);
        }
      }
    });
    canvas.addEventListener("pointerdown", this.onSpectatorPointerDown, { capture: true });
    canvas.addEventListener("contextmenu", this.onSpectatorContextMenu);
    window.addEventListener("keydown", this.onSpectatorKeyDown, { capture: true });

    this.engine.runRenderLoop(() => {
      const frameStartedAt = performance.now();
      this.updatePhysics(frameStartedAt);
      this.updateCameraFog(frameStartedAt / 1000);
      this.gameAudio.update(this.physics.player.position, this.physics.player.yaw);
      const gameLogicFinishedAt = performance.now();
      this.updateWaterRenderTargets();
      this.scene.render();
      const frameFinishedAt = performance.now();
      const profile = this.frameProfiler.finishFrame();
      this.performanceOverlay.recordFrame(gameLogicFinishedAt - frameStartedAt, frameFinishedAt - frameStartedAt, frameFinishedAt, profile);
    });
    window.addEventListener("resize", this.resize);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
  }

  async loadMap(map: SauerMap, textures: ResolvedTexture[], skyOverrides?: MapSkyOverrides,
                lightingOverrides?: MapLightingOverrides, fogOverrides?: MapFogOverrides,
                waterOverrides?: MapWaterOverrides,
                mapModels: MapModelAsset[] = [], teleporter?: MapModelAsset, mapSounds: MapSoundAsset[] = [],
                pickupModels: MapModelAsset[] = []): Promise<SceneStats> {
    const generation = ++this.loadGeneration;
    this.currentMap = map;
    this.waterParameters = resolveMapWater(map, waterOverrides);
    const lighting = resolveMapLighting(map, lightingOverrides);
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.collectRenderer.clear();
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    this.disposeWaterReflections();
    this.mapModelResources?.dispose();
    this.mapModelResources = undefined;
    this.volumeMeshes.length = 0;
    this.volumeMaterials.forEach((material) => material.dispose(true, true));
    this.volumeMaterials.clear();
    this.waterMaterials.clear();
    this.waterNormalTexture?.dispose();
    this.waterNormalTexture = undefined;
    this.waterDistortionTexture?.dispose();
    this.waterDistortionTexture = undefined;
    this.entityMeshes.length = 0;
    this.entityMaterials.forEach((material) => material.dispose());
    this.entityMaterials.clear();
    this.mapModelMeshes.length = 0;
    this.waypointMeshes.length = 0;
    this.entityModelAnimations.length = 0;
    this.materialCache.dispose();
    this.mapCaustics?.dispose();
    this.mapCaustics = shouldUseCaustics(this.waterQuality) ? createMapCausticResources(this.scene, map) : undefined;
    this.materialCache = new MaterialCache(this.scene, map.lightmaps, lighting.ambient, this.mapCaustics);
    this.fallbackMaterial?.dispose(true, true);
    this.fallbackMaterial = undefined;
    this.skyboxMaterial?.dispose(true, true);
    this.skyboxMaterial = undefined;
    this.fogDomeMaterial?.dispose();
    this.fogDomeMaterial = undefined;
    this.skyboxObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.skyboxObjectUrls = [];
    this.scene.onBeforeRenderObservable.clear();
    this.particleRenderer.clear();
    this.weaponRenderer.clear();
    this.weapons.projectiles.clear();
    this.physics.setMap(map);
    this.fpsClient.multiplayer.setMapEntities(map.entityRegistry);
    this.gameAudio.setMap(map.entityRegistry, mapSounds);
    await this.bots.setMap(map.name, map.entityRegistry, this.localGameMode);
    const batches = generateGeometry(map, textures);
    const materialBatches = generateMaterialGeometry(map, this.waterQuality, this.runtimeMode === "debug");
    let faces = 0;
    let triangles = 0;
    let vertices = 0;
    batches.forEach((batch) => {
      const mesh = new Mesh(batch.name, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = batch.positions;
      vertexData.indices = batch.indices;
      vertexData.colors = batch.colors;
      vertexData.uvs = batch.uvs;
      vertexData.uvs2 = batch.uv2s;
      const normals: number[] = [];
      VertexData.ComputeNormals(batch.positions, batch.indices, normals);
      vertexData.normals = normals;
      vertexData.tangents = computeTangents(batch.positions, normals, batch.uvs, batch.indices);
      vertexData.applyToMesh(mesh, true);
      const texture = textures[batch.textureIndex];
      mesh.material = texture
        ? this.materialCache.get(describeSauerMaterial(texture, batch.cubeMaterial, batch.lightmapId, batch.useLightmapAlpha))
        : this.createFallbackMaterial();
      mesh.freezeWorldMatrix();
      mesh.alwaysSelectAsActiveMesh = true;
      faces += batch.faceCount;
      triangles += batch.indices.length / 3;
      vertices += batch.positions.length / 3;
    });
    materialBatches.forEach((batch) => {
      const mesh = this.createMaterialVolumeMesh(batch);
      mesh.setEnabled(!batch.debugOnly || this.materialDebug);
      this.volumeMeshes.push(mesh);
      faces += batch.faceCount;
      triangles += batch.indices.length / 3;
      vertices += batch.positions.length / 3;
    });
    if (this.entityDebug && !this.entityMeshes.length) map.entityRegistry.forEach((entity) => this.createEntityMarker(entity));
    this.particleRenderer.loadMap(map.entityRegistry);
    const loadedMapModels = await loadMapModels(this.scene, map.entityRegistry, mapModels, this.wireframe,
      () => generation === this.loadGeneration, teleporter, pickupModels);
    if (generation !== this.loadGeneration) {
      loadedMapModels.resources.dispose();
      return {
        meshes: batches.length + materialBatches.length,
        faces,
        triangles,
        vertices,
        materialVolumes: map.materialVolumes.length,
        mapModelIssues: loadedMapModels.issues,
      };
    }
    if (this.mapCaustics) {
      const materials = new Set<StandardMaterial>();
      loadedMapModels.meshes.forEach((mesh) => {
        if (mesh.material instanceof StandardMaterial) materials.add(mesh.material);
      });
      materials.forEach((material) => new StandardMaterialCaustics(material, this.mapCaustics!));
    }
    this.mapModelResources = loadedMapModels.resources;
    this.physics.setMapModels(loadedMapModels.collisions);
    this.mapModelMeshes.push(...loadedMapModels.meshes);
    this.entityModelAnimations.push(...loadedMapModels.animations);
    triangles += loadedMapModels.triangles;
    vertices += loadedMapModels.vertices;
    this.materialCache.setWireframe(this.wireframe);
    const fog = resolveMapFog(map, fogOverrides);
    this.mapFog = fog;
    this.applyFog(fog);
    this.setMapFarPlane(map);
    await this.createSkybox(map, resolveMapSky(map, skyOverrides), generation);
    this.createFogDome(fog);
    await this.weaponRenderer.loadHudGuns();
    this.placeCamera(map, batches);
    this.fpsClient.multiplayer.synchronizeLocalState();
    this.syncPlayerView();
    this.applyRenderDiagnostics();
    return {
      meshes: batches.length + materialBatches.length + loadedMapModels.meshes.length,
      faces,
      triangles,
      vertices,
      materialVolumes: map.materialVolumes.length,
      mapModelIssues: loadedMapModels.issues,
    };
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.materialCache.setWireframe(enabled);
    if (this.fallbackMaterial) this.fallbackMaterial.wireframe = enabled;
    this.volumeMaterials.forEach((material) => { material.wireframe = enabled; });
    this.mapModelMeshes.forEach((mesh) => {
      if (mesh.material) mesh.material.wireframe = enabled;
    });
  }

  setMaterialDebug(enabled: boolean): void {
    this.materialDebug = enabled;
    this.volumeMeshes.forEach((mesh) => {
      if (mesh.metadata?.debugOnly === true) mesh.setEnabled(enabled);
    });
  }

  setEntityDebug(enabled: boolean): void {
    if (enabled === this.entityDebug) return;
    this.entityDebug = enabled;
    this.clearEntityDebugResources();
    if (enabled) this.currentMap?.entityRegistry.forEach((entity) => this.createEntityMarker(entity));
  }

  setViewportTuning(tuning: ViewportTuning): void {
    this.viewportTuning = { ...tuning };
  }

  setWaterQuality(quality: WaterQuality): void {
    if (quality === this.waterQuality) return;
    this.waterQuality = quality;
    this.disposeWaterRenderTargets();
    this.waterNormalTexture?.dispose();
    this.waterNormalTexture = undefined;
    this.waterDistortionTexture?.dispose();
    this.waterDistortionTexture = undefined;
    if (quality > 0) this.initializeWaterRenderTargets();
    this.rebuildMaterialVolumes();
  }

  setCameraMode(mode: CameraMode): void {
    if (this.runtimeMode === "game" && mode !== "player") return;
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    const playerMode = mode === "player";
    this.physicsInput.enabled = playerMode;
    this.weaponInput.enabled = playerMode;
    this.touchControls.setGameplayEnabled(playerMode);
    this.weaponHUD.setVisible(playerMode);
    this.crosshairHUD.setVisible(playerMode && !this.isLocalPlayerDead());
    this.multiplayerHUD.setVisible(playerMode && this.fpsClient.multiplayer.clientNumber >= 0);
    this.weaponRenderer.setHudGunVisible(playerMode && !this.thirdperson);
    if (playerMode) {
      this.freeCamera.detachControl();
      this.physics.reset(performance.now());
      this.weapons.resetClock(performance.now());
      this.scene.activeCamera = this.playerCamera;
      this.updatePlayerCamera(this.physics.player.position);
    } else {
      if (document.pointerLockElement === this.canvas) void document.exitPointerLock();
      this.freeCamera.position.copyFrom(this.playerCamera.position);
      this.freeCamera.setTarget(this.playerCamera.getTarget());
      this.freeCamera.attachControl(this.canvas, true);
      this.scene.activeCamera = this.freeCamera;
    }
  }

  setPhysicsPaused(paused: boolean): void {
    this.physics.setPaused(paused, performance.now());
  }

  setTouchControlsBlocked(blocked: boolean): void {
    this.touchControls.setBlocked(blocked);
  }

  isTouchMode(): boolean { return this.touchControls.preferred; }

  showTouchScoreboard(): void { this.multiplayerHUD.showTouchScoreboard(); }

  setThirdPerson(enabled: boolean): void {
    this.thirdperson = enabled;
    this.weaponRenderer.setHudGunVisible(this.cameraMode === "player" && !enabled && !this.isLocalPlayerDead());
    if (this.cameraMode === "player") this.updatePlayerCamera(this.physics.player.position);
  }

  setTeamSkins(enabled: boolean): void {
    this.teamskins = enabled;
  }

  setPlayerModel(model: number): void {
    this.playerModel = Number.isInteger(model) && model >= 0 && model < 5 ? model : 0;
  }

  resetPlayer(): void {
    this.physics.reset(performance.now());
    if (this.runtimeMode === "game") this.weapons.controller.spawnForGameMode(this.localGameMode, performance.now());
    else this.weapons.controller.respawn(performance.now());
    if (this.runtimeMode === "debug" && this.debugLoadout) this.weapons.controller.inventory.grantMaximumAmmo();
    this.weapons.projectiles.clear();
    this.weaponHUD.render();
    this.updatePlayerCamera(this.physics.player.position);
  }

  physicsDebugSnapshot(): PhysicsDebugSnapshot {
    return this.physics.debugSnapshot();
  }

  currentCameraMode(): CameraMode {
    return this.cameraMode;
  }

  enableDebugLoadout(): void {
    if (this.runtimeMode !== "debug") return;
    this.debugLoadout = true;
    this.weapons.controller.inventory.grantMaximumAmmo();
    this.weaponHUD.render();
  }

  async connectMultiplayer(endpoint: ServerEndpoint): Promise<void> {
    this.debugLoadout = false;
    this.setPlayerModel(endpoint.playerModel ?? this.playerModel);
    this.setCameraMode("player");
    this.multiplayerHUD.setVisible(true);
    await this.fpsClient.multiplayer.connect({ ...endpoint, playerModel: this.playerModel });
  }

  startLocalGame(playerName: string): void {
    if (this.runtimeMode !== "game") return;
    this.fpsClient.multiplayer.startLocalGame(playerName, this.playerModel);
    this.multiplayerHUD.setVisible(true);
    this.syncPlayerView();
  }

  setLocalGameMode(mode: number): void {
    if (this.runtimeMode !== "game") return;
    this.localGameMode = mode;
    this.fpsClient.multiplayer.setGameMode(mode);
    this.bots.setGameMode(mode);
    this.weapons.controller.spawnForGameMode(mode, performance.now());
    this.weaponHUD.render();
  }

  configureBotMatch(count: number, minimumSkill: number, maximumSkill: number): void {
    this.bots.clear();
    this.fpsClient.multiplayer.clearLocalBots();
    const total = Math.min(32, Math.max(0, Math.trunc(count))), minimum = Math.min(101, Math.max(1, Math.trunc(minimumSkill))),
      maximum = Math.min(101, Math.max(minimum, Math.trunc(maximumSkill)));
    this.fpsClient.multiplayer.setLocalTeam(gameModeHas(this.localGameMode, GameModeFlag.Team) ? "good" : "");
    for (let index = 0; index < total; index++) {
      const skill = minimum + Math.floor(Math.random() * (maximum - minimum + 1));
      this.bots.addbot(skill);
    }
    this.syncBotTargets();
  }

  executeBotCommand(commandLine: string): boolean {
    const [command = "", ...arguments_] = commandLine.trim().replace(/^\//, "").split(/\s+/);
    switch (command.toLowerCase()) {
      case "addbot": {
        const skill = arguments_[0] ? Number(arguments_[0]) : -1;
        if (this.fpsClient.multiplayer.connected) this.fpsClient.multiplayer.addBot(skill);
        else this.bots.addbot(skill);
        return true;
      }
      case "delbot":
        if (this.fpsClient.multiplayer.connected) this.fpsClient.multiplayer.deleteBot();
        else this.bots.delbot();
        return true;
      case "botlimit": this.fpsClient.multiplayer.setBotLimit(Number(arguments_[0] ?? 0)); return true;
      case "botbalance": this.fpsClient.multiplayer.setBotBalance(Number(arguments_[0] ?? 0) !== 0); return true;
      case "clearwaypoints": this.bots.waypoints.clearwaypoints(); this.syncWaypointDebug(true); return true;
      case "dropwaypoints": this.bots.waypoints.dropWaypoints = Number(arguments_[0] ?? 0) !== 0; return true;
      case "showwaypoints": this.bots.waypoints.showWaypoints = Number(arguments_[0] ?? 0) !== 0; this.syncWaypointDebug(true); return true;
      case "showwaypointsradius": this.bots.waypoints.showWaypointsRadius = Math.max(0, Number(arguments_[0] ?? 200));
        this.syncWaypointDebug(true); return true;
      case "loadwaypoints": void this.bots.waypoints.loadwaypoints(arguments_[0] || this.currentMap?.name || "", true); return true;
      case "savewaypoints": this.downloadWaypoints(arguments_[0] || this.currentMap?.name || "waypoints"); return true;
      case "movewaypoints": this.bots.waypoints.movewaypoints({ x: Number(arguments_[0] ?? 0), y: Number(arguments_[1] ?? 0),
        z: Number(arguments_[2] ?? 0) }, this.currentMap?.header.worldSize ?? 0); return true;
      default: return false;
    }
  }

  dispose(): void {
    this.fpsClient.multiplayer.disconnect();
    this.physicsInput.dispose();
    this.weaponInput.dispose();
    this.touchControls.dispose();
    this.crosshairHUD.dispose();
    this.multiplayerHUD.dispose();
    this.spectatorHUD.dispose();
    this.killFeed.dispose();
    this.canvas.removeEventListener("pointerdown", this.onSpectatorPointerDown, { capture: true });
    this.canvas.removeEventListener("contextmenu", this.onSpectatorContextMenu);
    window.removeEventListener("keydown", this.onSpectatorKeyDown, { capture: true });
    window.removeEventListener(WATER_QUALITY_CHANGED, this.onWaterQualityChanged);
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    if (document.pointerLockElement === this.canvas) void document.exitPointerLock();
    this.engine.stopRenderLoop();
    this.performanceOverlay.dispose();
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.collectRenderer.clear();
    this.particleRenderer.clear();
    this.weaponRenderer.clear();
    this.gameAudio.dispose();
    this.disposeWaterRenderTargets();
    this.mapModelResources?.dispose();
    this.mapModelResources = undefined;
    this.engine.dispose();
  }

  onMultiplayer(listener: (event: MultiplayerEvent) => void): () => void {
    const wrapped = (event: Event): void => listener((event as CustomEvent<MultiplayerEvent>).detail);
    this.fpsClient.multiplayer.addEventListener("multiplayer", wrapped);
    return () => this.fpsClient.multiplayer.removeEventListener("multiplayer", wrapped);
  }

  sendChat(text: string, team = false): boolean {
    return this.fpsClient.multiplayer.sendChat(text, team);
  }

  switchTeam(): void {
    this.fpsClient.multiplayer.switchTeam();
  }

  setSpectator(spectating: boolean): boolean {
    return this.fpsClient.multiplayer.setSpectator(spectating);
  }

  isLocalPlayerSpectator(): boolean {
    return this.fpsClient.multiplayer.isSpectator;
  }

  tryDropFlag(): void {
    this.fpsClient.multiplayer.tryDropFlag();
  }

  isLocalPlayerDead(): boolean {
    const multiplayer = this.fpsClient.multiplayer;
    if (multiplayer.clientNumber >= 0) return multiplayer.players.get(multiplayer.clientNumber)?.state === ClientState.Dead;
    return !this.physics.player.alive;
  }

  requestRespawn(): boolean {
    if (this.fpsClient.multiplayer.clientNumber >= 0) return this.fpsClient.multiplayer.requestRespawn();
    if (this.physics.player.alive) return false;
    // Native fps.cpp::respawnself() calls spawnplayer(), which restores the entity,
    // spawn state, HUD player and input state as one transition in local games.
    this.resetPlayer();
    this.stopFollowing();
    this.syncPlayerView();
    return true;
  }

  captureMouse(): void {
    // Menus and the death screen temporarily hide touch controls. Use the selected
    // control mode rather than current visibility so a respawn tap cannot acquire
    // pointer lock before the touch overlay is shown again.
    if (this.runtimeMode === "game" && !this.touchControls.preferred) this.physicsInput.capture();
  }

  setMultiplayerMapInfo(name: string, crc: number): void {
    this.fpsClient.multiplayer.setMapInfo(name, crc);
  }

  private createEntityMarker(entity: RegisteredMapEntity): void {
    if (entity.category === "empty") return;
    const position = toBabylonPosition(entity.position);
    const marker = entity.category === "mapmodel"
      ? MeshBuilder.CreateBox(`entity-${entity.index}-${entity.typeName}`, { size: 3 }, this.scene)
      : MeshBuilder.CreateSphere(`entity-${entity.index}-${entity.typeName}`,
        { diameter: entity.category === "spawn" ? 4 : 2.5, segments: 6 }, this.scene);
    marker.position.copyFrom(position);
    marker.material = this.getEntityMaterial(entity.category);
    marker.metadata = { entityIndex: entity.index, entityType: entity.typeName, attributes: entity.namedAttributes };
    marker.isPickable = true;
    this.entityMeshes.push(marker);
    const direction = entity.orientation?.direction
      ? toBabylonDirection(entity.orientation.direction)
      : entity.orientation?.yawDegrees === undefined ? undefined : toBabylonYawDirection(entity.orientation.yawDegrees);
    if (!direction) return;
    const line = MeshBuilder.CreateLines(`entity-${entity.index}-orientation`, { points: [position, position.add(direction.scale(7))] }, this.scene);
    line.color = this.entityColor(entity.category);
    line.isPickable = false;
    this.entityMeshes.push(line);
  }

  private clearEntityDebugResources(): void {
    this.entityMeshes.forEach((mesh) => mesh.dispose());
    this.entityMeshes.length = 0;
    this.entityMaterials.forEach((material) => material.dispose());
    this.entityMaterials.clear();
  }

  private getEntityMaterial(category: string): StandardMaterial {
    const cached = this.entityMaterials.get(category);
    if (cached) return cached;
    const color = this.entityColor(category);
    const material = new StandardMaterial(`entity-marker-${category}`, this.scene);
    material.diffuseColor = color;
    material.emissiveColor = color;
    material.disableLighting = true;
    material.alpha = 0.75;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    this.entityMaterials.set(category, material);
    return material;
  }

  private entityColor(category: string): Color3 {
    const colors: Record<string, Color3> = {
      light: new Color3(1, 0.9, 0.25),
      mapmodel: new Color3(0.45, 0.75, 1),
      spawn: new Color3(0.25, 1, 0.45),
      effect: new Color3(0.8, 0.4, 1),
      sound: new Color3(0.2, 0.9, 0.9),
      pickup: new Color3(1, 0.55, 0.15),
      teleport: new Color3(0.85, 0.25, 1),
      movement: new Color3(0.25, 0.65, 1),
      gameplay: new Color3(1, 0.25, 0.3),
      unknown: new Color3(0.8, 0.8, 0.8),
    };
    return colors[category] ?? colors.unknown;
  }

  private createMaterialVolumeMesh(batch: MaterialGeometryBatch): Mesh {
    if (batch.kind === "water" && batch.reflectionHeight !== undefined && this.waterQuality > 0) {
      this.ensureWaterReflection(batch.reflectionHeight);
    }
    const mesh = new Mesh(batch.name, this.scene);
    const vertexData = new VertexData();
    vertexData.positions = batch.positions;
    vertexData.indices = batch.indices;
    vertexData.colors = batch.colors;
    vertexData.uvs = batch.uvs;
    const normals: number[] = [];
    VertexData.ComputeNormals(batch.positions, batch.indices, normals);
    vertexData.normals = normals;
    vertexData.applyToMesh(mesh, true);
    mesh.setVerticesData("waveData", batch.waveData, false, 2);
    mesh.material = this.getMaterialVolumeMaterial(batch.kind, batch.materialIndex, batch.reflectionHeight);
    mesh.metadata = { debugOnly: batch.debugOnly, materialKind: batch.kind, materialIndex: batch.materialIndex,
      reflectionHeight: batch.reflectionHeight };
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    if (batch.reflectionHeight !== undefined) this.waterReflections.get(batch.reflectionHeight)?.meshes.add(mesh);
    return mesh;
  }

  private rebuildMaterialVolumes(): void {
    if (!this.currentMap) return;
    this.volumeMeshes.forEach((mesh) => mesh.dispose());
    this.volumeMeshes.length = 0;
    this.volumeMaterials.forEach((material) => material.dispose(true, true));
    this.volumeMaterials.clear();
    this.waterMaterials.clear();
    generateMaterialGeometry(this.currentMap, this.waterQuality, this.runtimeMode === "debug").forEach((batch) => {
      const mesh = this.createMaterialVolumeMesh(batch);
      mesh.setEnabled(!batch.debugOnly || this.materialDebug);
      this.volumeMeshes.push(mesh);
    });
  }

  private getMaterialVolumeMaterial(kind: MaterialRenderKind, materialIndex: number, reflectionHeight?: number): Material {
    const key = `${kind}:${materialIndex}${reflectionHeight === undefined ? "" : `:${reflectionHeight}`}`;
    const cached = this.volumeMaterials.get(key);
    if (cached) return cached;
    if (kind === "water") {
      const material = this.createWaterMaterial(materialIndex, reflectionHeight);
      this.volumeMaterials.set(key, material);
      return material;
    }
    const colors: Record<MaterialRenderKind, Color3> = {
      water: new Color3(0.05, 0.35, 0.55),
      lava: new Color3(1, 0.28, 0.03),
      glass: new Color3(0.15, 0.75, 0.82),
      clip: new Color3(0.9, 0.12, 0.12),
      noclip: new Color3(0.12, 0.85, 0.2),
      gameclip: new Color3(0.95, 0.82, 0.08),
      death: new Color3(0.25, 0.25, 0.25),
      alpha: new Color3(0.85, 0.1, 0.78),
    };
    const material = new StandardMaterial(`material-volume-${kind}`, this.scene);
    material.diffuseColor = colors[kind];
    material.emissiveColor = colors[kind].scale(kind === "lava" ? 0.8 : 0.45);
    material.specularColor = kind === "glass" ? new Color3(0.7, 0.9, 1) : Color3.Black();
    material.disableLighting = true;
    material.backFaceCulling = false;
    material.wireframe = this.wireframe;
    material.alpha = kind === "lava" ? 1 : kind === "glass" ? 0.3 : 0.24;
    if (kind !== "lava") {
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      material.needDepthPrePass = true;
    } else {
      const lavaUrl = packageAssetUrl("dg/floor_lava2.jpg");
      if (lavaUrl) {
        const texture = new Texture(lavaUrl, this.scene);
        texture.uScale = 0.125;
        texture.vScale = 0.125;
        texture.wrapU = Texture.WRAP_ADDRESSMODE;
        texture.wrapV = Texture.WRAP_ADDRESSMODE;
        material.diffuseTexture = texture;
        material.emissiveTexture = texture;
      }
    }
    this.volumeMaterials.set(key, material);
    return material;
  }

  // Original: src/engine/water.cpp and data/glsl.cfg water shaders. The WebGL port keeps the native two scrolling normal fields,
  // Fresnel blend, map-controlled tint/specularity, depth-faded shoreline, and cheap environment reflection.
  private createWaterMaterial(materialIndex: number, reflectionHeight?: number): ShaderMaterial {
    const quality = this.waterQuality;
    const parameters = this.waterParameters[materialIndex] ?? this.waterParameters[0];
    const material = new ShaderMaterial(`material-volume-water-${materialIndex}`, this.scene, {
      vertexSource: `
        precision highp float;
        #define WATER_QUALITY ${quality}
        attribute vec3 position;
        attribute vec3 normal;
        attribute vec2 uv;
        attribute vec2 waveData;
        uniform mat4 world;
        uniform mat4 view;
        uniform mat4 worldViewProjection;
        uniform mat4 reflectionProjectiveMatrix;
        uniform float time;
        varying vec3 worldPosition;
        varying vec3 worldNormal;
        varying vec2 surfaceUv;
        varying float cameraSpaceDepth;
        varying vec4 reflectionClipPosition;

        void main(void) {
          vec3 animatedPosition = position;
          float waterHeight = -1.1;
          #if WATER_QUALITY >= 1
            float waveSize = max(waveData.x, 1.0);
            vec2 nativePosition = mod(position.xz, waveSize);
            float angle = nativePosition.x * nativePosition.y * (59.0 / 23.0) / (2.0 * 3.14159265);
            float phase = fract(angle + time / (1.2 * 3.14159265)) - 0.5;
            phase *= 8.0 - abs(phase) * 16.0;
            waterHeight += 0.4 * phase;
          #endif
          animatedPosition.y += waterHeight * waveData.y;
          vec4 worldVertex = world * vec4(animatedPosition, 1.0);
          worldPosition = worldVertex.xyz;
          worldNormal = normalize(mat3(world) * normal);
          surfaceUv = uv;
          cameraSpaceDepth = (view * worldVertex).z;
          gl_Position = worldViewProjection * vec4(animatedPosition, 1.0);
          reflectionClipPosition = reflectionProjectiveMatrix * worldVertex;
        }
      `,
      fragmentSource: `
        precision highp float;
        #define WATER_QUALITY ${quality}
        varying vec3 worldPosition;
        varying vec3 worldNormal;
        varying vec2 surfaceUv;
        varying float cameraSpaceDepth;
        varying vec4 reflectionClipPosition;
        uniform vec3 cameraPosition;
        uniform vec3 waterColor;
        uniform vec3 waterfallColor;
        uniform float waterSpecular;
        uniform float waterFogEnd;
        uniform float time;
        uniform float hasReflection;
        uniform sampler2D normalSampler;
        uniform sampler2D distortionSampler;
        uniform sampler2D depthSampler;
        uniform sampler2D refractionSampler;
        uniform sampler2D reflectionSampler;
        uniform vec2 screenSize;

        void main(void) {
          vec3 viewDirection = normalize(cameraPosition - worldPosition);
          vec3 surfaceNormal = normalize(worldNormal);
          #if WATER_QUALITY >= 1
            float vertical = 1.0 - abs(worldNormal.y);
            vec2 baseUv = surfaceUv * 0.16;
            vec2 firstScroll = mix(vec2(time * 0.05), vec2(0.0, -time * 0.05), vertical);
            vec2 distortion = texture2D(distortionSampler, baseUv + firstScroll).rg * 2.0 - 1.0;
            vec3 firstWave = texture2D(normalSampler, baseUv - vec2(time * 0.03) + distortion * 0.025).rgb * 2.0 - 1.0;
            #if WATER_QUALITY >= 3
              vec3 secondWave = texture2D(normalSampler, baseUv * 1.73 + vec2(time * 0.021, -time * 0.017)).rgb * 2.0 - 1.0;
              firstWave = normalize(firstWave + secondWave * 0.55);
            #endif
            vec3 waveNormal = normalize(vec3(firstWave.x, abs(firstWave.z) + 0.35, firstWave.y));
            vec3 rippledNormal = normalize(surfaceNormal + firstWave * 0.2);
            surfaceNormal = normalize(mix(rippledNormal, waveNormal, abs(worldNormal.y) * 0.72));
          #endif
          float facing = clamp(dot(viewDirection, surfaceNormal), 0.0, 1.0);
          float tintWeight = facing * 0.5 + 0.5;
          float waterDepth = 0.6;
          vec3 baseColor = mix(waterfallColor, waterColor, abs(worldNormal.y));
          vec3 color = baseColor * waterDepth * mix(0.6, 1.0, tintWeight);
          #if WATER_QUALITY >= 1
            if (hasReflection > 0.5) {
              float reflectionW = max(abs(reflectionClipPosition.w), 0.0001);
              vec2 reflectionUv = reflectionClipPosition.xy / reflectionW * 0.5 + 0.5;
              reflectionUv = clamp(reflectionUv + distortion * (0.3 / reflectionW), vec2(0.002), vec2(0.998));
              vec3 reflected = texture2D(reflectionSampler, reflectionUv).rgb;
              float horizontalReflection = smoothstep(0.65, 0.95, abs(worldNormal.y));
              color = mix(color, mix(reflected, baseColor * waterDepth, tintWeight), horizontalReflection);
            }
          #endif
          #if WATER_QUALITY >= 1
            vec3 halfVector = normalize(viewDirection + normalize(vec3(0.35, 0.85, 0.25)));
            float specular = pow(max(dot(surfaceNormal, halfVector), 0.0), 96.0) * waterSpecular;
            color += vec3(specular);
          #endif
          // Native Sauer uses glBlendFunc(GL_ONE, GL_SRC_ALPHA), producing color + background * sourceAlpha.
          // Express the same result through Babylon's standard source-alpha blend mode.
          float nativeSourceAlpha = facing * (1.0 - waterDepth);
          float blendAlpha = 1.0 - nativeSourceAlpha;
          #if WATER_QUALITY >= 1
            vec2 screenUv = gl_FragCoord.xy / screenSize;
            float sceneDepth = abs(texture2D(depthSampler, screenUv).r);
            float depthBehindWater = sceneDepth - abs(cameraSpaceDepth);
            float shorelineFade = sceneDepth < 0.0001 ? 1.0 : smoothstep(0.0, 4.0, depthBehindWater);
            float horizontalSurface = smoothstep(0.5, 0.9, abs(worldNormal.y));
            shorelineFade = mix(1.0, shorelineFade, horizontalSurface);
            vec3 sceneColor = texture2D(refractionSampler, screenUv).rgb;
            color = mix(sceneColor * blendAlpha, color, shorelineFade);
            // The native underwater shaders show the refraction render directly through the underside of horizontal water.
            float underwaterView = step(cameraPosition.y, worldPosition.y) * horizontalSurface;
            vec2 refractedUv = clamp(screenUv + distortion * 0.007, vec2(0.001), vec2(0.999));
            vec3 refractedColor = texture2D(refractionSampler, refractedUv).rgb;
            float distanceToSurface = length(cameraPosition - worldPosition);
            float waterFog = clamp((waterFogEnd - distanceToSurface) / max(waterFogEnd, 0.0001), 0.0, 1.0);
            refractedColor = mix(waterColor, refractedColor, waterFog);
            color = mix(color, refractedColor * blendAlpha, underwaterView);
          #endif
          gl_FragColor = vec4(color / blendAlpha, blendAlpha);
        }
      `,
    }, {
      attributes: ["position", "normal", "uv", "waveData"],
      uniforms: ["world", "view", "worldViewProjection", "reflectionProjectiveMatrix", "cameraPosition", "waterColor", "waterfallColor",
        "waterSpecular", "time", "waterFogEnd", "hasReflection", "screenSize"],
      samplers: ["normalSampler", "distortionSampler", "depthSampler", "refractionSampler", "reflectionSampler"],
      needAlphaBlending: true,
    });
    material.backFaceCulling = false;
    material.alphaMode = Engine.ALPHA_COMBINE;
    material.needDepthPrePass = true;
    material.wireframe = this.wireframe;
    material.setColor3("waterColor", new Color3(...parameters.color));
    material.setColor3("waterfallColor", new Color3(...parameters.waterfallColor));
    material.setFloat("waterSpecular", parameters.specular / 150);
    material.setFloat("hasReflection", 0);
    if (quality >= 1) {
      this.waterNormalTexture ??= this.createRepeatingWaterTexture("textures/watern.jpg");
      this.waterDistortionTexture ??= this.createRepeatingWaterTexture("textures/waterdudv.jpg");
      material.setTexture("normalSampler", this.waterNormalTexture);
      material.setTexture("distortionSampler", this.waterDistortionTexture);
    }
    const reflection = reflectionHeight === undefined ? undefined : this.waterReflections.get(reflectionHeight);
    if (quality >= 1 && reflection) {
      material.setTexture("reflectionSampler", reflection.texture);
      material.setFloat("hasReflection", 1);
    }
    material.onBind = () => {
      const camera = this.scene.activeCamera;
      material.setVector3("cameraPosition", camera?.globalPosition ?? Vector3.Zero());
      material.setFloat("time", performance.now() / 1000);
      material.setFloat("waterFogEnd", Math.min(this.mapFog?.distance ?? Number.MAX_VALUE, Math.max(parameters.fogDistance * 4, 32)));
      material.setVector2("screenSize", new Vector2(this.engine.getRenderWidth(), this.engine.getRenderHeight()));
      const depthRenderer = camera ? this.waterDepthRenderers.get(camera) : undefined;
      if (depthRenderer) material.setTexture("depthSampler", depthRenderer.getDepthMap());
      if (this.waterRefractionTexture) material.setTexture("refractionSampler", this.waterRefractionTexture);
      const reflectionActive = reflection !== undefined && this.activeWaterReflections.has(reflection);
      material.setFloat("hasReflection", reflectionActive ? 1 : 0);
      if (reflectionActive) material.setMatrix("reflectionProjectiveMatrix", reflection.projectiveMatrix);
    };
    this.waterMaterials.set(`${materialIndex}:${reflectionHeight ?? "none"}`, material);
    return material;
  }

  private ensureWaterReflection(height: number): WaterReflectionPlane {
    const existing = this.waterReflections.get(height);
    if (existing) return existing;
    const texture = new MirrorTexture(`water-reflection-${height}`, waterReflectionSize(this.waterQuality), this.scene, false,
      Constants.TEXTURETYPE_UNSIGNED_BYTE, Texture.BILINEAR_SAMPLINGMODE, true);
    // Babylon's mirror pass reflects the active view matrix and injects this plane into every compatible material shader. The downward
    // normal retains geometry above the water and clips everything below it, including objects outside the main camera frustum.
    texture.mirrorPlane = new Plane(0, -1, 0, height);
    texture.renderParticles = false;
    texture.renderSprites = false;
    texture.enableBoundingBoxRendering = false;
    texture.enableOutlineRendering = false;
    texture.ignoreCameraViewport = true;
    texture.gammaSpace = false;
    texture.clearColor = this.scene.clearColor.clone();
    let reflection!: WaterReflectionPlane;
    let previousFog: { enabled: boolean; mode: number; start: number; end: number; color: Color3; clearColor: Color4 } | undefined;
    texture.onBeforeRenderObservable.add(() => {
      const fog = this.mapFog;
      if (!fog) return;
      previousFog = { enabled: this.scene.fogEnabled, mode: this.scene.fogMode, start: this.scene.fogStart, end: this.scene.fogEnd,
        color: this.scene.fogColor.clone(), clearColor: this.scene.clearColor.clone() };
      this.scene.fogEnabled = true;
      this.scene.fogMode = Scene.FOGMODE_LINEAR;
      this.scene.fogStart = fog.start;
      this.scene.fogEnd = fog.distance;
      this.scene.fogColor.copyFromFloats(...fog.color);
      this.scene.clearColor.copyFromFloats(...fog.color, 1);
      texture.clearColor.copyFrom(this.scene.clearColor);
    });
    texture.onAfterRenderObservable.add(() => {
      if (previousFog) {
        this.scene.fogEnabled = previousFog.enabled;
        this.scene.fogMode = previousFog.mode;
        this.scene.fogStart = previousFog.start;
        this.scene.fogEnd = previousFog.end;
        this.scene.fogColor.copyFrom(previousFog.color);
        this.scene.clearColor.copyFrom(previousFog.clearColor);
        previousFog = undefined;
      }
      // MirrorTexture's own observer has restored the main view at this point. Capture that exact frame's matrix after the reflected image
      // is complete, matching Sauerbraten's saved watermatrix and avoiding a one-frame mismatch with camera input processed by Scene.render.
      reflection.projectiveMatrix.copyFrom(this.scene.getTransformMatrix());
    });
    reflection = {
      height, texture, meshes: new Set(), projectiveMatrix: Matrix.Identity(), renderMeshes: [],
      frustumPlanes: Array.from({ length: 6 }, () => new Plane(0, 0, 0, 0)), initialized: false,
      distanceSquared: Number.POSITIVE_INFINITY,
    };
    texture.getCustomRenderList = () => {
      Frustum.GetPlanesToRef(this.scene.getTransformMatrix(), reflection.frustumPlanes);
      reflection.renderMeshes.length = 0;
      for (const mesh of this.scene.meshes) {
        if (this.isWaterRenderTargetMesh(mesh) && mesh.isInFrustum(reflection.frustumPlanes)) reflection.renderMeshes.push(mesh);
      }
      return reflection.renderMeshes;
    };
    this.waterReflections.set(height, reflection);
    return reflection;
  }

  private isWaterRenderTargetMesh(mesh: AbstractMesh): boolean {
    if (!mesh.isEnabled() || !mesh.isVisible || mesh.metadata?.materialKind === "water" || mesh.metadata?.isHudGun === true ||
        mesh.metadata?.debugOnly === true) return false;
    return !mesh.name.startsWith("entity-marker-") && !mesh.name.startsWith("waypoint-");
  }

  private updateWaterRenderTargets(): void {
    for (const reflection of this.waterReflections.values()) this.removeCustomRenderTarget(reflection.texture);
    if (this.waterRefractionTexture) this.removeCustomRenderTarget(this.waterRefractionTexture);
    this.activeWaterReflections.clear();
    if (this.waterQuality === 0) return;
    const camera = this.scene.activeCamera;
    if (!camera) return;
    // Camera.globalPosition is lazily derived from the world matrix. Reflection scheduling happens before Scene.render(), so refresh it
    // explicitly instead of relying on an unrelated frustum query to update it as a side effect.
    camera.getWorldMatrix();
    const cameraPosition = camera.globalPosition;
    let anyWaterSurface = false;
    this.waterReflectionCandidates.length = 0;
    for (const reflection of this.waterReflections.values()) {
      let visible = false;
      reflection.distanceSquared = Number.POSITIVE_INFINITY;
      for (const mesh of reflection.meshes) {
        if (!mesh.isEnabled() || !mesh.isVisible) continue;
        anyWaterSurface = true;
        const bounds = mesh.getBoundingInfo().boundingBox;
        const dx = Math.max(bounds.minimumWorld.x - cameraPosition.x, 0, cameraPosition.x - bounds.maximumWorld.x);
        const dy = Math.max(bounds.minimumWorld.y - cameraPosition.y, 0, cameraPosition.y - bounds.maximumWorld.y);
        const dz = Math.max(bounds.minimumWorld.z - cameraPosition.z, 0, cameraPosition.z - bounds.maximumWorld.z);
        reflection.distanceSquared = Math.min(reflection.distanceSquared, dx * dx + dy * dy + dz * dz);
        if (camera.isInFrustum(mesh)) visible = true;
      }
      if (visible && cameraPosition.y >= reflection.height - 0.5) this.waterReflectionCandidates.push(reflection);
    }
    if (!this.waterReflectionCandidates.length) {
      // Coarse material-volume bounds can miss a grazing water surface. Fall back to the nearest plane rather than freezing a previously
      // rendered image at an obsolete viewpoint.
      let nearest: WaterReflectionPlane | undefined;
      for (const reflection of this.waterReflections.values()) {
        if (cameraPosition.y < reflection.height - 0.5 || !Number.isFinite(reflection.distanceSquared)) continue;
        if (!nearest || reflection.distanceSquared < nearest.distanceSquared) nearest = reflection;
      }
      if (nearest) this.waterReflectionCandidates.push(nearest);
    }
    // Keep one relevant plane live on consecutive frames. Time-slicing planes makes players and other dynamic entities visibly update at a
    // fraction of the scene frame rate. Cached planes retain the projective matrix from their render, so they remain world-anchored until
    // they become the live plane again.
    if (this.waterReflectionCandidates.length) {
      this.waterReflectionCandidates.sort((first, second) => first.distanceSquared - second.distanceSquared);
      const nearest = this.waterReflectionCandidates[0];
      const selected = this.selectedWaterReflection && this.waterReflectionCandidates.includes(this.selectedWaterReflection) &&
        this.selectedWaterReflection.distanceSquared <= nearest.distanceSquared * 1.21 ? this.selectedWaterReflection : nearest;
      this.selectedWaterReflection = selected;
      if (selected !== nearest) {
        const nearestIndex = this.waterReflectionCandidates.indexOf(nearest);
        const selectedIndex = this.waterReflectionCandidates.indexOf(selected);
        this.waterReflectionCandidates[nearestIndex] = selected;
        this.waterReflectionCandidates[selectedIndex] = nearest;
      }
      // Sauerbraten's maxreflect defaults to two. Keep both relevant planes synchronized, but never submit every map elevation.
      const reflectionCount = Math.min(2, this.waterReflectionCandidates.length);
      for (let index = 0; index < reflectionCount; index++) {
        const liveReflection = this.waterReflectionCandidates[index];
        liveReflection.initialized = true;
        this.activeWaterReflections.add(liveReflection);
        this.scene.customRenderTargets.push(liveReflection.texture);
      }
    } else this.selectedWaterReflection = undefined;
    if (anyWaterSurface && this.waterRefractionTexture) this.scene.customRenderTargets.push(this.waterRefractionTexture);
  }

  private removeCustomRenderTarget(target: RenderTargetTexture): void {
    const index = this.scene.customRenderTargets.indexOf(target);
    if (index >= 0) this.scene.customRenderTargets.splice(index, 1);
  }

  private disposeWaterReflections(): void {
    for (const reflection of this.waterReflections.values()) {
      this.removeCustomRenderTarget(reflection.texture);
      reflection.texture.dispose();
    }
    this.waterReflections.clear();
    this.selectedWaterReflection = undefined;
  }

  private disposeWaterRenderTargets(): void {
    this.disposeWaterReflections();
    if (this.waterRefractionTexture) {
      this.removeCustomRenderTarget(this.waterRefractionTexture);
      this.waterRefractionTexture.dispose();
      this.waterRefractionTexture = undefined;
    }
    for (const camera of this.waterDepthRenderers.keys()) this.scene.disableDepthRenderer(camera);
    this.waterDepthRenderers.clear();
  }

  private initializeWaterRenderTargets(): void {
    [this.freeCamera, this.playerCamera].forEach((camera) => {
      const renderer = this.scene.enableDepthRenderer(camera, false, true, Texture.NEAREST_SAMPLINGMODE, true);
      renderer.useOnlyInActiveCamera = true;
      renderer.getDepthMap().renderListPredicate = (mesh) => mesh.metadata?.isHudGun !== true;
      this.waterDepthRenderers.set(camera, renderer);
    });
    const refraction = new RenderTargetTexture("water-refraction", { ratio: this.waterQuality >= 3 ? 1 : 0.5 }, this.scene, {
      generateMipMaps: false, samplingMode: Texture.BILINEAR_SAMPLINGMODE, generateDepthBuffer: true, gammaSpace: false,
    });
    refraction.renderListPredicate = (mesh) => this.isWaterRenderTargetMesh(mesh);
    refraction.renderParticles = false;
    refraction.ignoreCameraViewport = true;
    let previousFog: { enabled: boolean; mode: number; start: number; end: number; color: Color3; clearColor: Color4 } | undefined;
    refraction.onBeforeRenderObservable.add(() => {
      const fog = this.mapFog;
      if (!fog) return;
      previousFog = { enabled: this.scene.fogEnabled, mode: this.scene.fogMode, start: this.scene.fogStart, end: this.scene.fogEnd,
        color: this.scene.fogColor.clone(), clearColor: this.scene.clearColor.clone() };
      this.scene.fogEnabled = true;
      this.scene.fogMode = Scene.FOGMODE_LINEAR;
      this.scene.fogStart = fog.start;
      this.scene.fogEnd = fog.distance;
      this.scene.fogColor.copyFromFloats(...fog.color);
      this.scene.clearColor.copyFromFloats(...fog.color, 1);
    });
    refraction.onAfterRenderObservable.add(() => {
      if (!previousFog) return;
      this.scene.fogEnabled = previousFog.enabled;
      this.scene.fogMode = previousFog.mode;
      this.scene.fogStart = previousFog.start;
      this.scene.fogEnd = previousFog.end;
      this.scene.fogColor.copyFrom(previousFog.color);
      this.scene.clearColor.copyFrom(previousFog.clearColor);
      previousFog = undefined;
    });
    this.waterRefractionTexture = refraction;
  }

  private createRepeatingWaterTexture(path: string): Texture {
    const texture = new Texture(packageAssetUrl(path) ?? "", this.scene);
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    texture.anisotropicFilteringLevel = this.waterQuality >= 3 ? 4 : 1;
    return texture;
  }

  private createFallbackMaterial(): StandardMaterial {
    if (this.fallbackMaterial) return this.fallbackMaterial;
    const material = new StandardMaterial("missing-map-material", this.scene);
    material.diffuseColor = new Color3(0.7, 0.2, 0.7);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.wireframe = this.wireframe;
    if (this.mapCaustics) new StandardMaterialCaustics(material, this.mapCaustics);
    this.fallbackMaterial = material;
    return this.fallbackMaterial;
  }

  private async createSkybox(map: SauerMap, skybox: MapSky, generation: number): Promise<void> {
    const suffixes = ["rt", "up", "bk", "lf", "dn", "ft"];
    const objectUrls: string[] = [];
    try {
      const images = await Promise.all(suffixes.map((suffix) => loadSkyFace(skybox.basePath, suffix)));
      for (let index = 0; index < images.length; index++) {
        try {
          objectUrls.push(await transformSkyFace(images[index], index === 1 || index === 4, skybox.color));
        } catch (caught) {
          const reason = caught instanceof Error ? ` ${caught.name}: ${caught.message}` : "";
          throw new Error(`Could not prepare the ${suffixes[index]} face.${reason}`, { cause: caught });
        }
      }
    } catch (caught) {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      console.warn(`Could not load skybox ${skybox.basePath}.`, caught);
      return;
    }
    if (generation !== this.loadGeneration) {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      return;
    }
    this.skyboxObjectUrls = objectUrls;
    const cubeTexture = CubeTexture.CreateFromImages(objectUrls, this.scene);
    cubeTexture.coordinatesMode = Texture.SKYBOX_MODE;
    const material = new StandardMaterial("map-skybox-material", this.scene);
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.Black();
    material.reflectionTexture = cubeTexture;
    material.disableDepthWrite = true;
    material.fogEnabled = false;
    this.skyboxMaterial = material;
    const mesh = MeshBuilder.CreateBox("map-skybox", { size: map.header.worldSize * 4 }, this.scene);
    mesh.material = material;
    mesh.infiniteDistance = true;
    mesh.isPickable = false;
    cubeTexture.rotationY = skyTextureRotationRadians(skybox.yaw, skybox.spin, 0);
    const started = performance.now();
    if (skybox.spin !== 0) {
      this.scene.onBeforeRenderObservable.add(() => {
        cubeTexture.rotationY = skyTextureRotationRadians(skybox.yaw, skybox.spin, (performance.now() - started) / 1000);
      });
    }
  }

  private applyFog(fog: MapFog): void {
    this.fogWaterIndex = -2;
    this.fogWaterBlend = -1;
    this.scene.fogEnabled = true;
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = fog.start;
    this.scene.fogEnd = fog.distance;
    this.scene.fogColor = new Color3(...fog.color);
    this.scene.clearColor = new Color4(...fog.color, 1);
  }

  private updateCameraFog(time: number): void {
    const fog = this.mapFog;
    const camera = this.scene.activeCamera;
    if (!fog || !camera) return;
    const position = camera.globalPosition;
    const sauerPosition = { x: position.x, y: position.z, z: position.y };
    const waterVolume = this.waterVolumeAtCamera(sauerPosition);
    const surfaceHeight = waterVolume ? animatedWaterSurfaceHeight(waterVolume.surfaceZ, sauerPosition.x, sauerPosition.y,
      waterVolume.size, time, this.waterQuality >= 1) : Number.NEGATIVE_INFINITY;
    const waterBlend = waterVolume ? underwaterFogBlend(surfaceHeight, sauerPosition.z) : 0;
    const waterIndex = waterVolume && waterBlend > 0 ? waterVolume.material & MATF_INDEX : -1;
    const water = waterIndex >= 0 ? this.waterParameters[waterIndex] ?? this.waterParameters[0] : undefined;
    if (this.mapCaustics) {
      const logBlend = water ? Math.log(1 + 255 * waterBlend) / Math.log(256) : 0;
      const waterFogEnd = water ? Math.min(fog.distance, Math.max(water.fogDistance * 4, 32)) : 1;
      this.mapCaustics.setWaterFog(water?.color ?? [0, 0, 0], 0, waterFogEnd, logBlend);
      if (waterIndex === this.fogWaterIndex && Math.abs(waterBlend - this.fogWaterBlend) < 1e-3) return;
      this.fogWaterIndex = waterIndex;
      this.fogWaterBlend = waterBlend;
      this.scene.fogEnabled = true;
      this.scene.fogMode = Scene.FOGMODE_LINEAR;
      this.scene.fogStart = fog.start;
      this.scene.fogEnd = fog.distance;
      this.scene.fogColor.copyFromFloats(...fog.color);
      this.scene.clearColor.copyFromFloats(...fog.color, 1);
      return;
    }
    if (waterIndex === this.fogWaterIndex && Math.abs(waterBlend - this.fogWaterBlend) < 1e-3) return;
    this.fogWaterIndex = waterIndex;
    this.fogWaterBlend = waterBlend;
    if (water) {
      const logBlend = Math.log(1 + 255 * waterBlend) / Math.log(256);
      const waterFogEnd = Math.min(fog.distance, Math.max(water.fogDistance * 4, 32));
      this.scene.fogEnabled = true;
      this.scene.fogMode = Scene.FOGMODE_LINEAR;
      this.scene.fogStart = fog.start * (1 - logBlend);
      this.scene.fogEnd = waterFogEnd * logBlend + fog.distance * (1 - logBlend);
      this.scene.fogColor.copyFromFloats(
        fog.color[0] + (water.color[0] - fog.color[0]) * waterBlend,
        fog.color[1] + (water.color[1] - fog.color[1]) * waterBlend,
        fog.color[2] + (water.color[2] - fog.color[2]) * waterBlend,
      );
      this.scene.clearColor.copyFromFloats(this.scene.fogColor.r, this.scene.fogColor.g, this.scene.fogColor.b, 1);
      return;
    }
    this.scene.fogEnabled = true;
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = fog.start;
    this.scene.fogEnd = fog.distance;
    this.scene.fogColor = new Color3(...fog.color);
    this.scene.clearColor = new Color4(...fog.color, 1);
  }

  private waterVolumeAtCamera(position: RegisteredMapEntity["position"]): { material: number; surfaceZ: number; size: number } | undefined {
    const initial = this.physics.lookupMaterialCube(position);
    if (!initial || (initial.material & MATF_VOLUME) !== MAT_WATER) return undefined;
    let top = initial;
    for (;;) {
      const next = this.physics.lookupMaterialCube({ x: position.x, y: position.y, z: top.origin.z + top.size });
      if (!next || (next.material & MATF_VOLUME) !== MAT_WATER || next.origin.z + next.size <= top.origin.z + top.size) break;
      top = next;
    }
    return { material: initial.material, surfaceZ: top.origin.z + top.size, size: top.size };
  }

  private setMapFarPlane(map: SauerMap): void {
    const farPlane = Math.max(50_000, map.header.worldSize * 2.1);
    this.freeCamera.maxZ = farPlane;
    this.playerCamera.maxZ = farPlane;
  }

  private createFogDome(fog: MapFog): void {
    if (fog.domeMax <= 0) return;
    const geometry = createFogDomeGeometry(fog, this.freeCamera.maxZ * 2 * 0.999);
    const mesh = new Mesh("map-fog-dome", this.scene);
    const vertexData = new VertexData();
    vertexData.positions = geometry.positions;
    vertexData.indices = geometry.indices;
    vertexData.colors = geometry.colors;
    vertexData.applyToMesh(mesh, true);
    const material = new ShaderMaterial("map-fog-dome-material", this.scene, {
      vertexSource: `
        precision highp float;
        attribute vec3 position;
        attribute vec4 color;
        uniform mat4 worldViewProjection;
        varying vec4 vertexColor;

        void main(void) {
          gl_Position = worldViewProjection * vec4(position, 1.0);
          gl_Position.z = gl_Position.w;
          vertexColor = color;
        }
      `,
      fragmentSource: `
        precision highp float;
        varying vec4 vertexColor;

        void main(void) {
          gl_FragColor = vertexColor;
        }
      `,
    }, {
      attributes: ["position", "color"],
      uniforms: ["worldViewProjection"],
      needAlphaBlending: true,
    });
    material.backFaceCulling = false;
    mesh.useVertexColors = true;
    mesh.hasVertexAlpha = true;
    material.disableDepthWrite = true;
    material.depthFunction = Constants.LEQUAL;
    mesh.material = material;
    mesh.infiniteDistance = true;
    mesh.isPickable = false;
    // Rendering groups clear depth by default. Keep the dome with world geometry so its
    // transparent pass can test against the terrain instead of covering it.
    mesh.renderingGroupId = 0;
    mesh.metadata = { fogDomeClouds: fog.domeClouds };
    this.fogDomeMaterial = material;
  }

  private placeCamera(map: SauerMap, batches: GeometryBatch[]): void {
    const playerStart = map.entities.find((entity) => entity.type === 3);
    const fallback = { x: map.header.worldSize / 2, y: map.header.worldSize / 2, z: map.header.worldSize * 0.65 };
    const spawn = playerStart ? { ...playerStart.position, z: playerStart.position.z + 14 } : fallback;
    const spawnYaw = playerStart?.attributes[0] ?? 0;
    this.physics.spawn(spawn, spawnYaw, performance.now());
    const remotePlayer = this.fpsClient.multiplayer.clientNumber >= 0 && !this.fpsClient.multiplayer.isLocalGame;
    if (remotePlayer) this.fpsClient.multiplayer.synchronizeLocalSpawnState();
    else if (this.runtimeMode === "game") this.weapons.controller.spawnForGameMode(this.localGameMode, performance.now());
    else this.weapons.controller.respawn(performance.now());
    if (this.runtimeMode === "debug" && this.debugLoadout) this.weapons.controller.inventory.grantMaximumAmmo();
    this.weaponHUD.render();
    this.freeCamera.position.copyFrom(toBabylonPosition(spawn));
    const target = this.geometryCenter(batches);
    const fallbackDirection = playerStart ? toBabylonYawDirection(spawnYaw) : new Vector3(0, 0, -1);
    this.freeCamera.setTarget(target ?? this.freeCamera.position.add(fallbackDirection));
    this.freeCamera.speed = Math.max(1, map.header.worldSize / 1024);
    this.updatePlayerCamera(spawn);
  }

  private createCamera(name: string): UniversalCamera {
    const camera = new UniversalCamera(name, new Vector3(0, 64, 0), this.scene);
    camera.minZ = 0.1;
    camera.maxZ = 50_000;
    camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    camera.fov = 70 * Math.PI / 180;
    return camera;
  }

  private createViewportTuningPostProcess(camera: Camera): void {
    ShaderStore.ShadersStore.viewportTuningFragmentShader = `
      precision highp float;
      varying vec2 vUV;
      uniform sampler2D textureSampler;
      uniform float contrast;
      uniform float gamma;
      uniform float vibrance;

      void main(void) {
        vec4 source = texture2D(textureSampler, vUV);
        vec3 color = pow(max(source.rgb, vec3(0.0)), vec3(1.0 / gamma));
        color = (color - 0.5) * contrast + 0.5;
        float luminance = dot(color, vec3(0.2126, 0.7152, 0.0722));
        float chroma = max(color.r, max(color.g, color.b)) - min(color.r, min(color.g, color.b));
        float saturation = 1.0 + (vibrance - 1.0) * (1.0 - clamp(chroma, 0.0, 1.0));
        color = mix(vec3(luminance), color, saturation);
        gl_FragColor = vec4(clamp(color, 0.0, 1.0), source.a);
      }
    `;
    const postProcess = new PostProcess("viewport-tuning", "viewportTuning", ["contrast", "gamma", "vibrance"], null, 1, camera);
    postProcess.onApply = (effect) => {
      effect.setFloat("contrast", this.viewportTuning.contrast);
      effect.setFloat("gamma", this.viewportTuning.gamma);
      effect.setFloat("vibrance", this.viewportTuning.vibrance);
    };
  }

  private updatePhysics(nowMilliseconds: number): void {
    animateEntityModels(this.entityModelAnimations, nowMilliseconds,
      (entity) => entity.type < 8 || entity.type > 18 || this.fpsClient.multiplayer.entities.isSpawned(entity.index));
    if (this.bots.waypoints.showWaypoints && nowMilliseconds - this.lastWaypointDebugUpdate >= 500) {
      this.lastWaypointDebugUpdate = nowMilliseconds;
      this.syncWaypointDebug(true);
    }
    if (this.cameraMode !== "player") return;
    const dead = this.isLocalPlayerDead(), wasDead = this.localDeadAt > 0;
    if (dead && !wasDead) this.localDeadAt = nowMilliseconds;
    else if (!dead && wasDead) this.localDeadAt = 0;
    this.physicsInput.setFullGyroContext(this.isLocalPlayerSpectator());
    const input = this.physicsInput.sample();
    let followed = this.followedPlayer();
    if (followed && (input.forward || input.backward || input.left || input.right)) {
      this.stopFollowing();
      followed = undefined;
    }
    let renderPosition: RegisteredMapEntity["position"];
    if (followed) {
      interpolateNetworkEntity(followed, nowMilliseconds);
      const player = this.physics.player;
      player.position = { ...followed.position };
      player.previousPosition = { ...followed.position };
      player.falling = { x: 0, y: 0, z: 0 };
      this.spectatorYawOffset = (this.spectatorYawOffset + input.yawDelta * 0.1 + 360) % 360;
      this.spectatorPitchOffset = Math.min(90, Math.max(-90, this.spectatorPitchOffset - input.pitchDelta * 0.1));
      player.yaw = (followed.yaw + this.spectatorYawOffset) % 360;
      player.pitch = Math.min(90, Math.max(-90, (followed.state === ClientState.Dead ? 0 : followed.pitch) + this.spectatorPitchOffset));
      player.roll = followed.roll;
      player.move = player.strafe = 0;
      player.physicsState = PhysicsState.Float;
      renderPosition = player.position;
    } else renderPosition = this.frameProfiler.measure("playerPhysics", () => this.physics.update(nowMilliseconds, input));
    this.updatePlayerCamera(renderPosition);
    const aimTarget = this.frameProfiler.measure("weaponSimulation", () => this.aimTarget());
    this.frameProfiler.measure("hud", () => this.crosshairHUD.update(this.aimingAtTeammate(aimTarget)));
    this.weaponRenderer.setViewedGun(followed?.selectedGun, followed?.lastAction, followed?.gunWait);
    const hudPlayer = followed ?? this.fpsClient.multiplayer.players.get(this.fpsClient.multiplayer.clientNumber);
    this.frameProfiler.measure("hud", () => this.weaponHUD.render(hudPlayer ? {
      health: hudPlayer.health, maxHealth: hudPlayer.maxHealth, armour: hudPlayer.armour, armourType: hudPlayer.armourType,
      selectedGun: hudPlayer.selectedGun, ammo: hudPlayer.ammo, state: hudPlayer.state, flags: hudPlayer.flags, tokens: hudPlayer.tokens,
      clientNumber: hudPlayer.clientNumber,
    } : {
      health: this.physics.player.health, maxHealth: this.physics.player.maxHealth, armour: this.physics.player.armour,
      armourType: this.physics.player.armourType, selectedGun: this.weapons.controller.inventory.selectedGun,
      ammo: this.weapons.controller.inventory.ammo, state: this.physics.player.clientState, flags: 0, tokens: 0,
    }));
    this.frameProfiler.measure("weaponSimulation", () => this.weapons.update(nowMilliseconds, aimTarget));
    this.botUpdatePlayers.length = 0;
    for (const player of this.fpsClient.multiplayer.players.values()) {
      if (player.aiType === 0 || player.ownerNumber >= 0) this.botUpdatePlayers.push(player);
    }
    this.bots.update(nowMilliseconds, this.botUpdatePlayers, !dead);
    this.frameProfiler.measure("networking", () => {
      for (const bot of this.bots.bots.values()) if (bot.ownerNumber < 0) this.fpsClient.multiplayer.syncLocalBot(bot);
      this.syncBotTargets();
      if (nowMilliseconds - this.lastBotNetworkUpdate >= 33) {
        this.lastBotNetworkUpdate = nowMilliseconds;
        for (const bot of this.bots.bots.values()) {
          if (bot.ownerNumber === this.fpsClient.multiplayer.clientNumber && bot.alive) {
            this.fpsClient.multiplayer.sendOwnedBotPosition(bot, bot.clientNumber, bot.lifeSequence);
          }
        }
      }
      this.fpsClient.multiplayer.update(nowMilliseconds);
      if (this.fpsClient.multiplayer.isLocalGame) {
        for (const bot of this.bots.bots.values()) {
          const player = this.fpsClient.multiplayer.players.get(bot.clientNumber);
          if (player) { bot.flags = player.flags; bot.tokens = player.tokens; }
        }
      }
    });
    this.frameProfiler.measure("hud", () => this.multiplayerHUD.render());
    this.updateNetworkPlayers(renderPosition);
  }

  private toggleRenderDiagnostic(diagnostic: keyof RendererDiagnosticState): void {
    this.renderDiagnostics[diagnostic] = !this.renderDiagnostics[diagnostic];
    this.applyRenderDiagnostics();
  }

  private applyRenderDiagnostics(): void {
    this.particleRenderer.setRenderingEnabled(this.renderDiagnostics.particles);
    for (const mesh of this.scene.meshes) {
      const owner = this.resourceOwner(mesh.name);
      if (owner === "world" || owner === "mapmodels") mesh.isVisible = this.renderDiagnostics.world;
    }
  }

  private resourceCounters(): RendererResourceCounters {
    const counters: RendererResourceCounters = {
      world: { meshes: 0, materials: 0 },
      mapmodels: { meshes: 0, materials: 0 },
      players: { meshes: 0, materials: 0 },
      weapons: { meshes: 0, materials: 0 },
      particles: { meshes: 0, materials: 0 },
      debugging: { meshes: 0, materials: 0 },
    };
    for (const mesh of this.scene.meshes) counters[this.resourceOwner(mesh.name)].meshes++;
    for (const material of this.scene.materials) counters[this.resourceOwner(material.name)].materials++;
    return counters;
  }

  private resourceOwner(name: string): RendererResourceOwner {
    if (name.startsWith("mapmodel-")) return "mapmodels";
    if (name.startsWith("player-") || name.startsWith("ragdoll-")) return "players";
    if (name.startsWith("hudgun-") || name.startsWith("weapon-projectile-")) return "weapons";
    if (name.includes("particle") || name.startsWith("map-flame") || name.startsWith("map-smoke") || name.startsWith("beam-")) {
      return "particles";
    }
    if (name.startsWith("entity-") || name.startsWith("waypoint-") || name.startsWith("material-volume-") ||
        name.startsWith("volume-material-")) return "debugging";
    return "world";
  }

  private handleMultiplayerEvent(event: MultiplayerEvent): void {
    if (event.type === "item-effect") {
      const icon = ITEM_ICONS[event.entityType - 8];
      if (icon !== undefined) this.particleRenderer.itemIcon(event.position, icon, !event.spawned);
      return;
    }
    if (event.type === "bot-init") {
      if (event.player.ownerNumber === this.fpsClient.multiplayer.clientNumber) {
        const bot = this.bots.init({ clientNumber: event.player.clientNumber, ownerNumber: event.player.ownerNumber, skill: event.player.skill,
          name: event.player.name, team: event.player.team, model: event.player.model });
        bot.lifeSequence = event.player.lifeSequence;
        bot.clientState = event.player.state;
        bot.alive = event.player.alive;
        if (!bot.alive) bot.deadAt = performance.now() - 500;
      } else this.bots.remove(event.player.clientNumber);
      return;
    }
    if (event.type === "players" && event.disconnectedClientNumber !== undefined) this.bots.remove(event.disconnectedClientNumber);
    if (event.type === "players") {
      for (const bot of this.bots.bots.values()) {
        if (bot.ownerNumber !== this.fpsClient.multiplayer.clientNumber) continue;
        const player = this.fpsClient.multiplayer.players.get(bot.clientNumber);
        if (!player) continue;
        bot.health = player.health; bot.maxHealth = player.maxHealth; bot.armour = player.armour; bot.armourType = player.armourType;
        bot.weaponSystem.controller.inventory.ammo.set(player.ammo);
        bot.weaponSystem.controller.quadMilliseconds = player.quadMillis;
        bot.velocity = { ...player.velocity };
        if (player.state === ClientState.Dead && bot.alive) this.bots.killed(bot);
      }
    }
    if (event.type === "spawn" && event.clientNumber !== undefined && event.clientNumber !== this.fpsClient.multiplayer.clientNumber) {
      const bot = this.bots.bots.get(event.clientNumber);
      const player = this.fpsClient.multiplayer.players.get(event.clientNumber);
      if (bot && player) {
        this.bots.spawned(bot, performance.now());
        bot.lifeSequence = player.lifeSequence;
        bot.health = player.health;
        bot.maxHealth = player.maxHealth;
        bot.armour = player.armour;
        bot.armourType = player.armourType;
        bot.weaponSystem.controller.inventory.selectedGun = player.selectedGun;
        bot.weaponSystem.controller.inventory.ammo.set(player.ammo);
      }
    }
    if (event.type === "spawn" && (event.clientNumber === undefined || event.clientNumber === this.fpsClient.multiplayer.clientNumber)) {
      this.stopFollowing();
      this.spawnNetworkPlayer();
      this.syncPlayerView();
    } else if (event.type === "players") {
      if (event.disconnectedClientNumber === this.following) {
        if (this.followDirection) this.nextFollow(this.followDirection);
        else this.stopFollowing();
      } else this.validateFollowing();
      this.syncPlayerView();
    } else if (event.type === "disconnect") {
      this.stopFollowing();
      this.syncPlayerView();
    }
  }

  private spawnNetworkPlayer(): void {
    const player = this.fpsClient.multiplayer.players.get(this.fpsClient.multiplayer.clientNumber);
    const start = this.chooseNetworkSpawn(player);
    if (start) {
      this.physics.spawn({ ...start.position, z: start.position.z + this.physics.player.eyeHeight }, start.attributes[0] ?? 0,
        performance.now());
    }
    else this.physics.reset(performance.now());
    // physics.spawn() restores generic entity defaults. The server's N_SPAWNSTATE is
    // authoritative for health, armour, weapon selection and ammo in multiplayer.
    this.fpsClient.multiplayer.synchronizeLocalSpawnState();
    this.weaponHUD.render();
  }

  // Original: src/engine/world.cpp::gatherspawninfos()/poprandomspawn() and
  // src/fpsgame/fps.cpp::ratespawn(). Native Sauerbraten uses a weighted random
  // choice that favours starts away from visible, living enemies.
  private chooseNetworkSpawn(localPlayer: NetworkPlayer | undefined): RegisteredMapEntity | undefined {
    const multiplayer = this.fpsClient.multiplayer, mode = multiplayer.gameMode;
    const allStarts = this.currentMap?.entityRegistry.filter((entity) => entity.type === 3) ?? [];
    const team = ctfTeamFlag(localPlayer?.team ?? "");
    const groupedMode = (gameModeHas(mode, GameModeFlag.Ctf) && !gameModeHas(mode, GameModeFlag.Hold)) ||
      gameModeHas(mode, GameModeFlag.Collect);
    const tag = groupedMode ? team : 0;
    const taggedStarts = allStarts.filter((entity) => (entity.attributes[1] ?? 0) === tag);
    const starts = taggedStarts.length ? taggedStarts : allStarts;
    if (!starts.length) return undefined;
    const clientMode = gameModeHas(mode, GameModeFlag.Ctf) || gameModeHas(mode, GameModeFlag.Capture) ||
      gameModeHas(mode, GameModeFlag.Collect);
    const maximumRange = !gameModeHas(mode, GameModeFlag.NoItems) ? 400 : clientMode ? 300 : 110;
    const enemies = [...multiplayer.players.values()].filter((player) => player !== localPlayer && player.state === ClientState.Alive &&
      (!localPlayer?.team || player.team !== localPlayer.team));
    const weighted = starts.map((start) => {
      const origin = { ...start.position, z: start.position.z + this.physics.player.eyeHeight };
      let minimumDistance = maximumRange;
      for (const enemy of enemies) {
        const direction = subtract(enemy.position, origin), actualDistance = magnitude(direction);
        if (actualDistance >= minimumDistance || actualDistance <= 0) continue;
        normalize(direction);
        const obstruction = this.physics.raycast(origin, direction, actualDistance, 0, true);
        minimumDistance = Math.min(minimumDistance, obstruction && obstruction.distance < actualDistance ? actualDistance * 1.5 : actualDistance);
      }
      const proximity = this.nativeProximityScore(minimumDistance, 80, maximumRange);
      let weight = 1 - proximity;
      if (clientMode) weight = weight > 0 ? 2 * weight / (weight + 1) : 0;
      return { start, weight };
    });
    const total = weighted.reduce((sum, candidate) => sum + candidate.weight, 0);
    if (total <= 0) return weighted[Math.floor(Math.random() * weighted.length)]?.start;
    let selection = Math.random() * total;
    for (const candidate of weighted) {
      selection -= candidate.weight;
      if (selection <= 0) return candidate.start;
    }
    return weighted[weighted.length - 1]?.start;
  }

  private nativeProximityScore(distance: number, lower: number, upper: number): number {
    if (distance <= lower) return 1;
    if (distance >= upper) return 0;
    const aboveLower = distance - lower, belowUpper = distance - upper;
    return belowUpper * belowUpper / (aboveLower * aboveLower + belowUpper * belowUpper);
  }

  private updateNetworkPlayers(localRenderPosition: RegisteredMapEntity["position"]): void {
    const multiplayer = this.fpsClient.multiplayer;
    const nowMilliseconds = performance.now();
    const followed = this.followedPlayer();
    const thirdPersonView = this.thirdperson || this.isLocalPlayerDead() || followed?.state === ClientState.Dead;
    const players: RenderPlayer[] = [];
    const localNetworkPlayer = multiplayer.players.get(multiplayer.clientNumber);
    for (const [clientNumber, player] of multiplayer.players) {
      const ownedBot = this.bots.bots.get(clientNumber);
      if (ownedBot && isBotLocallySimulated(ownedBot.ownerNumber, multiplayer.clientNumber)) continue;
      if (!this.renderDiagnostics.bots && player.aiType !== 0) continue;
      const local = clientNumber === multiplayer.clientNumber;
      if (!local) interpolateNetworkEntity(player, nowMilliseconds);
      if (local && !thirdPersonView) continue;
      if (!local && clientNumber === this.following && multiplayer.isSpectator && !thirdPersonView) continue;
      const source = local ? this.physics.player : player;
      players.push({
        id: clientNumber,
        model: local ? this.playerModel : player.model,
        team: player.team,
        local,
        visible: player.positionReady && player.state !== ClientState.Spectator && player.state !== ClientState.Spawning,
        position: {
          ...(local ? localRenderPosition : source.position),
          z: (local ? localRenderPosition.z : source.position.z) - source.eyeHeight,
        },
        yaw: source.yaw,
        pitch: source.pitch,
        selectedGun: local ? this.weapons.controller.inventory.selectedGun : player.selectedGun,
        lastAction: local ? this.weapons.controller.lastAction : player.lastAction,
        lastAttackGun: local ? this.weapons.controller.lastAttackGun : player.lastAttackGun,
        gunWait: local ? this.weapons.controller.gunWait : player.gunWait,
        state: local ? this.physics.player.clientState : player.state,
        move: source.move,
        strafe: source.strafe,
        physicsState: source.physicsState,
        inWater: local ? this.physics.player.inWater : 0,
        timeInAir: local ? this.physics.player.timeInAir : undefined,
        velocityZ: source.velocity.z + (local ? this.physics.player.falling.z : player.falling.z),
        velocity: {
          x: source.velocity.x + (local ? this.physics.player.falling.x : player.falling.x),
          y: source.velocity.y + (local ? this.physics.player.falling.y : player.falling.y),
          z: source.velocity.z + (local ? this.physics.player.falling.z : player.falling.z),
        },
        lastPain: player.lastPain,
        deadAt: player.deadAt || this.localDeadAt,
      });
    }
    for (const bot of this.bots.bots.values()) {
      if (!this.renderDiagnostics.bots) continue;
      if (multiplayer.players.has(bot.clientNumber) && !isBotLocallySimulated(bot.ownerNumber, multiplayer.clientNumber)) continue;
      players.push({
        id: bot.clientNumber, model: bot.model % 5, team: bot.team, local: false,
        visible: bot.clientState !== ClientState.Spectator && bot.clientState !== ClientState.Spawning,
        position: { ...bot.position, z: bot.position.z - bot.eyeHeight }, yaw: bot.yaw, pitch: bot.pitch,
        selectedGun: bot.selectedGun, lastAction: bot.lastAction, lastAttackGun: bot.lastAttackGun, gunWait: bot.gunWait,
        state: bot.clientState, move: bot.move, strafe: bot.strafe, physicsState: bot.physicsState, inWater: bot.inWater,
        timeInAir: bot.timeInAir, velocityZ: bot.velocity.z + bot.falling.z,
        velocity: { x: bot.velocity.x + bot.falling.x, y: bot.velocity.y + bot.falling.y, z: bot.velocity.z + bot.falling.z },
        lastPain: bot.lastPain, deadAt: bot.deadAt,
      });
    }
    if (thirdPersonView && multiplayer.clientNumber < 0) {
      const player = this.physics.player;
      players.push({
        id: -1,
        model: this.playerModel,
        team: "",
        local: true,
        visible: player.clientState !== ClientState.Spectator,
        position: { ...localRenderPosition, z: localRenderPosition.z - player.eyeHeight },
        yaw: player.yaw,
        pitch: player.pitch,
        selectedGun: this.weapons.controller.inventory.selectedGun,
        lastAction: this.weapons.controller.lastAction,
        lastAttackGun: this.weapons.controller.lastAttackGun,
        gunWait: this.weapons.controller.gunWait,
        state: player.clientState,
        move: player.move,
        strafe: player.strafe,
        physicsState: player.physicsState,
        inWater: player.inWater,
        timeInAir: player.timeInAir,
        velocityZ: player.velocity.z + player.falling.z,
        velocity: {
          x: player.velocity.x + player.falling.x,
          y: player.velocity.y + player.falling.y,
          z: player.velocity.z + player.falling.z,
        },
        deadAt: this.localDeadAt,
      });
    }
    this.playerRenderer.rendergame(players, multiplayer.gameMode, this.teamskins, localNetworkPlayer?.team ?? "", nowMilliseconds);
    this.ctfRenderer.render(multiplayer.ctfMode.flags, multiplayer.players, multiplayer.clientNumber, localNetworkPlayer?.team ?? "",
      this.physics.player.position, this.physics.player.aboveEye, this.physics.player.yaw, multiplayer.gameMode,
      (clientNumber) => this.playerRenderer.flagAttachmentPosition(clientNumber));
    this.collectRenderer.render(multiplayer.collectMode.bases, multiplayer.collectMode.tokens, multiplayer.players, multiplayer.clientNumber,
      localNetworkPlayer?.team ?? "", multiplayer.gameMode, nowMilliseconds,
      (clientNumber) => this.playerRenderer.flagAttachmentPosition(clientNumber));
  }

  private syncBotTargets(): void {
    this.weapons.targets.length = Math.min(1, this.weapons.targets.length);
    for (const player of this.fpsClient.multiplayer.players.values()) {
      if (player.clientNumber !== this.fpsClient.multiplayer.clientNumber && !(player.aiType !== 0 && player.ownerNumber < 0)) {
        this.weapons.targets.push(player);
      }
    }
    for (const bot of this.bots.bots.values()) this.weapons.targets.push(bot);
  }

  // Original: src/fpsgame/ctf.h, ctfclientmode::aicheck() / aihomerun().
  private gameModeAiObjective(bot: BotActor, interests: AiInterest[]): boolean {
    const multiplayer = this.fpsClient.multiplayer;
    if (gameModeHas(multiplayer.gameMode, GameModeFlag.Collect)) {
      const team = collectTeamBase(bot.team), feet = { ...bot.position, z: bot.position.z - bot.eyeHeight };
      if (bot.tokens > 0) {
        for (const base of multiplayer.collectMode.bases) {
          if (base.team === team) continue;
          const node = this.bots.waypoints.closestwaypoint(base.o, SIGHTMIN, true);
          if (this.bots.waypoints.iswaypoint(node)) interests.push({ state: AiStateType.Pursue, node, target: -(base.id + 1),
            targetType: AiTargetType.Affinity, score: squaredDistance(feet, base.o) / (bot.tokens > 2 ? 1000 : 100) });
        }
      }
      if (bot.tokens < COLLECT_TOKEN_LIMIT) {
        for (const token of multiplayer.collectMode.tokens) {
          const node = this.bots.waypoints.closestwaypoint(token.o, SIGHTMIN, true);
          if (!this.bots.waypoints.iswaypoint(node)) continue;
          const collectible = token.team !== team && (token.team > 0 || -token.team === team);
          interests.push({ state: AiStateType.Pursue, node, target: token.id, targetType: AiTargetType.Affinity,
            score: squaredDistance(feet, token.o) / (collectible ? 10 : 1) });
        }
      }
      return interests.length > 0;
    }
    if (!multiplayer.isLocalGame) return false;
    if (!gameModeHas(multiplayer.gameMode, GameModeFlag.Ctf) ||
        gameModeHas(multiplayer.gameMode, GameModeFlag.Protect) || gameModeHas(multiplayer.gameMode, GameModeFlag.Hold)) return false;
    const team = ctfTeamFlag(bot.team), carrying = multiplayer.ctfMode.flags.find((flag) => flag.owner === bot.clientNumber);
    const ownFlag = multiplayer.ctfMode.flags.find((flag) => flag.team === team);
    if (!carrying && (!ownFlag || ownFlag.owner < 0 && !ownFlag.dropped)) return false;
    const target = ownFlag;
    if (!target) return false;
    const owner = target.owner >= 0 ? multiplayer.players.get(target.owner) : undefined;
    const position = owner?.position ?? (target.dropped ? target.dropLoc : target.spawnLoc);
    const node = this.bots.waypoints.closestwaypoint(position, SIGHTMIN, true);
    if (!this.bots.waypoints.iswaypoint(node)) return false;
    interests.push({ state: AiStateType.Pursue, node, target: target.id, targetType: AiTargetType.Affinity,
      score: magnitude(subtract(bot.position, position)) / 10 });
    return true;
  }

  private downloadWaypoints(mapName: string): void {
    const bytes = Uint8Array.from(this.bots.waypoints.savewaypoints());
    const url = URL.createObjectURL(new Blob([bytes.buffer], { type: "application/octet-stream" }));
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${mapName}.wpt`;
    anchor.click();
    URL.revokeObjectURL(url);
  }

  private syncWaypointDebug(rebuild = false): void {
    if (rebuild || !this.bots.waypoints.showWaypoints) {
      this.waypointMeshes.forEach((mesh) => { if (mesh.material?.name.startsWith("waypoint-material-")) mesh.material.dispose(); mesh.dispose(); });
      this.waypointMeshes.length = 0;
    }
    if (!this.bots.waypoints.showWaypoints || this.waypointMeshes.length) return;
    const radius = this.bots.waypoints.showWaypointsRadius, origin = this.physics.player.position;
    const visible = this.bots.waypoints.waypoints.map((waypoint, index) => ({ waypoint, index })).filter(({ waypoint, index }) =>
      index > 0 && (!radius || Math.hypot(waypoint.o.x - origin.x, waypoint.o.y - origin.y, waypoint.o.z - origin.z) <= radius));
    const visibleIndices = new Set(visible.map(({ index }) => index));
    for (const { waypoint, index } of visible) {
      const marker = MeshBuilder.CreateSphere(`waypoint-${index}`, { diameter: 1.5, segments: 4 }, this.scene);
      marker.position.copyFrom(toBabylonPosition(waypoint.o));
      const material = new StandardMaterial(`waypoint-material-${index}`, this.scene);
      material.emissiveColor = waypoint.weight < 0 ? new Color3(1, 0.4, 0) : new Color3(1, 1, 1);
      material.disableLighting = true;
      marker.material = material;
      marker.isPickable = false;
      this.waypointMeshes.push(marker);
      for (const link of waypoint.links) {
        if (!visibleIndices.has(link)) continue;
        const line = MeshBuilder.CreateLines(`waypoint-link-${index}-${link}`, {
          points: [toBabylonPosition(waypoint.o), toBabylonPosition(this.bots.waypoints.waypoints[link].o)],
        }, this.scene);
        line.color = new Color3(0, 0.35, 1);
        line.isPickable = false;
        this.waypointMeshes.push(line);
      }
    }
  }

  private updatePlayerCamera(position: RegisteredMapEntity["position"]): void {
    const yaw = this.physics.player.yaw * Math.PI / 180;
    const pitch = this.physics.player.pitch * Math.PI / 180;
    let cameraPosition = toBabylonPosition(position);
    if (this.thirdperson || this.isLocalPlayerDead() || this.followedPlayer()?.state === ClientState.Dead) {
      const desired = thirdpersoncamera(position, this.physics.player.yaw, this.physics.player.pitch);
      const offset = desired.subtract(cameraPosition);
      const distance = offset.length();
      const hit = distance > 0 ? this.physics.raycast(position, {
        x: offset.x / distance,
        y: offset.z / distance,
        z: offset.y / distance,
      }, distance, 1) : undefined;
      if (hit) offset.scaleInPlace(Math.max(0, hit.distance - 0.5) / distance);
      cameraPosition = cameraPosition.add(offset);
    }
    this.playerCamera.position.copyFrom(cameraPosition);
    // Sauerbraten applies yaw and pitch as independent camera rotations. Avoiding a look-at decomposition preserves yaw at vertical pitch.
    this.playerCamera.rotation.set(pitch, Math.PI - yaw, 0);
  }

  // Original: src/engine/rendergl.cpp
  // Function: setcammatrix() worldpos ray
  private aimTarget(): RegisteredMapEntity["position"] {
    const camera = this.playerCamera.position;
    const forward = this.playerCamera.getForwardRay().direction;
    const origin = { x: camera.x, y: camera.z, z: camera.y };
    const direction = { x: forward.x, y: forward.z, z: forward.y };
    const maximumDistance = 2 * (this.currentMap?.header.worldSize ?? 1024);
    const hit = this.physics.raycast(origin, direction, maximumDistance, 0, true);
    return hit?.position ?? {
      x: origin.x + direction.x * maximumDistance,
      y: origin.y + direction.y * maximumDistance,
      z: origin.z + direction.z * maximumDistance,
    };
  }

  private aimingAtTeammate(target: RegisteredMapEntity["position"]): boolean {
    const multiplayer = this.fpsClient.multiplayer;
    const local = multiplayer.players.get(multiplayer.clientNumber);
    if (!local?.team) return false;
    const origin = this.physics.player.position;
    const direction = subtract(target, origin);
    const maximumDistance = magnitude(direction);
    if (maximumDistance <= 0) return false;
    normalize(direction);
    let closestDistance = maximumDistance;
    let closestTeam = "";
    for (const player of multiplayer.players.values()) {
      if (player === local || !player.alive) continue;
      const distance = lineCylinderIntersection(origin, direction, closestDistance, player);
      if (distance === undefined || distance >= closestDistance) continue;
      closestDistance = distance;
      closestTeam = player.team;
    }
    return closestTeam === local.team;
  }

  // Original: src/fpsgame/fps.cpp, nextfollow(), followingplayer(), stopfollowing(), setupcamera().
  private nextFollow(direction: number): void {
    const multiplayer = this.fpsClient.multiplayer;
    if (!multiplayer.isSpectator) {
      this.stopFollowing();
      return;
    }
    const step = direction < 0 ? -1 : 1;
    const length = Math.max(0, ...multiplayer.players.keys()) + 1;
    let current = this.following >= 0 ? this.following : step < 0 ? length - 1 : 0;
    for (let index = 0; index < length; index++) {
      current = (current + step + length) % length;
      const candidate = multiplayer.players.get(current);
      if (!candidate || candidate.clientNumber === multiplayer.clientNumber || candidate.state === ClientState.Spectator) continue;
      this.following = candidate.clientNumber;
      this.followDirection = step;
      this.spectatorYawOffset = this.spectatorPitchOffset = 0;
      this.physics.player.velocity = { x: 0, y: 0, z: 0 };
      this.physics.player.falling = { x: 0, y: 0, z: 0 };
      this.physics.scheduler.reset(performance.now());
      this.syncPlayerView();
      return;
    }
    this.stopFollowing();
  }

  private stopFollowing(): void {
    if (this.following < 0) return;
    this.following = -1;
    this.followDirection = 0;
    this.spectatorYawOffset = this.spectatorPitchOffset = 0;
    this.physics.scheduler.reset(performance.now());
    this.syncPlayerView();
  }

  private followedPlayer(): NetworkPlayer | undefined {
    if (!this.fpsClient.multiplayer.isSpectator || this.following < 0) return undefined;
    const player = this.fpsClient.multiplayer.players.get(this.following);
    return player && player.state !== ClientState.Spectator ? player : undefined;
  }

  private validateFollowing(): void {
    const spectator = this.fpsClient.multiplayer.isSpectator;
    if (!spectator) {
      this.stopFollowing();
      return;
    }
    if (this.following < 0 || this.fpsClient.multiplayer.players.has(this.following)) return;
    this.stopFollowing();
  }

  private readonly onSpectatorPointerDown = (event: PointerEvent): void => {
    if (!this.isLocalPlayerSpectator() || document.pointerLockElement !== this.canvas) return;
    if (event.button === 0) this.nextFollow(1);
    else if (event.button === 2) this.nextFollow(-1);
    else if (event.button === 1) this.stopFollowing();
    else return;
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly onSpectatorContextMenu = (event: MouseEvent): void => {
    if (this.isLocalPlayerSpectator()) event.preventDefault();
  };

  private readonly onSpectatorKeyDown = (event: KeyboardEvent): void => {
    if (!this.isLocalPlayerSpectator() || document.pointerLockElement !== this.canvas || event.code !== "Space") return;
    this.stopFollowing();
    event.preventDefault();
    event.stopImmediatePropagation();
  };

  private readonly resize = (): void => this.engine.resize();

  private syncPlayerView(): void {
    const dead = this.isLocalPlayerDead();
    const spectator = this.isLocalPlayerSpectator();
    const followed = this.followedPlayer();
    this.physicsInput.enabled = this.runtimeMode === "game";
    this.weaponInput.enabled = this.runtimeMode === "game" && !dead && !spectator;
    this.touchControls.setSpectatorMode(spectator);
    this.touchControls.setGameplayEnabled(this.runtimeMode === "game" && !dead);
    // Native gameplayhud remains active while dead and while freely spectating (health 0, clock/scores, and spectator text still render).
    this.weaponHUD.setVisible(this.runtimeMode === "game");
    this.crosshairHUD.setVisible(this.runtimeMode === "game" && !dead && (!spectator || followed?.state !== ClientState.Dead && Boolean(followed)));
    this.weaponRenderer.setViewedGun(followed?.selectedGun, followed?.lastAction, followed?.gunWait);
    this.weaponRenderer.setHudGunVisible(this.cameraMode === "player" && !this.thirdperson && !dead &&
      (!spectator || followed?.state !== ClientState.Dead && Boolean(followed)));
    this.spectatorHUD.render(spectator, followed);
  }

  private geometryCenter(batches: GeometryBatch[]): Vector3 | undefined {
    const minimum = new Vector3(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    const maximum = new Vector3(Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY, Number.NEGATIVE_INFINITY);
    for (const batch of batches) {
      for (let index = 0; index < batch.positions.length; index += 3) {
        minimum.x = Math.min(minimum.x, batch.positions[index]);
        minimum.y = Math.min(minimum.y, batch.positions[index + 1]);
        minimum.z = Math.min(minimum.z, batch.positions[index + 2]);
        maximum.x = Math.max(maximum.x, batch.positions[index]);
        maximum.y = Math.max(maximum.y, batch.positions[index + 1]);
        maximum.z = Math.max(maximum.z, batch.positions[index + 2]);
      }
    }
    return Number.isFinite(minimum.x) ? minimum.add(maximum).scale(0.5) : undefined;
  }

}

export function computeTangents(positions: number[], normals: number[], uvs: number[], indices: number[]): number[] {
  const vertexCount = positions.length / 3;
  const tangents = new Array<number>(vertexCount * 3).fill(0);
  const bitangents = new Array<number>(vertexCount * 3).fill(0);
  for (let index = 0; index < indices.length; index += 3) {
    const first = indices[index], second = indices[index + 1], third = indices[index + 2];
    const edge1 = subtractPosition(positions, second, first), edge2 = subtractPosition(positions, third, first);
    const du1 = uvs[second * 2] - uvs[first * 2], dv1 = uvs[second * 2 + 1] - uvs[first * 2 + 1];
    const du2 = uvs[third * 2] - uvs[first * 2], dv2 = uvs[third * 2 + 1] - uvs[first * 2 + 1];
    const determinant = du1 * dv2 - du2 * dv1;
    if (Math.abs(determinant) < 1e-12) continue;
    const inverse = 1 / determinant;
    const tangent = [
      (edge1[0] * dv2 - edge2[0] * dv1) * inverse,
      (edge1[1] * dv2 - edge2[1] * dv1) * inverse,
      (edge1[2] * dv2 - edge2[2] * dv1) * inverse,
    ];
    const bitangent = [
      (edge2[0] * du1 - edge1[0] * du2) * inverse,
      (edge2[1] * du1 - edge1[1] * du2) * inverse,
      (edge2[2] * du1 - edge1[2] * du2) * inverse,
    ];
    for (const vertex of [first, second, third]) {
      for (let component = 0; component < 3; component++) {
        tangents[vertex * 3 + component] += tangent[component];
        bitangents[vertex * 3 + component] += bitangent[component];
      }
    }
  }
  const result: number[] = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = vertex * 3;
    const normal = normals.slice(offset, offset + 3);
    const accumulated = tangents.slice(offset, offset + 3);
    const projection = dot3(normal, accumulated);
    let tangent = accumulated.map((component, componentIndex) => component - normal[componentIndex] * projection);
    let length = Math.hypot(...tangent);
    if (length < 1e-12) {
      const axis = Math.abs(normal[2]) < 0.999 ? [0, 0, 1] : [0, 1, 0];
      tangent = cross3(axis, normal);
      length = Math.hypot(...tangent);
    }
    tangent = tangent.map((component) => component / length);
    const handedness = dot3(cross3(normal, tangent), bitangents.slice(offset, offset + 3)) < 0 ? -1 : 1;
    result.push(tangent[0], tangent[1], tangent[2], handedness);
  }
  return result;
}

function subtractPosition(positions: number[], left: number, right: number): number[] {
  return [positions[left * 3] - positions[right * 3], positions[left * 3 + 1] - positions[right * 3 + 1],
    positions[left * 3 + 2] - positions[right * 3 + 2]];
}

function dot3(left: number[], right: number[]): number {
  return left[0] * right[0] + left[1] * right[1] + left[2] * right[2];
}

function cross3(left: number[], right: number[]): number[] {
  return [left[1] * right[2] - left[2] * right[1], left[2] * right[0] - left[0] * right[2],
    left[0] * right[1] - left[1] * right[0]];
}

async function loadSkyFace(basePath: string, suffix: string): Promise<Blob> {
  for (const candidate of skyFaceCandidates(basePath, suffix)) {
    const url = packageAssetUrl(candidate);
    if (!url) continue;
    const response = await fetch(url, { cache: "no-cache" });
    if (response.ok && response.headers.get("Content-Type")?.toLowerCase().startsWith("image/")) return response.blob();
  }
  throw new Error(`Could not load the ${suffix} face.`);
}

async function transformSkyFace(blob: Blob, rotate: boolean, color: [number, number, number]): Promise<string> {
  const solidFace = await singleColorIndexedPng(blob);
  if (solidFace) {
    const canvas = document.createElement("canvas");
    canvas.width = rotate ? solidFace.height : solidFace.width;
    canvas.height = rotate ? solidFace.width : solidFace.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for an indexed skybox face.");
    const tinted = solidFace.color.map((component, index) => Math.round(component * color[index]));
    context.fillStyle = `rgb(${tinted.join(", ")})`;
    context.fillRect(0, 0, canvas.width, canvas.height);
    return canvasObjectUrl(canvas);
  }
  const decodedFace = await decodeRgbPng(blob);
  if (decodedFace) {
    const source = document.createElement("canvas");
    source.width = decodedFace.width;
    source.height = decodedFace.height;
    const sourceContext = source.getContext("2d");
    if (!sourceContext) throw new Error("Could not create a canvas for a decoded skybox face.");
    sourceContext.putImageData(new ImageData(decodedFace.pixels, decodedFace.width, decodedFace.height), 0, 0);
    const canvas = document.createElement("canvas");
    canvas.width = rotate ? decodedFace.height : decodedFace.width;
    canvas.height = rotate ? decodedFace.width : decodedFace.height;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for a decoded skybox face.");
    if (rotate) {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(-Math.PI / 2);
      context.drawImage(source, -source.width / 2, -source.height / 2);
      context.setTransform(1, 0, 0, 1, 0, 0);
    } else context.drawImage(source, 0, 0);
    tintCanvas(context, canvas, color);
    return canvasObjectUrl(canvas);
  }
  if (!rotate && color.every((component) => component === 1)) return URL.createObjectURL(blob);
  const sourceUrl = URL.createObjectURL(await pngWithoutAncillaryChunks(blob));
  const image = new Image();
  try {
    image.src = sourceUrl;
    await image.decode();
    const canvas = document.createElement("canvas");
    canvas.width = rotate ? image.naturalHeight : image.naturalWidth;
    canvas.height = rotate ? image.naturalWidth : image.naturalHeight;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for skybox orientation correction.");
    if (rotate) {
      context.translate(canvas.width / 2, canvas.height / 2);
      context.rotate(-Math.PI / 2);
      context.drawImage(image, -image.naturalWidth / 2, -image.naturalHeight / 2);
      context.setTransform(1, 0, 0, 1, 0, 0);
    } else context.drawImage(image, 0, 0);
    tintCanvas(context, canvas, color);
    return canvasObjectUrl(canvas);
  } finally {
    URL.revokeObjectURL(sourceUrl);
  }
}

async function singleColorIndexedPng(blob: Blob): Promise<{ width: number; height: number; color: [number, number, number] } | undefined> {
  if (blob.type !== "image/png") return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 32 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47 || bytes[25] !== 3) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "PLTE" && length === 3) {
      return {
        width: view.getUint32(16),
        height: view.getUint32(20),
        color: [bytes[offset + 8], bytes[offset + 9], bytes[offset + 10]],
      };
    }
    offset += 12 + length;
  }
  return undefined;
}

async function pngWithoutAncillaryChunks(blob: Blob): Promise<Blob> {
  if (blob.type !== "image/png") return blob;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 20 || bytes[0] !== 0x89 || bytes[1] !== 0x50 || bytes[2] !== 0x4e || bytes[3] !== 0x47) return blob;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const chunks: BlobPart[] = [bytes.slice(0, 8)];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return blob;
    const critical = bytes[offset + 4] >= 0x41 && bytes[offset + 4] <= 0x5a;
    if (critical) chunks.push(bytes.slice(offset, offset + 12 + length));
    offset += 12 + length;
  }
  return new Blob(chunks, { type: "image/png" });
}

async function decodeRgbPng(blob: Blob): Promise<{ width: number; height: number; pixels: Uint8ClampedArray<ArrayBuffer> } | undefined> {
  if (blob.type !== "image/png") return undefined;
  const bytes = new Uint8Array(await blob.arrayBuffer());
  if (bytes.length < 32 || bytes[24] !== 8 || bytes[25] !== 2 || bytes[28] !== 0) return undefined;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const width = view.getUint32(16);
  const height = view.getUint32(20);
  const compressed: BlobPart[] = [];
  let offset = 8;
  while (offset + 12 <= bytes.length) {
    const length = view.getUint32(offset);
    if (offset + 12 + length > bytes.length) return undefined;
    const type = String.fromCharCode(...bytes.subarray(offset + 4, offset + 8));
    if (type === "IDAT") compressed.push(bytes.slice(offset + 8, offset + 8 + length));
    offset += 12 + length;
  }
  const stream = new Blob(compressed).stream().pipeThrough(new DecompressionStream("deflate"));
  const filtered = new Uint8Array(await new Response(stream).arrayBuffer());
  const stride = width * 3;
  if (filtered.length !== (stride + 1) * height) return undefined;
  const rgb = new Uint8Array(stride * height);
  for (let y = 0; y < height; y++) {
    const filter = filtered[y * (stride + 1)];
    for (let x = 0; x < stride; x++) {
      const source = filtered[y * (stride + 1) + x + 1];
      const left = x >= 3 ? rgb[y * stride + x - 3] : 0;
      const above = y > 0 ? rgb[(y - 1) * stride + x] : 0;
      const upperLeft = y > 0 && x >= 3 ? rgb[(y - 1) * stride + x - 3] : 0;
      const predictor = filter === 0 ? 0 : filter === 1 ? left : filter === 2 ? above : filter === 3
        ? Math.floor((left + above) / 2) : filter === 4 ? paeth(left, above, upperLeft) : Number.NaN;
      if (!Number.isFinite(predictor)) return undefined;
      rgb[y * stride + x] = source + predictor;
    }
  }
  const pixels = new Uint8ClampedArray(new ArrayBuffer(width * height * 4));
  for (let source = 0, target = 0; source < rgb.length; source += 3, target += 4) {
    pixels[target] = rgb[source];
    pixels[target + 1] = rgb[source + 1];
    pixels[target + 2] = rgb[source + 2];
    pixels[target + 3] = 255;
  }
  return { width, height, pixels };
}

function paeth(left: number, above: number, upperLeft: number): number {
  const prediction = left + above - upperLeft;
  const leftDistance = Math.abs(prediction - left);
  const aboveDistance = Math.abs(prediction - above);
  const upperLeftDistance = Math.abs(prediction - upperLeft);
  return leftDistance <= aboveDistance && leftDistance <= upperLeftDistance ? left : aboveDistance <= upperLeftDistance ? above : upperLeft;
}

function tintCanvas(context: CanvasRenderingContext2D, canvas: HTMLCanvasElement, color: [number, number, number]): void {
  if (color.every((component) => component === 1)) return;
  context.globalCompositeOperation = "multiply";
  context.fillStyle = `rgb(${color.map((component) => Math.round(component * 255)).join(", ")})`;
  context.fillRect(0, 0, canvas.width, canvas.height);
}

async function canvasObjectUrl(canvas: HTMLCanvasElement): Promise<string> {
  const blob = await new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode a skybox face.")), "image/png");
  });
  return URL.createObjectURL(blob);
}

function squaredDistance(left: RegisteredMapEntity["position"], right: RegisteredMapEntity["position"]): number {
  const x = left.x - right.x, y = left.y - right.y, z = left.z - right.z;
  return x * x + y * y + z * z;
}
