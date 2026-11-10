import { Color3, Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { StandardMaterial } from "@babylonjs/core/Materials/standardMaterial";
import { Mesh } from "@babylonjs/core/Meshes/mesh";
import { VertexData } from "@babylonjs/core/Meshes/mesh.vertexData";
import { Scene } from "@babylonjs/core/scene";
import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Camera } from "@babylonjs/core/Cameras/camera";
import type { SauerMap } from "../map/types";
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
  private material: StandardMaterial;

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

    this.material = this.createMaterial();
    this.engine.runRenderLoop(() => this.scene.render());
    window.addEventListener("resize", () => this.engine.resize());
    new ResizeObserver(() => this.engine.resize()).observe(canvas);
  }

  loadMap(map: SauerMap): SceneStats {
    this.scene.meshes.slice().forEach((mesh) => mesh.dispose());
    const batches = generateGeometry(map);
    let faces = 0;
    let triangles = 0;
    let vertices = 0;
    batches.forEach((batch) => {
      const mesh = new Mesh(batch.name, this.scene);
      const vertexData = new VertexData();
      vertexData.positions = batch.positions;
      vertexData.indices = batch.indices;
      vertexData.colors = batch.colors;
      const normals: number[] = [];
      VertexData.ComputeNormals(batch.positions, batch.indices, normals);
      vertexData.normals = normals;
      vertexData.applyToMesh(mesh, true);
      mesh.material = this.material;
      mesh.freezeWorldMatrix();
      mesh.alwaysSelectAsActiveMesh = true;
      faces += batch.faceCount;
      triangles += batch.indices.length / 3;
      vertices += batch.positions.length / 3;
    });
    this.placeCamera(map, batches);
    return { meshes: batches.length, faces, triangles, vertices };
  }

  setWireframe(enabled: boolean): void {
    this.material.wireframe = enabled;
  }

  private createMaterial(): StandardMaterial {
    const material = new StandardMaterial("map-material", this.scene);
    material.diffuseColor = Color3.White();
    material.specularColor = new Color3(0.08, 0.08, 0.08);
    material.ambientColor = new Color3(0.5, 0.5, 0.5);
    material.emissiveColor = Color3.White();
    material.backFaceCulling = false;
    material.disableLighting = true;
    return material;
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
