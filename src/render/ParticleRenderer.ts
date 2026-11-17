import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import "@babylonjs/core/Culling/ray";
import { Constants } from "@babylonjs/core/Engines/constants";
import { ShaderStore } from "@babylonjs/core/Engines/shaderStore";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { RawTexture } from "@babylonjs/core/Materials/Textures/rawTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Space } from "@babylonjs/core/Maths/math.axis";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { InstancedMesh } from "@babylonjs/core/Meshes/instancedMesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Particle } from "@babylonjs/core/Particles/particle";
import { CustomParticleEmitter } from "@babylonjs/core/Particles/EmitterTypes/customParticleEmitter";
import { GPUParticleSystem } from "@babylonjs/core/Particles/gpuParticleSystem";
import "@babylonjs/core/Particles/webgl2ParticleSystem";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";
import "@babylonjs/core/Shaders/particles.fragment";
import "@babylonjs/core/Shaders/particles.vertex";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { MapModelAsset } from "../assets/types";
import type { RegisteredMapEntity, Vec3 } from "../engine/octa";
import { parseIqm, parseMd2, parseMd3, parseMd5, parseObj, type ModelGeometry } from "../engine/rendermodel";
import { Gun } from "../fpsgame/weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "../fpsgame/weapon/WeaponEvents";
import { projectileRenderPose, projectileVisualPosition } from "../fpsgame/weapon/ProjectileSystem";
import { GameModeFlag, gameModeHas } from "../fpsgame/game";
import { toBabylonDirection, toBabylonPosition } from "./coordinates";
import { DECAL_QUALITY_SETTINGS, loadDecalQuality, type DecalQuality } from "./DecalSettings";
import { DEFAULT_ENGINE_SETTINGS, PARTICLE_CAPACITY_LIMITS, type EngineSettings, type ParticleBackend } from "./EngineSettings";
import { selectModelSkin } from "./modelSkin";

type ParticleTexture = "ball1.png" | "ball2.png" | "ball3.png" | "base.png" | "explosion.png" | "flames.png" | "flare.jpg" |
  "lensflares.png" | "lightning.jpg" | "muzzleflash1.jpg" | "muzzleflash2.jpg" | "muzzleflash3.jpg" | "plasma.png" | "smoke.png" |
  "snow.png" | "spark.png" | "steam.png" | "blood.png" | "bullet.png" | "scorch.png";

interface SpriteEffect {
  mesh: Mesh;
  started: number;
  duration: number;
  startScale: number;
  endScale: number;
  reusableMesh?: "sprite" | "beam" | "fireball-red" | "fireball-blue";
  light?: PointLight;
  track?: () => Vec3 | undefined;
  update?: (progress: number) => void;
  fadeMesh?: boolean;
  fadeStart?: number;
}

export interface DecalSurface {
  position: Vec3;
  normal: Vec3;
}

interface PooledParticleSystem {
  system: CosmeticParticleSystem;
  capacity: number;
  tiled: boolean;
  backend: ResolvedParticleBackend;
  recipe: string;
  batchData?: { update: RawTexture; render: RawTexture };
}

type CosmeticParticleSystem = ParticleSystem | GPUParticleSystem;
type ResolvedParticleBackend = Exclude<ParticleBackend, "auto">;
type CosmeticParticleRender = (preWarm?: boolean, forceUpdateOnly?: boolean) => number;

export interface ParticleRenderStats {
  readonly backend: "GPU" | "CPU";
  readonly activeEmitters: number;
  readonly capacity: number;
  readonly estimatedActiveParticles?: number;
  readonly drawCalls?: number;
  readonly gpuBatches: number;
  readonly gpuSimulationDraws: number;
  readonly gpuRenderingDraws: number;
  readonly cpuParticleDraws: number;
  readonly cpuUpdateTime: number;
  readonly gpuTime?: number;
}

interface ProjectileEffect {
  gun: Gun;
  position: Vec3;
  destination: Vec3;
  direction: Vec3;
  offset: Vec3;
  offsetMillis: number;
  meshes: InstancedMesh[];
  light?: PointLight;
}

interface ExplosionMeshMetadata {
  center: Vector3;
  color: Color3;
  fade: number;
}

export interface CombatPrewarmReport {
  variants: string[];
  materials: number;
  pooledMeshes: number;
}

interface BouncerEffect {
  meshes: InstancedMesh[];
  position: Vec3;
  rotation: Quaternion;
  modelIndex: number;
  yaw: number;
  roll: number;
  fade: number;
  smoke: boolean;
  dirty: boolean;
}

interface ParticleOptions {
  texture: ParticleTexture;
  color: number;
  size: number;
  minSize?: number;
  maxSize?: number;
  endSize?: number;
  fadeMinMs: number;
  fadeMaxMs: number;
  rate?: number;
  count?: number;
  radius?: number;
  direction?: Vector3;
  spread?: number;
  speed?: number;
  minSpeed?: number;
  maxSpeed?: number;
  velocityRadius?: number;
  velocityBox?: number;
  gravity?: number;
  additive?: boolean;
  startPosition?: () => Vector3;
  fadeAtIndex?: (index: number) => number;
  forceCpu?: boolean;
  emitBoxMin?: Vector3;
  emitBoxMax?: Vector3;
}

interface SauerParticleState {
  origin: Vector3;
  velocity: Vector3;
  gravity: number;
  fadeMs: number;
  ageMs: number;
}

interface MapParticleEmitter {
  name: string;
  position: Vec3;
  options: ParticleOptions;
}

const SAUER_EMIT_MILLIS = 17;
const MAX_POOLED_PARTICLE_SYSTEMS = 16;
const MAX_POOLED_SPRITES = 64;
const MAX_POOLED_BEAMS = 128;
const MAX_POOLED_FIREBALLS = 12;
const PARTICLE_LAYER_MASK = 0x0fffffff;

const EXPLOSION_VERTEX_SHADER = `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  uniform mat4 worldViewProjection;
  uniform vec3 center;
  uniform vec3 cameraRight;
  uniform vec3 cameraUp;
  uniform float millis;
  varying vec2 texcoord0;
  varying vec2 texcoord1;
  varying vec2 texcoord2;

  vec3 rotateAroundAxis(vec3 value, vec3 axis, float angle) {
    float sine = sin(angle);
    float cosine = cos(angle);
    return value * cosine + cross(axis, value) * sine + axis * dot(axis, value) * (1.0 - cosine);
  }

  void main(void) {
    vec3 unitPosition = normalize(position);
    float wobble = 1.0 + 0.5 * abs(fract(dot(unitPosition, center) + millis * 2.0) - 0.5);
    float angle = radians(143.0) * millis;
    vec3 axis = normalize(vec3(1.0));
    vec3 rotatedPosition = rotateAroundAxis(position * wobble, axis, angle);
    vec3 rotatedDirection = rotateAroundAxis(unitPosition, axis, angle);
    gl_Position = worldViewProjection * vec4(rotatedPosition, 1.0);

    vec2 projected = vec2(dot(cameraRight, rotatedDirection), dot(cameraUp, rotatedDirection));
    texcoord0 = uv;
    texcoord1 = projected;
    texcoord2 = projected * 0.5 - millis * 0.5;
  }
`;

const EXPLOSION_FRAGMENT_SHADER = `
  precision highp float;
  uniform sampler2D explosionSampler;
  uniform vec3 color;
  uniform float fade;
  varying vec2 texcoord0;
  varying vec2 texcoord1;
  varying vec2 texcoord2;

  void main(void) {
    vec2 distorted = texcoord0 + texture2D(explosionSampler, texcoord2).xy * 0.1;
    vec4 diffuse = texture2D(explosionSampler, distorted);
    float edge = pow(clamp(1.0 - dot(texcoord1, texcoord1), 0.0, 1.0), 4.0);
    diffuse *= edge * 4.0;
    diffuse.b += 0.5 - edge * 0.5;
    gl_FragColor = vec4(diffuse.rgb * color, diffuse.a * fade);
  }
`;

const BULLET_DECAL_VERTEX_SHADER = `
  precision highp float;
  attribute vec3 position;
  attribute vec2 uv;
  uniform mat4 worldViewProjection;
  varying vec2 texcoord;

  void main(void) {
    gl_Position = worldViewProjection * vec4(position, 1.0);
    texcoord = uv;
  }
`;

const BULLET_DECAL_FRAGMENT_SHADER = `
  precision highp float;
  uniform sampler2D decalSampler;
  uniform float opacity;
  varying vec2 texcoord;

  void main(void) {
    vec3 decal = texture2D(decalSampler, texcoord).rgb;
    gl_FragColor = vec4(mix(vec3(0.5), decal, opacity), 1.0);
  }
`;

/** Babylon presentation of Sauerbraten's renderparticles.cpp particle recipes. */
export class ParticleRenderer {
  private readonly systems = new Set<CosmeticParticleSystem>();
  private readonly systemRecipes = new Map<CosmeticParticleSystem, string>();
  private readonly systemExpiresAt = new Map<CosmeticParticleSystem, number>();
  private readonly systemEmitterCounts = new Map<CosmeticParticleSystem, number>();
  private readonly pendingMapEmitters: MapParticleEmitter[] = [];
  private readonly originalSystemRender = new Map<CosmeticParticleSystem, CosmeticParticleRender>();
  private readonly systemPool: PooledParticleSystem[] = [];
  private readonly systemBatchData = new Map<CosmeticParticleSystem, { update: RawTexture; render: RawTexture }>();
  private readonly spritePool: Mesh[] = [];
  private readonly beamPool: Mesh[] = [];
  private readonly fireballPools: [Mesh[], Mesh[]] = [[], []];
  private readonly textures = new Map<string, Texture>();
  private readonly batchDataTextures = new Set<RawTexture>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly persistentMeshes = new Set<Mesh>();
  private readonly effects: SpriteEffect[] = [];
  private readonly decals: SpriteEffect[] = [];
  private readonly projectiles = new Map<string, ProjectileEffect>();
  private readonly bouncers = new Map<string, BouncerEffect>();
  private readonly bouncerMeshPools = new Map<number, InstancedMesh[][]>();
  private bouncerTemplates?: Promise<Map<number, Mesh[]>>;
  private bulletMaterial?: ShaderMaterial;
  private readonly fireballMaterials: Array<ShaderMaterial | undefined> = [undefined, undefined];
  private fireballTemplate?: Mesh;
  private templateGeneration = 0;
  private renderingEnabled = true;
  private updateRegistered = false;
  private decalQuality = loadDecalQuality();
  private readonly particleBackend: ResolvedParticleBackend;
  private readonly particleCapacityLimit: number;
  private particleCpuUpdateTime = 0;
  private collectingMapEmitters = false;
  private profilingEnabled = false;
  private gpuSimulationDraws = 0;
  private gpuRenderingDraws = 0;
  private cpuParticleDraws = 0;

  constructor(private readonly scene: Scene, events: WeaponEvents, private readonly playerCamera: Camera,
              private readonly taggedMuzzle: (event: WeaponEvent) => Vec3 | undefined,
              private readonly resolveSurface?: (from: Vec3, to: Vec3) => DecalSurface | undefined,
              settings: Pick<EngineSettings, "particleBackend" | "particleQuality"> = DEFAULT_ENGINE_SETTINGS) {
    this.particleBackend = resolveParticleBackend(settings.particleBackend);
    this.particleCapacityLimit = PARTICLE_CAPACITY_LIMITS[settings.particleQuality];
    if (this.particleBackend === "gpu") enableBatchedCustomEmitterSimulation();
    events.on((event) => this.handleWeaponEvent(event));
  }

  getParticleStats(): ParticleRenderStats {
    let capacity = 0, active = 0, emitters = 0, gpuBatches = 0;
    this.systems.forEach((system) => {
      capacity += system.getCapacity();
      active += system.getActiveCount();
      emitters += this.systemEmitterCounts.get(system) ?? 1;
      if (system instanceof GPUParticleSystem) gpuBatches++;
    });
    return {
      backend: this.particleBackend === "gpu" ? "GPU" : "CPU",
      activeEmitters: emitters,
      capacity,
      estimatedActiveParticles: active,
      drawCalls: this.systems.size,
      gpuBatches,
      gpuSimulationDraws: this.gpuSimulationDraws,
      gpuRenderingDraws: this.gpuRenderingDraws,
      cpuParticleDraws: this.cpuParticleDraws,
      cpuUpdateTime: this.particleCpuUpdateTime,
    };
  }

  setProfilingEnabled(enabled: boolean): void {
    if (this.profilingEnabled === enabled) return;
    this.profilingEnabled = enabled;
    if (enabled) this.systems.forEach((system) => this.instrumentParticleSystem(system));
    else {
      this.originalSystemRender.forEach((render, system) => { system.render = render; });
      this.originalSystemRender.clear();
    }
  }

  private instrumentParticleSystem(system: CosmeticParticleSystem): void {
    if (!this.profilingEnabled || this.originalSystemRender.has(system)) return;
    const render = system.render.bind(system) as CosmeticParticleRender;
    this.originalSystemRender.set(system, render);
    system.render = ((preWarm?: boolean, forceUpdateOnly?: boolean): number => {
      const before = this.scene.getEngine()._drawCalls.current;
      const rendered = render(preWarm, forceUpdateOnly);
      const draws = Math.max(0, this.scene.getEngine()._drawCalls.current - before);
      if (system instanceof GPUParticleSystem) {
        if (draws > 0) this.gpuSimulationDraws++;
        this.gpuRenderingDraws += Math.max(0, draws - 1);
      } else this.cpuParticleDraws += draws;
      return rendered;
    }) as typeof system.render;
  }

  loadMap(entities: readonly RegisteredMapEntity[]): void {
    this.clear();
    this.collectingMapEmitters = this.particleBackend === "gpu";
    entities.filter((entity) => entity.typeName === "particles").forEach((entity) => this.createMapEmitter(entity));
    this.collectingMapEmitters = false;
    this.flushMapEmitterBatches();
    if (!this.updateRegistered) {
      this.scene.onBeforeRenderObservable.add(() => this.update());
      this.updateRegistered = true;
    }
  }

  setRenderingEnabled(enabled: boolean): void {
    this.renderingEnabled = enabled;
    this.systems.forEach((system) => { system.layerMask = enabled ? PARTICLE_LAYER_MASK : 0; });
    this.systemPool.forEach(({ system }) => { system.layerMask = enabled ? PARTICLE_LAYER_MASK : 0; });
    this.persistentMeshes.forEach((mesh) => { mesh.isVisible = enabled; });
    this.effects.forEach((effect) => { effect.mesh.isVisible = enabled; });
    this.projectiles.forEach((projectile) => {
      projectile.meshes.forEach((mesh) => { mesh.isVisible = enabled; });
      projectile.light?.setEnabled(enabled);
    });
    this.bouncers.forEach((bouncer) => bouncer.meshes.forEach((mesh) => { mesh.isVisible = enabled; }));
  }

  setDecalQuality(quality: DecalQuality): void {
    this.decalQuality = quality;
    const maximum = DECAL_QUALITY_SETTINGS[quality].maximum;
    while (this.decals.length > maximum) this.removeDecal(this.decals[0]);
  }

  /** Prepares only combat variants reachable in the selected mode. All helper meshes remain disabled. */
  async prewarmCombatEffects(mode: number, multiplayer: boolean, mobile: boolean,
                             progress?: (fraction: number, detail: string) => void): Promise<CombatPrewarmReport> {
    const generation = this.templateGeneration;
    const guns = combatGunsForMode(mode, multiplayer);
    const variants = combatVariantNames(guns, this.decalQuality > 0);
    const compilationMesh = MeshBuilder.CreatePlane("combat-prewarm-plane", { size: 1 }, this.scene);
    compilationMesh.setEnabled(false);
    compilationMesh.isPickable = false;
    const materials = new Set<Material>();
    const compile = async (material: Material, mesh: Mesh, useInstances = false): Promise<void> => {
      materials.add(material);
      material.unfreeze();
      await material.forceCompilationAsync(mesh, { useInstances });
    };
    try {
      const spriteVariants = combatSpriteVariants(guns);
      for (let index = 0; index < spriteVariants.length; index++) {
        const variant = spriteVariants[index];
        const material = this.spriteMaterial(`prewarm-${variant.texture}`, variant.texture, variant.color, variant.additive);
        compilationMesh.material = material;
        await compile(material, compilationMesh);
        progress?.(0.05 + 0.3 * (index + 1) / Math.max(1, spriteVariants.length), variants[index] ?? variant.texture);
        await yieldForPrewarm();
      }
      if (this.decalQuality > 0 && guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Chaingun || gun === Gun.Rifle || gun === Gun.Pistol)) {
        const material = this.bulletDecalMaterial();
        compilationMesh.material = material;
        await compile(material, compilationMesh);
      }
      if (this.decalQuality > 0) {
        const decalVariants: Array<[ParticleTexture, number]> = [["blood.png", 0x60ffff]];
        if (guns.some((gun) => gun === Gun.Rocket || gun === Gun.Grenade)) decalVariants.push(["scorch.png", 0xffffff]);
        for (const [texture, color] of decalVariants) {
          const material = this.decalMaterial(texture, color);
          compilationMesh.material = material;
          await compile(material, compilationMesh);
        }
      }
      for (const blue of [false, true]) {
        if (!guns.includes(blue ? Gun.Grenade : Gun.Rocket)) continue;
        const material = this.fireballMaterial(blue);
        const mesh = this.explosionTemplate();
        mesh.material = material;
        await compile(material, mesh);
      }
      const particleTexture = this.particleTexture("spark.png");
      if (!particleTexture.isReady()) {
        await new Promise<void>((resolve) => particleTexture.onLoadObservable.addOnce(() => resolve()));
      }
      const particleCapacities = mobile ? [8, 32, 128, 256] : [8, 32, 128, 256, 512];
      for (const capacity of particleCapacities) {
        if (this.systemPool.some((entry) => entry.backend === this.particleBackend && !entry.tiled && entry.capacity === capacity)) continue;
        const system: CosmeticParticleSystem = this.particleBackend === "gpu"
          ? new GPUParticleSystem(`combat-particle-pooled-${capacity}`, { capacity, randomTextureSize: 256 }, this.scene)
          : new ParticleSystem(`combat-particle-pooled-${capacity}`, capacity, this.scene);
        system.particleTexture = particleTexture;
        system.layerMask = 0;
        system.isReady();
        system.stop();
        system.reset();
        this.systemPool.push({ system, capacity, tiled: false, backend: this.particleBackend, recipe: "prewarm" });
      }
      progress?.(0.45, "loading combat models...");
      const templates = await (this.bouncerTemplates ??= this.loadBouncerTemplates(generation));
      if (generation !== this.templateGeneration) return { variants: [], materials: 0, pooledMeshes: 0 };
      const modelCapacities = combatBouncerCapacities(guns, mobile);
      let pooledMeshes = 0, completedModels = 0;
      for (const [modelIndex, capacity] of modelCapacities) {
        const modelTemplates = templates.get(modelIndex) ?? [];
        for (const template of modelTemplates) {
          if (template.material) await compile(template.material, template, true);
        }
        const missing = Math.max(0, capacity - (this.bouncerMeshPools.get(modelIndex)?.length ?? 0));
        for (let index = 0; index < missing; index++) {
          const meshes = this.createBouncerMeshGroup(modelIndex, templates);
          pooledMeshes += meshes.length;
          this.releaseBouncerMeshes(modelIndex, meshes);
        }
        completedModels++;
        progress?.(0.45 + 0.45 * completedModels / Math.max(1, modelCapacities.length), `preparing ${bouncerVariantName(modelIndex)}...`);
        await yieldForPrewarm();
      }
      const spriteCapacity = mobile ? 12 : 32;
      while (this.spritePool.length < spriteCapacity) {
        const mesh = MeshBuilder.CreatePlane("particle-sprite-pooled", { size: 1 }, this.scene);
        mesh.setEnabled(false);
        mesh.isPickable = false;
        this.spritePool.push(mesh);
        pooledMeshes++;
      }
      materials.forEach((material) => material.freeze());
      progress?.(1, `${variants.length} combat variants ready`);
      return { variants, materials: materials.size, pooledMeshes };
    } finally {
      compilationMesh.dispose();
    }
  }

  // Original: src/fpsgame/entities.cpp, N_ITEMSPAWN and pickupeffects() particle_icon calls.
  itemIcon(position: Vec3, icon: number, grey: boolean): void {
    const mesh = MeshBuilder.CreatePlane(`particle-item-icon-${icon}`, { size: 4 }, this.scene);
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.isPickable = false;
    mesh.isVisible = this.renderingEnabled;
    const key = `item-icon:${icon}:${grey ? 1 : 0}`;
    let material = this.materials.get(key);
    if (!material) {
      material = new StandardMaterial(`particle-item-icon-${icon}-material`, this.scene);
      const texture = new Texture(packageAssetUrl("hud/items.png") ?? "", this.scene, false, false);
      texture.hasAlpha = true;
      texture.uScale = texture.vScale = 0.25;
      texture.uOffset = (icon % 4) * 0.25;
      texture.vOffset = Math.floor(icon / 4) * 0.25;
      material.diffuseTexture = texture;
      material.opacityTexture = texture;
      material.emissiveTexture = texture;
      material.diffuseColor = material.emissiveColor = grey ? new Color3(0.7, 0.7, 0.7) : Color3.White();
      material.disableLighting = true;
      material.backFaceCulling = false;
      material.useAlphaFromDiffuseTexture = true;
      material.transparencyMode = Material.MATERIAL_ALPHABLEND;
      this.materials.set(key, material);
      this.textures.set(`items-${icon}-${grey ? 1 : 0}`, texture);
    }
    mesh.material = material;
    this.effects.push({ mesh, started: performance.now(), duration: 2_000, startScale: 1, endScale: 1 });
  }

  // Original: src/fpsgame/capture.h, captureclientmode::updatebase().
  captureBaseEffect(position: Vec3, color: number): void {
    this.splash(position, "spark.png", color, 0.24, 200, 250, 150, 2, true);
  }

  clear(): void {
    this.systems.forEach((system) => system.dispose(false));
    this.systems.clear();
    this.systemRecipes.clear();
    this.systemExpiresAt.clear();
    this.systemEmitterCounts.clear();
    this.systemBatchData.clear();
    this.pendingMapEmitters.length = 0;
    this.originalSystemRender.clear();
    this.effects.forEach((effect) => this.disposeEffect(effect, false));
    this.effects.length = 0;
    this.decals.length = 0;
    this.bouncers.forEach((bouncer) => bouncer.meshes.forEach((mesh) => mesh.dispose()));
    this.bouncers.clear();
    this.bouncerMeshPools.forEach((pool) => pool.forEach((meshes) => meshes.forEach((mesh) => mesh.dispose())));
    this.bouncerMeshPools.clear();
    this.persistentMeshes.forEach((mesh) => this.disposeMesh(mesh));
    this.persistentMeshes.clear();
    this.projectiles.forEach((projectile) => {
      projectile.meshes.forEach((mesh) => mesh.dispose());
      projectile.light?.dispose();
    });
    this.projectiles.clear();
    this.bouncerTemplates = undefined;
    this.templateGeneration++;
    this.systemPool.forEach(({ system }) => system.dispose(false));
    this.systemPool.length = 0;
    this.spritePool.forEach((mesh) => mesh.dispose());
    this.spritePool.length = 0;
    this.beamPool.forEach((mesh) => mesh.dispose());
    this.beamPool.length = 0;
    this.fireballPools.forEach((pool) => pool.forEach((mesh) => mesh.dispose()));
    this.fireballPools.forEach((pool) => { pool.length = 0; });
    this.fireballTemplate?.dispose();
    this.fireballTemplate = undefined;
    this.materials.forEach((material) => material.dispose(false, false));
    this.materials.clear();
    this.bulletMaterial?.dispose(false, false);
    this.bulletMaterial = undefined;
    this.fireballMaterials.forEach((material, index) => {
      material?.dispose(false, false);
      this.fireballMaterials[index] = undefined;
    });
    this.textures.forEach((texture) => texture.dispose());
    this.textures.clear();
    this.batchDataTextures.forEach((texture) => texture.dispose());
    this.batchDataTextures.clear();
  }

  private createMapEmitter(entity: RegisteredMapEntity): void {
    const [type, value1, value2, value3, value4] = entity.attributes;
    const position = entity.position;
    switch (type) {
      case 0: {
        const radius = value1 ? value1 / 100 : 1.5;
        const height = value2 ? value2 / 100 : radius / 3;
        this.flame(position, radius, height, value3 ? sauerParticleColor(value3) : 0x903020, true);
        this.flame({ ...position, z: position.z + 4 * Math.min(radius, height) }, radius, height, 0x303020, false);
        break;
      }
      case 1:
        this.directionalEmitter(position, value1, "steam.png", 0x897661, 2.4, 1, 200, 50, -20);
        break;
      case 2:
        this.directionalEmitter(position, value1, "base.png", value2 > 0 ? sauerParticleColor(value2) : 0x406080, 0.6, 4, 200, 150, 2);
        break;
      case 3:
        this.persistentSprite(position, "explosion.png", sauerParticleColor(value2), Math.max(1, 5 + value1) * 2, true);
        break;
      case 4:
      case 7:
      case 9:
      case 10:
      case 13:
        this.shapedMapEffect(position, type, value1, value2, value3, value4);
        break;
      case 5:
      case 6:
        this.meter(position, Math.min(100, Math.max(0, value1)) / 100, sauerParticleColor(value2), sauerParticleColor(value3), type === 6);
        break;
      case 11:
        this.flame(position, value1 / 100, value2 / 100, sauerParticleColor(value3), true);
        break;
      case 12:
        this.flame(position, value1 / 100, value2 / 100, sauerParticleColor(value3), false);
        break;
      case 32:
      case 33:
      case 34:
      case 35:
        this.persistentSprite(position, "lensflares.png", (value1 << 16) | (value2 << 8) | value3, type >= 34 ? 12 : 7, true);
        break;
    }
  }

  private shapedMapEffect(position: Vec3, type: number, direction: number, length: number, colorAttribute: number, fade: number): void {
    const texture = type === 4 ? "flare.jpg" : type === 7 ? "lightning.jpg" : type === 9 ? "steam.png" :
      type === 10 ? "base.png" : "snow.png";
    const color = sauerParticleColor(colorAttribute);
    const size = type === 4 ? 0.28 : type === 7 ? 1 : type === 13 ? 0.5 : type === 9 ? 2.4 : 0.6;
    if (direction < 256) {
      const target = sauerParticleOffset(position, direction, Math.max(1 + length, 0));
      if (type === 4 || type === 7) this.beam(position, target, texture, color, size, Number.POSITIVE_INFINITY);
      else if (type === 10) {
        const trailEnd = { ...target, z: target.z - 0.5 };
        trailEnd.x = position.x - trailEnd.x / 75;
        trailEnd.y = position.y - trailEnd.y / 75;
        trailEnd.z = position.z - trailEnd.z / 75;
        this.beam(position, trailEnd, texture, color, size, Number.POSITIVE_INFINITY);
      } else this.persistentSprite(position, texture, color, sauerParticleDiameter(size), true);
      return;
    }
    const radius = Math.max(1 + length, 1);
    const directed = direction < 256 ? direction : direction - 256;
    if (type === 4 || type === 7) {
      for (let index = 0; index < 5; index++) {
        const target = shapedEndpoint(position, directed, radius, index / 5 * Math.PI * 2);
        this.beam(position, target, texture, color, size, Number.POSITIVE_INFINITY);
      }
      return;
    }
    this.particleSystem(`map-particles-${type}`, position, {
      texture, color, size, fadeMinMs: 1, fadeMaxMs: (fade > 0 ? Math.min(fade, 10_000) : 200) * 3,
      rate: 5 * 1000 / SAUER_EMIT_MILLIS,
      radius, direction: toBabylonDirection(sauerParticleOffset({ x: 0, y: 0, z: 0 }, directed, 1)), spread: 0.5,
      speed: 200, gravity: type === 13 ? 20 : type === 9 ? -20 : 2,
    });
  }

  private directionalEmitter(position: Vec3, direction: number, texture: ParticleTexture, color: number, size: number, count: number,
                             fadeMs: number, velocityRadius: number, gravity: number): void {
    const end = toBabylonPosition(sauerParticleOffset(position, direction, 9));
    const origin = toBabylonPosition(position);
    const center = Vector3.Center(origin, end);
    const halfExtent = end.subtract(origin).scale(0.5);
    halfExtent.set(Math.abs(halfExtent.x), Math.abs(halfExtent.y), Math.abs(halfExtent.z));
    this.particleSystem(`map-${texture}`, { x: center.x, y: center.z, z: center.y }, {
      texture, color, size, fadeMinMs: 1, fadeMaxMs: fadeMs * 3, rate: count * 1000 / SAUER_EMIT_MILLIS, velocityRadius, gravity,
      emitBoxMin: halfExtent.negate(), emitBoxMax: halfExtent,
    });
  }

  private flame(position: Vec3, radius: number, height: number, color: number, fire: boolean): void {
    const safeRadius = Math.max(0.01, radius);
    const safeHeight = Math.max(0.01, height);
    this.particleSystem(fire ? "map-flame" : "map-smoke", position, {
      texture: fire ? "flames.png" : "smoke.png", color, size: (fire ? 2 : 4) * Math.min(safeRadius, safeHeight),
      fadeMinMs: 1, fadeMaxMs: Math.max(1, Math.trunc((fire ? 600 : 2000) * safeHeight)),
      rate: (fire ? 3 : 1) * 1000 / SAUER_EMIT_MILLIS, radius: safeRadius, direction: new Vector3(0, 1, 0),
      speed: (fire ? 200 : 100) * Math.min(1, safeHeight), gravity: fire ? -15 : -20, additive: fire,
    });
  }

  private handleWeaponEvent(event: WeaponEvent): void {
    if (event.type === "shot" || event.type === "shot-effect") this.shot(event.gun, event.from, event.to, event.rays,
      () => this.taggedMuzzle(event));
    else if (event.type === "projectile-spawned") void this.spawnProjectile(event);
    else if (event.type === "projectile-moved") this.moveProjectile(event);
    else if (event.type === "projectile-removed") this.removeProjectile(event.key);
    else if (event.type === "bouncer-spawned") void this.spawnBouncer(event.key, event.bouncerType, event.variant, event.position);
    else if (event.type === "bouncer-moved") this.moveBouncer(event.key, event.position, event.yaw, event.roll, event.smoke, event.fade);
    else if (event.type === "bouncer-removed") this.removeBouncer(event.key);
    else if (event.type === "bouncer-impact") this.decal(event.position, event.normal, "blood.png", 0x60ffff,
      2.96 / event.bounces);
    else if (event.type === "explosion") this.explosion(event.gun, event.position, event.radius, event.normal);
    else if (event.type === "damage") this.splash(event.position, "blood.png", 0x60ffff, 2.96,
      Math.max(1, Math.trunc(event.amount / 10)), 1000, 150, 2);
  }

  // Original: src/fpsgame/weapon.cpp
  // Function: shoteffects()
  // Sauerbraten reference: SVN r6488
  private shot(gun: Gun, from: Vec3, to: Vec3, rays: Vec3[], taggedMuzzle?: () => Vec3 | undefined): void {
    const endpoints = rays.length ? rays : [to];
    const muzzle = taggedMuzzle?.() ?? this.muzzlePosition(from, to);
    if (gun === Gun.Shotgun) {
      endpoints.forEach((endpoint) => {
        this.beam(muzzle, endpoint, "flare.jpg", 0xffc864, 0.28, 300);
        this.bulletDecal(from, endpoint, 2);
      });
      this.sparks(endpoints, 20, 250);
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 2.75, 200, 30, taggedMuzzle);
    } else if (gun === Gun.Chaingun || gun === Gun.Pistol) {
      this.sparks(endpoints[0], 200, 250);
      this.beam(muzzle, endpoints[0], "flare.jpg", 0xffc864, 0.28, 600);
      this.bulletDecal(from, endpoints[0], 2);
      this.muzzleFlash(muzzle, "muzzleflash1.jpg", gun === Gun.Chaingun ? 2.25 : 1.25, gun === Gun.Chaingun ? 100 : 200,
        gun === Gun.Chaingun ? 30 : 15, taggedMuzzle);
    } else if (gun === Gun.Rifle) {
      this.sparks(endpoints[0], 200, 250);
      this.trail(muzzle, endpoints[0], "smoke.png", 0x404040, 0.6, 500, 20);
      this.bulletDecal(from, endpoints[0], 3);
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 1.25, 150, 25, taggedMuzzle);
    } else if (gun === Gun.Rocket) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 3, 250, 0, taggedMuzzle);
    else if (gun === Gun.Grenade) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 1.5, 200, 20, taggedMuzzle);
  }

  private async spawnProjectile(event: Extract<WeaponEvent, { type: "projectile-spawned" }>): Promise<void> {
    if (this.projectiles.has(event.key)) return;
    const { gun } = event;
    const projectile: ProjectileEffect = {
      gun, position: { ...event.position }, destination: { ...event.destination }, direction: { ...event.direction },
      offset: { ...event.offset }, offsetMillis: event.offsetMillis, meshes: [],
    };
    this.projectiles.set(event.key, projectile);
    if (gun === Gun.Rocket) {
      const templates = await (this.bouncerTemplates ??= this.loadBouncerTemplates(this.templateGeneration));
      if (this.projectiles.get(event.key) !== projectile) return;
      projectile.meshes = this.acquireBouncerMeshes(12, templates);
      projectile.meshes.forEach((mesh, index) => { mesh.name = `weapon-projectile-${event.key}-${index}`; });
      const light = new PointLight(`weapon-projectile-light-${event.key}`, Vector3.Zero(), this.scene);
      light.diffuse = new Color3(1, 0.75, 0.5);
      light.intensity = 1;
      light.range = 20;
      projectile.light = light;
      this.positionProjectile(projectile);
      return;
    }
    const texture = gun === Gun.Iceball ? "ball2.png" : gun === Gun.Slimeball ? "ball3.png" : "ball1.png";
    const color = gun === Gun.Iceball ? 0xffffff : gun === Gun.Slimeball ? 0xffffff : 0xffc8c8;
    this.positionProjectile(projectile);
    const visualPosition = projectileVisualPosition({ o: projectile.position, offset: projectile.offset,
      offsetmillis: projectile.offsetMillis });
    this.splash(visualPosition, texture, color, 4.8, 1, 1, 150, 20);
  }

  private moveProjectile(event: Extract<WeaponEvent, { type: "projectile-moved" }>): void {
    const projectile = this.projectiles.get(event.key);
    if (!projectile) return;
    projectile.position = { ...event.position };
    projectile.destination = { ...event.destination };
    projectile.direction = { ...event.direction };
    projectile.offset = { ...event.offset };
    projectile.offsetMillis = event.offsetMillis;
    this.positionProjectile(projectile);
    const visualPosition = projectileVisualPosition({ o: projectile.position, offset: projectile.offset,
      offsetmillis: projectile.offsetMillis });
    const magic = projectile.gun === Gun.Fireball || projectile.gun === Gun.Iceball || projectile.gun === Gun.Slimeball;
    this.splash(visualPosition, "smoke.png", 0x404040, magic ? 0.6 : 2.4, 2, 300, magic ? 150 : 50, -20);
    if (magic) {
      const texture = projectile.gun === Gun.Iceball ? "ball2.png" : projectile.gun === Gun.Slimeball ? "ball3.png" : "ball1.png";
      this.splash(visualPosition, texture, projectile.gun === Gun.Fireball ? 0xffc8c8 : 0xffffff, 4.8, 1, 1, 150, 20);
    }
  }

  private positionProjectile(projectile: ProjectileEffect): ReturnType<typeof projectileRenderPose> {
    const pose = projectileRenderPose({ o: projectile.position, to: projectile.destination, dir: projectile.direction,
      offset: projectile.offset, offsetmillis: projectile.offsetMillis });
    const rotation = Quaternion.RotationYawPitchRoll(-pose.yaw * Math.PI / 180, -pose.pitch * Math.PI / 180, 0);
    projectile.meshes.forEach((mesh) => {
      mesh.position.copyFrom(toBabylonPosition(projectile.gun === Gun.Rocket ? pose.modelPosition : pose.position));
      if (projectile.gun === Gun.Rocket) mesh.rotationQuaternion = rotation;
    });
    const lightPosition = projectileVisualPosition({ o: projectile.position, offset: projectile.offset,
      offsetmillis: projectile.offsetMillis });
    projectile.light?.position.copyFrom(toBabylonPosition(lightPosition));
    return pose;
  }

  private removeProjectile(key: string): void {
    const projectile = this.projectiles.get(key);
    if (!projectile) return;
    if (projectile.gun === Gun.Rocket) this.releaseBouncerMeshes(12, projectile.meshes);
    else projectile.meshes.forEach((mesh) => mesh.dispose());
    projectile.light?.dispose();
    this.projectiles.delete(key);
  }

  // Original: src/fpsgame/weapon.cpp renderbouncers()/preloadbouncers().
  private async spawnBouncer(key: string, type: number, variant: number, position: Vec3): Promise<void> {
    const modelIndex = type === 0 ? 0 : type === 1 ? 1 + variant : type === 2 ? 4 + variant : 8 + variant;
    if (this.bouncers.has(key)) return;
    const effect: BouncerEffect = {
      meshes: [], position: { ...position }, rotation: Quaternion.Identity(), modelIndex, yaw: 0, roll: 0, fade: 1,
      smoke: false, dirty: true,
    };
    this.bouncers.set(key, effect);
    const templates = await (this.bouncerTemplates ??= this.loadBouncerTemplates(this.templateGeneration));
    if (this.bouncers.get(key) !== effect) return;
    effect.meshes = this.acquireBouncerMeshes(modelIndex, templates);
    effect.meshes.forEach((mesh, index) => { mesh.name = `bouncer-${key}-${modelIndex}-${index}`; });
    effect.dirty = true;
  }

  private moveBouncer(key: string, position: Vec3, yaw: number, roll: number, smoke: boolean, fade: number): void {
    const bouncer = this.bouncers.get(key);
    if (!bouncer) return;
    bouncer.position.x = position.x;
    bouncer.position.y = position.y;
    bouncer.position.z = position.z;
    bouncer.yaw = yaw;
    bouncer.roll = roll;
    bouncer.fade = fade;
    bouncer.smoke ||= smoke;
    bouncer.dirty = true;
  }

  private removeBouncer(key: string): void {
    const bouncer = this.bouncers.get(key);
    if (bouncer) this.releaseBouncerMeshes(bouncer.modelIndex, bouncer.meshes);
    this.bouncers.delete(key);
  }

  private acquireBouncerMeshes(modelIndex: number, templates: Map<number, Mesh[]>): InstancedMesh[] {
    const pool = this.bouncerMeshPools.get(modelIndex);
    const meshes = pool?.pop() ?? this.createBouncerMeshGroup(modelIndex, templates);
    meshes.forEach((mesh) => {
      mesh.position.setAll(0);
      mesh.rotation.setAll(0);
      mesh.rotationQuaternion ??= Quaternion.Identity();
      mesh.rotationQuaternion.set(0, 0, 0, 1);
      mesh.scaling.setAll(1);
      mesh.instancedBuffers.color ??= new Color4(1, 1, 1, 1);
      mesh.instancedBuffers.color.set(1, 1, 1, 1);
      mesh.isVisible = this.renderingEnabled;
      mesh.isPickable = false;
      mesh.setEnabled(true);
    });
    return meshes;
  }

  private createBouncerMeshGroup(modelIndex: number, templates: Map<number, Mesh[]>): InstancedMesh[] {
    return (templates.get(modelIndex) ?? []).map((template, index) => {
      const mesh = template.createInstance(`bouncer-pooled-${modelIndex}-${index}`);
      mesh.isPickable = false;
      mesh.setEnabled(false);
      return mesh;
    });
  }

  private releaseBouncerMeshes(modelIndex: number, meshes: InstancedMesh[]): void {
    if (!meshes.length) return;
    meshes.forEach((mesh, index) => {
      mesh.name = `bouncer-pooled-${modelIndex}-${index}`;
      mesh.setEnabled(false);
      mesh.isVisible = false;
      mesh.position.setAll(0);
      mesh.rotation.setAll(0);
      mesh.rotationQuaternion?.set(0, 0, 0, 1);
      mesh.scaling.setAll(1);
      mesh.instancedBuffers.color?.set(1, 1, 1, 1);
    });
    let pool = this.bouncerMeshPools.get(modelIndex);
    if (!pool) this.bouncerMeshPools.set(modelIndex, pool = []);
    pool.push(meshes);
  }

  private async loadBouncerTemplates(generation: number): Promise<Map<number, Mesh[]>> {
    const response = await fetch("/api/bouncers", { cache: "no-store" });
    if (!response.ok) throw new Error(`Bouncer manifest request failed (${response.status}).`);
    const assets = await response.json() as MapModelAsset[];
    const result = new Map<number, Mesh[]>();
    await Promise.all(assets.map(async (asset) => {
      if (generation !== this.templateGeneration || asset.status !== "ready" || !asset.geometryPath) return;
      const geometry = await this.fetchBouncerGeometry(asset);
      if (generation !== this.templateGeneration) return;
      const meshes = geometry.meshes.map((source) => {
        const mesh = new Mesh(`bouncer-template-${asset.index}-${source.name}`, this.scene);
        const data = new VertexData();
        const translate = asset.translate ?? [0, 0, 0], scale = asset.scale ?? 0.25;
        data.positions = new Array<number>(source.positions.length);
        for (let index = 0; index < source.positions.length; index += 3) {
          data.positions[index] = (source.positions[index] + translate[0]) * scale;
          data.positions[index + 1] = (source.positions[index + 1] + translate[2]) * scale;
          data.positions[index + 2] = (source.positions[index + 2] + translate[1]) * scale;
        }
        data.uvs = source.uvs;
        data.indices = source.indices;
        const normals: number[] = [];
        VertexData.ComputeNormals(data.positions, source.indices, normals);
        data.normals = normals;
        data.applyToMesh(mesh);
        const skin = selectModelSkin(asset.skins ?? [], source.name);
        const materialKey = `bouncer:${asset.index}:${source.name}`;
        let material = this.materials.get(materialKey);
        if (!material) {
          material = new StandardMaterial(`bouncer-material-${asset.index}-${source.name}`, this.scene);
          material.backFaceCulling = asset.cullFace ?? true;
          material.specularColor = Color3.White().scale(asset.specular ?? 1);
          material.ambientColor = Color3.White().scale(asset.ambient ?? 0.3);
          const diffuseUrl = packageAssetUrl(skin?.diffusePath);
          if (diffuseUrl) {
            const texture = new Texture(diffuseUrl, this.scene, false, false);
            texture.hasAlpha = true;
            material.diffuseTexture = texture;
            material.emissiveTexture = texture;
            material.emissiveColor = Color3.White().scale(Math.max(asset.ambient ?? 0.3, Math.min(asset.glow ?? 0, 1)));
            material.useAlphaFromDiffuseTexture = true;
            this.textures.set(`${materialKey}:diffuse`, texture);
          }
          const masksUrl = packageAssetUrl(skin?.masksPath);
          if (masksUrl) {
            const masks = new Texture(masksUrl, this.scene, false, false);
            material.specularTexture = masks;
            this.textures.set(`${materialKey}:masks`, masks);
          }
          if (asset.alphaBlend) material.transparencyMode = Material.MATERIAL_ALPHABLEND;
          else {
            material.transparencyMode = Material.MATERIAL_ALPHATEST;
            material.alphaCutOff = asset.alphaTest ?? 0.9;
          }
          this.materials.set(materialKey, material);
        }
        mesh.material = material;
        mesh.registerInstancedBuffer("color", 4);
        mesh.setEnabled(false);
        mesh.isPickable = false;
        this.persistentMeshes.add(mesh);
        return mesh;
      });
      result.set(asset.index, meshes);
    }));
    return result;
  }

  private async fetchBouncerGeometry(asset: MapModelAsset): Promise<ModelGeometry> {
    const response = await fetch(packageAssetUrl(asset.geometryPath) ?? "", { cache: "no-cache" });
    if (!response.ok) throw new Error(`Could not load ${asset.geometryPath} (${response.status}).`);
    if (asset.format === "OBJ") return parseObj(await response.text());
    if (asset.format === "MD5") return parseMd5(await response.text());
    const bytes = await response.arrayBuffer();
    if (asset.format === "MD2") return parseMd2(bytes);
    if (asset.format === "MD3") return parseMd3(bytes);
    if (asset.format === "IQM") return parseIqm(bytes);
    throw new Error(`${asset.format ?? "Unknown"} bouncer model format is unsupported.`);
  }

  private explosion(gun: Gun, position: Vec3, radius: number, normal?: Vec3): void {
    const magic = gun === Gun.Fireball || gun === Gun.Iceball || gun === Gun.Slimeball;
    if (magic) {
      this.sparks(position, 100, 200);
      return;
    }
    if (normal) this.decal(position, normal, "scorch.png", 0xffffff, radius / 2);
    const blue = gun === Gun.Grenade;
    const duration = Math.max(1, (radius - 4) * (blue ? 15 : 20));
    const effect = this.fireball(position, radius, duration, blue);
    const light = new PointLight("weapon-explosion-light", toBabylonPosition(position), this.scene);
    light.diffuse = blue ? new Color3(0.25, 1, 1) : new Color3(1, 0.75, 0.5);
    light.intensity = 2;
    light.range = radius * 1.15;
    effect.light = light;
  }

  // Original: src/engine/explosion.h and data/glsl.cfg. Native Sauerbraten renders
  // fireballs as expanding, shader-wobbled spheres rather than billboard particles.
  private fireball(position: Vec3, radius: number, duration: number, blue: boolean): SpriteEffect {
    const material = this.fireballMaterial(blue);
    const pool = this.fireballPools[blue ? 1 : 0];
    const mesh = pool.pop() ?? this.explosionTemplate().clone("weapon-explosion-fireball", null, false)!;
    mesh.name = "weapon-explosion-fireball";
    mesh.setEnabled(true);
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.scaling.setAll(4);
    mesh.isPickable = false;
    mesh.isVisible = this.renderingEnabled;
    mesh.material = material;
    const metadata: ExplosionMeshMetadata = {
      center: toBabylonPosition(position), color: particleColor3(blue ? 0x80ffff : 0xff8080), fade: 1,
    };
    mesh.metadata = metadata;
    const started = performance.now();
    const effect: SpriteEffect = {
      mesh, started, duration, startScale: 4, endScale: radius, fadeMesh: false,
      reusableMesh: blue ? "fireball-blue" : "fireball-red",
      update: (progress) => { metadata.fade = Math.min(1, (1 - progress) * 4); },
    };
    this.effects.push(effect);
    return effect;
  }

  private fireballMaterial(blue: boolean): ShaderMaterial {
    const materialIndex = blue ? 1 : 0;
    const cached = this.fireballMaterials[materialIndex];
    if (cached) return cached;
    const texture = this.particleTexture(blue ? "plasma.png" : "explosion.png");
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    const material = new ShaderMaterial(`weapon-explosion-${blue ? "blue" : "red"}-material`, this.scene, {
      vertexSource: EXPLOSION_VERTEX_SHADER,
      fragmentSource: EXPLOSION_FRAGMENT_SHADER,
    }, {
      attributes: ["position", "uv"],
      uniforms: ["worldViewProjection", "center", "cameraRight", "cameraUp", "millis", "color", "fade"],
      samplers: ["explosionSampler"],
      needAlphaBlending: true,
    });
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.alphaMode = 1;
    material.setTexture("explosionSampler", texture);
    material.setFloat("fade", 1);
    material.onBindObservable.add((boundMesh) => {
      const metadata = boundMesh.metadata as ExplosionMeshMetadata | undefined;
      if (!metadata) return;
      const camera = this.scene.activeCamera ?? this.playerCamera;
      const basis = explosionTexgenBasis(metadata.center, camera.globalPosition,
        camera.getDirection(Vector3.Right()), camera.getDirection(Vector3.Up()));
      material.setVector3("center", metadata.center);
      material.setColor3("color", metadata.color);
      material.setFloat("millis", performance.now() / 1000);
      material.setFloat("fade", metadata.fade);
      material.setVector3("cameraRight", basis.right);
      material.setVector3("cameraUp", basis.up);
    });
    this.fireballMaterials[materialIndex] = material;
    return material;
  }

  private explosionTemplate(): Mesh {
    if (this.fireballTemplate) return this.fireballTemplate;
    const mesh = createExplosionSphere(this.scene);
    mesh.name = "weapon-explosion-template";
    mesh.setEnabled(false);
    mesh.isPickable = false;
    this.fireballTemplate = mesh;
    return mesh;
  }

  private decal(position: Vec3, normal: Vec3, texture: ParticleTexture, color: number, size: number): void {
    const from = { x: position.x + normal.x * 2, y: position.y + normal.y * 2, z: position.z + normal.z * 2 };
    const surface = this.resolveSurface ? this.resolveSurface(from, position) : { position, normal };
    if (surface) this.createDecal(surface, texture, color, size);
  }

  private createDecal(surface: DecalSurface, texture: ParticleTexture, color: number, size: number, approach?: Vec3): void {
    const settings = DECAL_QUALITY_SETTINGS[this.decalQuality];
    if (!settings.maximum) return;
    const camera = this.scene.activeCamera ?? this.playerCamera;
    const babylonPosition = toBabylonPosition(surface.position);
    if (Vector3.DistanceSquared(camera.globalPosition, babylonPosition) > settings.distance * settings.distance) return;
    while (this.decals.length >= settings.maximum) this.removeDecal(this.decals[0]);
    const mesh = MeshBuilder.CreatePlane(`weapon-decal-${texture}`, { size: size * 2 }, this.scene);
    mesh.position.copyFrom(toBabylonPosition(surface.position));
    const direction = toBabylonDirection(surface.normal).normalize();
    mesh.position.addInPlace(direction.scale(0.03));
    mesh.lookAt(mesh.position.add(direction));
    if (texture === "scorch.png") mesh.rotate(direction, Math.random() * Math.PI * 2, Space.WORLD);
    else if (texture === "bullet.png" && approach) this.orientBulletDecal(mesh, direction, approach);
    mesh.isPickable = false;
    mesh.isVisible = this.renderingEnabled;
    mesh.material = this.decalMaterial(texture, color);
    const effect: SpriteEffect = {
      mesh, started: performance.now(), duration: settings.lifetimeMs, startScale: 1, endScale: 1, fadeStart: 0.8,
    };
    this.effects.push(effect);
    this.decals.push(effect);
  }

  private bulletDecal(from: Vec3, endpoint: Vec3, size: number): void {
    const surface = this.resolveSurface?.(from, endpoint);
    if (surface) this.createDecal(surface, "bullet.png", 0xffffff, size, {
      x: endpoint.x - from.x, y: endpoint.y - from.y, z: endpoint.z - from.z,
    });
  }

  private orientBulletDecal(mesh: Mesh, normal: Vector3, approach: Vec3): void {
    const shot = toBabylonDirection(approach).normalize();
    const projected = shot.subtract(normal.scale(Vector3.Dot(shot, normal)));
    if (projected.lengthSquared() <= 1e-8) return;
    projected.normalize();
    mesh.computeWorldMatrix(true);
    const currentDown = Vector3.TransformNormal(Vector3.Down(), mesh.getWorldMatrix()).normalize();
    const angle = Math.atan2(Vector3.Dot(normal, Vector3.Cross(currentDown, projected)), Vector3.Dot(currentDown, projected));
    mesh.rotate(normal, angle + Math.PI, Space.WORLD);
  }

  private sparks(position: Vec3 | readonly Vec3[], count: number, fadeMs: number): void {
    const positions = Array.isArray(position) ? position : [position];
    if (this.particleBackend === "gpu" && positions.length > 1) {
      this.gpuSparkBatch(positions, count, fadeMs);
      return;
    }
    this.splash(positions[0], "spark.png", 0xb49b4b, 0.24, count, fadeMs, 150, 2, true);
  }

  private gpuSparkBatch(positions: readonly Vec3[], countPerEmitter: number, fadeMs: number): void {
    const maximumFade = fadeMs * 3;
    const options: ParticleOptions = {
      texture: "spark.png", color: 0xb49b4b, size: 0.24, fadeMinMs: 1, fadeMaxMs: maximumFade,
      velocityRadius: 150, gravity: 2, additive: true,
    };
    const emitters = positions.map((position, index): MapParticleEmitter => ({ name: `impact-${index}`, position, options }));
    const capacity = positions.length * countPerEmitter;
    const recipe = `spark-batch:${positions.length}:${countPerEmitter}:${fadeMs}`;
    const pooledIndex = this.systemPool.findIndex((entry) => entry.backend === "gpu" && entry.recipe === recipe &&
      entry.capacity === capacity && entry.batchData !== undefined);
    const pooled = pooledIndex >= 0 ? this.systemPool.splice(pooledIndex, 1)[0] : undefined;
    const system = pooled?.system as GPUParticleSystem | undefined ?? new GPUParticleSystem(`weapon-spark-batch-${positions.length}`, {
      capacity, randomTextureSize: Math.min(4_096, Math.max(256, capacity)), emitRateControl: true,
    }, this.scene);
    const emitterData = this.mapEmitterData(emitters);
    let batchData = pooled?.batchData;
    if (batchData) {
      batchData.update.update(emitterData);
      batchData.render.update(emitterData);
    } else {
      const update = RawTexture.CreateRGBATexture(emitterData, positions.length, 7, this.scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
      const render = RawTexture.CreateRGBATexture(emitterData, positions.length, 7, this.scene, false, false,
        Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
      update.name = `${system.name}-update-data`;
      render.name = `${system.name}-render-data`;
      batchData = { update, render };
      this.batchDataTextures.add(update);
      this.systemBatchData.set(system, batchData);
      const emitter = new CustomParticleEmitter();
      emitter.particlePositionGenerator = (index, _particle, target) => {
        const emitterIndex = Math.min(positions.length - 1, Math.floor(index / countPerEmitter));
        target.set((emitterIndex + 0.5) / positions.length, 0, 0);
      };
      emitter.particleDestinationGenerator = (_index, _particle, target) => target.setAll(0);
      system.particleEmitterType = emitter;
      system.flowMap = update;
      system.flowMapStrength = positions.length;
      (system as GPUParticleSystem & { _colorGradientsTexture: RawTexture })._colorGradientsTexture = render;
      const fillDefines = system.fillDefines.bind(system);
      system.fillDefines = (defines, blendMode, fillImageProcessing): void => {
        fillDefines(defines, blendMode, fillImageProcessing);
        defines.push("#define SAUER_BATCH");
      };
      system.emitter = Vector3.Zero();
      system.particleTexture = this.particleTexture("spark.png");
      system.minSize = system.maxSize = 1;
      system.minScaleX = system.maxScaleX = 1;
      system.minScaleY = system.maxScaleY = 1;
      system.minLifeTime = 0.001;
      system.maxLifeTime = maximumFade / 1_000;
      system.gravity.setAll(0);
      system.blendMode = ParticleSystem.BLENDMODE_ADD;
      system.updateSpeed = 1 / 60;
      system.maxActiveParticleCount = capacity;
    }
    system.name = `weapon-spark-batch-${positions.length}`;
    system.layerMask = this.renderingEnabled ? PARTICLE_LAYER_MASK : 0;
    system.manualEmitCount = capacity;
    system.emitRate = Math.max(1, capacity * 60);
    system.start();
    this.systems.add(system);
    this.systemRecipes.set(system, recipe);
    this.systemEmitterCounts.set(system, positions.length);
    this.systemExpiresAt.set(system, performance.now() + maximumFade + 50);
    this.instrumentParticleSystem(system);
  }

  private splash(position: Vec3, texture: ParticleTexture, color: number, size: number, count: number, fadeMs: number,
                 velocityRadius: number, gravity: number, additive = false): void {
    const maximumFade = fadeMs * 3;
    this.particleSystem(`weapon-${texture}`, position, {
      texture, color, size, fadeMinMs: 1, fadeMaxMs: maximumFade, count, velocityRadius, gravity, additive,
      fadeAtIndex: (index) => count < 10 ? 1 + Math.floor(Math.random() * maximumFade) :
        Math.trunc(maximumFade - index * (maximumFade - 1) / (count - 1)),
    });
  }

  private trail(from: Vec3, to: Vec3, texture: ParticleTexture, color: number, size: number, fade: number, gravity: number,
                maximumCount = 500): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const count = Math.min(maximumCount, Math.max(1, Math.floor(distance * 2)));
    const start = toBabylonPosition(from), end = toBabylonPosition(to);
    let emitted = 0;
    this.particleSystem("weapon-trail", from, {
      texture, color, size, fadeMinMs: fade, fadeMaxMs: fade * 2 - 1, count, velocityBox: 5, gravity,
      startPosition: () => Vector3.Lerp(start, end, Math.min(1, ++emitted / count)), forceCpu: true,
    });
  }

  private flushMapEmitterBatches(): void {
    if (!this.pendingMapEmitters.length) return;
    const groups = new Map<string, MapParticleEmitter[]>();
    for (const emitter of this.pendingMapEmitters) {
      const key = this.mapBatchRecipe(emitter.options);
      let group = groups.get(key);
      if (!group) groups.set(key, group = []);
      group.push(emitter);
    }
    const maximumBatchCapacity = Math.max(8_192, this.particleCapacityLimit * 4);
    for (const group of groups.values()) {
      let chunk: MapParticleEmitter[] = [], capacity = 0;
      for (const emitter of group) {
        const emitterCapacity = this.mapEmitterCapacity(emitter.options);
        if (chunk.length && capacity + emitterCapacity > maximumBatchCapacity) {
          this.gpuMapParticleBatch(chunk, capacity);
          chunk = [];
          capacity = 0;
        }
        chunk.push(emitter);
        capacity += emitterCapacity;
      }
      if (chunk.length) this.gpuMapParticleBatch(chunk, capacity);
    }
    this.pendingMapEmitters.length = 0;
  }

  private gpuMapParticleBatch(emitters: readonly MapParticleEmitter[], capacity: number): void {
    const options = emitters[0].options;
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    const system = new GPUParticleSystem(`map-particle-batch-${options.texture}-${this.systems.size}`, {
      capacity,
      randomTextureSize: Math.min(4_096, Math.max(256, capacity)),
      emitRateControl: false,
    }, this.scene, undefined, tiled);
    const owner = this.mapEmitterSlotOwners(emitters, capacity);
    const emitterData = this.mapEmitterData(emitters);
    const updateDataTexture = RawTexture.CreateRGBATexture(emitterData, emitters.length, 7, this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    const renderDataTexture = RawTexture.CreateRGBATexture(emitterData, emitters.length, 7, this.scene, false, false,
      Texture.NEAREST_SAMPLINGMODE, Constants.TEXTURETYPE_FLOAT);
    updateDataTexture.name = `${system.name}-update-data`;
    renderDataTexture.name = `${system.name}-render-data`;
    this.batchDataTextures.add(updateDataTexture);
    const emitter = new CustomParticleEmitter();
    const assigned = new Uint32Array(emitters.length);
    const totals = emitters.map((definition) => this.mapEmitterCapacity(definition.options));
    emitter.particlePositionGenerator = (index, _particle, target) => {
      const emitterIndex = owner[index];
      const phase = assigned[emitterIndex]++ / Math.max(1, totals[emitterIndex]);
      target.set((emitterIndex + 0.5) / emitters.length, phase, 0);
    };
    emitter.particleDestinationGenerator = (_index, _particle, target) => target.setAll(0);
    system.particleEmitterType = emitter;
    system.flowMap = updateDataTexture;
    system.flowMapStrength = emitters.length;
    (system as GPUParticleSystem & { _colorGradientsTexture: RawTexture })._colorGradientsTexture = renderDataTexture;
    const fillDefines = system.fillDefines.bind(system);
    system.fillDefines = (defines, blendMode, fillImageProcessing): void => {
      fillDefines(defines, blendMode, fillImageProcessing);
      defines.push("#define SAUER_BATCH");
    };
    system.emitter = Vector3.Zero();
    system.particleTexture = this.particleTexture(options.texture);
    system.minSize = system.maxSize = 1;
    system.minScaleX = system.maxScaleX = 1;
    system.minScaleY = system.maxScaleY = 1;
    system.minLifeTime = Math.min(...emitters.map((definition) => Math.max(0.001, definition.options.fadeMinMs / 1_000)));
    system.maxLifeTime = Math.max(...emitters.map((definition) => Math.max(0.001, definition.options.fadeMaxMs / 1_000)));
    system.gravity.setAll(0);
    system.blendMode = options.additive ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    system.updateSpeed = 1 / 60;
    system.layerMask = this.renderingEnabled ? PARTICLE_LAYER_MASK : 0;
    system.minInitialRotation = 0;
    system.maxInitialRotation = Math.PI * 2;
    system.minAngularSpeed = system.maxAngularSpeed = 0;
    if (tiled) {
      system.startSpriteCellID = 0;
      system.endSpriteCellID = 3;
      system.spriteCellWidth = options.texture === "flames.png" ? 128 : 64;
      system.spriteCellHeight = system.spriteCellWidth;
      system.spriteCellLoop = false;
      system.spriteRandomStartCell = true;
    }
    system.maxActiveParticleCount = capacity;
    // Seed the entire steady-state population in one update. The custom shader applies a deterministic per-emitter phase,
    // so legacy recycling remains evenly staggered instead of filling the batch in periodic clumps.
    system.manualEmitCount = capacity;
    system.emitRate = emitters.reduce((total, definition) => total + (definition.options.rate ?? 10), 0);
    system.start();
    this.systems.add(system);
    this.systemRecipes.set(system, this.mapBatchRecipe(options));
    this.systemEmitterCounts.set(system, emitters.length);
    this.instrumentParticleSystem(system);
  }

  private mapEmitterData(emitters: readonly MapParticleEmitter[]): Float32Array {
    const rowCount = 7, componentCount = 4;
    const data = new Float32Array(emitters.length * rowCount * componentCount);
    const write = (emitter: number, row: number, x: number, y: number, z: number, w: number): void => {
      const offset = (row * emitters.length + emitter) * componentCount;
      data[offset] = x;
      data[offset + 1] = y;
      data[offset + 2] = z;
      data[offset + 3] = w;
    };
    emitters.forEach((definition, index) => {
      const options = definition.options;
      const position = toBabylonPosition(definition.position);
      const { low: velocityLow, high: velocityHigh, mode } = this.gpuVelocityBounds(options);
      const boxLow = options.emitBoxMin ?? new Vector3(-(options.radius ?? 0), 0, -(options.radius ?? 0));
      const boxHigh = options.emitBoxMax ?? new Vector3(options.radius ?? 0, 0, options.radius ?? 0);
      const color = particleColor4(options.color, 1);
      const minimumSize = sauerParticleDiameter(options.minSize ?? options.size);
      const maximumSize = sauerParticleDiameter(options.maxSize ?? options.size);
      const endSize = sauerParticleDiameter(options.endSize ?? options.size);
      write(index, 0, position.x, position.y, position.z, mode);
      write(index, 1, velocityLow.x, velocityLow.y, velocityLow.z, Math.max(0.001, options.fadeMinMs / 1_000));
      write(index, 2, velocityHigh.x, velocityHigh.y, velocityHigh.z, Math.max(0.001, options.fadeMaxMs / 1_000));
      write(index, 3, options.gravity ? -200 / options.gravity : 0, minimumSize, maximumSize, endSize);
      write(index, 4, color.r, color.g, color.b, color.a);
      write(index, 5, boxLow.x, boxLow.y, boxLow.z, options.rate ?? 10);
      write(index, 6, boxHigh.x, boxHigh.y, boxHigh.z, 0);
    });
    return data;
  }

  private mapEmitterSlotOwners(emitters: readonly MapParticleEmitter[], capacity: number): Uint16Array {
    const counts = emitters.map((emitter) => this.mapEmitterCapacity(emitter.options));
    const assigned = new Uint32Array(emitters.length);
    const owners = new Uint16Array(capacity);
    for (let slot = 0; slot < capacity; slot++) {
      let selected = 0, selectedScore = Number.NEGATIVE_INFINITY;
      for (let emitter = 0; emitter < emitters.length; emitter++) {
        if (assigned[emitter] >= counts[emitter]) continue;
        const score = (slot + 1) * counts[emitter] / capacity - assigned[emitter];
        if (score > selectedScore) {
          selected = emitter;
          selectedScore = score;
        }
      }
      owners[slot] = selected;
      assigned[selected]++;
    }
    return owners;
  }

  private gpuVelocityBounds(options: ParticleOptions): { low: Vector3; high: Vector3; mode: number } {
    if (options.velocityRadius !== undefined) {
      const radius = options.velocityRadius / 5;
      return { low: new Vector3(-radius, -radius, -radius), high: new Vector3(radius, radius, radius), mode: 1 };
    }
    if (options.velocityBox !== undefined) {
      const radius = options.velocityBox / 5;
      return { low: new Vector3(-radius, -radius, -radius), high: new Vector3(radius, radius, radius), mode: 2 };
    }
    const direction = options.direction ?? Vector3.Up();
    const spread = options.spread ?? 0;
    const minimumSpeed = (options.minSpeed ?? options.speed ?? 0) / 5;
    const maximumSpeed = (options.maxSpeed ?? options.speed ?? 0) / 5;
    return {
      low: direction.subtract(new Vector3(spread, spread, spread)).scale(minimumSpeed),
      high: direction.add(new Vector3(spread, spread, spread)).scale(maximumSpeed),
      mode: 0,
    };
  }

  private mapEmitterCapacity(options: ParticleOptions): number {
    const minimumLife = Math.max(1, options.fadeMinMs);
    const maximumLife = Math.max(minimumLife, options.fadeMaxMs);
    return Math.max(1, Math.ceil((options.rate ?? 10) * (minimumLife + maximumLife) / 2_000));
  }

  private mapBatchRecipe(options: ParticleOptions): string {
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    return `${options.texture}:${options.additive ? 1 : 0}:${tiled ? 1 : 0}`;
  }

  private particleSystem(name: string, position: Vec3, options: ParticleOptions): CosmeticParticleSystem | undefined {
    if (this.collectingMapEmitters && options.count === undefined && !options.forceCpu && !options.startPosition) {
      this.pendingMapEmitters.push({ name, position: { ...position }, options });
      return undefined;
    }
    if (this.particleBackend === "gpu" && !options.forceCpu && !options.startPosition) {
      return this.gpuParticleSystem(name, position, options);
    }
    return this.cpuParticleSystem(name, position, options);
  }

  private cpuParticleSystem(name: string, position: Vec3, options: ParticleOptions): ParticleSystem {
    const capacity = this.particleCapacity(options);
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    const recipe = this.particleRecipe(options);
    const pooledIndex = this.systemPool.findIndex((entry) => entry.backend === "cpu" && entry.recipe === recipe &&
      entry.tiled === tiled && entry.capacity >= capacity &&
      entry.capacity <= capacity * 2);
    const pooled = pooledIndex >= 0 ? this.systemPool.splice(pooledIndex, 1)[0] : undefined;
    const system = (pooled?.system as ParticleSystem | undefined) ?? new ParticleSystem(name, capacity, this.scene, undefined, tiled);
    system.reset();
    system.layerMask = this.renderingEnabled ? PARTICLE_LAYER_MASK : 0;
    const states = new WeakMap<Particle, SauerParticleState>();
    let particleIndex = 0;
    system.particleTexture = this.particleTexture(options.texture);
    system.emitter = toBabylonPosition(position);
    system.color1 = particleColor4(options.color, 1);
    system.color2 = particleColor4(options.color, 1);
    system.colorDead = particleColor4(options.color, 0);
    system.minSize = sauerParticleDiameter(options.size);
    system.maxSize = sauerParticleDiameter(options.size);
    system.minLifeTime = 1;
    system.maxLifeTime = 1;
    system.minEmitPower = 1;
    system.maxEmitPower = 1;
    system.gravity = Vector3.Zero();
    system.blendMode = options.additive ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    // With Babylon's animation ratio, 1/60 makes scaledUpdateSpeed equal elapsed seconds.
    system.updateSpeed = 1 / 60;
    if (tiled) {
      system.startSpriteCellID = 0;
      system.endSpriteCellID = 3;
      system.spriteCellWidth = options.texture === "flames.png" ? 128 : 64;
      system.spriteCellHeight = options.texture === "flames.png" ? 128 : 64;
      system.spriteCellLoop = false;
      system.spriteRandomStartCell = true;
    }
    const direction = options.direction ?? new Vector3(0, 1, 0);
    const spread = options.spread ?? 0;
    const low = direction.subtract(new Vector3(spread, spread, spread));
    const high = direction.add(new Vector3(spread, spread, spread));
    system.createBoxEmitter(low, high, options.emitBoxMin ?? new Vector3(-(options.radius ?? 0), 0, -(options.radius ?? 0)),
      options.emitBoxMax ?? new Vector3(options.radius ?? 0, 0, options.radius ?? 0));
    if (options.startPosition) system.startPositionFunction = (_matrix, target) => target.copyFrom(options.startPosition!());
    system.startDirectionFunction = (_matrix, target, particle) => {
      const velocity = this.nativeParticleVelocity(options, low, high);
      const index = particleIndex++;
      const fadeMs = options.fadeAtIndex?.(index) ?? randomInteger(options.fadeMinMs, options.fadeMaxMs);
      states.set(particle, {
        origin: particle.position.clone(), velocity, gravity: options.gravity ?? 0, fadeMs, ageMs: 0,
      });
      target.setAll(0);
    };
    system.updateFunction = (particles) => {
      const elapsedMs = this.scene.getEngine().getDeltaTime();
      for (let index = particles.length - 1; index >= 0; index--) {
        const particle = particles[index];
        const state = states.get(particle);
        if (!state) continue;
        state.ageMs += elapsedMs;
        if (state.ageMs >= state.fadeMs) {
          const lastParticle = particles[particles.length - 1];
          const lastState = states.get(lastParticle);
          states.delete(particle);
          system.recycleParticle(particle);
          if (lastParticle !== particle) {
            states.delete(lastParticle);
            if (lastState) states.set(particle, lastState);
          }
          continue;
        }
        const particleMillis = state.fadeMs <= 5 ? 1 : Math.min(state.ageMs, state.fadeMs);
        particle.position.copyFrom(state.origin);
        if (state.gravity) {
          particle.position.addInPlace(state.velocity.scale(particleMillis / 5000));
          particle.position.y -= particleMillis * particleMillis / (2 * 5000 * state.gravity);
        }
        particle.color.a = state.fadeMs <= 5 ? 1 : Math.min(1, Math.max(0, 1 - state.ageMs / state.fadeMs) * 4);
      }
    };
    if (options.count !== undefined) {
      system.manualEmitCount = options.count;
      system.disposeOnStop = false;
    } else {
      system.manualEmitCount = -1;
      system.emitRate = options.rate ?? 10;
    }
    system.start();
    this.systems.add(system);
    this.systemRecipes.set(system, recipe);
    this.systemEmitterCounts.set(system, 1);
    this.instrumentParticleSystem(system);
    if (options.count !== undefined) this.systemExpiresAt.set(system, performance.now() + options.fadeMaxMs + 50);
    return system;
  }

  private gpuParticleSystem(name: string, position: Vec3, options: ParticleOptions): GPUParticleSystem {
    const capacity = this.particleCapacity(options);
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    const recipe = this.particleRecipe(options);
    const pooledIndex = this.systemPool.findIndex((entry) => entry.backend === "gpu" && entry.recipe === recipe &&
      entry.tiled === tiled && entry.capacity >= capacity && entry.capacity <= capacity * 2);
    const pooled = pooledIndex >= 0 ? this.systemPool.splice(pooledIndex, 1)[0] : undefined;
    const system = pooled?.system as GPUParticleSystem | undefined ?? new GPUParticleSystem(name, {
      capacity,
      randomTextureSize: Math.min(4_096, Math.max(256, capacity)),
      // Dynamic GPU systems are finite bursts. Emit-rate control prevents dead slots from being recycled after the one manual emission.
      emitRateControl: true,
    }, this.scene, undefined, tiled);
    system.name = name;
    // A pooled GPU burst retains its transform-feedback buffers. Re-emission overwrites the active slots without rebuilding them.
    if (!pooled) system.reset();
    system.layerMask = this.renderingEnabled ? PARTICLE_LAYER_MASK : 0;
    system.particleTexture = this.particleTexture(options.texture);
    system.emitter = toBabylonPosition(position);
    const color = particleColor4(options.color, 1);
    system.color1.copyFrom(color);
    system.color2.copyFrom(color);
    system.colorDead.copyFrom(particleColor4(options.color, 0));
    system.minSize = system.maxSize = sauerParticleDiameter(options.size);
    system.minLifeTime = Math.max(0.001, options.fadeMinMs / 1_000);
    system.maxLifeTime = Math.max(system.minLifeTime, options.fadeMaxMs / 1_000);
    system.minInitialRotation = 0;
    system.maxInitialRotation = Math.PI * 2;
    system.minAngularSpeed = system.maxAngularSpeed = 0;
    system.blendMode = options.additive ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    system.updateSpeed = 1 / 60;
    system.gravity.set(0, options.gravity ? -200 / options.gravity : 0, 0);
    if (tiled) {
      system.startSpriteCellID = 0;
      system.endSpriteCellID = 3;
      system.spriteCellWidth = options.texture === "flames.png" ? 128 : 64;
      system.spriteCellHeight = system.spriteCellWidth;
      system.spriteCellLoop = false;
      system.spriteRandomStartCell = true;
    }
    const direction = options.direction ?? Vector3.Up();
    const spread = options.spread ?? 0;
    const speed = options.speed ?? 0;
    let low: Vector3, high: Vector3;
    if (options.velocityRadius !== undefined) {
      const velocity = options.velocityRadius / 5;
      low = new Vector3(-velocity, -velocity, -velocity);
      high = new Vector3(velocity, velocity, velocity);
    } else if (options.velocityBox !== undefined) {
      const velocity = options.velocityBox / 5;
      low = new Vector3(-velocity, -velocity, -velocity);
      high = new Vector3(velocity, velocity, velocity);
    } else {
      low = direction.subtract(new Vector3(spread, spread, spread)).scale(speed / 5);
      high = direction.add(new Vector3(spread, spread, spread)).scale(speed / 5);
    }
    system.createBoxEmitter(low, high, options.emitBoxMin ?? new Vector3(-(options.radius ?? 0), 0, -(options.radius ?? 0)),
      options.emitBoxMax ?? new Vector3(options.radius ?? 0, 0, options.radius ?? 0));
    if (!pooled) {
      system.addColorGradient(0, particleColor4(options.color, 1));
      system.addColorGradient(0.75, particleColor4(options.color, 1));
      system.addColorGradient(1, particleColor4(options.color, 0));
      system.addSizeGradient(0, 1);
      system.addSizeGradient(1, 1);
    }
    system.maxActiveParticleCount = capacity;
    if (options.count !== undefined) {
      system.manualEmitCount = Math.min(options.count, capacity);
      system.emitRate = Math.max(1, options.count * 60);
    } else {
      system.manualEmitCount = -1;
      system.emitRate = options.rate ?? 10;
    }
    system.start();
    this.systems.add(system);
    this.systemRecipes.set(system, recipe);
    this.systemEmitterCounts.set(system, 1);
    this.instrumentParticleSystem(system);
    if (options.count !== undefined) this.systemExpiresAt.set(system, performance.now() + options.fadeMaxMs + 50);
    return system;
  }

  private particleCapacity(options: ParticleOptions): number {
    const requested = Math.max(8, options.count ?? Math.ceil((options.rate ?? 10) * options.fadeMaxMs / 1_000 * 1.1));
    return Math.min(requested, this.particleCapacityLimit);
  }

  private particleRecipe(options: ParticleOptions): string {
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    return `${options.texture}:${options.color}:${options.additive ? 1 : 0}:${tiled ? 1 : 0}`;
  }

  private nativeParticleVelocity(options: ParticleOptions, low: Vector3, high: Vector3): Vector3 {
    if (options.velocityRadius !== undefined) return toBabylonDirection(randomSphereVector(options.velocityRadius));
    if (options.velocityBox !== undefined) {
      const radius = options.velocityBox;
      return toBabylonDirection({
        x: randomInteger(-radius, radius), y: randomInteger(-radius, radius), z: randomInteger(-radius, radius),
      });
    }
    return new Vector3(randomRange(low.x, high.x), randomRange(low.y, high.y), randomRange(low.z, high.z)).scale(options.speed ?? 0);
  }

  private muzzlePosition(from: Vec3, to: Vec3): Vec3 {
    if (this.scene.activeCamera !== this.playerCamera) return from;
    const forward = toBabylonDirection({ x: to.x - from.x, y: to.y - from.y, z: to.z - from.z }).normalize();
    const up = this.playerCamera.upVector.normalizeToNew();
    const right = Vector3.Cross(forward, up).normalize();
    const position = toBabylonPosition(from).add(forward.scale(2)).add(right.scale(0.8)).subtract(up);
    return { x: position.x, y: position.z, z: position.y };
  }

  private muzzleFlash(position: Vec3, texture: ParticleTexture, size: number, duration: number, lightRange = 0,
                      track?: () => Vec3 | undefined): void {
    // Native muzzle particles use the supplied value as their visible width and PT_TRACK keeps them on tag_muzzle.
    const effect = this.sprite(position, texture, 0xffffff, size * 0.5, duration, true);
    effect.track = track;
    if (!lightRange) return;
    const light = new PointLight("weapon-muzzle-light", toBabylonPosition(position), this.scene);
    light.diffuse = new Color3(1, 0.75, 0.5);
    light.intensity = 1;
    light.range = lightRange;
    effect.light = light;
  }

  private sprite(position: Vec3, texture: ParticleTexture, color: number, size: number, duration: number, additive: boolean,
                 endScale = size): SpriteEffect {
    const material = this.spriteMaterial(`particle-${texture}`, texture, color, additive);
    const mesh = this.spritePool.pop() ?? MeshBuilder.CreatePlane("particle-sprite", { size: 1 }, this.scene);
    mesh.setEnabled(true);
    mesh.isVisible = this.renderingEnabled;
    mesh.visibility = 1;
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.scaling.setAll(sauerParticleDiameter(size));
    mesh.isPickable = false;
    mesh.material = material;
    const effect = {
      mesh, started: performance.now(), duration, startScale: sauerParticleDiameter(size), endScale: sauerParticleDiameter(endScale),
      reusableMesh: "sprite" as const,
    };
    this.effects.push(effect);
    return effect;
  }

  private persistentSprite(position: Vec3, texture: ParticleTexture, color: number, size: number, additive: boolean): void {
    const material = this.spriteMaterial(`map-${texture}`, texture, color, additive);
    const mesh = MeshBuilder.CreatePlane(`map-particle-${texture}`, { size }, this.scene);
    mesh.isVisible = this.renderingEnabled;
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.isPickable = false;
    mesh.material = material;
    this.persistentMeshes.add(mesh);
  }

  private beam(from: Vec3, to: Vec3, texture: ParticleTexture, color: number, width: number, duration: number): void {
    const start = toBabylonPosition(from), end = toBabylonPosition(to);
    const midpoint = start.add(end).scale(0.5);
    const view = (this.scene.activeCamera?.globalPosition ?? midpoint.add(new Vector3(0, 0, 1))).subtract(midpoint);
    const side = Vector3.Cross(end.subtract(start), view).normalize().scale(width);
    const positions = [...start.subtract(side).asArray(), ...start.add(side).asArray(), ...end.add(side).asArray(), ...end.subtract(side).asArray()];
    let mesh = this.beamPool.pop();
    if (mesh) {
      mesh.setEnabled(true);
      mesh.isVisible = this.renderingEnabled;
      mesh.visibility = 1;
      mesh.updateVerticesData(VertexBuffer.PositionKind, positions, true);
    } else {
      mesh = new Mesh(`particle-beam-${texture}`, this.scene);
      mesh.isVisible = this.renderingEnabled;
      const data = new VertexData();
      data.positions = positions;
      data.indices = [0, 1, 2, 0, 2, 3];
      data.uvs = [0, 0, 0, 1, 1, 1, 1, 0];
      data.normals = new Array<number>(12).fill(0);
      data.applyToMesh(mesh, true);
    }
    const material = this.spriteMaterial(`beam-${texture}`, texture, color, true);
    mesh.material = material;
    mesh.isPickable = false;
    if (Number.isFinite(duration)) {
      this.effects.push({ mesh, started: performance.now(), duration, startScale: 1, endScale: 1, reusableMesh: "beam" });
    }
    else this.persistentMeshes.add(mesh);
  }

  private meter(position: Vec3, progress: number, color: number, color2: number, versus: boolean): void {
    const width = 4, height = 0.35;
    const createPart = (name: string, x: number, partWidth: number, partColor: number) => {
      if (partWidth <= 0) return;
      const mesh = MeshBuilder.CreatePlane(name, { width: partWidth, height }, this.scene);
      mesh.isVisible = this.renderingEnabled;
      mesh.position.copyFrom(toBabylonPosition(position));
      mesh.position.x += x;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false;
      const key = `meter:${partColor}`;
      let material = this.materials.get(key);
      if (!material) {
        material = new StandardMaterial(`${name}-material`, this.scene);
        material.disableLighting = true;
        material.emissiveColor = particleColor3(partColor);
        material.backFaceCulling = false;
        this.materials.set(key, material);
      }
      mesh.material = material;
      this.persistentMeshes.add(mesh);
    };
    createPart("map-particle-meter-fill", -(width - width * progress) / 2, width * progress, color);
    createPart("map-particle-meter-rest", width * progress / 2, width * (1 - progress), versus ? color2 : 0x202020);
  }

  private spriteMaterial(name: string, textureName: ParticleTexture, color: number, additive: boolean): StandardMaterial {
    const key = `sprite:${textureName}:${color}:${additive ? 1 : 0}`;
    const cached = this.materials.get(key);
    if (cached) return cached;
    const material = new StandardMaterial(`${name}-material`, this.scene);
    const texture = this.particleTexture(textureName);
    material.diffuseTexture = texture;
    material.opacityTexture = texture;
    material.emissiveTexture = texture;
    material.diffuseColor = particleColor3(color);
    material.emissiveColor = particleColor3(color);
    material.specularColor = Color3.Black();
    material.disableLighting = true;
    material.disableDepthWrite = true;
    material.backFaceCulling = false;
    material.useAlphaFromDiffuseTexture = true;
    material.transparencyMode = Material.MATERIAL_ALPHABLEND;
    if (additive) material.alphaMode = 1;
    this.materials.set(key, material);
    return material;
  }

  private decalMaterial(textureName: ParticleTexture, color: number): Material {
    if (textureName === "bullet.png") return this.bulletDecalMaterial();
    const material = this.spriteMaterial(`decal-${textureName}`, textureName, color, false);
    const texture = material.opacityTexture!;
    const grayscaleMask = textureName === "blood.png";
    texture.getAlphaFromRGB = grayscaleMask;
    material.transparencyMode = Material.MATERIAL_ALPHATESTANDBLEND;
    material.alphaCutOff = 0.02;
    material.zOffset = -1;
    material.zOffsetUnits = -4;
    return material;
  }

  private bulletDecalMaterial(): ShaderMaterial {
    if (this.bulletMaterial) return this.bulletMaterial;
    const material = new ShaderMaterial("decal-bullet-material", this.scene, {
      vertexSource: BULLET_DECAL_VERTEX_SHADER,
      fragmentSource: BULLET_DECAL_FRAGMENT_SHADER,
    }, {
      attributes: ["position", "uv"], uniforms: ["worldViewProjection", "opacity"], samplers: ["decalSampler"],
      needAlphaBlending: true,
    });
    material.setTexture("decalSampler", this.particleTexture("bullet.png"));
    material.alphaMode = Constants.ALPHA_MULTIPLY;
    material.backFaceCulling = false;
    material.disableDepthWrite = true;
    material.zOffset = -1;
    material.zOffsetUnits = -4;
    material.onBindObservable.add((mesh) => {
      material.setFloat("opacity", mesh.visibility);
      const alphaState = (this.scene.getEngine() as unknown as {
        _alphaState: { setAlphaBlendFunctionParameters: (sourceRgb: number, destinationRgb: number,
                                                         sourceAlpha: number, destinationAlpha: number) => void };
      })._alphaState;
      alphaState.setAlphaBlendFunctionParameters(Constants.GL_ALPHA_FUNCTION_DST_COLOR, Constants.GL_ALPHA_FUNCTION_SRC,
        1, 1);
    });
    this.bulletMaterial = material;
    return material;
  }

  private particleTexture(name: ParticleTexture): Texture {
    let texture = this.textures.get(name);
    if (texture) return texture;
    texture = new Texture(particleUrl(name), this.scene, false, false);
    texture.hasAlpha = true;
    this.textures.set(name, texture);
    return texture;
  }

  private update(): void {
    const updateStartedAt = performance.now();
    if (this.profilingEnabled) this.gpuSimulationDraws = this.gpuRenderingDraws = this.cpuParticleDraws = 0;
    this.updateBouncerVisuals();
    const now = performance.now();
    for (let index = this.effects.length - 1; index >= 0; index--) {
      const effect = this.effects[index];
      const progress = Math.min(1, (now - effect.started) / effect.duration);
      const trackedPosition = effect.track?.();
      if (trackedPosition) {
        effect.mesh.position.copyFrom(toBabylonPosition(trackedPosition));
        effect.light?.position.copyFrom(effect.mesh.position);
      }
      const fade = effect.fadeStart === undefined ? 1 - progress
        : progress <= effect.fadeStart ? 1 : 1 - (progress - effect.fadeStart) / (1 - effect.fadeStart);
      const decalIndex = this.decals.indexOf(effect);
      const capacityFade = decalIndex < 0 ? 1
        : decalCapacityOpacity(decalIndex, this.decals.length, DECAL_QUALITY_SETTINGS[this.decalQuality].maximum);
      effect.mesh.visibility = this.renderingEnabled ? (effect.fadeMesh === false ? 1 : fade * capacityFade) : 0;
      effect.mesh.scaling.setAll(effect.startScale + (effect.endScale - effect.startScale) * progress);
      effect.update?.(progress);
      if (effect.light) effect.light.intensity = (1 - progress) * 2;
      if (progress >= 1) {
        this.disposeEffect(effect);
        this.effects.splice(index, 1);
        const decalIndex = this.decals.indexOf(effect);
        if (decalIndex >= 0) this.decals.splice(decalIndex, 1);
      }
    }
    this.systems.forEach((system) => {
      const expiresAt = this.systemExpiresAt.get(system);
      const gpuExpired = system instanceof GPUParticleSystem && expiresAt !== undefined && now >= expiresAt;
      const cpuExpired = system instanceof ParticleSystem && system.isStarted() && system.manualEmitCount === 0 &&
        system.getActiveCount() === 0;
      if (!gpuExpired && !cpuExpired) return;
      this.systems.delete(system);
      const recipe = this.systemRecipes.get(system) ?? "";
      this.systemRecipes.delete(system);
      this.systemExpiresAt.delete(system);
      this.systemEmitterCounts.delete(system);
      system.stop();
      if (system instanceof ParticleSystem) system.reset();
      if (this.systemPool.length < MAX_POOLED_PARTICLE_SYSTEMS) {
        this.systemPool.push({
          system,
          capacity: system.getCapacity(),
          tiled: system.isAnimationSheetEnabled,
          backend: system instanceof GPUParticleSystem ? "gpu" : "cpu",
          recipe,
          batchData: this.systemBatchData.get(system),
        });
      } else {
        this.originalSystemRender.delete(system);
        this.systemBatchData.delete(system);
        system.dispose(false);
      }
    });
    this.particleCpuUpdateTime = performance.now() - updateStartedAt;
  }

  private updateBouncerVisuals(): void {
    this.bouncers.forEach((bouncer) => {
      if (bouncer.dirty) {
        Quaternion.RotationYawPitchRollToRef(-bouncer.yaw * Math.PI / 180, bouncer.roll * Math.PI / 180, 0, bouncer.rotation);
        bouncer.meshes.forEach((mesh) => {
          mesh.position.set(bouncer.position.x, bouncer.position.z, bouncer.position.y);
          mesh.rotationQuaternion!.copyFrom(bouncer.rotation);
          mesh.instancedBuffers.color.set(1, 1, 1, bouncer.fade);
          mesh.isVisible = this.renderingEnabled;
        });
        bouncer.dirty = false;
      }
      if (bouncer.smoke) {
        this.splash(bouncer.position, "smoke.png", 0x404040, 2.4, 1, 150, 50, -20);
        bouncer.smoke = false;
      }
    });
  }

  private disposeEffect(effect: SpriteEffect, reuseMesh = true): void {
    effect.light?.dispose();
    const pool = effect.reusableMesh === "sprite" ? this.spritePool : effect.reusableMesh === "beam" ? this.beamPool
      : effect.reusableMesh === "fireball-red" ? this.fireballPools[0]
        : effect.reusableMesh === "fireball-blue" ? this.fireballPools[1] : undefined;
    const limit = effect.reusableMesh === "beam" ? MAX_POOLED_BEAMS
      : effect.reusableMesh === "fireball-red" || effect.reusableMesh === "fireball-blue" ? MAX_POOLED_FIREBALLS : MAX_POOLED_SPRITES;
    if (reuseMesh && pool && pool.length < limit) {
      effect.mesh.setEnabled(false);
      effect.mesh.visibility = 1;
      effect.mesh.metadata = undefined;
      pool.push(effect.mesh);
    } else this.disposeMesh(effect.mesh);
  }

  private removeDecal(effect: SpriteEffect): void {
    const effectIndex = this.effects.indexOf(effect);
    if (effectIndex >= 0) this.effects.splice(effectIndex, 1);
    const decalIndex = this.decals.indexOf(effect);
    if (decalIndex >= 0) this.decals.splice(decalIndex, 1);
    this.disposeEffect(effect, false);
  }

  private disposeMesh(mesh: Mesh): void {
    mesh.dispose();
  }
}

/** Expands Sauerbraten's packed 0xRGB entity attribute to 0xRRGGBB. */
export function sauerParticleColor(attribute: number): number {
  return (((attribute & 0x00f) << 4) | ((attribute & 0x0f0) << 8) | ((attribute & 0xf00) << 12)) + 0x0f0f0f;
}

/** Matches renderparticles.cpp offsetvec: 0/1/2 are +Z/+X/+Y and 3/4/5 are their negatives. */
export function sauerParticleOffset(origin: Vec3, direction: number, distance: number): Vec3 {
  const result = { ...origin };
  const axis = (2 + direction) % 3;
  const amount = direction > 2 ? -distance : distance;
  if (axis === 0) result.x += amount;
  else if (axis === 1) result.y += amount;
  else result.z += amount;
  return result;
}

/** Native quad vertices extend by size on both sides, while Babylon's particle size is the complete width. */
export function sauerParticleDiameter(size: number): number {
  return size * 2;
}

/** Fades the oldest 20% as the decal pool fills, so capacity eviction is visually imperceptible. */
export function decalCapacityOpacity(index: number, count: number, maximum: number): number {
  if (maximum <= 0 || count <= maximum * 0.75) return 1;
  const pressure = Math.min(1, (count / maximum - 0.75) / 0.25);
  return Math.min(1, Math.max(0, 1 - pressure + index / Math.max(1, maximum * 0.2)));
}

/** Exact renderparticles.cpp calc() trajectory, with elapsed time in milliseconds. */
export function sauerParticlePosition(origin: Vec3, velocity: Vec3, gravity: number, elapsedMs: number): Vec3 {
  if (!gravity) return { ...origin };
  return {
    x: origin.x + velocity.x * elapsedMs / 5000,
    y: origin.y + velocity.y * elapsedMs / 5000,
    z: origin.z + velocity.z * elapsedMs / 5000 - elapsedMs * elapsedMs / (2 * 5000 * gravity),
  };
}

function shapedEndpoint(origin: Vec3, direction: number, radius: number, angle: number): Vec3 {
  const axis = direction % 3;
  const result = { ...origin };
  const first = axis === 0 ? "x" : axis === 1 ? "y" : "z";
  const secondAxis = (axis + 1) % 3;
  const second = secondAxis === 0 ? "x" : secondAxis === 1 ? "y" : "z";
  result[first] += Math.sin(angle) * radius;
  result[second] += Math.cos(angle) * radius;
  return result;
}

function particleColor3(color: number): Color3 {
  return new Color3((color >> 16 & 0xff) / 255, (color >> 8 & 0xff) / 255, (color & 0xff) / 255);
}

function particleColor4(color: number, alpha: number): Color4 {
  const value = particleColor3(color);
  return new Color4(value.r, value.g, value.b, alpha);
}

function particleUrl(texture: ParticleTexture): string {
  return packageAssetUrl(`particles/${texture}`) ?? "";
}

/** Camera-facing texture projection used by explosion.h for fireball texgen. */
export function explosionTexgenBasis(center: Vector3, cameraPosition: Vector3, cameraRight: Vector3,
                                     cameraUp: Vector3): { right: Vector3; up: Vector3 } {
  const view = center.subtract(cameraPosition);
  if (view.lengthSquared() < 1e-8) return { right: cameraRight.normalizeToNew(), up: cameraUp.normalizeToNew() };
  view.normalize();
  let right = Vector3.Cross(Vector3.Up(), view);
  if (right.lengthSquared() < 1e-8) right = cameraRight.clone();
  right.normalize();
  const up = Vector3.Cross(view, right).normalize();
  return { right, up };
}

// Original: src/fpsgame/game.h, src/fpsgame/render.cpp
// Functions: m_insta, preload()
// Sauerbraten reference: SVN r6488
export function combatGunsForMode(mode: number, multiplayer: boolean): Gun[] {
  if (gameModeHas(mode, GameModeFlag.Insta)) return [Gun.Rifle];
  const guns = [Gun.Fist, Gun.Shotgun, Gun.Chaingun, Gun.Rocket, Gun.Rifle, Gun.Grenade, Gun.Pistol];
  if (!multiplayer && (gameModeHas(mode, GameModeFlag.ClassicSp) || gameModeHas(mode, GameModeFlag.Dmsp))) {
    guns.push(Gun.Fireball, Gun.Iceball, Gun.Slimeball, Gun.Bite, Gun.Barrel);
  }
  return guns;
}

function combatVariantNames(guns: readonly Gun[], decals: boolean): string[] {
  const variants = new Set<string>();
  const hasHitscan = guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Chaingun || gun === Gun.Rifle || gun === Gun.Pistol);
  if (hasHitscan) variants.add("sparks:additive");
  if (guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Chaingun || gun === Gun.Pistol)) variants.add("tracer:additive");
  if (guns.some((gun) => gun >= Gun.Shotgun && gun <= Gun.Grenade || gun === Gun.Pistol)) variants.add("muzzle-flash:additive");
  if (guns.some((gun) => gun === Gun.Rifle || gun === Gun.Rocket || gun === Gun.Grenade ||
      gun === Gun.Fireball || gun === Gun.Iceball || gun === Gun.Slimeball)) variants.add("smoke:alpha");
  if (guns.includes(Gun.Rocket)) variants.add("explosion:red-shader");
  if (guns.includes(Gun.Grenade)) variants.add("explosion:blue-shader");
  if (guns.some((gun) => gun === Gun.Fireball || gun === Gun.Iceball || gun === Gun.Slimeball)) variants.add("monster-projectiles:alpha");
  if (decals && hasHitscan) variants.add("decal:bullet-multiply");
  if (decals) variants.add("decal:blood-alpha-test");
  if (decals && guns.some((gun) => gun === Gun.Rocket || gun === Gun.Grenade)) variants.add("decal:scorch-alpha-test");
  variants.add("bouncers:gibs-instanced");
  if (guns.includes(Gun.Grenade)) variants.add("bouncers:grenade-instanced");
  if (guns.includes(Gun.Rocket)) variants.add("projectile:rocket-instanced");
  if (guns.some((gun) => gun === Gun.Rocket || gun === Gun.Grenade || gun === Gun.Barrel)) variants.add("bouncers:debris-instanced");
  return [...variants];
}

function combatSpriteVariants(guns: readonly Gun[]): Array<{ texture: ParticleTexture; color: number; additive: boolean }> {
  const variants: Array<{ texture: ParticleTexture; color: number; additive: boolean }> = [];
  const add = (texture: ParticleTexture, color: number, additive: boolean): void => {
    if (!variants.some((variant) => variant.texture === texture && variant.color === color && variant.additive === additive)) {
      variants.push({ texture, color, additive });
    }
  };
  const hasHitscan = guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Chaingun || gun === Gun.Rifle || gun === Gun.Pistol);
  if (hasHitscan) add("spark.png", 0xb49b4b, true);
  if (guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Chaingun || gun === Gun.Pistol)) add("flare.jpg", 0xffc864, true);
  if (guns.some((gun) => gun === Gun.Rifle || gun === Gun.Rocket || gun === Gun.Grenade || gun >= Gun.Fireball && gun <= Gun.Slimeball)) {
    add("smoke.png", 0x404040, false);
  }
  if (guns.some((gun) => gun === Gun.Shotgun || gun === Gun.Rifle)) add("muzzleflash3.jpg", 0xffffff, true);
  if (guns.some((gun) => gun === Gun.Chaingun || gun === Gun.Pistol)) add("muzzleflash1.jpg", 0xffffff, true);
  if (guns.some((gun) => gun === Gun.Rocket || gun === Gun.Grenade)) add("muzzleflash2.jpg", 0xffffff, true);
  if (guns.includes(Gun.Fireball)) add("ball1.png", 0xffc8c8, false);
  if (guns.includes(Gun.Iceball)) add("ball2.png", 0xffffff, false);
  if (guns.includes(Gun.Slimeball)) add("ball3.png", 0xffffff, false);
  return variants;
}

function combatBouncerCapacities(guns: readonly Gun[], mobile: boolean): Array<[number, number]> {
  const result: Array<[number, number]> = [];
  if (guns.includes(Gun.Grenade)) result.push([0, mobile ? 3 : 8]);
  for (let modelIndex = 1; modelIndex <= 3; modelIndex++) result.push([modelIndex, mobile ? 5 : 14]);
  if (guns.some((gun) => gun === Gun.Rocket || gun === Gun.Grenade || gun === Gun.Barrel)) {
    for (let modelIndex = 4; modelIndex <= 7; modelIndex++) result.push([modelIndex, mobile ? 3 : 8]);
  }
  if (guns.includes(Gun.Barrel)) for (let modelIndex = 8; modelIndex <= 11; modelIndex++) result.push([modelIndex, mobile ? 2 : 4]);
  if (guns.includes(Gun.Rocket)) result.push([12, mobile ? 3 : 8]);
  return result;
}

function bouncerVariantName(modelIndex: number): string {
  if (modelIndex === 0) return "grenade mesh";
  if (modelIndex <= 3) return "gib mesh";
  if (modelIndex <= 7) return "debris mesh";
  if (modelIndex <= 11) return "barrel debris mesh";
  return "rocket mesh";
}

async function yieldForPrewarm(): Promise<void> {
  if (typeof requestAnimationFrame === "function") await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
  else await Promise.resolve();
}

/** Exact 12x6 sphere topology and UV layout from src/engine/explosion.h. */
function createExplosionSphere(scene: Scene): Mesh {
  const slices = 12, stacks = 6, stride = slices + 1;
  const positions: number[] = [], uvs: number[] = [], indices: number[] = [];
  for (let stack = 0; stack <= stacks; stack++) {
    const t = 1 - stack / stacks;
    const rho = Math.PI * (1 - t);
    const sineRho = stack > 0 && stack < stacks ? Math.sin(rho) : 0;
    const cosineRho = stack === 0 ? 1 : stack < stacks ? Math.cos(rho) : -1;
    for (let slice = 0; slice <= slices; slice++) {
      const s = slice / slices;
      const theta = slice === slices ? 0 : 2 * Math.PI * s;
      // Sauerbraten is Z-up; Babylon is Y-up.
      positions.push(-Math.sin(theta) * sineRho, cosineRho, Math.cos(theta) * sineRho);
      uvs.push(s, t);
    }
  }
  for (let stack = 0; stack < stacks; stack++) {
    for (let index = 0; index < slices; index++) {
      const slice = stack % 2 ? slices - index - 1 : index;
      if (stack > 0) indices.push(stack * stride + slice, (stack + 1) * stride + slice, stack * stride + slice + 1);
      if (stack + 1 < stacks) {
        indices.push(stack * stride + slice + 1, (stack + 1) * stride + slice, (stack + 1) * stride + slice + 1);
      }
    }
  }
  const mesh = new Mesh("weapon-explosion-fireball", scene);
  const data = new VertexData();
  data.positions = positions;
  data.uvs = uvs;
  data.indices = indices;
  data.applyToMesh(mesh, false);
  return mesh;
}

function randomSphereVector(radius: number): Vec3 {
  let result: Vec3;
  do {
    result = {
      x: randomInteger(-radius, radius - 1), y: randomInteger(-radius, radius - 1), z: randomInteger(-radius, radius - 1),
    };
  } while (result.x * result.x + result.y * result.y + result.z * result.z > radius * radius);
  return result;
}

function randomInteger(minimum: number, maximum: number): number {
  return minimum + Math.floor(Math.random() * (maximum - minimum + 1));
}

function randomRange(minimum: number, maximum: number): number {
  return minimum + Math.random() * (maximum - minimum);
}

let batchedCustomEmitterSimulationEnabled = false;

function enableBatchedCustomEmitterSimulation(): void {
  if (batchedCustomEmitterSimulationEnabled) return;
  const key = "gpuUpdateParticlesVertexShader";
  const source = ShaderStore.ShadersStore[key];
  if (!source) throw new Error("Babylon's GPU particle update shader is unavailable.");
  const positionSource = "outPosition=position+(direction-position)*ageGradient;";
  const positionReplacement = "outPosition=position+direction*directionScale;";
  const randomSource = "vec4 getRandomVec4(float offset) {return texture(randomSampler,vec2(float(gl_VertexID)*offset/currentCount,0));}";
  const randomReplacement = `${randomSource}
#ifdef CUSTOMEMITTER
vec4 sauerEmitterData(float emitterU,float row) {return texture(flowMapSampler,vec2(emitterU,(row+0.5)/7.0));}
#endif`;
  const spawnSource = "newPosition=initialPosition;outInitialPosition=initialPosition;";
  const spawnReplacement = `vec4 sauer0=sauerEmitterData(initialPosition.x,0.0);
vec4 sauer1=sauerEmitterData(initialPosition.x,1.0);
vec4 sauer2=sauerEmitterData(initialPosition.x,2.0);
vec4 sauer3=sauerEmitterData(initialPosition.x,3.0);
vec4 sauer5=sauerEmitterData(initialPosition.x,5.0);
vec4 sauer6=sauerEmitterData(initialPosition.x,6.0);
vec3 sauerRandomPosition=getRandomVec3(seed.y);
vec3 sauerRandomVelocity=getRandomVec3(seed.z);
newPosition=sauer0.xyz+mix(sauer5.xyz,sauer6.xyz,sauerRandomPosition);
if (sauer0.w<0.5) {newDirection=mix(sauer1.xyz,sauer2.xyz,sauerRandomVelocity);}
else if (sauer0.w<1.5) {
vec3 sphereDirection=normalize(sauerRandomVelocity*2.0-1.0);
newDirection=sphereDirection*pow(max(randoms.a,0.000001),1.0/3.0)*sauer2.x;
} else {newDirection=mix(sauer1.xyz,sauer2.xyz,sauerRandomVelocity);}
float sauerFadeLife=mix(sauer1.w,sauer2.w,randoms.r);
outLife=sauerFadeLife;
outAge=life<=0.0 ? initialPosition.y*outLife : 0.0;
if (life<=0.0) {
float sauerInitialGravity=sauer3.x;
newPosition+=newDirection*outAge+vec3(0.0,0.5*sauerInitialGravity*outAge*outAge,0.0);
newDirection+=vec3(0.0,sauerInitialGravity*outAge,0.0);
}
outSize=vec3(mix(sauer3.y,sauer3.z,randoms.g),initialPosition.x,sauerFadeLife);
outInitialPosition=initialPosition;`;
  const spawnDirectionSource = `#ifdef CUSTOMEMITTER
outDirection=direction;
#ifndef BILLBOARD`;
  const spawnDirectionReplacement = `#ifdef CUSTOMEMITTER
outDirection=newDirection;
#ifndef BILLBOARD`;
  const gravitySource = `#ifdef CUSTOMEMITTER
outDirection=direction;
#else
vec3 updatedDirection=direction+gravity*timeDelta;`;
  const gravityReplacement = `#ifdef CUSTOMEMITTER
outDirection=direction+vec3(0.0,sauerEmitterData(initialPosition.x,3.0).x,0.0)*timeDelta;
#else
vec3 updatedDirection=direction+gravity*timeDelta;`;
  const patched = source.replace(randomSource, randomReplacement).replace(spawnSource, spawnReplacement)
    .replace(spawnDirectionSource, spawnDirectionReplacement).replace(positionSource, positionReplacement)
    .replace(gravitySource, gravityReplacement);
  if (patched === source) throw new Error("Babylon's GPU particle shader layout changed; batched emitter patch was not applied.");
  ShaderStore.ShadersStore[key] = patched;
  patchBatchedParticleRenderShader();
  batchedCustomEmitterSimulationEnabled = true;
}

function patchBatchedParticleRenderShader(): void {
  const key = "gpuRenderParticlesVertexShader";
  const source = ShaderStore.ShadersStore[key];
  if (!source) throw new Error("Babylon's GPU particle render shader is unavailable.");
  const deadSource = "#endif\n#ifdef ANIMATESHEET\nfloat rowOffset=";
  const deadReplacement = `#endif
#ifdef SAUER_BATCH
if (age>=size.z) {gl_Position=vec4(0.0,0.0,2.0,1.0);vColor=vec4(0.0);vUV=vec2(0.0);vPositionW=vec3(0.0);return;}
#endif
#ifdef ANIMATESHEET
float rowOffset=`;
  const colorSource = "vColor=texture2D(colorGradientSampler,vec2(ratio,0));";
  const colorReplacement = `#ifdef SAUER_BATCH
vec4 sauerColor=texture2D(colorGradientSampler,vec2(size.y,4.5/7.0));
vColor=vec4(sauerColor.rgb,sauerColor.a*clamp((1.0-age/size.z)*4.0,0.0,1.0));
#else
vColor=texture2D(colorGradientSampler,vec2(ratio,0));
#endif`;
  const sizeSource = "vec2 cornerPos=(offset-translationPivot)*size.yz*size.x;";
  const sizeReplacement = `#ifdef SAUER_BATCH
float sauerEndSize=texture2D(colorGradientSampler,vec2(size.y,3.5/7.0)).w;
vec2 cornerPos=(offset-translationPivot)*mix(size.x,sauerEndSize,min(1.0,age/size.z));
#else
vec2 cornerPos=(offset-translationPivot)*size.yz*size.x;
#endif`;
  const patched = source.replace(deadSource, deadReplacement).replace(colorSource, colorReplacement)
    .replace(sizeSource, sizeReplacement);
  if (patched === source) throw new Error("Babylon's GPU particle render shader layout changed; batching patch was not applied.");
  ShaderStore.ShadersStore[key] = patched;
}

export function resolveParticleBackend(requested: ParticleBackend, gpuSupported = GPUParticleSystem.IsSupported): ResolvedParticleBackend {
  if (requested === "cpu") return "cpu";
  return gpuSupported ? "gpu" : "cpu";
}
