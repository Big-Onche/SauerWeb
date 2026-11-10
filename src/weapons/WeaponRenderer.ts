import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../assets/TextureResolver";
import type { HudGunAsset, MapModelAsset, MapModelSkin } from "../assets/types";
import type { Vec3 } from "../map/types";
import { toBabylonPosition } from "../render/coordinates";
import { parseMd5, type ModelGeometryMesh, type ModelJointPose } from "../render/MapModelLoader";
import type { WeaponController } from "./WeaponController";
import { Gun, WEAPONS } from "./WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "./WeaponEvents";

export class WeaponRenderer {
  private readonly projectiles = new Map<number, Mesh>();
  private readonly hudRoot: TransformNode;
  private readonly hudGuns = new Map<Gun, Mesh[]>();
  private hudVisible = false;
  private recoilStarted = 0;

  constructor(private readonly scene: Scene, events: WeaponEvents, private readonly camera: Camera,
              private readonly controller: WeaponController) {
    this.hudRoot = new TransformNode("hudgun-root", scene);
    this.hudRoot.parent = this.camera;
    scene.setRenderingAutoClearDepthStencil(3, true, true, true);
    events.on((event) => this.handle(event));
    scene.onBeforeRenderObservable.add(() => this.updateHudGun());
  }

  clear(): void {
    this.projectiles.forEach((mesh) => mesh.dispose());
    this.projectiles.clear();
    this.hudGuns.forEach((meshes) => meshes.forEach((mesh) => mesh.dispose(false, true)));
    this.hudGuns.clear();
  }

  async loadHudGuns(): Promise<string[]> {
    const issues: string[] = [];
    this.scene.onBeforeRenderObservable.add(() => this.updateHudGun());
    let assets: HudGunAsset[];
    try {
      const response = await fetch("/api/hudguns", { cache: "no-store" });
      if (!response.ok) throw new Error(`HUD-gun manifest request failed (${response.status}).`);
      assets = await response.json() as HudGunAsset[];
    } catch (caught) {
      const reason = caught instanceof Error ? caught.message : String(caught);
      console.warn(reason);
      return [reason];
    }
    await Promise.all(assets.map(async (asset) => {
      const meshes: Mesh[] = [];
      if (asset.hands.status !== "ready" || !asset.hands.geometryPath || asset.weapon.status !== "ready" || !asset.weapon.geometryPath) {
        issues.push(`${asset.model}: ${asset.hands.reason || asset.weapon.reason}`);
      } else try {
        const hands = await this.loadHudComponent(asset.hands, asset.handsAnimationPath, asset.handsAdjustments, asset.gun);
        const attachment = hands.joints?.find((joint) => joint.name === asset.attachmentBone);
        if (!attachment) throw new Error(`attachment bone ${asset.attachmentBone} was not found.`);
        const weapon = await this.loadHudComponent(asset.weapon, asset.weaponAnimationPath, asset.weaponAdjustments, asset.gun, attachment);
        meshes.push(...hands.meshes, ...weapon.meshes);
      } catch (caught) {
        issues.push(`${asset.model}: ${caught instanceof Error ? caught.message : String(caught)}`);
      }
      this.hudGuns.set(asset.gun, meshes);
    }));
    this.updateHudGunVisibility();
    issues.forEach((issue) => console.warn(`hudgun ${issue}`));
    return issues;
  }

  setHudGunVisible(visible: boolean): void {
    this.hudVisible = visible;
    this.updateHudGunVisibility();
  }

  private handle(event: WeaponEvent): void {
    if (event.type === "shot") {
      this.recoilStarted = performance.now();
      const endpoints = event.rays.length ? event.rays : [event.to];
      endpoints.forEach((endpoint) => this.tracer(event.from, endpoint, event.gun));
    } else if (event.type === "selected") {
      this.updateHudGunVisibility();
    } else if (event.type === "projectile-spawned") {
      const mesh = MeshBuilder.CreateSphere(`weapon-projectile-${event.id}`, { diameter: event.gun === Gun.Rocket ? 2.5 : 3 }, this.scene);
      mesh.position.copyFrom(toBabylonPosition(event.position));
      mesh.isPickable = false;
      mesh.material = this.effectMaterial(event.gun === Gun.Grenade ? new Color3(0.2, 0.7, 1) : new Color3(1, 0.35, 0.08));
      this.projectiles.set(event.id, mesh);
    } else if (event.type === "projectile-moved") {
      this.projectiles.get(event.id)?.position.copyFrom(toBabylonPosition(event.position));
    } else if (event.type === "explosion") {
      const existing = [...this.projectiles.entries()].find(([, mesh]) => mesh.position.subtract(toBabylonPosition(event.position)).length() < 5);
      if (existing) {
        existing[1].dispose();
        this.projectiles.delete(existing[0]);
      }
      const sphere = MeshBuilder.CreateSphere("weapon-explosion", { diameter: event.radius * 2, segments: 12 }, this.scene);
      sphere.position.copyFrom(toBabylonPosition(event.position));
      sphere.isPickable = false;
      sphere.material = this.effectMaterial(event.gun === Gun.Grenade ? new Color3(0.25, 0.8, 1) : new Color3(1, 0.25, 0.05));
      window.setTimeout(() => sphere.dispose(), 120);
    }
  }

  private async loadHudComponent(asset: MapModelAsset, animationPath: string, adjustments: HudGunAsset["handsAdjustments"], gun: number,
                                 attachment?: ModelJointPose): Promise<{ meshes: Mesh[]; joints?: ModelJointPose[] }> {
    const url = packageAssetUrl(asset.geometryPath);
    const animationUrl = packageAssetUrl(animationPath);
    if (!url) throw new Error("HUD-gun geometry path is missing.");
    if (!animationUrl) throw new Error("HUD-gun animation path is missing.");
    const [response, animationResponse] = await Promise.all([
      fetch(url, { cache: "no-cache" }), fetch(animationUrl, { cache: "no-cache" }),
    ]);
    if (!response.ok) throw new Error(`Could not load ${asset.geometryPath} (${response.status}).`);
    if (!animationResponse.ok) throw new Error(`Could not load ${animationPath} (${animationResponse.status}).`);
    const geometry = parseMd5(await response.text(), await animationResponse.text(), adjustments);
    return { meshes: geometry.meshes.map((source) => this.createHudMesh(source, asset, gun, attachment)), joints: geometry.joints };
  }

  private createHudMesh(source: ModelGeometryMesh, asset: MapModelAsset, gun: number, attachment?: ModelJointPose): Mesh {
    const mesh = new Mesh(`hudgun-${gun}-${asset.name}-${source.name}`, this.scene);
    const data = new VertexData();
    const scale = asset.scale ?? 0.75;
    const translate = asset.translate ?? [0, 0, 0];
    const fovCompensation = Math.tan(this.camera.fov / 2) / Math.tan(65 * Math.PI / 360);
    const positions = new Array<number>(source.positions.length);
    for (let index = 0; index < positions.length; index += 3) {
      const attached = attachment ? attachHudPoint(source.positions, index, attachment) :
        [source.positions[index], source.positions[index + 1], source.positions[index + 2]];
      // drawhudmodel uses yaw + 90. In camera space this maps Sauer (x, y, z) to
      // (right, up, forward) = (-y, z, x). Keep mdltrans inside mdlscale, as the native model matrix does.
      positions[index] = -(attached[2] + translate[1]) * scale * fovCompensation;
      positions[index + 1] = (attached[1] + translate[2]) * scale * fovCompensation;
      // Babylon's right-handed camera looks down local -Z, matching Sauerbraten/OpenGL camera-space -Z.
      positions[index + 2] = -(attached[0] + translate[0]) * scale;
    }
    data.positions = positions;
    data.uvs = source.uvs;
    const indices = source.indices.slice();
    for (let index = 0; index < indices.length; index += 3) {
      [indices[index + 1], indices[index + 2]] = [indices[index + 2], indices[index + 1]];
    }
    data.indices = indices;
    const normals: number[] = [];
    VertexData.ComputeNormals(positions, indices, normals);
    data.normals = normals;
    data.applyToMesh(mesh, true);
    mesh.material = this.createHudMaterial(asset, selectHudSkin(asset.skins ?? [], source.name), `${gun}-${asset.name}-${source.name}`);
    mesh.parent = this.hudRoot;
    mesh.renderingGroupId = 3;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

  private createHudMaterial(asset: MapModelAsset, skin: MapModelSkin | undefined, key: string): StandardMaterial {
    const material = new StandardMaterial(`hudgun-material-${key}`, this.scene);
    material.backFaceCulling = asset.cullFace ?? true;
    material.disableDepthWrite = true;
    material.specularColor = Color3.White().scale(asset.specular ?? 1);
    material.ambientColor = Color3.White().scale(asset.ambient ?? 0.3);
    const diffuseUrl = packageAssetUrl(skin?.diffusePath);
    if (diffuseUrl) {
      const texture = new Texture(diffuseUrl, this.scene, false, false);
      texture.hasAlpha = true;
      material.diffuseTexture = texture;
      material.emissiveTexture = texture;
      material.emissiveColor = Color3.White().scale(0.35);
      material.useAlphaFromDiffuseTexture = true;
    }
    material.transparencyMode = Material.MATERIAL_ALPHATEST;
    material.alphaCutOff = asset.alphaTest ?? 0.9;
    return material;
  }

  private updateHudGun(): void {
    const elapsed = performance.now() - this.recoilStarted;
    const delay = WEAPONS[this.controller.inventory.selectedGun].attackDelay;
    const phase = elapsed < delay ? Math.sin(Math.min(1, elapsed / Math.max(1, delay)) * Math.PI) : 0;
    this.hudRoot.position.copyFrom(new Vector3(0, -0.05 * phase, 0.2 * phase));
  }

  private updateHudGunVisibility(): void {
    const selected = this.controller.inventory.selectedGun;
    this.hudGuns.forEach((meshes, gun) => meshes.forEach((mesh) => mesh.setEnabled(this.hudVisible && gun === selected)));
  }

  private tracer(from: Vec3, to: Vec3, gun: Gun): void {
    if (gun === Gun.Fist || gun === Gun.Rocket || gun === Gun.Grenade) return;
    const line = MeshBuilder.CreateLines("weapon-tracer", { points: [toBabylonPosition(from), toBabylonPosition(to)] }, this.scene);
    line.color = gun === Gun.Rifle ? new Color3(0.8, 0.9, 1) : new Color3(1, 0.75, 0.3);
    line.isPickable = false;
    window.setTimeout(() => line.dispose(), gun === Gun.Rifle ? 90 : 45);
  }

  private effectMaterial(color: Color3): StandardMaterial {
    const material = new StandardMaterial("weapon-effect", this.scene);
    material.diffuseColor = color;
    material.emissiveColor = color;
    material.disableLighting = true;
    material.alpha = 0.72;
    return material;
  }
}

function selectHudSkin(skins: MapModelSkin[], meshName: string): MapModelSkin | undefined {
  return skins.find((skin) => skin.mesh === meshName) ?? skins.find((skin) => skin.mesh === "*") ?? skins[0];
}

function attachHudPoint(positions: number[], index: number, attachment: ModelJointPose): [number, number, number] {
  const point: [number, number, number] = [positions[index], positions[index + 2], positions[index + 1]];
  const [x, y, z, w] = attachment.orientation;
  const tx = 2 * (y * point[2] - z * point[1]);
  const ty = 2 * (z * point[0] - x * point[2]);
  const tz = 2 * (x * point[1] - y * point[0]);
  return [
    point[0] + w * tx + y * tz - z * ty + attachment.position[0],
    point[2] + w * tz + x * ty - y * tx + attachment.position[2],
    point[1] + w * ty + z * tx - x * tz + attachment.position[1],
  ];
}
