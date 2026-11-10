import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Engine } from "@babylonjs/core/Engines/engine";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { CubeTexture } from "@babylonjs/core/Materials/Textures/cubeTexture";
import { Texture } from "@babylonjs/core/Materials/Textures/texture";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { MeshBuilder } from "@babylonjs/core/Meshes/meshBuilder";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { SauerMap } from "../map/types";
import type { MapLightingOverrides, MapSkyOverrides, ResolvedTexture } from "../assets/types";
import { packageAssetUrl } from "../assets/TextureResolver";
import { generateGeometry, type GeometryBatch } from "./geometry";
import { describeSauerMaterial, MaterialCache } from "./MaterialCache";
import { toBabylonPosition, toBabylonYawDirection } from "./coordinates";
import { resolveMapLighting } from "./MapLighting";
import { resolveMapSky, skyFaceCandidates, skyTextureRotationRadians, type MapSky } from "./MapSky";

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
  private materialCache: MaterialCache;
  private fallbackMaterial?: StandardMaterial;
  private skyboxMaterial?: StandardMaterial;
  private skyboxObjectUrls: string[] = [];
  private loadGeneration = 0;
  private wireframe = false;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false });
    this.scene = new Scene(this.engine);
    this.materialCache = new MaterialCache(this.scene);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0.055, 0.067, 0.06, 1);

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

  async loadMap(map: SauerMap, textures: ResolvedTexture[], skyOverrides?: MapSkyOverrides,
                lightingOverrides?: MapLightingOverrides): Promise<SceneStats> {
    const generation = ++this.loadGeneration;
    const lighting = resolveMapLighting(map, lightingOverrides);
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    this.materialCache.dispose();
    this.materialCache = new MaterialCache(this.scene, map.lightmaps, lighting.ambient);
    this.fallbackMaterial?.dispose(true, true);
    this.fallbackMaterial = undefined;
    this.skyboxMaterial?.dispose(true, true);
    this.skyboxMaterial = undefined;
    this.skyboxObjectUrls.forEach((url) => URL.revokeObjectURL(url));
    this.skyboxObjectUrls = [];
    this.scene.onBeforeRenderObservable.clear();
    const batches = generateGeometry(map, textures);
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
    this.materialCache.setWireframe(this.wireframe);
    await this.createSkybox(map, resolveMapSky(map, skyOverrides), generation);
    this.placeCamera(map, batches);
    return { meshes: batches.length, faces, triangles, vertices };
  }

  setWireframe(enabled: boolean): void {
    this.wireframe = enabled;
    this.materialCache.setWireframe(enabled);
    if (this.fallbackMaterial) this.fallbackMaterial.wireframe = enabled;
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
