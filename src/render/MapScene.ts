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
import type { MapFogOverrides, MapLightingOverrides, MapModelAsset, MapSkyOverrides, ResolvedTexture } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import { generateGeometry, type GeometryBatch } from "../engine/renderva";
import { generateMaterialGeometry, type MaterialGeometryBatch, type MaterialRenderKind } from "./materialGeometry";
import { describeSauerMaterial, MaterialCache } from "./MaterialCache";
import { toBabylonDirection, toBabylonPosition, toBabylonYawDirection } from "./coordinates";
import { resolveMapLighting } from "./MapLighting";
import { loadMapModels } from "./MapModelLoader";
import { resolveMapSky, skyFaceCandidates, skyTextureRotationRadians, type MapSky } from "./MapSky";
import { createFogDomeGeometry, resolveMapFog, type MapFog } from "./MapFog";
import { installSauerFogDistance } from "./SauerFogShader";
import { BrowserPhysicsInput } from "../platform/browser/PhysicsInput";
import { PhysicsSimulation, type PhysicsDebugSnapshot } from "../engine/physics";
import { createClient, type MultiplayerEvent, type ServerEndpoint } from "../fpsgame/client";
import { BrowserWeaponInput } from "../platform/browser/WeaponInput";
import { WeaponHUD } from "../platform/browser/WeaponHUD";
import { WeaponRenderer } from "../platform/browser/WeaponRenderer";
import { WeaponAudio } from "../platform/browser/WeaponAudio";
import { ParticleRenderer } from "./ParticleRenderer";
import { MultiplayerHUD } from "../platform/browser/MultiplayerHUD";
import { PlayerRenderer, thirdpersoncamera, type RenderPlayer } from "../platform/browser/PlayerRenderer";
import { CtfRenderer } from "../platform/browser/CtfRenderer";
import { ClientState } from "../engine/physics/types";
import { ctfTeamFlag } from "../fpsgame/ctf";
import type { RuntimeMode } from "../runtime";

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
  private readonly weaponInput: BrowserWeaponInput;
  private readonly weaponHUD: WeaponHUD;
  private readonly weaponRenderer: WeaponRenderer;
  private readonly particleRenderer: ParticleRenderer;
  private readonly multiplayerHUD: MultiplayerHUD;
  private readonly playerRenderer: PlayerRenderer;
  private readonly ctfRenderer: CtfRenderer;
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
  private currentMap?: SauerMap;
  private viewportTuning: ViewportTuning = { contrast: 1, gamma: 1, vibrance: 1 };
  private debugLoadout = false;
  private playerModel = 0;
  private localGameMode = 0;
  private localDeadAt = 0;
  private readonly resizeObserver: ResizeObserver;

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
    this.weaponHUD = new WeaponHUD(viewport, this.weapons.controller, this.weapons.events);
    this.multiplayerHUD = new MultiplayerHUD(viewport, this.fpsClient.multiplayer);
    this.playerRenderer = new PlayerRenderer(this.scene);
    this.ctfRenderer = new CtfRenderer(this.scene);
    this.physicsInput.enabled = runtimeMode === "game";
    this.weaponInput.enabled = runtimeMode === "game";
    this.weaponHUD.setVisible(runtimeMode === "game");
    this.particleRenderer = new ParticleRenderer(this.scene, this.weapons.events, this.playerCamera);
    this.weaponRenderer = new WeaponRenderer(this.scene, this.weapons.events, this.playerCamera, this.weapons.controller);
    this.weaponRenderer.setHudGunVisible(this.cameraMode === "player" && !this.thirdperson);
    new WeaponAudio(this.weapons.events);
    this.fpsClient.multiplayer.addEventListener("multiplayer", (event) =>
      this.handleMultiplayerEvent((event as CustomEvent<MultiplayerEvent>).detail));

    this.engine.runRenderLoop(() => {
      this.updatePhysics(performance.now());
      this.scene.render();
    });
    window.addEventListener("resize", this.resize);
    this.resizeObserver = new ResizeObserver(this.resize);
    this.resizeObserver.observe(canvas);
  }

  async loadMap(map: SauerMap, textures: ResolvedTexture[], skyOverrides?: MapSkyOverrides,
                lightingOverrides?: MapLightingOverrides, fogOverrides?: MapFogOverrides,
                mapModels: MapModelAsset[] = []): Promise<SceneStats> {
    const generation = ++this.loadGeneration;
    this.currentMap = map;
    const lighting = resolveMapLighting(map, lightingOverrides);
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    this.volumeMeshes.length = 0;
    this.volumeMaterials.forEach((material) => material.dispose(true, true));
    this.volumeMaterials.clear();
    this.entityMeshes.length = 0;
    this.entityMaterials.forEach((material) => material.dispose());
    this.entityMaterials.clear();
    this.mapModelMeshes.length = 0;
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
    map.entityRegistry.forEach((entity) => this.createEntityMarker(entity));
    this.particleRenderer.loadMap(map.entityRegistry);
    const loadedMapModels = await loadMapModels(this.scene, map.entityRegistry, mapModels, this.wireframe,
      () => generation === this.loadGeneration);
    this.physics.setMapModels(loadedMapModels.collisions);
    this.mapModelMeshes.push(...loadedMapModels.meshes);
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
    this.entityDebug = enabled;
    this.entityMeshes.forEach((mesh) => mesh.setEnabled(enabled));
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

  setLocalGameMode(mode: number): void {
    if (this.runtimeMode !== "game") return;
    this.localGameMode = mode;
    this.fpsClient.multiplayer.gameMode = mode;
    this.weapons.controller.spawnForGameMode(mode, performance.now());
    this.weaponHUD.render();
  }

  dispose(): void {
    this.fpsClient.multiplayer.disconnect();
    this.physicsInput.dispose();
    this.weaponInput.dispose();
    this.multiplayerHUD.dispose();
    this.resizeObserver.disconnect();
    window.removeEventListener("resize", this.resize);
    if (document.pointerLockElement === this.canvas) void document.exitPointerLock();
    this.engine.stopRenderLoop();
    this.playerRenderer.clear();
    this.ctfRenderer.clear();
    this.particleRenderer.clear();
    this.weaponRenderer.clear();
    this.engine.dispose();
  }

  onMultiplayer(listener: (event: MultiplayerEvent) => void): () => void {
    const wrapped = (event: Event): void => listener((event as CustomEvent<MultiplayerEvent>).detail);
    this.fpsClient.multiplayer.addEventListener("multiplayer", wrapped);
    return () => this.fpsClient.multiplayer.removeEventListener("multiplayer", wrapped);
  }

  sendChat(text: string): void {
    this.fpsClient.multiplayer.sendChat(text);
  }

  switchTeam(): void {
    this.fpsClient.multiplayer.switchTeam();
  }

  tryDropFlag(): void {
    this.fpsClient.multiplayer.tryDropFlag();
  }

  isLocalPlayerDead(): boolean {
    return this.fpsClient.multiplayer.clientNumber >= 0 && !this.physics.player.alive;
  }

  requestRespawn(): boolean {
    return this.fpsClient.multiplayer.requestRespawn();
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
    marker.setEnabled(this.entityDebug);
    this.entityMeshes.push(marker);
    const direction = entity.orientation?.direction
      ? toBabylonDirection(entity.orientation.direction)
      : entity.orientation?.yawDegrees === undefined ? undefined : toBabylonYawDirection(entity.orientation.yawDegrees);
    if (!direction) return;
    const line = MeshBuilder.CreateLines(`entity-${entity.index}-orientation`, { points: [position, position.add(direction.scale(7))] }, this.scene);
    line.color = this.entityColor(entity.category);
    line.isPickable = false;
    line.setEnabled(this.entityDebug);
    this.entityMeshes.push(line);
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
    if (this.cameraMode !== "player") return;
    const wasDead = this.localDeadAt > 0;
    if (!this.physics.player.alive && !wasDead) this.localDeadAt = nowMilliseconds;
    else if (this.physics.player.alive && wasDead) this.localDeadAt = 0;
    const renderPosition = this.physics.update(nowMilliseconds, this.physicsInput.sample());
    const yaw = this.physics.player.yaw * Math.PI / 180;
    const pitch = this.physics.player.pitch * Math.PI / 180;
    this.weapons.update(nowMilliseconds, {
      x: this.physics.player.position.x - Math.sin(yaw) * Math.cos(pitch) * 2048,
      y: this.physics.player.position.y + Math.cos(yaw) * Math.cos(pitch) * 2048,
      z: this.physics.player.position.z + Math.sin(pitch) * 2048,
    });
    this.fpsClient.multiplayer.update(nowMilliseconds);
    this.multiplayerHUD.render();
    this.updateNetworkPlayers();
    this.updatePlayerCamera(renderPosition);
  }

  private handleMultiplayerEvent(event: MultiplayerEvent): void {
    if (event.type === "spawn") {
      this.spawnNetworkPlayer();
      this.syncDeathView();
    } else if (event.type === "players") this.syncDeathView();
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
    const thirdPersonView = this.thirdperson || this.isLocalPlayerDead();
    const players: RenderPlayer[] = [];
    const localNetworkPlayer = multiplayer.players.get(multiplayer.clientNumber);
    for (const [clientNumber, player] of multiplayer.players) {
      const local = clientNumber === multiplayer.clientNumber;
      if (local && !thirdPersonView) continue;
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
        state: local ? this.physics.player.clientState : player.state,
        move: source.move,
        strafe: source.strafe,
        physicsState: source.physicsState,
        inWater: local ? this.physics.player.inWater : 0,
        timeInAir: local ? this.physics.player.timeInAir : undefined,
        velocityZ: source.velocity.z + (local ? this.physics.player.falling.z : 0),
        lastPain: player.lastPain,
        deadAt: player.deadAt || this.localDeadAt,
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
        state: player.clientState,
        move: player.move,
        strafe: player.strafe,
        physicsState: player.physicsState,
        inWater: player.inWater,
        timeInAir: player.timeInAir,
        velocityZ: player.velocity.z + player.falling.z,
        deadAt: this.localDeadAt,
      });
    }
    this.playerRenderer.rendergame(players, multiplayer.gameMode, this.teamskins, localNetworkPlayer?.team ?? "", performance.now());
    this.ctfRenderer.render(multiplayer.ctfMode.flags, multiplayer.players, multiplayer.clientNumber, localNetworkPlayer?.team ?? "",
      this.physics.player.position, this.physics.player.aboveEye, this.physics.player.yaw, multiplayer.gameMode,
      (clientNumber) => this.playerRenderer.flagAttachmentPosition(clientNumber));
  }

  private updatePlayerCamera(position: RegisteredMapEntity["position"]): void {
    const yaw = this.physics.player.yaw * Math.PI / 180;
    const pitch = this.physics.player.pitch * Math.PI / 180;
    let cameraPosition = toBabylonPosition(position);
    if (this.thirdperson || this.isLocalPlayerDead()) {
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
    const direction = toBabylonDirection({
      x: -Math.sin(yaw) * Math.cos(pitch),
      y: Math.cos(yaw) * Math.cos(pitch),
      z: Math.sin(pitch),
    });
    this.playerCamera.setTarget(this.playerCamera.position.add(direction));
  }

  private readonly resize = (): void => this.engine.resize();

  private syncDeathView(): void {
    const dead = this.isLocalPlayerDead();
    this.weaponHUD.setVisible(this.runtimeMode === "game" && !dead);
    this.weaponRenderer.setHudGunVisible(this.cameraMode === "player" && !this.thirdperson && !dead);
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
