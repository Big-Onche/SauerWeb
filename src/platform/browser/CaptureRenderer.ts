import { Color3 } from "@babylonjs/core/Maths/math.color";
import { DynamicTexture } from "@babylonjs/core/Materials/Textures/dynamicTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import type { LinesMesh } from "@babylonjs/core/Meshes/linesMesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../../assets/TextureResolver";
import { parseMd3, type ModelGeometryMesh } from "../../engine/rendermodel";
import { type CaptureBase, MAXAMMO, OCCUPYENEMYLIMIT, OCCUPYNEUTRALLIMIT } from "../../fpsgame/capture";
import type { NetworkPlayer } from "../../fpsgame/client";
import { GameModeFlag, gameModeHas } from "../../fpsgame/game";
import { ClientState } from "../../engine/physics/types";
import { toBabylonPosition } from "../../render/coordinates";

const BASE_SCALE = 0.25 * 0.75;
const AMMO_SCALE = 0.25;
const AMMO_HEIGHT = 5;
const AMMO_NAMES = ["shells", "bullets", "rockets", "rrounds", "grenades", "cartridges"] as const;

interface Geometry { name: string; positions: number[]; uvs: number[]; indices: number[]; height: number }
interface BaseMeshes { base: Mesh[]; ammo: Mesh[]; flame: Mesh; label: Mesh; texture: DynamicTexture }

// Original: src/fpsgame/capture.h, captureclientmode::rendergame().
export class CaptureRenderer {
  private baseGeometry?: Geometry[];
  private ammoGeometry?: Geometry[];
  private readonly instances = new Map<number, BaseMeshes>();
  private readonly materials = new Map<string, StandardMaterial>();
  private readonly tethers = new Map<string, LinesMesh>();
  private loading?: Promise<void>;

  constructor(private readonly scene: Scene) {}

  render(bases: readonly CaptureBase[], players: ReadonlyMap<number, NetworkPlayer>, localTeam: string, mode: number, now: number): void {
    if (!gameModeHas(mode, GameModeFlag.Capture)) { this.setAllEnabled(false); return; }
    if (!this.baseGeometry || !this.ammoGeometry) { void this.load(); return; }
    const active = new Set<number>(), regen = gameModeHas(mode, GameModeFlag.Regen);
    for (let index = 0; index < bases.length; index++) {
      const base = bases[index];
      if (base.ammoType < 1 || base.ammoType > 6) continue;
      const instance = this.instances.get(index) ?? this.createInstance(index);
      const color = !base.owner ? "neutral" : base.owner === localTeam ? "blue" : "red";
      const origin = toBabylonPosition(base.o);
      for (const mesh of instance.base) {
        mesh.position.copyFrom(origin);
        mesh.material = this.baseMaterial(mesh.metadata.capturePart, color);
        mesh.setEnabled(true);
      }
      const ammoPosition = { ...base.o, z: base.o.z + this.baseHeight() + AMMO_HEIGHT - 2 };
      instance.flame.position.copyFrom(toBabylonPosition({ ...ammoPosition, z: ammoPosition.z - 4.5 }));
      instance.flame.material = this.flameMaterial(color);
      instance.flame.setEnabled(true);
      const ammoCount = regen ? 1 : base.ammo;
      for (let item = 0; item < instance.ammo.length; item++) {
        const mesh = instance.ammo[item];
        if (item >= ammoCount) { mesh.setEnabled(false); continue; }
        if (regen) {
          mesh.position.copyFrom(toBabylonPosition({ ...ammoPosition,
            z: ammoPosition.z - this.ammoHeight() / 2 - Math.sin(now / 100) / 20 }));
          mesh.rotation.y = -now / 10 * Math.PI / 180;
        } else {
          const angle = 2 * Math.PI * (now / 4000 + item / MAXAMMO);
          mesh.position.copyFrom(toBabylonPosition({ x: base.o.x + 10 * Math.cos(angle), y: base.o.y + 10 * Math.sin(angle),
            z: base.o.z + 4 }));
          mesh.rotation.y = 0;
        }
        mesh.material = this.ammoMaterial(base.ammoType);
        mesh.setEnabled(true);
      }
      instance.label.position.copyFrom(toBabylonPosition({ ...ammoPosition, z: ammoPosition.z + AMMO_HEIGHT + 1 }));
      instance.label.setEnabled(true);
      this.drawLabel(instance.texture, base, color);
      active.add(index);
    }
    for (const [index, instance] of this.instances) if (!active.has(index)) this.enable(instance, false);
    this.renderTethers(bases, players, localTeam);
  }

  clear(): void {
    for (const instance of this.instances.values()) {
      instance.base.forEach((mesh) => mesh.dispose());
      instance.ammo.forEach((mesh) => mesh.dispose());
      instance.flame.dispose();
      instance.label.dispose();
      instance.texture.dispose();
    }
    this.instances.clear();
    this.materials.forEach((material) => material.dispose(true, true));
    this.materials.clear();
    this.tethers.forEach((mesh) => mesh.dispose());
    this.tethers.clear();
    this.baseGeometry = this.ammoGeometry = undefined;
    this.loading = undefined;
  }

  private async load(): Promise<void> {
    if (this.loading) return this.loading;
    this.loading = (async () => {
      const [base, ammo] = await Promise.all([
        fetch(packageAssetUrl("models/base/base.md3")!, { cache: "no-cache" }),
        fetch(packageAssetUrl("models/ammo/tris.md3")!, { cache: "no-cache" }),
      ]);
      if (!base.ok || !ammo.ok) throw new Error("Could not load native Capture models.");
      this.baseGeometry = parseMd3Geometry(await base.arrayBuffer(), BASE_SCALE);
      this.ammoGeometry = parseMd3Geometry(await ammo.arrayBuffer(), AMMO_SCALE);
    })().catch((error) => { console.warn(error); });
    return this.loading;
  }

  private createInstance(index: number): BaseMeshes {
    const base = this.baseGeometry!.map((geometry) => {
      const mesh = createMesh(this.scene, `capture-base-${index}-${geometry.name}`, geometry);
      mesh.metadata = { capturePart: geometry.name.toLowerCase().includes("energy") ? "energy" : "monolith" };
      return mesh;
    });
    const ammo: Mesh[] = [];
    for (let item = 0; item < MAXAMMO; item++) {
      const parts = this.ammoGeometry!.map((geometry) => createMesh(this.scene, `capture-ammo-${index}-${item}-${geometry.name}`, geometry));
      // The native ammo model currently has one mesh. Parent any future parts so they retain one orbit transform.
      const root = parts[0];
      for (let part = 1; part < parts.length; part++) parts[part].parent = root;
      ammo.push(root);
    }
    const texture = new DynamicTexture(`capture-label-${index}`, { width: 512, height: 128 }, this.scene, false);
    texture.hasAlpha = true;
    const material = new StandardMaterial(`capture-label-material-${index}`, this.scene);
    material.diffuseTexture = material.emissiveTexture = texture;
    material.opacityTexture = texture;
    material.disableLighting = true;
    material.backFaceCulling = false;
    const label = MeshBuilder.CreatePlane(`capture-label-${index}`, { width: 16, height: 4 }, this.scene);
    label.billboardMode = Mesh.BILLBOARDMODE_ALL;
    label.material = material;
    label.isPickable = false;
    const flame = MeshBuilder.CreatePlane(`capture-flame-${index}`, { width: 2, height: 1 }, this.scene);
    flame.billboardMode = Mesh.BILLBOARDMODE_ALL;
    flame.isPickable = false;
    const instance = { base, ammo, flame, label, texture };
    this.instances.set(index, instance);
    return instance;
  }

  private drawLabel(texture: DynamicTexture, base: CaptureBase, color: string): void {
    const context = texture.getContext() as unknown as CanvasRenderingContext2D;
    context.clearRect(0, 0, 512, 128);
    context.font = "bold 42px sans-serif";
    context.textAlign = "center";
    context.fillStyle = color === "blue" ? "#6496ff" : color === "red" ? "#ff4b19" : "#1ec850";
    context.fillText(`base ${base.tag}${base.owner ? `: ${base.owner}` : base.enemy ? `: ${base.enemy}` : ""}`, 256, 48);
    if (base.enemy) {
      const progress = Math.min(1, Math.max(0, base.converted / (base.owner ? OCCUPYENEMYLIMIT : OCCUPYNEUTRALLIMIT)));
      context.fillStyle = "rgba(20,20,20,.85)";
      context.fillRect(64, 72, 384, 24);
      context.fillStyle = base.enemy === base.owner ? "#3219ff" : "#ff1932";
      context.fillRect(64, 72, 384 * progress, 24);
      if (base.owner) {
        context.strokeStyle = "#3219ff";
        context.lineWidth = 4;
        context.strokeRect(64, 72, 384, 24);
      }
    }
    texture.update(false);
  }

  private baseMaterial(part: "energy" | "monolith", color: string): StandardMaterial {
    const key = `base:${part}:${color}`;
    let material = this.materials.get(key);
    if (material) return material;
    material = new StandardMaterial(`capture-${key}`, this.scene);
    const energy = part === "energy";
    const texture = new Texture(packageAssetUrl(`models/base/${energy ? "energy.jpg" : "skin.jpg"}`)!, this.scene, false, false);
    material.diffuseTexture = texture;
    if (energy) {
      material.emissiveTexture = texture;
      material.diffuseColor = material.emissiveColor = color === "blue" ? new Color3(0, 0, 1) : color === "red" ? new Color3(1, 0, 0)
        : new Color3(0, 1, 0);
    } else material.specularTexture = new Texture(packageAssetUrl("models/base/mask.jpg")!, this.scene, false, false);
    this.materials.set(key, material);
    return material;
  }

  private ammoMaterial(ammoType: number): StandardMaterial {
    const key = `ammo:${ammoType}`;
    let material = this.materials.get(key);
    if (material) return material;
    const name = AMMO_NAMES[ammoType - 1];
    material = new StandardMaterial(`capture-${key}`, this.scene);
    material.diffuseTexture = new Texture(packageAssetUrl(`models/ammo/${name}/skin.jpg`)!, this.scene, false, false);
    material.specularTexture = new Texture(packageAssetUrl(`models/ammo/${name}/masks.jpg`)!, this.scene, false, false);
    material.ambientColor = Color3.White().scale(0.5);
    material.specularColor = Color3.White().scale(1.5);
    this.materials.set(key, material);
    return material;
  }

  private flameMaterial(color: string): StandardMaterial {
    const key = `flame:${color}`;
    let material = this.materials.get(key);
    if (material) return material;
    material = new StandardMaterial(`capture-${key}`, this.scene);
    const texture = new Texture(packageAssetUrl("particles/flames.png")!, this.scene, false, false);
    texture.hasAlpha = true;
    material.diffuseTexture = material.emissiveTexture = material.opacityTexture = texture;
    material.diffuseColor = material.emissiveColor = color === "blue" ? new Color3(0.13, 0.13, 1) : color === "red"
      ? new Color3(0.5, 0.13, 0.13) : new Color3(0.13, 0.5, 0.13);
    material.disableLighting = true;
    material.backFaceCulling = false;
    this.materials.set(key, material);
    return material;
  }

  private baseHeight(): number { return Math.max(...this.baseGeometry!.map((geometry) => geometry.height)); }
  private ammoHeight(): number { return Math.max(...this.ammoGeometry!.map((geometry) => geometry.height)); }
  private setAllEnabled(enabled: boolean): void {
    this.instances.forEach((instance) => this.enable(instance, enabled));
    this.tethers.forEach((mesh) => mesh.setEnabled(enabled));
  }
  private enable(instance: BaseMeshes, enabled: boolean): void {
    instance.base.forEach((mesh) => mesh.setEnabled(enabled));
    instance.ammo.forEach((mesh) => mesh.setEnabled(enabled));
    instance.flame.setEnabled(enabled);
    instance.label.setEnabled(enabled);
  }

  private renderTethers(bases: readonly CaptureBase[], players: ReadonlyMap<number, NetworkPlayer>, localTeam: string): void {
    const active = new Set<string>();
    for (const player of players.values()) {
      if (player.state !== ClientState.Alive || !player.team) continue;
      const feet = { ...player.position, z: player.position.z - player.eyeHeight };
      for (let index = 0; index < bases.length; index++) {
        const base = bases[index], dx = base.o.x - feet.x, dy = base.o.y - feet.y, dz = base.o.z - feet.z;
        if (base.ammoType < 1 || base.ammoType > 6 || dx * dx + dy * dy > 64 * 64 || Math.abs(dz) > 24 ||
            base.owner !== player.team && base.enemy !== player.team) continue;
        const key = `${player.clientNumber}:${index}`, points = [toBabylonPosition({ ...player.position,
          z: player.position.z + (player.aboveEye - player.eyeHeight) / 2 }),
        toBabylonPosition({ ...base.o, z: base.o.z + this.baseHeight() - 1.4 })];
        let tether = this.tethers.get(key);
        tether = MeshBuilder.CreateLines(`capture-tether-${key}`, { points, instance: tether, updatable: true }, this.scene);
        tether.color = player.team === localTeam ? new Color3(0.13, 0.13, 1) : new Color3(1, 0.13, 0.13);
        tether.alpha = 0.9;
        tether.isPickable = false;
        tether.setEnabled(true);
        this.tethers.set(key, tether);
        active.add(key);
      }
    }
    for (const [key, tether] of this.tethers) if (!active.has(key)) tether.setEnabled(false);
  }
}

function parseMd3Geometry(bytes: ArrayBuffer, scale: number): Geometry[] {
  return parseMd3(bytes).meshes.map((mesh) => geometry(mesh, scale));
}

function geometry(source: ModelGeometryMesh, scale: number): Geometry {
  const positions = new Array<number>(source.positions.length);
  let height = 0;
  for (let index = 0; index < source.positions.length; index += 3) {
    positions[index] = source.positions[index] * scale;
    positions[index + 1] = source.positions[index + 1] * scale;
    positions[index + 2] = source.positions[index + 2] * scale;
    height = Math.max(height, positions[index + 1]);
  }
  return { name: source.name, positions, uvs: source.uvs, indices: source.indices, height };
}

function createMesh(scene: Scene, name: string, geometry: Geometry): Mesh {
  const mesh = new Mesh(name, scene), data = new VertexData(), normals: number[] = [];
  data.positions = geometry.positions;
  data.uvs = geometry.uvs;
  data.indices = geometry.indices;
  VertexData.ComputeNormals(data.positions, data.indices, normals);
  data.normals = normals;
  data.applyToMesh(mesh, true);
  mesh.isPickable = false;
  return mesh;
}
