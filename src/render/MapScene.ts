import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Engine } from "@babylonjs/core/Engines/engine";
import { Constants } from "@babylonjs/core/Engines/constants";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { Material } from "@babylonjs/core/Materials/material";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { PostProcess } from "@babylonjs/core/PostProcesses/postProcess";
import "@babylonjs/core/Shaders/default.vertex";
import "@babylonjs/core/Shaders/default.fragment";
import "@babylonjs/core/Shaders/postprocess.vertex";
import type { RegisteredMapEntity, SauerMap } from "../engine/octa";
import type { MapFogOverrides, MapLightingOverrides, MapModelAsset, MapSkyOverrides, MapSoundAsset, ResolvedTexture } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import { generateGeometry, type GeometryBatch } from "../engine/renderva";
import { generateMaterialGeometry, type MaterialGeometryBatch, type MaterialRenderKind } from "./materialGeometry";
import { describeSauerMaterial, MaterialCache } from "./MaterialCache";
import { toBabylonDirection, toBabylonPosition, toBabylonYawDirection } from "./coordinates";
import { resolveMapLighting } from "./MapLighting";
import { animateEntityModels, loadMapModels, type EntityModelAnimation, type MapModelResources } from "./MapModelLoader";
import { resolveMapSky, skyFaceCandidates, skyTextureRotationRadians, type MapSky } from "./MapSky";
import { createFogDomeGeometry, resolveMapFog, type MapFog } from "./MapFog";
import { installSauerFogDistance } from "./SauerFogShader";
import { BrowserPhysicsInput } from "../platform/browser/PhysicsInput";
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
import { ClientState, PhysicsState } from "../engine/physics/types";
import { ctfTeamFlag } from "../fpsgame/ctf";
import { interpolateNetworkEntity } from "../fpsgame/networkInterpolation";
import type { RuntimeMode } from "../runtime";
import { lineCylinderIntersection } from "../fpsgame/weapon/HitscanSystem";
import type { Damageable } from "../fpsgame/weapon/DamageSystem";
import { magnitude, normalize, subtract } from "../engine/physics/vector";
import { AiStateType, AiTargetType, BotManager, type AiInterest, type BotActor } from "../fpsgame/ai";
import { GameModeFlag, gameModeHas } from "../fpsgame/game";
import { SIGHTMIN } from "../fpsgame/waypoint";
import { RendererPerformanceOverlay, type RendererDiagnosticState, type RendererResourceCounters,
  type RendererResourceOwner } from "../platform/browser/RendererPerformanceOverlay";
import { FrameProfiler } from "../platform/browser/FrameProfiler";

export type CameraMode = "free" | "player";

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
    objective: (bot, _state, interests) => this.ctfAiObjective(bot, interests),
  });
  private readonly weaponInput: BrowserWeaponInput;
  private readonly weaponHUD: WeaponHUD;
  private readonly crosshairHUD: CrosshairHUD;
  private readonly weaponRenderer: WeaponRenderer;
  private readonly particleRenderer: ParticleRenderer;
  private readonly multiplayerHUD: MultiplayerHUD;
  private readonly spectatorHUD: SpectatorHUD;
  private readonly playerRenderer: PlayerRenderer;
  private readonly ctfRenderer: CtfRenderer;
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
  private readonly volumeMaterials = new Map<MaterialRenderKind, StandardMaterial>();
  private entityDebug = false;
  private readonly entityMeshes: Mesh[] = [];
  private readonly entityMaterials = new Map<string, StandardMaterial>();
  private readonly mapModelMeshes: Mesh[] = [];
  private mapModelResources?: MapModelResources;
  private readonly waypointMeshes: Mesh[] = [];
  private lastWaypointDebugUpdate = 0;
  private readonly entityModelAnimations: EntityModelAnimation[] = [];
  private currentMap?: SauerMap;
  private viewportTuning: ViewportTuning = { contrast: 1, gamma: 1, vibrance: 1 };
  private debugLoadout = false;
  private playerModel = 0;
  private localGameMode = 0;
  private localDeadAt = 0;
  private following = -1;
  private followDirection = 0;
  private lastBotNetworkUpdate = 0;
  private readonly resizeObserver: ResizeObserver;
  private readonly performanceOverlay: RendererPerformanceOverlay;
  private readonly frameProfiler = new FrameProfiler();
  private readonly renderDiagnostics: RendererDiagnosticState = { particles: true, bots: true, world: true };
  private particleUpdateStartedAt = 0;
  private readonly botUpdatePlayers: Damageable[] = [];

  constructor(canvas: HTMLCanvasElement, readonly runtimeMode: RuntimeMode) {
    this.canvas = canvas;
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
    installSauerFogDistance();
    this.scene = new Scene(this.engine);
    this.materialCache = new MaterialCache(this.scene);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.055, 0.067, 0.06, 1);

    this.freeCamera = this.createCamera("free-camera");
    this.freeCamera.speed = 4;
    this.freeCamera.angularSensibility = 2200;
    this.freeCamera.keysUp = [87, 38];
    this.freeCamera.keysDown = [83, 40];
    this.freeCamera.keysLeft = [65, 37];
    this.freeCamera.keysRight = [68, 39];
    if (runtimeMode === "debug") this.freeCamera.attachControl(canvas, true);
    this.playerCamera = this.createCamera("player-camera");
    this.createViewportTuningPostProcess(this.freeCamera);
    this.createViewportTuningPostProcess(this.playerCamera);
    this.cameraMode = runtimeMode === "debug" ? "free" : "player";
    this.scene.activeCamera = runtimeMode === "debug" ? this.freeCamera : this.playerCamera;
    this.physicsInput = new BrowserPhysicsInput(canvas);
    this.weaponInput = new BrowserWeaponInput(canvas, this.weapons.controller);
    const viewport = canvas.parentElement;
    if (!viewport) throw new Error("The weapon HUD requires a viewport parent.");
    this.performanceOverlay = new RendererPerformanceOverlay(viewport, this.engine, this.scene, this.frameProfiler,
      () => this.resourceCounters(), () => ({ ...this.renderDiagnostics }), (diagnostic) => this.toggleRenderDiagnostic(diagnostic));
    this.physics.raycastPerformanceRecorder = (milliseconds) => this.frameProfiler.recordRaycast(milliseconds);
    this.physics.raycastPerformanceEnabled = () => this.frameProfiler.enabled;
    this.bots.performanceRecorder = (phase, operation) => {
      const key = phase === "ai" ? "botAi" : phase === "physics" ? "botPhysics" : "weaponSimulation";
      this.frameProfiler.measure(key, operation);
    };
    this.weaponHUD = new WeaponHUD(viewport, this.weapons.controller, this.weapons.events);
    this.crosshairHUD = new CrosshairHUD(viewport, this.weapons.controller, this.weapons.events);
    this.multiplayerHUD = new MultiplayerHUD(viewport, this.fpsClient.multiplayer);
    this.spectatorHUD = new SpectatorHUD(viewport);
    this.playerRenderer = new PlayerRenderer(this.scene, (from, to, radius) => {
      const direction = { x: to.x - from.x, y: to.z - from.z, z: to.y - from.y };
      const distance = Math.hypot(direction.x, direction.y, direction.z);
      if (!distance) return undefined;
      const hit = this.physics.raycast({ x: from.x, y: from.z, z: from.y }, {
        x: direction.x / distance, y: direction.y / distance, z: direction.z / distance,
      }, distance, radius, true);
      return hit ? { position: { x: hit.position.x, y: hit.position.z, z: hit.position.y },
        normal: { x: hit.normal.x, y: hit.normal.z, z: hit.normal.y } } : undefined;
    }, (milliseconds) => this.frameProfiler.record("playerGeometry", milliseconds), () => this.frameProfiler.enabled);
    this.ctfRenderer = new CtfRenderer(this.scene);
    this.physicsInput.enabled = runtimeMode === "game";
    this.weaponInput.enabled = runtimeMode === "game";
    this.weaponHUD.setVisible(runtimeMode === "game");
    this.crosshairHUD.setVisible(runtimeMode === "game");
    this.weaponRenderer = new WeaponRenderer(this.scene, this.weapons.events, this.playerCamera, this.weapons.controller);
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
      this.gameAudio.update(this.physics.player.position, this.physics.player.yaw);
      const gameLogicFinishedAt = performance.now();
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
                mapModels: MapModelAsset[] = [], teleporter?: MapModelAsset, mapSounds: MapSoundAsset[] = []): Promise<SceneStats> {
    const generation = ++this.loadGeneration;
    this.currentMap = map;
    const lighting = resolveMapLighting(map, lightingOverrides);
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    this.mapModelResources?.dispose();
    this.mapModelResources = undefined;
    this.volumeMeshes.length = 0;
    this.volumeMaterials.forEach((material) => material.dispose(true, true));
    this.volumeMaterials.clear();
    this.entityMeshes.length = 0;
    this.entityMaterials.forEach((material) => material.dispose());
    this.entityMaterials.clear();
    this.mapModelMeshes.length = 0;
    this.waypointMeshes.length = 0;
    this.entityModelAnimations.length = 0;
    this.materialCache.dispose();
    this.materialCache = new MaterialCache(this.scene, map.lightmaps, lighting.ambient);
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
    const materialBatches = generateMaterialGeometry(map);
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
      () => generation === this.loadGeneration, teleporter);
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
    this.mapModelResources = loadedMapModels.resources;
    this.physics.setMapModels(loadedMapModels.collisions);
    this.mapModelMeshes.push(...loadedMapModels.meshes);
    this.entityModelAnimations.push(...loadedMapModels.animations);
    triangles += loadedMapModels.triangles;
    vertices += loadedMapModels.vertices;
    this.materialCache.setWireframe(this.wireframe);
    const fog = resolveMapFog(map, fogOverrides);
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

  setCameraMode(mode: CameraMode): void {
    if (this.runtimeMode === "game" && mode !== "player") return;
    if (mode === this.cameraMode) return;
    this.cameraMode = mode;
    const playerMode = mode === "player";
    this.physicsInput.enabled = playerMode;
    this.weaponInput.enabled = playerMode;
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
    this.fpsClient.multiplayer.gameMode = mode;
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
    this.crosshairHUD.dispose();
    this.multiplayerHUD.dispose();
    this.spectatorHUD.dispose();
    this.canvas.removeEventListener("pointerdown", this.onSpectatorPointerDown, { capture: true });
    this.canvas.removeEventListener("contextmenu", this.onSpectatorContextMenu);
    window.removeEventListener("keydown", this.onSpectatorKeyDown, { capture: true });
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    if (document.pointerLockElement === this.canvas) void document.exitPointerLock();
    this.engine.stopRenderLoop();
    this.performanceOverlay.dispose();
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.particleRenderer.clear();
    this.weaponRenderer.clear();
    this.gameAudio.dispose();
    this.mapModelResources?.dispose();
    this.mapModelResources = undefined;
    this.engine.dispose();
  }

  onMultiplayer(listener: (event: MultiplayerEvent) => void): () => void {
    const wrapped = (event: Event): void => listener((event as CustomEvent<MultiplayerEvent>).detail);
    this.fpsClient.multiplayer.addEventListener("multiplayer", wrapped);
    return () => this.fpsClient.multiplayer.removeEventListener("multiplayer", wrapped);
  }

  sendChat(text: string, team = false): void {
    this.fpsClient.multiplayer.sendChat(text, team);
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
    mesh.material = this.getMaterialVolumeMaterial(batch.kind);
    mesh.metadata = { debugOnly: batch.debugOnly, materialKind: batch.kind };
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    mesh.freezeWorldMatrix();
    return mesh;
  }

  private getMaterialVolumeMaterial(kind: MaterialRenderKind): StandardMaterial {
    const cached = this.volumeMaterials.get(kind);
    if (cached) return cached;
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
    material.alpha = kind === "lava" ? 1 : kind === "water" ? 0.52 : kind === "glass" ? 0.3 : 0.24;
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
    this.volumeMaterials.set(kind, material);
    return material;
  }

  private createFallbackMaterial(): StandardMaterial {
    if (this.fallbackMaterial) return this.fallbackMaterial;
    const material = new StandardMaterial("missing-map-material", this.scene);
    material.diffuseColor = new Color3(0.7, 0.2, 0.7);
    material.emissiveColor = Color3.White();
    material.disableLighting = true;
    material.wireframe = this.wireframe;
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
    this.scene.fogEnabled = true;
    this.scene.fogMode = Scene.FOGMODE_LINEAR;
    this.scene.fogStart = fog.start;
    this.scene.fogEnd = fog.distance;
    this.scene.fogColor = new Color3(...fog.color);
    this.scene.clearColor = new Color4(...fog.color, 1);
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
    if (this.runtimeMode === "game") this.weapons.controller.spawnForGameMode(this.localGameMode, performance.now());
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
    animateEntityModels(this.entityModelAnimations, nowMilliseconds);
    if (this.bots.waypoints.showWaypoints && nowMilliseconds - this.lastWaypointDebugUpdate >= 500) {
      this.lastWaypointDebugUpdate = nowMilliseconds;
      this.syncWaypointDebug(true);
    }
    if (this.cameraMode !== "player") return;
    const dead = this.isLocalPlayerDead(), wasDead = this.localDeadAt > 0;
    if (dead && !wasDead) this.localDeadAt = nowMilliseconds;
    else if (!dead && wasDead) this.localDeadAt = 0;
    const input = this.physicsInput.sample();
    const followed = this.followedPlayer();
    let renderPosition: RegisteredMapEntity["position"];
    if (followed) {
      interpolateNetworkEntity(followed, nowMilliseconds);
      const player = this.physics.player;
      player.position = { ...followed.position };
      player.previousPosition = { ...followed.position };
      player.falling = { x: 0, y: 0, z: 0 };
      player.yaw = followed.yaw;
      player.pitch = followed.state === ClientState.Dead ? 0 : followed.pitch;
      player.roll = followed.roll;
      player.move = player.strafe = 0;
      player.physicsState = PhysicsState.Float;
      renderPosition = player.position;
    } else renderPosition = this.frameProfiler.measure("playerPhysics", () => this.physics.update(nowMilliseconds, input));
    this.updatePlayerCamera(renderPosition);
    const aimTarget = this.frameProfiler.measure("weaponSimulation", () => this.aimTarget());
    this.frameProfiler.measure("hud", () => this.crosshairHUD.update(this.aimingAtTeammate(aimTarget)));
    this.weaponRenderer.setViewedGun(followed?.selectedGun, followed?.lastAction, followed?.gunWait);
    if (followed) this.frameProfiler.measure("hud", () =>
      this.weaponHUD.render({ health: followed.health, selectedGun: followed.selectedGun, ammo: followed.ammo }));
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
          if (bot.ownerNumber < 0 && player) bot.flags = player.flags;
        }
      }
    });
    this.frameProfiler.measure("hud", () => this.multiplayerHUD.render());
    this.updateNetworkPlayers();
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
    const team = ctfTeamFlag(player?.team ?? "");
    const allStarts = this.currentMap?.entities.filter((entity) => entity.type === 3) ?? [];
    const teamStarts = team ? allStarts.filter((entity) => (entity.attributes[1] ?? 0) === team) : [];
    const starts = teamStarts.length ? teamStarts : allStarts;
    const start = starts[Math.floor(Math.random() * starts.length)];
    if (start) {
      this.physics.spawn({ ...start.position, z: start.position.z + this.physics.player.eyeHeight }, start.attributes[0] ?? 0,
        performance.now());
    }
    else this.physics.reset(performance.now());
    this.weaponHUD.render();
  }

  private updateNetworkPlayers(): void {
    const multiplayer = this.fpsClient.multiplayer;
    const nowMilliseconds = performance.now();
    const followed = this.followedPlayer();
    const thirdPersonView = this.thirdperson || this.isLocalPlayerDead() || followed?.state === ClientState.Dead;
    const players: RenderPlayer[] = [];
    const localNetworkPlayer = multiplayer.players.get(multiplayer.clientNumber);
    for (const [clientNumber, player] of multiplayer.players) {
      const ownedBot = this.bots.bots.get(clientNumber);
      if (ownedBot?.ownerNumber === multiplayer.clientNumber) continue;
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
        visible: player.state !== ClientState.Spectator && player.state !== ClientState.Spawning,
        position: { ...source.position, z: source.position.z - source.eyeHeight },
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
        velocityZ: source.velocity.z + (local ? this.physics.player.falling.z : 0),
        velocity: {
          x: source.velocity.x + (local ? this.physics.player.falling.x : 0),
          y: source.velocity.y + (local ? this.physics.player.falling.y : 0),
          z: source.velocity.z + (local ? this.physics.player.falling.z : 0),
        },
        lastPain: player.lastPain,
        deadAt: player.deadAt || this.localDeadAt,
      });
    }
    for (const bot of this.bots.bots.values()) {
      if (!this.renderDiagnostics.bots) continue;
      if (multiplayer.players.has(bot.clientNumber) && bot.ownerNumber !== multiplayer.clientNumber) continue;
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
        position: { ...player.position, z: player.position.z - player.eyeHeight },
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
  private ctfAiObjective(bot: BotActor, interests: AiInterest[]): boolean {
    const multiplayer = this.fpsClient.multiplayer;
    if (!multiplayer.isLocalGame || !gameModeHas(multiplayer.gameMode, GameModeFlag.Ctf) ||
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
    this.weaponHUD.setVisible(this.runtimeMode === "game" && !dead && (!spectator || Boolean(followed)));
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
