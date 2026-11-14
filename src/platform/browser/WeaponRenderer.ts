import type { Camera } from "@babylonjs/core/Cameras/camera";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer";
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
import { modelAnimationPosition, type ModelAnimationPosition } from "../../engine/modelanimation";
import { interpolateModelGeometry, prepareMd5Animation, prepareMd5Model, skinMd5Model, type ModelGeometry, type ModelGeometryMesh,
  type ModelJointPose, type PreparedMd5Animation, type PreparedMd5Model } from "../../engine/rendermodel";
import type { WeaponController } from "../../fpsgame/weapon/WeaponController";
import { Gun, WEAPONS } from "../../fpsgame/weapon/WeaponDefinitions";
import type { WeaponEvent, WeaponEvents } from "../../fpsgame/weapon/WeaponEvents";

interface HudMeshBuffers {
  positions: Float32Array;
  normals: Float32Array;
  indices: number[];
}

interface HudComponent {
  key: string;
  asset: MapModelAsset;
  model: PreparedMd5Model;
  shootAnimation: PreparedMd5Animation;
  shootFrameCount: number;
  shootAnimationSpeed: number;
  meshes: Mesh[];
  idleGeometry: ModelGeometry;
  interpolatedGeometry?: ModelGeometry;
}

interface HudGunModel {
  hands: HudComponent;
  weapon: HudComponent;
  attachmentBone: string;
  muzzleBone?: string;
  shooting: boolean;
  handsFrame: number;
  weaponFrame: number;
}

const MAX_HUD_GEOMETRY_FRAMES = 48;

export class WeaponRenderer {
  private readonly hudRoot: TransformNode;
  private readonly hudGuns = new Map<Gun, Mesh[]>();
  private readonly hudModels = new Map<Gun, HudGunModel>();
  private readonly hudMuzzles = new Map<Gun, Vector3>();
  private readonly geometryFrames = new Map<string, ModelGeometry>();
  private readonly meshVertexBuffers = new WeakMap<Mesh, HudMeshBuffers>();
  private readonly warmedGuns = new Set<Gun>();
  private warmGeneration = 0;
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
    this.hudModels.clear();
    this.hudMuzzles.clear();
    this.geometryFrames.clear();
    this.warmedGuns.clear();
    this.warmGeneration++;
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
        const hands = await this.loadHudComponent(asset.hands, asset.handsAnimationPath, asset.handsShootAnimationPath,
          asset.handsShootAnimationSpeed, asset.handsAdjustments, asset.gun, "hands");
        const attachment = hands.idleGeometry.joints?.find((joint) => joint.name === asset.attachmentBone);
        if (!attachment) throw new Error(`attachment bone ${asset.attachmentBone} was not found.`);
        const weapon = await this.loadHudComponent(asset.weapon, asset.weaponAnimationPath, asset.weaponShootAnimationPath,
          asset.weaponShootAnimationSpeed, asset.weaponAdjustments, asset.gun, "weapon", attachment);
        meshes.push(...hands.meshes, ...weapon.meshes);
        const muzzleBone = asset.weapon.tags?.tag_muzzle;
        const muzzle = weapon.idleGeometry.joints?.find((joint) => joint.name === muzzleBone);
        if (muzzle) this.hudMuzzles.set(asset.gun, this.hudPoint(muzzle.position, asset.weapon, attachment));
        this.hudModels.set(asset.gun, {
          hands, weapon, attachmentBone: asset.attachmentBone, muzzleBone, shooting: false, handsFrame: -1, weaponFrame: -1,
        });
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

  private async loadHudComponent(asset: MapModelAsset, animationPath: string, shootAnimationPath: string, shootAnimationSpeed: number,
                                 adjustments: HudGunAsset["handsAdjustments"], gun: number, part: string,
                                 attachment?: ModelJointPose): Promise<HudComponent> {
    const url = packageAssetUrl(asset.geometryPath);
    const animationUrl = packageAssetUrl(animationPath);
    const shootAnimationUrl = packageAssetUrl(shootAnimationPath);
    if (!url) throw new Error("HUD-gun geometry path is missing.");
    if (!animationUrl) throw new Error("HUD-gun animation path is missing.");
    if (!shootAnimationUrl) throw new Error("HUD-gun shoot animation path is missing.");
    const [response, animationResponse, shootAnimationResponse] = await Promise.all([
      fetch(url, { cache: "no-cache" }), fetch(animationUrl, { cache: "no-cache" }), fetch(shootAnimationUrl, { cache: "no-cache" }),
    ]);
    if (!response.ok) throw new Error(`Could not load ${asset.geometryPath} (${response.status}).`);
    if (!animationResponse.ok) throw new Error(`Could not load ${animationPath} (${animationResponse.status}).`);
    if (!shootAnimationResponse.ok) throw new Error(`Could not load ${shootAnimationPath} (${shootAnimationResponse.status}).`);
    const [geometrySource, idleAnimationSource, shootAnimationSource] = await Promise.all([
      response.text(), animationResponse.text(), shootAnimationResponse.text(),
    ]);
    const model = prepareMd5Model(geometrySource);
    const idleGeometry = skinMd5Model(model, prepareMd5Animation(idleAnimationSource, adjustments));
    const shootAnimation = prepareMd5Animation(shootAnimationSource, adjustments);
    return {
      key: `${gun}:${part}`,
      asset,
      model,
      shootAnimation,
      shootFrameCount: shootAnimation.frames.length,
      shootAnimationSpeed,
      idleGeometry,
      meshes: idleGeometry.meshes.map((source) => this.createHudMesh(source, asset, gun, attachment)),
    };
  }

  private createHudMesh(source: ModelGeometryMesh, asset: MapModelAsset, gun: number, attachment?: ModelJointPose): Mesh {
    const mesh = new Mesh(`hudgun-${gun}-${asset.name}-${source.name}`, this.scene);
    const data = new VertexData();
    const buffers: HudMeshBuffers = {
      positions: new Float32Array(source.positions.length),
      normals: new Float32Array(source.positions.length),
      indices: source.indices,
    };
    this.writeHudPositions(buffers.positions, source.positions, asset, attachment);
    data.positions = buffers.positions;
    data.uvs = source.uvs;
    // The horizontal HUD mirror adds a second reflection, restoring the MD5 source winding.
    const indices = source.indices.slice();
    data.indices = indices;
    VertexData.ComputeNormals(buffers.positions, indices, buffers.normals);
    data.normals = buffers.normals;
    data.applyToMesh(mesh, true);
    this.meshVertexBuffers.set(mesh, buffers);
    mesh.material = this.createHudMaterial(asset, selectHudSkin(asset.skins ?? [], source.name), `${gun}-${asset.name}-${source.name}`);
    mesh.parent = this.hudRoot;
    mesh.metadata = { isHudGun: true };
    mesh.renderingGroupId = 3;
    mesh.isPickable = false;
    mesh.alwaysSelectAsActiveMesh = true;
    return mesh;
  }

  private updateHudComponent(component: HudComponent, geometry: ModelGeometry, attachment?: ModelJointPose): void {
    geometry.meshes.forEach((source, index) => {
      const mesh = component.meshes[index];
      const buffers = mesh && this.meshVertexBuffers.get(mesh);
      if (!mesh || !buffers || buffers.positions.length !== source.positions.length) return;
      this.writeHudPositions(buffers.positions, source.positions, component.asset, attachment);
      VertexData.ComputeNormals(buffers.positions, buffers.indices, buffers.normals);
      mesh.updateVerticesData(VertexBuffer.PositionKind, buffers.positions, true);
      mesh.updateVerticesData(VertexBuffer.NormalKind, buffers.normals, false);
    });
  }

  private writeHudPositions(target: Float32Array, source: number[], asset: MapModelAsset, attachment?: ModelJointPose): void {
    const scale = asset.scale ?? 0.75;
    const translate = asset.translate ?? [0, 0, 0];
    const fovCompensation = Math.tan(this.camera.fov / 2) / Math.tan(65 * Math.PI / 360);
    const attached: [number, number, number] = [0, 0, 0];
    for (let index = 0; index < target.length; index += 3) {
      if (attachment) attachHudPoint(source, index, attachment, attached);
      else {
        attached[0] = source[index];
        attached[1] = source[index + 1];
        attached[2] = source[index + 2];
      }
      // drawhudmodel uses yaw + 90. In camera space this maps Sauer (x, y, z) to
      // (right, up, forward) = (-y, z, x). Keep mdltrans inside mdlscale, as the native model matrix does.
      target[index] = (attached[2] + translate[1]) * scale * fovCompensation;
      target[index + 1] = (attached[1] + translate[2]) * scale * fovCompensation;
      // Babylon's right-handed camera looks down local -Z, matching Sauerbraten/OpenGL camera-space -Z.
      target[index + 2] = -(attached[0] + translate[0]) * scale;
    }
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
    if (!this.hudVisible) return;
    const gun = this.viewedGun ?? this.controller.inventory.selectedGun;
    const model = this.hudModels.get(gun);
    if (!model) return;
    const viewed = this.viewedGun !== undefined;
    const elapsed = performance.now() - (viewed ? this.viewedLastAction : this.recoilStarted);
    const delay = Math.max(1, viewed ? this.viewedGunWait : WEAPONS[gun].attackDelay);
    const shooting = elapsed >= 0 && elapsed < delay;
    const handsPosition = shooting ? this.hudShootPosition(model.hands, elapsed, delay) : undefined;
    const weaponPosition = shooting ? this.hudShootPosition(model.weapon, elapsed, delay) : undefined;
    const handsFrame = handsPosition
      ? handsPosition.frame + (handsPosition.nextFrame === handsPosition.frame ? 0 : handsPosition.interpolation) : -1;
    const weaponFrame = weaponPosition
      ? weaponPosition.frame + (weaponPosition.nextFrame === weaponPosition.frame ? 0 : weaponPosition.interpolation) : -1;
    if (shooting === model.shooting && (!shooting || handsFrame === model.handsFrame && weaponFrame === model.weaponFrame)) return;
    const handsGeometry = handsPosition ? this.hudGeometry(model.hands, handsPosition) : model.hands.idleGeometry;
    const attachment = handsGeometry.joints?.find((joint) => joint.name === model.attachmentBone);
    if (!attachment) return;
    const weaponGeometry = weaponPosition ? this.hudGeometry(model.weapon, weaponPosition) : model.weapon.idleGeometry;
    this.updateHudComponent(model.hands, handsGeometry);
    this.updateHudComponent(model.weapon, weaponGeometry, attachment);
    const muzzle = weaponGeometry.joints?.find((joint) => joint.name === model.muzzleBone);
    if (muzzle) this.hudMuzzles.set(gun, this.hudPoint(muzzle.position, model.weapon.asset, attachment));
    model.shooting = shooting;
    model.handsFrame = handsFrame;
    model.weaponFrame = weaponFrame;
  }

  private hudShootPosition(component: HudComponent, elapsed: number, delay: number): ModelAnimationPosition {
    return hudGunShootAnimationPosition(component.shootFrameCount, elapsed, delay, component.shootAnimationSpeed);
  }

  private hudGeometry(component: HudComponent, position: ModelAnimationPosition): ModelGeometry {
    const current = this.hudGeometryFrame(component, position.frame);
    if (position.interpolation <= 0 || position.nextFrame === position.frame) return current;
    const next = this.hudGeometryFrame(component, position.nextFrame);
    const geometry = interpolateModelGeometry(current, next, position.interpolation, component.interpolatedGeometry);
    component.interpolatedGeometry = geometry;
    return geometry;
  }

  private hudGeometryFrame(component: HudComponent, frame: number): ModelGeometry {
    const key = `${component.key}:${frame}`;
    const cached = this.geometryFrames.get(key);
    if (cached) {
      this.geometryFrames.delete(key);
      this.geometryFrames.set(key, cached);
      return cached;
    }
    const geometry = skinMd5Model(component.model, component.shootAnimation, frame);
    this.geometryFrames.set(key, geometry);
    while (this.geometryFrames.size > MAX_HUD_GEOMETRY_FRAMES) {
      const oldest = this.geometryFrames.keys().next().value as string | undefined;
      if (oldest === undefined) break;
      this.geometryFrames.delete(oldest);
    }
    return geometry;
  }

  private updateHudGunVisibility(): void {
    const selected = this.viewedGun ?? this.controller.inventory.selectedGun;
    this.hudGuns.forEach((meshes, gun) => meshes.forEach((mesh) => mesh.setEnabled(this.hudVisible && gun === selected)));
    this.prewarmHudGun(selected);
  }

  private prewarmHudGun(gun: Gun): void {
    const model = this.hudModels.get(gun);
    if (!model || this.warmedGuns.has(gun)) return;
    const generation = this.warmGeneration;
    const work: Array<{ component: HudComponent; frame: number }> = [];
    for (const component of [model.hands, model.weapon]) {
      const frameCount = Math.min(component.shootFrameCount, 18);
      for (let frame = 0; frame < frameCount; frame++) {
        if (!this.geometryFrames.has(`${component.key}:${frame}`)) work.push({ component, frame });
      }
    }
    if (!work.length) return;
    this.warmedGuns.add(gun);
    const run = (): void => {
      if (generation !== this.warmGeneration) return;
      const item = work.shift();
      if (!item) {
        this.warmedGuns.delete(gun);
        return;
      }
      this.hudGeometryFrame(item.component, item.frame);
      if (work.length) this.scheduleWarmup(run);
      else this.warmedGuns.delete(gun);
    };
    this.scheduleWarmup(run);
  }

  private scheduleWarmup(operation: () => void): void {
    if (typeof window.requestIdleCallback === "function") window.requestIdleCallback(operation, { timeout: 50 });
    else window.setTimeout(operation, 0);
  }

}

// animmodel::calcanim() uses a configured animation speed in preference to ANIM_SETSPEED's attackdelay / 17 fallback.
export function hudGunShootAnimationPosition(frameCount: number, elapsed: number, attackDelay: number,
                                             configuredSpeed = 0): ModelAnimationPosition {
  const speed = configuredSpeed > 0 ? configuredSpeed : 1_000 / Math.ceil(Math.max(1, attackDelay) / 17);
  return modelAnimationPosition(frameCount, speed, elapsed, false);
}

function selectHudSkin(skins: MapModelSkin[], meshName: string): MapModelSkin | undefined {
  return skins.find((skin) => skin.mesh === meshName) ?? skins.find((skin) => skin.mesh === "*") ?? skins[0];
}

function attachHudPoint(positions: number[], index: number, attachment: ModelJointPose,
                        result: [number, number, number] = [0, 0, 0]): [number, number, number] {
  const point: [number, number, number] = [positions[index], positions[index + 2], positions[index + 1]];
  const [x, y, z, w] = attachment.orientation;
  const tx = 2 * (y * point[2] - z * point[1]);
  const ty = 2 * (z * point[0] - x * point[2]);
  const tz = 2 * (x * point[1] - y * point[0]);
  result[0] = point[0] + w * tx + y * tz - z * ty + attachment.position[0];
  result[1] = point[2] + w * tz + x * ty - y * tx + attachment.position[2];
  result[2] = point[1] + w * ty + z * tx - x * tz + attachment.position[1];
  return result;
}
