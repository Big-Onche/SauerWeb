import type { Camera } from "@babylonjs/core/Cameras/camera";
import "@babylonjs/core/Culling/ray";
import { PointLight } from "@babylonjs/core/Lights/pointLight";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { ParticleSystem } from "@babylonjs/core/Particles/particleSystem";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { RegisteredMapEntity, Vec3 } from "../map/types";
import { Gun } from "../weapons/WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "../weapons/WeaponEvents";
import { toBabylonDirection, toBabylonPosition } from "./coordinates";

type ParticleTexture = "ball1.png" | "ball2.png" | "ball3.png" | "base.png" | "explosion.png" | "flames.png" | "flare.jpg" |
  "lensflares.png" | "lightning.jpg" | "muzzleflash1.jpg" | "muzzleflash2.jpg" | "muzzleflash3.jpg" | "smoke.png" | "snow.png" |
  "spark.png" | "steam.png";

interface SpriteEffect {
  mesh: Mesh;
  material: StandardMaterial;
  started: number;
  duration: number;
  startScale: number;
  endScale: number;
  light?: PointLight;
}

interface ProjectileEffect {
  gun: Gun;
  position: Vec3;
  mesh?: Mesh;
}

interface ParticleOptions {
  texture: ParticleTexture;
  color: number;
  size: number;
  life: number;
  rate?: number;
  count?: number;
  radius?: number;
  direction?: Vector3;
  spread?: number;
  speed?: number;
  gravity?: number;
  additive?: boolean;
}

/** Babylon presentation of Sauerbraten's renderparticles.cpp particle recipes. */
export class ParticleRenderer {
  private readonly systems = new Set<ParticleSystem>();
  private readonly persistentMeshes = new Set<Mesh>();
  private readonly effects: SpriteEffect[] = [];
  private readonly projectiles = new Map<number, ProjectileEffect>();

  constructor(private readonly scene: Scene, events: WeaponEvents, private readonly playerCamera: Camera) {
    events.on((event) => this.handleWeaponEvent(event));
  }

  loadMap(entities: readonly RegisteredMapEntity[]): void {
    this.clear();
    entities.filter((entity) => entity.typeName === "particles").forEach((entity) => this.createMapEmitter(entity));
    this.scene.onBeforeRenderObservable.add(() => this.update());
  }

  clear(): void {
    this.systems.forEach((system) => system.dispose());
    this.systems.clear();
    this.effects.forEach((effect) => this.disposeEffect(effect));
    this.effects.length = 0;
    this.persistentMeshes.forEach((mesh) => this.disposeMesh(mesh));
    this.persistentMeshes.clear();
    this.projectiles.forEach((projectile) => projectile.mesh && this.disposeMesh(projectile.mesh));
    this.projectiles.clear();
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
        this.directionalEmitter(position, value1, "steam.png", 0x897661, 2.4, 8, 0.6, -20);
        break;
      case 2:
        this.directionalEmitter(position, value1, "base.png", value2 > 0 ? sauerParticleColor(value2) : 0x406080, 0.6, 35, 0.6, 2);
        break;
      case 3:
        this.persistentSprite(position, "explosion.png", sauerParticleColor(value2), Math.max(1, 1 + value1) * 2, true);
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
    if (direction < 256 && (type === 4 || type === 7)) {
      const target = sauerParticleOffset(position, direction, Math.max(1 + length, 0));
      this.beam(position, target, texture, color, size, Number.POSITIVE_INFINITY);
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
    const destination = direction < 256 ? sauerParticleOffset(position, direction, Math.max(1 + length, 0)) : position;
    this.particleSystem(`map-particles-${type}`, destination, {
      texture, color, size, life: Math.max(0.05, (fade > 0 ? Math.min(fade, 10_000) : 200) / 1000), rate: type === 13 ? 12 : 8,
      radius, direction: toBabylonDirection(sauerParticleOffset({ x: 0, y: 0, z: 0 }, directed, 1)), spread: 0.5,
      speed: type === 13 ? 2 : 20, gravity: type === 13 ? 20 : type === 9 ? -20 : 2,
    });
  }

  private directionalEmitter(position: Vec3, direction: number, texture: ParticleTexture, color: number, size: number, rate: number,
                             life: number, gravity: number): void {
    const destination = sauerParticleOffset(position, direction, 5);
    const vector = sauerParticleOffset({ x: 0, y: 0, z: 0 }, direction, 1);
    this.particleSystem(`map-${texture}`, destination, {
      texture, color, size, life, rate, radius: 0.5, direction: toBabylonDirection(vector), spread: 0.7, speed: 25, gravity,
    });
  }

  private flame(position: Vec3, radius: number, height: number, color: number, fire: boolean): void {
    const safeRadius = Math.max(0.01, radius);
    const safeHeight = Math.max(0.01, height);
    this.particleSystem(fire ? "map-flame" : "map-smoke", position, {
      texture: fire ? "flames.png" : "smoke.png", color, size: (fire ? 2 : 4) * Math.min(safeRadius, safeHeight),
      life: (fire ? 0.6 : 2) * safeHeight, rate: fire ? 30 : 8, radius: safeRadius, direction: new Vector3(0, 1, 0), spread: 0.12,
      speed: fire ? 200 * Math.min(1, safeHeight) : 100 * Math.min(1, safeHeight), gravity: -20, additive: fire,
    });
  }

  private handleWeaponEvent(event: WeaponEvent): void {
    if (event.type === "shot") this.shot(event.gun, event.from, event.to, event.rays);
    else if (event.type === "projectile-spawned") this.spawnProjectile(event.id, event.gun, event.position);
    else if (event.type === "projectile-moved") this.moveProjectile(event.id, event.position);
    else if (event.type === "explosion") this.explosion(event.gun, event.position, event.radius);
  }

  private shot(gun: Gun, from: Vec3, to: Vec3, rays: Vec3[]): void {
    const endpoints = rays.length ? rays : [to];
    const muzzle = this.muzzlePosition(from);
    if (gun === Gun.Shotgun) {
      endpoints.forEach((endpoint) => {
        this.sparks(endpoint, 20, 0.25);
        this.beam(muzzle, endpoint, "flare.jpg", 0xffc864, 0.28, 300);
      });
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 2.75, 200, 30);
    } else if (gun === Gun.Chaingun || gun === Gun.Pistol) {
      this.sparks(endpoints[0], 200, 0.25);
      this.beam(muzzle, endpoints[0], "flare.jpg", 0xffc864, 0.28, 600);
      this.muzzleFlash(muzzle, "muzzleflash1.jpg", gun === Gun.Chaingun ? 2.25 : 1.25, gun === Gun.Chaingun ? 100 : 200,
        gun === Gun.Chaingun ? 30 : 15);
    } else if (gun === Gun.Rifle) {
      this.sparks(endpoints[0], 200, 0.25);
      this.trail(muzzle, endpoints[0], "smoke.png", 0x404040, 0.6, 500, 20);
      this.muzzleFlash(muzzle, "muzzleflash3.jpg", 1.25, 150, 25);
    } else if (gun === Gun.Rocket) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 3, 250);
    else if (gun === Gun.Grenade) this.muzzleFlash(muzzle, "muzzleflash2.jpg", 1.5, 200, 20);
  }

  private spawnProjectile(id: number, gun: Gun, position: Vec3): void {
    const projectile: ProjectileEffect = { gun, position: { ...position } };
    const texture = gun === Gun.Iceball ? "ball2.png" : gun === Gun.Slimeball ? "ball3.png" : "ball1.png";
    const color = gun === Gun.Iceball ? 0x80ffff : gun === Gun.Slimeball ? 0x80ff80 : gun === Gun.Grenade ? 0x80ffff : 0xffc8c8;
    const material = this.spriteMaterial(`projectile-${id}`, texture, color, true);
    const mesh = MeshBuilder.CreatePlane(`weapon-projectile-${id}`, { size: gun === Gun.Rocket ? 2.5 : 4.8 }, this.scene);
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
    const previous = projectile.position;
    projectile.position = { ...position };
    projectile.mesh?.position.copyFrom(toBabylonPosition(position));
    const magic = projectile.gun === Gun.Fireball || projectile.gun === Gun.Iceball || projectile.gun === Gun.Slimeball;
    this.trail(previous, position, "smoke.png", 0x404040, magic ? 0.6 : 2.4, 300, -20, magic ? 2 : 1);
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
    this.sparks(position, magic ? 100 : 200, magic ? 0.2 : 0.3);
    if (magic) return;
    const blue = gun === Gun.Grenade;
    const duration = blue ? Math.max(120, (radius - 4) * 15) : Math.max(300, radius * 20);
    const effect = this.sprite(position, "explosion.png", blue ? 0x80ffff : 0xff8080, 4, duration, true, radius * 2);
    const light = new PointLight("weapon-explosion-light", toBabylonPosition(position), this.scene);
    light.diffuse = blue ? new Color3(0.25, 1, 1) : new Color3(1, 0.75, 0.5);
    light.intensity = 2;
    light.range = radius * 1.15;
    effect.light = light;
  }

  private sparks(position: Vec3, count: number, life: number): void {
    this.particleSystem("weapon-sparks", position, {
      texture: "spark.png", color: 0xb49b4b, size: 0.24, life, count, radius: 0.1, direction: new Vector3(0, 1, 0), spread: 1,
      speed: 45, gravity: 20, additive: true,
    });
  }

  private trail(from: Vec3, to: Vec3, texture: ParticleTexture, color: number, size: number, fade: number, gravity: number,
                maximumCount = 500): void {
    const distance = Math.hypot(to.x - from.x, to.y - from.y, to.z - from.z);
    const count = Math.min(maximumCount, Math.max(1, Math.floor(distance * 2)));
    const system = this.particleSystem("weapon-trail", from, {
      texture, color, size, life: fade / 1000, count, direction: Vector3.Zero(), speed: 0, gravity,
    });
    const start = toBabylonPosition(from), end = toBabylonPosition(to);
    system.startPositionFunction = (_matrix, target) => Vector3.LerpToRef(start, end, Math.random(), target);
  }

  private particleSystem(name: string, position: Vec3, options: ParticleOptions): ParticleSystem {
    const capacity = Math.max(8, options.count ?? Math.ceil((options.rate ?? 10) * options.life * 2));
    const tiled = options.texture === "flames.png" || options.texture === "snow.png";
    const system = new ParticleSystem(name, capacity, this.scene, undefined, tiled);
    system.particleTexture = new Texture(particleUrl(options.texture), this.scene, false, false);
    system.emitter = toBabylonPosition(position);
    system.color1 = particleColor4(options.color, 1);
    system.color2 = particleColor4(options.color, 0.85);
    system.colorDead = particleColor4(options.color, 0);
    system.minSize = options.size * 0.8;
    system.maxSize = options.size * 1.2;
    system.minLifeTime = Math.max(0.01, options.life * 0.65);
    system.maxLifeTime = Math.max(0.02, options.life * 1.35);
    system.minEmitPower = (options.speed ?? 0) * 0.75;
    system.maxEmitPower = (options.speed ?? 0) * 1.25;
    system.gravity = new Vector3(0, -(options.gravity ?? 0), 0);
    system.blendMode = options.additive ? ParticleSystem.BLENDMODE_ADD : ParticleSystem.BLENDMODE_STANDARD;
    system.updateSpeed = 0.01;
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
    if (options.count !== undefined) {
      system.manualEmitCount = options.count;
      system.disposeOnStop = false;
    } else system.emitRate = options.rate ?? 10;
    system.start();
    this.systems.add(system);
    return system;
  }

  private muzzlePosition(fallback: Vec3): Vec3 {
    if (this.scene.activeCamera !== this.playerCamera) return fallback;
    const forward = this.playerCamera.getForwardRay().direction;
    const up = this.playerCamera.upVector.normalizeToNew();
    const right = Vector3.Cross(forward, up).normalize();
    const position = this.playerCamera.globalPosition.add(forward.scale(2.5)).add(right.scale(0.65)).subtract(up.scale(0.45));
    return { x: position.x, y: -position.z, z: position.y };
  }

  private muzzleFlash(position: Vec3, texture: ParticleTexture, size: number, duration: number, lightRange = 0): void {
    const effect = this.sprite(position, texture, 0xffffff, size, duration, true);
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
    const mesh = MeshBuilder.CreatePlane(`particle-${texture}`, { size: 1 }, this.scene);
    mesh.position.copyFrom(toBabylonPosition(position));
    mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
    mesh.scaling.setAll(size);
    mesh.isPickable = false;
    mesh.material = material;
    const effect = { mesh, material, started: performance.now(), duration, startScale: size, endScale };
    this.effects.push(effect);
    return effect;
  }

  private persistentSprite(position: Vec3, texture: ParticleTexture, color: number, size: number, additive: boolean): void {
    const material = this.spriteMaterial(`map-${texture}`, texture, color, additive);
    const mesh = MeshBuilder.CreatePlane(`map-particle-${texture}`, { size }, this.scene);
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
    const mesh = new Mesh(`particle-beam-${texture}`, this.scene);
    const data = new VertexData();
    data.positions = positions;
    data.indices = [0, 1, 2, 0, 2, 3];
    data.uvs = [0, 0, 0, 1, 1, 1, 1, 0];
    data.normals = new Array<number>(12).fill(0);
    data.applyToMesh(mesh, true);
    const material = this.spriteMaterial(`beam-${texture}`, texture, color, true);
    mesh.material = material;
    mesh.isPickable = false;
    if (Number.isFinite(duration)) this.effects.push({ mesh, material, started: performance.now(), duration, startScale: 1, endScale: 1 });
    else this.persistentMeshes.add(mesh);
  }

  private meter(position: Vec3, progress: number, color: number, color2: number, versus: boolean): void {
    const width = 4, height = 0.35;
    const createPart = (name: string, x: number, partWidth: number, partColor: number) => {
      if (partWidth <= 0) return;
      const mesh = MeshBuilder.CreatePlane(name, { width: partWidth, height }, this.scene);
      mesh.position.copyFrom(toBabylonPosition(position));
      mesh.position.x += x;
      mesh.billboardMode = Mesh.BILLBOARDMODE_ALL;
      mesh.isPickable = false;
      const material = new StandardMaterial(`${name}-material`, this.scene);
      material.disableLighting = true;
      material.emissiveColor = particleColor3(partColor);
      material.backFaceCulling = false;
      mesh.material = material;
      this.persistentMeshes.add(mesh);
    };
    createPart("map-particle-meter-fill", -(width - width * progress) / 2, width * progress, color);
    createPart("map-particle-meter-rest", width * progress / 2, width * (1 - progress), versus ? color2 : 0x202020);
  }

  private spriteMaterial(name: string, textureName: ParticleTexture, color: number, additive: boolean): StandardMaterial {
    const material = new StandardMaterial(`${name}-material`, this.scene);
    const texture = new Texture(particleUrl(textureName), this.scene, false, false);
    texture.hasAlpha = true;
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
    return material;
  }

  private update(): void {
    const now = performance.now();
    for (let index = this.effects.length - 1; index >= 0; index--) {
      const effect = this.effects[index];
      const progress = Math.min(1, (now - effect.started) / effect.duration);
      effect.material.alpha = 1 - progress;
      effect.mesh.scaling.setAll(effect.startScale + (effect.endScale - effect.startScale) * progress);
      if (effect.light) effect.light.intensity = (1 - progress) * 2;
      if (progress >= 1) {
        this.disposeEffect(effect);
        this.effects.splice(index, 1);
      }
    }
    this.systems.forEach((system) => {
      if (!system.isStarted() || system.manualEmitCount < 0 || system.getActiveCount() > 0) return;
      system.dispose();
      this.systems.delete(system);
    });
  }

  private disposeEffect(effect: SpriteEffect): void {
    effect.light?.dispose();
    this.disposeMesh(effect.mesh);
  }

  private disposeMesh(mesh: Mesh): void {
    mesh.material?.dispose(true, true);
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
