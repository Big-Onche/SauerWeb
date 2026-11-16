import { readFile } from "node:fs/promises";
import { performance } from "node:perf_hooks";
import { AnimationGroup } from "@babylonjs/core/Animations/animationGroup.js";
import { VertexBuffer } from "@babylonjs/core/Buffers/buffer.js";
import { FreeCamera } from "@babylonjs/core/Cameras/freeCamera.js";
import { NullEngine } from "@babylonjs/core/Engines/nullEngine.js";
import { LoadAssetContainerAsync } from "@babylonjs/core/Loading/sceneLoader.js";
import { Vector3 } from "@babylonjs/core/Maths/math.vector.js";
import { Scene } from "@babylonjs/core/scene.js";
import "@babylonjs/loaders/glTF/glTFFileLoader.js";
import "@babylonjs/loaders/glTF/2.0/glTFLoader.js";

const root = new URL("../public/assets/models/playermodels/", import.meta.url);
const manifest = JSON.parse(await readFile(new URL("manifest.json", root), "utf8"));
const engine = new NullEngine({ renderWidth: 64, renderHeight: 64, deterministicLockstep: true });
const scene = new Scene(engine);
scene.activeCamera = new FreeCamera("validation-camera", Vector3.Zero(), scene);
const results = [];

for (const [name, model] of Object.entries(manifest.models)) {
  const bytes = new Uint8Array(await readFile(new URL(model.glb, root)));
  const started = performance.now();
  const container = await LoadAssetContainerAsync(bytes, scene, {
    pluginExtension: ".glb",
    pluginOptions: { gltf: { skipMaterials: true } },
  });
  const loadMilliseconds = performance.now() - started;
  if (container.materials.length || model.materials) {
    throw new Error(`${name}: player GLBs must not export materials; SauerWeb applies shared team materials at runtime`);
  }
  const clips = new Set(container.animationGroups.map((group) => group.name));
  const missing = model.clips.map((clip) => clip.name).filter((clip) => !clips.has(clip));
  if (missing.length) throw new Error(`${name}: missing Babylon animation groups: ${missing.join(", ")}`);
  if (!container.skeletons.length || container.meshes.every((mesh) => !mesh.skeleton)) {
    throw new Error(`${name}: Babylon did not create a GPU-skinned mesh and skeleton`);
  }
  for (const mesh of container.meshes.filter((candidate) => candidate.skeleton && candidate.getTotalVertices() > 0)) {
    for (const kind of [VertexBuffer.PositionKind, VertexBuffer.NormalKind, VertexBuffer.UVKind, VertexBuffer.MatricesIndicesKind,
      VertexBuffer.MatricesWeightsKind]) {
      if (!mesh.isVerticesDataPresent(kind)) throw new Error(`${name}/${mesh.name}: missing ${kind} vertex data`);
    }
  }
  const instance = container.instantiateModelsToScene((sourceName) => `validation-${name}-${sourceName}`, false);
  if (!instance.skeletons.length || instance.animationGroups.length !== model.animations) {
    throw new Error(`${name}: instantiated skeleton/animation count differs from the source container`);
  }
  instance.animationGroups[0]?.start(true, 1).goToFrame(instance.animationGroups[0].from);
  scene.render(false);
  instance.dispose();
  results.push({ name, bytes: bytes.byteLength, meshes: model.meshes, joints: model.joints, animations: model.animations,
    loadMilliseconds: Number(loadMilliseconds.toFixed(2)) });
}

const stressModel = results.reduce((largest, model) => model.animations * model.joints > largest.animations * largest.joints ? model : largest);
const stressManifest = manifest.models[stressModel.name];
const stressBytes = new Uint8Array(await readFile(new URL(stressManifest.glb, root)));
const stressContainer = await LoadAssetContainerAsync(stressBytes, scene, {
  pluginExtension: ".glb",
  pluginOptions: { gltf: { skipMaterials: true } },
});
const heapBefore = process.memoryUsage().heapUsed;
const stressStarted = performance.now();
const bots = Array.from({ length: 21 }, (_, index) => stressContainer.instantiateModelsToScene(
  (sourceName) => `stress-${index}-${sourceName}`, false));
const sharedGeometryIds = new Set(bots.flatMap((bot) => bot.rootNodes.flatMap((rootNode) => rootNode.getChildMeshes(false)))
  .map((mesh) => mesh.geometry?.uniqueId).filter((id) => id !== undefined));
if (sharedGeometryIds.size > stressManifest.meshes) throw new Error(`${stressModel.name}: instances duplicated GPU geometry`);
const instantiateMilliseconds = performance.now() - stressStarted;
for (const bot of bots) {
  const idle = bot.animationGroups.find((group) => group.name.toLowerCase().includes("idle")) ?? bot.animationGroups[0];
  if (!(idle instanceof AnimationGroup)) throw new Error(`${stressModel.name}: stress instance has no idle animation`);
  idle.start(true, 1).goToFrame(idle.from);
}
const frameStarted = performance.now();
scene.render(false);
const frameMilliseconds = performance.now() - frameStarted;
const heapMegabytes = (process.memoryUsage().heapUsed - heapBefore) / (1024 * 1024);
bots.forEach((bot) => bot.dispose());
stressContainer.dispose();

console.log(JSON.stringify({ models: results, stress: { model: stressModel.name, instances: bots.length,
  instantiateMilliseconds: Number(instantiateMilliseconds.toFixed(2)), nullEngineFrameMilliseconds: Number(frameMilliseconds.toFixed(2)),
  heapMegabytes: Number(heapMegabytes.toFixed(2)), sharedGeometryBuffers: sharedGeometryIds.size } }, null, 2));
scene.dispose();
engine.dispose();
