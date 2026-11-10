import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { SauerMap } from "../map/types";
import type { ResolvedTexture, SkyboxManifest } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import { generateGeometry, type GeometryBatch } from "./geometry";
import { toBabylonPosition, toBabylonYawDirection } from "./coordinates";

export interface SceneStats {
  meshes: number;
  faces: number;
  triangles: number;
  vertices: number;
}

export class MapScene {
  readonly engine: Engine;
  readonly scene: Scene;
  private readonly camera: UniversalCamera;
  private materials: StandardMaterial[] = [];
  private fallbackMaterial?: StandardMaterial;
  private skyboxMaterial?: StandardMaterial;
  private skyboxObjectUrls: string[] = [];
  private loadGeneration = 0;
  private wireframe = false;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.055, 0.067, 0.06, 1);
    this.scene.ambientColor = new Color3(0.42, 0.45, 0.4);
    new HemisphericLight("sky", new Vector3(0.25, 1, 0.1), this.scene).intensity = 1.25;

    this.camera = new UniversalCamera("camera", new Vector3(0, 64, 0), this.scene);
    this.camera.minZ = 0.1;
    this.camera.maxZ = 50_000;
    this.camera.fovMode = Camera.FOVMODE_VERTICAL_FIXED;
    this.camera.fov = 70 * Math.PI / 180;
    this.camera.speed = 4;
    this.camera.angularSensibility = 2200;
    this.camera.keysUp = [87, 38];
    this.camera.keysDown = [83, 40];
    this.camera.keysLeft = [65, 37];
    this.camera.keysRight = [68, 39];
    this.camera.attachControl(canvas, true);

    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener("resize", () => this.engine.resize());
    new ResizeObserver(() => this.engine.resize()).observe(canvas);
  }

  async loadMap(map: SauerMap, textures: ResolvedTexture[], skybox?: SkyboxManifest): Promise<SceneStats> {
    const generation = ++this.loadGeneration;
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    this.materials.forEach((material) => material.dispose(true, true));
    this.fallbackMaterial?.dispose(true, true);
    this.fallbackMaterial = undefined;
    this.skyboxMaterial?.dispose(true, true);
    this.skyboxMaterial = undefined;
    this.skyboxObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.skyboxObjectUrls = [];
    this.scene.onBeforeRenderObservable.clear();
    const batches = generateGeometry(map, textures);
    this.materials = [];
    for (const textureIndex of new Set(batches.map((batch) => batch.textureIndex))) {
      const texture = textures[textureIndex];
      if (texture) this.materials[textureIndex] = this.createMaterial(texture, textureIndex);
    }
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
      const normals: number[] = [];
      VertexData.ComputeNormals(batch.positions, batch.indices, normals);
      vertexData.normals = normals;
      vertexData.applyToMesh(mesh, true);
      mesh.material = this.materials[batch.textureIndex] ?? this.createFallbackMaterial();
      mesh.freezeWorldMatrix();
      mesh.alwaysSelectAsActiveMesh = true;
      faces += batch.faceCount;
      triangles += batch.indices.length / 3;
      vertices += batch.positions.length / 3;
    });
    if (skybox) await this.createSkybox(map, skybox, generation);
    this.placeCamera(map, batches);
    return { meshes: batches.length, faces, triangles, vertices };
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.materials.forEach((material) => { material.wireframe = enabled; });
  }

  private createMaterial(resolved: ResolvedTexture, index: number): StandardMaterial {
    const material = new StandardMaterial(`map-material-${index}`, this.scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.ambientColor = new Color3(0.5, 0.5, 0.5);
    material.emissiveColor = Color3.White();
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.wireframe = this.wireframe;
    material.alpha = 1;
    if (resolved.diffuseUrl) material.diffuseTexture = this.createTexture(resolved.diffuseUrl, resolved.vslot, `diffuse-${index}`);
    if (resolved.normalUrl) material.bumpTexture = this.createTexture(resolved.normalUrl, resolved.vslot, `normal-${index}`);
    if (resolved.glowUrl) material.emissiveTexture = this.createTexture(resolved.glowUrl, resolved.vslot, `glow-${index}`);
    return material;
  }

  private createTexture(url: string, vslot: ResolvedTexture["vslot"], name: string): Texture {
    const texture = new Texture(url, this.scene, false, true, Texture.TRILINEAR_SAMPLINGMODE, () => {
      const size = texture.getBaseSize();
      texture.uScale = size.width > 0 ? 1 / size.width : 1;
      texture.vScale = size.height > 0 ? 1 / size.height : 1;
    });
    texture.name = name;
    texture.wrapU = Texture.WRAP_ADDRESSMODE;
    texture.wrapV = Texture.WRAP_ADDRESSMODE;
    if (vslot.scroll[0] !== 0 || vslot.scroll[1] !== 0) {
      const started = performance.now();
      this.scene.onBeforeRenderObservable.add(() => {
        const elapsed = performance.now() - started;
        texture.uOffset = vslot.scroll[0] * elapsed;
        texture.vOffset = vslot.scroll[1] * elapsed;
      });
    }
    return texture;
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

  private async createSkybox(map: SauerMap, skybox: SkyboxManifest, generation: number): Promise<void> {
    const urls = skybox.faces.map((face) => packageAssetUrl(face)).filter((url): url is string => Boolean(url));
    if (urls.length !== 6) return;
    const rotatedUrls = await Promise.all(urls.map((url, index) => index === 1 || index === 4 ? rotateImageClockwise(url) : url));
    const objectUrls = rotatedUrls.filter((url) => url.startsWith("blob:"));
    if (generation !== this.loadGeneration) {
      objectUrls.forEach((url) => URL.revokeObjectURL(url));
      return;
    }
    this.skyboxObjectUrls = objectUrls;
    const cubeTexture = CubeTexture.CreateFromImages(rotatedUrls, this.scene);
    cubeTexture.coordinatesMode = Texture.SKYBOX_MODE;
    const material = new StandardMaterial("map-skybox-material", this.scene);
    material.backFaceCulling = false;
    material.disableLighting = true;
    material.diffuseColor = Color3.Black();
    material.specularColor = Color3.Black();
    material.emissiveColor = Color3.Black();
    cubeTexture.level = (skybox.color[0] + skybox.color[1] + skybox.color[2]) / 3;
    material.reflectionTexture = cubeTexture;
    this.skyboxMaterial = material;
    const mesh = MeshBuilder.CreateBox("map-skybox", { size: map.header.worldSize * 4 }, this.scene);
    mesh.material = material;
    mesh.infiniteDistance = true;
    mesh.isPickable = false;
    mesh.rotation.y = -skybox.yaw * Math.PI / 180;
    const started = performance.now();
    if (skybox.spin !== 0) {
      this.scene.onBeforeRenderObservable.add(() => {
        mesh.rotation.y = -(skybox.yaw + skybox.spin * (performance.now() - started) / 1000) * Math.PI / 180;
      });
    }
  }

  private placeCamera(map: SauerMap, batches: GeometryBatch[]): void {
    const playerStart = map.entities.find((entity) => entity.type === 3);
    const fallback = { x: map.header.worldSize / 2, y: map.header.worldSize / 2, z: map.header.worldSize * 0.65 };
    const spawn = playerStart ? { ...playerStart.position, z: playerStart.position.z + 14 } : fallback;
    this.camera.position.copyFrom(toBabylonPosition(spawn));
    const target = this.geometryCenter(batches);
    const fallbackDirection = playerStart ? toBabylonYawDirection(playerStart.attributes[0]) : new Vector3(0, 0, -1);
    this.camera.setTarget(target ?? this.camera.position.add(fallbackDirection));
    this.camera.speed = Math.max(1, map.header.worldSize / 1024);
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

async function rotateImageClockwise(url: string): Promise<string> {
  const response = await fetch(url, { cache: "no-cache" });
  if (!response.ok) throw new Error(`Could not load skybox face ${url} (${response.status}).`);
  const image = await createImageBitmap(await response.blob());
  try {
    const canvas = document.createElement("canvas");
    canvas.width = image.height;
    canvas.height = image.width;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Could not create a canvas for skybox orientation correction.");
    context.translate(canvas.width / 2, canvas.height / 2);
    context.rotate(-Math.PI / 2);
    context.drawImage(image, -image.width / 2, -image.height / 2);
    const blob = await new Promise<Blob>((resolve, reject) => canvas.toBlob((value) => value ? resolve(value) : reject(new Error("Could not encode a skybox face.")), "image/png"));
    return URL.createObjectURL(blob);
  } finally {
    image.close();
  }
}
