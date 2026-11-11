import type { Camera } from "@babylonjs/core/Cameras/camera";
import { Material } from "@babylonjs/core/Materials/material";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Color3 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { TransformNode } from "@babylonjs/core/Meshes/transformNode";
import type { Scene } from "@babylonjs/core/scene";
import { packageAssetUrl } from "../../assets/TextureResolver";
import type { HudGunAsset, MapModelAsset, MapModelSkin } from "../../assets/types";
import { parseMd5, type ModelGeometryMesh, type ModelJointPose } from "../../engine/rendermodel";
import type { WeaponController } from "../../fpsgame/weapon/WeaponController";
import { Gun, WEAPONS } from "../../fpsgame/weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";

export class WeaponRenderer {
  private readonly hudRoot: TransformNode;
  private readonly hudGuns = new Map<Gun, Mesh[]>();
  private readonly hudMuzzles = new Map<Gun, Vector3>();
  private hudVisible = false;
  private viewedGun?: Gun;
  private viewedLastAction = 0;
  private viewedGunWait = 0;
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
    this.hudGuns.forEach((meshes) => meshes.forEach((mesh) => mesh.dispose(false, true)));
    this.hudGuns.clear();
    this.hudMuzzles.clear();
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
        const muzzleBone = asset.weapon.tags?.tag_muzzle;
        const muzzle = weapon.joints?.find((joint) => joint.name === muzzleBone);
        if (muzzle) this.hudMuzzles.set(asset.gun, this.hudPoint(muzzle.position, asset.weapon, attachment));
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

  setViewedGun(gun?: number, lastAction = 0, gunWait = 0): void {
    const viewed = gun !== undefined && gun >= Gun.Fist && gun <= Gun.Pistol ? gun as Gun : undefined;
    const changed = viewed !== this.viewedGun;
    this.viewedGun = viewed;
    this.viewedLastAction = lastAction;
    this.viewedGunWait = gunWait;
    if (changed) this.updateHudGunVisibility();
  }

  muzzlePosition(): { x: number; y: number; z: number } | undefined {
    const local = this.hudMuzzles.get(this.viewedGun ?? this.controller.inventory.selectedGun);
    if (!local || !this.hudVisible) return undefined;
    const position = Vector3.TransformCoordinates(local, this.hudRoot.computeWorldMatrix(true));
    return { x: position.x, y: position.z, z: position.y };
  }

  private handle(event: WeaponEvent): void {
    if (event.type === "shot") {
      this.recoilStarted = performance.now();
    } else if (event.type === "selected") {
      this.updateHudGunVisibility();
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
      positions[index] = (attached[2] + translate[1]) * scale * fovCompensation;
      positions[index + 1] = (attached[1] + translate[2]) * scale * fovCompensation;
      // Babylon's right-handed camera looks down local -Z, matching Sauerbraten/OpenGL camera-space -Z.
      positions[index + 2] = -(attached[0] + translate[0]) * scale;
    }
    data.positions = positions;
    data.uvs = source.uvs;
    // The horizontal HUD mirror adds a second reflection, restoring the MD5 source winding.
    const indices = source.indices.slice();
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

  private hudPoint(position: [number, number, number], asset: MapModelAsset, attachment?: ModelJointPose): Vector3 {
    const point: [number, number, number] = [position[0], position[2], position[1]];
    const attached = attachment ? attachHudPoint(point, 0, attachment) : point;
    const scale = asset.scale ?? 0.75;
    const translate = asset.translate ?? [0, 0, 0];
    const fovCompensation = Math.tan(this.camera.fov / 2) / Math.tan(65 * Math.PI / 360);
    return new Vector3((attached[2] + translate[1]) * scale * fovCompensation, (attached[1] + translate[2]) * scale * fovCompensation,
      -(attached[0] + translate[0]) * scale);
  }

  private createHudMaterial(asset: MapModelAsset, skin: MapModelSkin | undefined, key: string): StandardMaterial {
    const material = new StandardMaterial(`hudgun-material-${key}`, this.scene);
    material.backFaceCulling = asset.cullFace ?? true;
    material.disableDepthWrite = false;
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
    const viewed = this.viewedGun !== undefined;
    const elapsed = performance.now() - (viewed ? this.viewedLastAction : this.recoilStarted);
    const delay = viewed ? this.viewedGunWait : WEAPONS[this.controller.inventory.selectedGun].attackDelay;
    const phase = elapsed < delay ? Math.sin(Math.min(1, elapsed / Math.max(1, delay)) * Math.PI) : 0;
    this.hudRoot.position.copyFrom(new Vector3(0, -0.05 * phase, 0.2 * phase));
  }

  private updateHudGunVisibility(): void {
    const selected = this.viewedGun ?? this.controller.inventory.selectedGun;
    this.hudGuns.forEach((meshes, gun) => meshes.forEach((mesh) => mesh.setEnabled(this.hudVisible && gun === selected)));
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
