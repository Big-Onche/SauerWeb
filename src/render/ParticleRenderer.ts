import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
import type { Camera } from "@babylonjs/core/Cameras/camera";
import "@babylonjs/core/Culling/ray";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Material } from "@babylonjs/core/Materials/material";
import { ShaderMaterial } from "@babylonjs/core/Materials/shaderMaterial";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Quaternion, Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Particle } from "@babylonjs/core/Particles/particle";
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
import { toBabylonDirection, toBabylonPosition } from "./coordinates";
import { selectModelSkin } from "./modelSkin";

type ParticleTexture = "ball1.png" | "ball2.png" | "ball3.png" | "base.png" | "explosion.png" | "flames.png" | "flare.jpg" |
  "lensflares.png" | "lightning.jpg" | "muzzleflash1.jpg" | "muzzleflash2.jpg" | "muzzleflash3.jpg" | "plasma.png" | "smoke.png" |
  "snow.png" | "spark.png" | "steam.png" | "blood.png" | "scorch.png";

interface SpriteEffect {
  mesh: Mesh;
  started: number;
  duration: number;
  startScale: number;
  endScale: number;
  reusableMesh?: "sprite" | "beam";
  light?: PointLight;
  track?: () => Vec3 | undefined;
  update?: (progress: number) => void;
  fadeMesh?: boolean;
  ownedMaterial?: Material;
}

interface PooledParticleSystem {
  system: ParticleSystem;
  capacity: number;
  tiled: boolean;
}

interface ProjectileEffect {
  gun: Gun;
  position: Vec3;
  mesh?: Mesh;
}

interface BouncerEffect {
  meshes: Mesh[];
  position: Vec3;
}

interface ParticleOptions {
  texture: ParticleTexture;
  color: number;
  size: number;
  fadeMinMs: number;
  fadeMaxMs: number;
  rate?: number;
  count?: number;
  radius?: number;
  direction?: Vector3;
  spread?: number;
  speed?: number;
  velocityRadius?: number;
  velocityBox?: number;
  gravity?: number;
  additive?: boolean;
  startPosition?: () => Vector3;
  fadeAtIndex?: (index: number) => number;
}

interface SauerParticleState {
  origin: Vector3;
  velocity: Vector3;
  gravity: number;
  fadeMs: number;
  ageMs: number;
}

const SAUER_EMIT_MILLIS = 17;
const MAX_POOLED_PARTICLE_SYSTEMS = 16;
const MAX_POOLED_SPRITES = 64;
const MAX_POOLED_BEAMS = 128;
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

/** Babylon presentation of Sauerbraten's renderparticles.cpp particle recipes. */
export class ParticleRenderer {
  private readonly systems = new Set<ParticleSystem>();
  private readonly systemPool: PooledParticleSystem[] = [];
  private readonly spritePool: Mesh[] = [];
  private readonly beamPool: Mesh[] = [];
  private readonly textures = new Map<string, Texture>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly persistentMeshes = new Set<Mesh>();
  private readonly effects: SpriteEffect[] = [];
  private readonly projectiles = new Map<number, ProjectileEffect>();
  private readonly bouncers = new Map<string, BouncerEffect>();
  private bouncerTemplates?: Promise<Map<number, Mesh[]>>;
  private renderingEnabled = true;

  constructor(private readonly scene: Scene, events: WeaponEvents, private readonly playerCamera: Camera,
              private readonly taggedMuzzle: (event: WeaponEvent) => Vec3 | undefined) {
    events.on((event) => this.handleWeaponEvent(event));
  }

  loadMap(entities: readonly RegisteredMapEntity[]): void {
    this.clear();
    entities.filter((entity) => entity.typeName === "particles").forEach((entity) => this.createMapEmitter(entity));
    this.scene.onBeforeRenderObservable.add(() => this.update());
  }

  setRenderingEnabled(enabled: boolean): void {
    this.renderingEnabled = enabled;
    this.systems.forEach((system) => { system.layerMask = enabled ? PARTICLE_LAYER_MASK : 0; });
    this.systemPool.forEach(({ system }) => { system.layerMask = enabled ? PARTICLE_LAYER_MASK : 0; });
    this.persistentMeshes.forEach((mesh) => { mesh.isVisible = enabled; });
    this.effects.forEach((effect) => { effect.mesh.isVisible = enabled; });
    this.projectiles.forEach((projectile) => { if (projectile.mesh) projectile.mesh.isVisible = enabled; });
    this.bouncers.forEach((bouncer) => bouncer.meshes.forEach((mesh) => { mesh.isVisible = enabled; }));
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

  clear(): void {
    this.systems.forEach((system) => system.dispose(false));
    this.systems.clear();
    this.effects.forEach((effect) => this.disposeEffect(effect, false));
    this.effects.length = 0;
    this.persistentMeshes.forEach((mesh) => this.disposeMesh(mesh));
    this.persistentMeshes.clear();
    this.projectiles.forEach((projectile) => projectile.mesh && this.disposeMesh(projectile.mesh));
    this.projectiles.clear();
    this.bouncers.forEach((bouncer) => bouncer.meshes.forEach((mesh) => mesh.dispose(false, false)));
    this.bouncers.clear();
    this.bouncerTemplates = undefined;
    this.systemPool.forEach(({ system }) => system.dispose(false));
    this.systemPool.length = 0;
    this.spritePool.forEach((mesh) => mesh.dispose());
    this.spritePool.length = 0;
    this.beamPool.forEach((mesh) => mesh.dispose());
    this.beamPool.length = 0;
    this.materials.forEach((material) => material.dispose(false, false));
    this.materials.clear();
    this.textures.forEach((texture) => texture.dispose());
    this.textures.clear();
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
    this.particleSystem(`map-${texture}`, position, {
      texture, color, size, fadeMinMs: 1, fadeMaxMs: fadeMs * 3, rate: count * 1000 / SAUER_EMIT_MILLIS, velocityRadius, gravity,
      startPosition: () => toBabylonPosition(sauerParticleOffset(position, direction, Math.floor(Math.random() * 10))),
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
    else if (event.type === "projectile-spawned") this.spawnProjectile(event.id, event.gun, event.position);
    else if (event.type === "projectile-moved") this.moveProjectile(event.id, event.position);
    else if (event.type === "bouncer-spawned") void this.spawnBouncer(event.key, event.bouncerType, event.variant, event.position);
    else if (event.type === "bouncer-moved") this.moveBouncer(event.key, event.position, event.yaw, event.roll, event.smoke, event.fade);
    else if (event.type === "bouncer-removed") this.removeBouncer(event.key);
    else if (event.type === "bouncer-impact") this.decal(event.position, event.normal, "blood.png", 0x60ffff,
      2.96 / event.bounces);
    else if (event.type === "explosion") this.explosion(event.gun, event.position, event.radius);
  }

  // Original: src/fpsgame/weapon.cpp
  // Function: shoteffects()
  // Sauerbraten reference: SVN r6488
  private shot(gun: Gun, from: Vec3, to: Vec3, rays: Vec3[], taggedMuzzle?: () => Vec3 | undefined): void {
    const endpoints = rays.length ? rays : [to];
    const muzzle = taggedMuzzle?.() ?? this.muzzlePosition(from, to);
    if (gun === Gun.Shotgun) {
      endpoints.forEach((endpoint) => {
        this.sparks(endpoint, 20, 250);
        this.beam(muzzle, endpoint, "flare.jpg", 0xffc864, 0.28, 300);
      });
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 2.75, 200, 30, taggedMuzzle);
    } else if (gun === Gun.Chaingun || gun === Gun.Pistol) {
      this.sparks(endpoints[0], 200, 250);
      this.beam(muzzle, endpoints[0], "flare.jpg", 0xffc864, 0.28, 600);
      this.muzzleFlash(muzzle, "muzzleflash1.jpg", gun === Gun.Chaingun ? 2.25 : 1.25, gun === Gun.Chaingun ? 100 : 200,
        gun === Gun.Chaingun ? 30 : 15, taggedMuzzle);
    } else if (gun === Gun.Rifle) {
      this.sparks(endpoints[0], 200, 250);
      this.trail(muzzle, endpoints[0], "smoke.png", 0x404040, 0.6, 500, 20);
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 1.25, 150, 25, taggedMuzzle);
    } else if (gun === Gun.Rocket) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 3, 250, 0, taggedMuzzle);
    else if (gun === Gun.Grenade) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 1.5, 200, 20, taggedMuzzle);
  }

  private spawnProjectile(id: number, gun: Gun, position: Vec3): void {
    const projectile: ProjectileEffect = { gun, position: { ...position } };
    const texture = gun === Gun.Iceball ? "ball2.png" : gun === Gun.Slimeball ? "ball3.png" : "ball1.png";
    const color = gun === Gun.Iceball ? 0x80ffff : gun === Gun.Slimeball ? 0x80ff80 : gun === Gun.Grenade ? 0x80ffff : 0xffc8c8;
    const material = this.spriteMaterial(`projectile-${id}`, texture, color, true);
    const nativeSize = gun === Gun.Rocket ? 2.5 : 4.8;
    const mesh = MeshBuilder.CreatePlane(`weapon-projectile-${id}`, { size: sauerParticleDiameter(nativeSize) }, this.scene);
    mesh.isVisible = this.renderingEnabled;
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.isPickable = false;
    mesh.material = material;
    projectile.mesh = mesh;
    this.projectiles.set(id, projectile);
  }

  private moveProjectile(id: number, position: Vec3): void {
    const projectile = this.projectiles.get(id);
    if (!projectile) return;
    projectile.position = { ...position };
    projectile.mesh?.position.copyFrom(toBabylonPosition(position));
    const magic = projectile.gun === Gun.Fireball || projectile.gun === Gun.Iceball || projectile.gun === Gun.Slimeball;
    this.splash(position, "smoke.png", 0x404040, magic ? 0.6 : 2.4, 2, 300, magic ? 150 : 50, -20);
  }

  // Original: src/fpsgame/weapon.cpp renderbouncers()/preloadbouncers().
  private async spawnBouncer(key: string, type: number, variant: number, position: Vec3): Promise<void> {
    const modelIndex = type === 0 ? 0 : type === 1 ? 1 + variant : type === 2 ? 4 + variant : 8 + variant;
    if (this.bouncers.has(key)) return;
    const effect: BouncerEffect = { meshes: [], position: { ...position } };
    this.bouncers.set(key, effect);
    const templates = await (this.bouncerTemplates ??= this.loadBouncerTemplates());
    if (this.bouncers.get(key) !== effect) return;
    const meshes = (templates.get(modelIndex) ?? []).map((template) => {
      const mesh = template.clone(`bouncer-${key}-${template.name}`, null, false)!;
      mesh.setEnabled(true);
      mesh.isVisible = this.renderingEnabled;
      mesh.position.copyFrom(toBabylonPosition(effect.position));
      mesh.isPickable = false;
      return mesh;
    });
    effect.meshes = meshes;
  }

  private moveBouncer(key: string, position: Vec3, yaw: number, roll: number, smoke: boolean, fade: number): void {
    const bouncer = this.bouncers.get(key);
    if (!bouncer) return;
    bouncer.position = { ...position };
    const rotation = Quaternion.RotationYawPitchRoll(-yaw * Math.PI / 180, roll * Math.PI / 180, 0);
    bouncer.meshes.forEach((mesh) => {
      mesh.position.copyFrom(toBabylonPosition(position));
      mesh.rotationQuaternion = rotation;
      mesh.visibility = fade;
    });
    if (smoke) this.splash(position, "smoke.png", 0x404040, 2.4, 1, 150, 50, -20);
  }

  private removeBouncer(key: string): void {
    const bouncer = this.bouncers.get(key);
    bouncer?.meshes.forEach((mesh) => mesh.dispose(false, false));
    this.bouncers.delete(key);
  }

  private async loadBouncerTemplates(): Promise<Map<number, Mesh[]>> {
    const response = await fetch("/api/bouncers", { cache: "no-store" });
    if (!response.ok) throw new Error(`Bouncer manifest request failed (${response.status}).`);
    const assets = await response.json() as MapModelAsset[];
    const result = new Map<number, Mesh[]>();
    await Promise.all(assets.map(async (asset) => {
      if (asset.status !== "ready" || !asset.geometryPath) return;
      const geometry = await this.fetchBouncerGeometry(asset);
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

  private explosion(gun: Gun, position: Vec3, radius: number): void {
    let closest: [number, ProjectileEffect] | undefined;
    this.projectiles.forEach((projectile, id) => {
      const distance = Math.hypot(projectile.position.x - position.x, projectile.position.y - position.y, projectile.position.z - position.z);
      if (projectile.gun === gun && (!closest || distance < Math.hypot(closest[1].position.x - position.x, closest[1].position.y - position.y,
        closest[1].position.z - position.z))) closest = [id, projectile];
    });
    if (closest) {
      const [id, projectile] = closest;
      if (projectile.mesh) this.disposeMesh(projectile.mesh);
      this.projectiles.delete(id);
    }
    const magic = gun === Gun.Fireball || gun === Gun.Iceball || gun === Gun.Slimeball;
    this.sparks(position, magic ? 100 : 200, magic ? 200 : 300);
    if (magic) return;
    this.decal(position, { x: 0, y: 0, z: 1 }, "scorch.png", 0xffffff, radius / 2);
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
    material.setVector3("center", toBabylonPosition(position));
    material.setColor3("color", particleColor3(blue ? 0x80ffff : 0xff8080));
    material.setFloat("fade", 1);
    material.onBindObservable.add(() => {
      const camera = this.scene.activeCamera ?? this.playerCamera;
      const basis = explosionTexgenBasis(toBabylonPosition(position), camera.globalPosition,
        camera.getDirection(Vector3.Right()), camera.getDirection(Vector3.Up()));
      material.setVector3("cameraRight", basis.right);
      material.setVector3("cameraUp", basis.up);
    });

    const mesh = createExplosionSphere(this.scene);
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.scaling.setAll(4);
    mesh.isPickable = false;
    mesh.isVisible = this.renderingEnabled;
    mesh.material = material;
    const started = performance.now();
    const effect: SpriteEffect = {
      mesh, started, duration, startScale: 4, endScale: radius, fadeMesh: false, ownedMaterial: material,
      update: (progress) => {
        material.setFloat("millis", performance.now() / 1000);
        material.setFloat("fade", Math.min(1, (1 - progress) * 4));
      },
    };
    this.effects.push(effect);
    return effect;
  }

  private decal(position: Vec3, normal: Vec3, texture: ParticleTexture, color: number, size: number): void {
    const mesh = MeshBuilder.CreatePlane(`weapon-decal-${texture}`, { size: size * 2 }, this.scene);
    mesh.position.copyFrom(toBabylonPosition(position));
    const direction = toBabylonDirection(normal).normalize();
    mesh.position.addInPlace(direction.scale(0.01));
    mesh.lookAt(mesh.position.add(direction));
    mesh.isPickable = false;
    mesh.isVisible = this.renderingEnabled;
    mesh.material = this.spriteMaterial(`decal-${texture}`, texture, color, false);
    this.effects.push({ mesh, started: performance.now(), duration: 60_000, startScale: 1, endScale: 1 });
  }

  private sparks(position: Vec3, count: number, fadeMs: number): void {
    this.splash(position, "spark.png", 0xb49b4b, 0.24, count, fadeMs, 150, 20, true);
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
      startPosition: () => Vector3.Lerp(start, end, Math.min(1, ++emitted / count)),
    });
  }

  private particleSystem(name: string, position: Vec3, options: ParticleOptions): ParticleSystem {
    const capacity = Math.max(8, options.count ?? Math.ceil((options.rate ?? 10) * options.fadeMaxMs / 1000 * 1.1));
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    const pooledIndex = this.systemPool.findIndex((entry) => entry.tiled === tiled && entry.capacity >= capacity &&
      entry.capacity <= capacity * 2);
    const pooled = pooledIndex >= 0 ? this.systemPool.splice(pooledIndex, 1)[0] : undefined;
    const system = pooled?.system ?? new ParticleSystem(name, capacity, this.scene, undefined, tiled);
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
    system.createBoxEmitter(low, high, new Vector3(-(options.radius ?? 0), 0, -(options.radius ?? 0)),
      new Vector3(options.radius ?? 0, 0, options.radius ?? 0));
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
          states.delete(particle);
          particles.splice(index, 1);
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
    return system;
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

  private particleTexture(name: ParticleTexture): Texture {
    let texture = this.textures.get(name);
    if (texture) return texture;
    texture = new Texture(particleUrl(name), this.scene, false, false);
    texture.hasAlpha = true;
    this.textures.set(name, texture);
    return texture;
  }

  private update(): void {
    const now = performance.now();
    for (let index = this.effects.length - 1; index >= 0; index--) {
      const effect = this.effects[index];
      const progress = Math.min(1, (now - effect.started) / effect.duration);
      const trackedPosition = effect.track?.();
      if (trackedPosition) {
        effect.mesh.position.copyFrom(toBabylonPosition(trackedPosition));
        effect.light?.position.copyFrom(effect.mesh.position);
      }
      effect.mesh.visibility = this.renderingEnabled ? (effect.fadeMesh === false ? 1 : 1 - progress) : 0;
      effect.mesh.scaling.setAll(effect.startScale + (effect.endScale - effect.startScale) * progress);
      effect.update?.(progress);
      if (effect.light) effect.light.intensity = (1 - progress) * 2;
      if (progress >= 1) {
        this.disposeEffect(effect);
        this.effects.splice(index, 1);
      }
    }
    this.systems.forEach((system) => {
      if (!system.isStarted() || system.manualEmitCount !== 0 || system.getActiveCount() > 0) return;
      this.systems.delete(system);
      system.stop();
      system.reset();
      if (this.systemPool.length < MAX_POOLED_PARTICLE_SYSTEMS) {
        this.systemPool.push({ system, capacity: system.getCapacity(), tiled: system.isAnimationSheetEnabled });
      } else system.dispose(false);
    });
  }

  private disposeEffect(effect: SpriteEffect, reuseMesh = true): void {
    effect.light?.dispose();
    effect.ownedMaterial?.dispose(false, false);
    const pool = effect.reusableMesh === "sprite" ? this.spritePool : effect.reusableMesh === "beam" ? this.beamPool : undefined;
    const limit = effect.reusableMesh === "beam" ? MAX_POOLED_BEAMS : MAX_POOLED_SPRITES;
    if (reuseMesh && pool && pool.length < limit) {
      effect.mesh.setEnabled(false);
      effect.mesh.visibility = 1;
      pool.push(effect.mesh);
    } else this.disposeMesh(effect.mesh);
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
