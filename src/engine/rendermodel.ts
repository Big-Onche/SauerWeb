export interface ModelAdjustment {
  bone: string;
  yaw: number;
  pitch: number;
  roll: number;
  translate: [number, number, number];
}

export interface ModelGeometry {
  meshes: ModelGeometryMesh[];
  joints?: ModelJointPose[];
}

export interface ModelJointPose {
  name: string;
  parent: number;
  position: [number, number, number];
  orientation: [number, number, number, number];
}

export interface ModelGeometryMesh {
  name: string;
  positions: number[];
  uvs: number[];
  indices: number[];
  bones?: number[];
}

interface Md5Vertex {
  index: number;
  firstWeight: number;
  weightCount: number;
}

interface Md5Weight {
  joint: number;
  bias: number;
  position: [number, number, number];
}

interface PreparedMd5Mesh {
  name: string;
  vertices: Md5Vertex[];
  weights: Md5Weight[];
  uvs: number[];
  indices: number[];
  bones: number[];
}

interface Md5HierarchyEntry {
  name: string;
  parent: number;
  flags: number;
  start: number;
}

interface Md5BasePose {
  position: [number, number, number];
  orientation: [number, number, number];
}

export interface PreparedMd5Model {
  bindJoints: ModelJointPose[];
  meshes: PreparedMd5Mesh[];
}

export interface PreparedMd5Animation {
  hierarchy: Md5HierarchyEntry[];
  base: Md5BasePose[];
  frames: Float32Array[];
  adjustmentByBone: Map<string, ModelAdjustment>;
}

// Original: src/engine/md5.h
// Function: md5meshgroup::loadmesh()
// Sauerbraten reference: SVN r6488
export function parseMd5(source: string, animationSource?: string, adjustments: ModelAdjustment[] = [], animationFrame = 0): ModelGeometry {
  return skinMd5Model(prepareMd5Model(source), animationSource ? prepareMd5Animation(animationSource, adjustments) : undefined, animationFrame);
}

export function prepareMd5Model(source: string): PreparedMd5Model {
  const jointBlock = source.match(/joints\s*\{([\s\S]*?)\}/i)?.[1];
  if (!jointBlock) throw new Error("MD5 model has no joints block.");
  const bindJoints = [...jointBlock.matchAll(/^\s*"([^"]*)"\s+(-?\d+)\s+\(\s*([^)]*?)\s*\)\s+\(\s*([^)]*?)\s*\)/gm)].map((match) => {
    const position = parseMd5Vector(match[3]);
    const orientation = parseMd5Vector(match[4]);
    position[1] *= -1;
    orientation[0] *= -1;
    orientation[2] *= -1;
    return { name: match[1], parent: Number(match[2]), position, orientation: md5Quaternion(orientation) };
  });
  if (!bindJoints.length) throw new Error("MD5 model has no readable joints.");
  const meshes: PreparedMd5Mesh[] = [];
  let meshIndex = 0;
  for (const match of source.matchAll(/mesh\s*\{([\s\S]*?)\}/gi)) {
    const block = match[1];
    const name = block.match(/shader\s+"([^"]*)"/i)?.[1].split(/[\\/]/).pop()?.replace(/\.[^.]+$/, "") || `mesh-${meshIndex}`;
    const vertices = [...block.matchAll(/^\s*vert\s+(\d+)\s+\(\s*([^)]*?)\s*\)\s+(\d+)\s+(\d+)/gm)].map((vertex) => ({
      index: Number(vertex[1]),
      uv: vertex[2].trim().split(/\s+/).map(Number),
      firstWeight: Number(vertex[3]),
      weightCount: Number(vertex[4]),
    }));
    const triangles = [...block.matchAll(/^\s*tri\s+\d+\s+(\d+)\s+(\d+)\s+(\d+)/gm)];
    const weights = [...block.matchAll(/^\s*weight\s+(\d+)\s+(\d+)\s+([^\s]+)\s+\(\s*([^)]*?)\s*\)/gm)].map((weight) => ({
      joint: Number(weight[2]),
      bias: Number(weight[3]),
      position: flipMd5Weight(parseMd5Vector(weight[4])),
    }));
    if (!vertices.length || !triangles.length || !weights.length) continue;
    const uvs = new Array<number>(vertices.length * 2).fill(0);
    const bones = new Array<number>(vertices.length).fill(0);
    for (const vertex of vertices) {
      let dominantBias = -1;
      for (let offset = 0; offset < vertex.weightCount; offset++) {
        const weight = weights[vertex.firstWeight + offset];
        if (!weight || !bindJoints[weight.joint]) throw new Error("MD5 vertex references an invalid weight or joint.");
        if (weight.bias > dominantBias) {
          dominantBias = weight.bias;
          bones[vertex.index] = weight.joint;
        }
      }
      uvs.splice(vertex.index * 2, 2, vertex.uv[0] ?? 0, vertex.uv[1] ?? 0);
    }
    const indices: number[] = [];
    for (const triangle of triangles) indices.push(Number(triangle[1]), Number(triangle[2]), Number(triangle[3]));
    meshes.push({ name, vertices, weights, uvs, indices, bones });
    meshIndex++;
  }
  if (!meshes.length) throw new Error("MD5 model contains no renderable geometry.");
  return { bindJoints, meshes };
}

export function skinMd5Model(model: PreparedMd5Model, animation?: PreparedMd5Animation, animationFrame = 0): ModelGeometry {
  const joints = animation ? sampleMd5AnimationFrame(animation, animationFrame) : model.bindJoints;
  return skinMd5Joints(model, joints);
}

export function skinMd5ModelParts(model: PreparedMd5Model,
                                  parts: Array<{ animation: PreparedMd5Animation; frame: number; nextFrame?: number; interpolation?: number;
                                    roots: string[] }>): ModelGeometry {
  if (!parts.length) return skinMd5Joints(model, model.bindJoints);
  const localParts = parts.map((part) => {
    const joints = sampleMd5AnimationLocals(part.animation, part.frame);
    if (part.interpolation && part.nextFrame !== undefined && part.nextFrame !== part.frame) {
      const next = sampleMd5AnimationLocals(part.animation, part.nextFrame);
      joints.forEach((joint, index) => interpolateJointPose(joint, next[index], part.interpolation!, joint));
    }
    return { ...part, joints };
  });
  const partByJoint = animationPartAssignments(localParts[0].joints, parts.map((part) => part.roots));
  const locals = localParts[0].joints.map((_, index) => localParts[partByJoint[index]]?.joints[index] ?? localParts[0].joints[index]);
  return skinMd5Joints(model, composeMd5Joints(locals));
}

function skinMd5Joints(model: PreparedMd5Model, joints: ModelJointPose[]): ModelGeometry {
  if (joints.length !== model.bindJoints.length) throw new Error("MD5 animation does not match its mesh skeleton.");
  const meshes = model.meshes.map((mesh) => {
    const positions = new Array<number>(mesh.vertices.length * 3).fill(0);
    for (const vertex of mesh.vertices) {
      let x = 0;
      let y = 0;
      let z = 0;
      for (let offset = 0; offset < vertex.weightCount; offset++) {
        const weight = mesh.weights[vertex.firstWeight + offset];
        const joint = weight && joints[weight.joint];
        if (!weight || !joint) throw new Error("MD5 vertex references an invalid weight or joint.");
        const rotated = rotateMd5Vector(weight.position, joint.orientation);
        x += (joint.position[0] + rotated[0]) * weight.bias;
        y += (joint.position[1] + rotated[1]) * weight.bias;
        z += (joint.position[2] + rotated[2]) * weight.bias;
      }
      positions[vertex.index * 3] = x;
      positions[vertex.index * 3 + 1] = z;
      positions[vertex.index * 3 + 2] = y;
    }
    return { name: mesh.name, positions, uvs: mesh.uvs, indices: mesh.indices, bones: mesh.bones };
  });
  return { meshes, joints };
}

export interface Md5AnimationInfo {
  frameCount: number;
  frameRate: number;
}

export function interpolateModelGeometry(current: ModelGeometry, next: ModelGeometry, interpolation: number,
                                         reusable?: ModelGeometry): ModelGeometry {
  if (interpolation <= 0 || current.meshes.length !== next.meshes.length) return current;
  const amount = Math.min(interpolation, 1);
  let joints = current.joints;
  if (current.joints && next.joints && current.joints.length === next.joints.length) {
    joints = reusable?.joints?.length === current.joints.length ? reusable.joints : new Array<ModelJointPose>(current.joints.length);
    for (let index = 0; index < joints.length; index++) {
      joints[index] = interpolateJointPose(current.joints[index], next.joints[index], amount, joints[index]);
    }
  }
  const meshes = reusable?.meshes.length === current.meshes.length ? reusable.meshes : new Array<ModelGeometryMesh>(current.meshes.length);
  for (let meshIndex = 0; meshIndex < current.meshes.length; meshIndex++) {
    const mesh = current.meshes[meshIndex];
    const nextMesh = next.meshes[meshIndex];
    if (mesh.positions.length !== nextMesh.positions.length) {
      meshes[meshIndex] = mesh;
      continue;
    }
    const target = meshes[meshIndex];
    const positions = target?.positions.length === mesh.positions.length ? target.positions : new Array<number>(mesh.positions.length);
    for (let index = 0; index < positions.length; index++) {
      positions[index] = mesh.positions[index] + (nextMesh.positions[index] - mesh.positions[index]) * amount;
    }
    if (target && target !== current.meshes[meshIndex] && target !== next.meshes[meshIndex]) {
      target.name = mesh.name;
      target.positions = positions;
      target.uvs = mesh.uvs;
      target.indices = mesh.indices;
      target.bones = mesh.bones;
      meshes[meshIndex] = target;
    } else meshes[meshIndex] = { ...mesh, positions };
  }
  if (reusable) {
    if (reusable.meshes !== meshes) reusable.meshes = meshes;
    if (reusable.joints !== joints) reusable.joints = joints;
    return reusable;
  }
  return { meshes, joints };
}

function interpolateJointPose(current: ModelJointPose, next: ModelJointPose, amount: number, reusable?: ModelJointPose): ModelJointPose {
  const direction = current.orientation.reduce((sum, value, index) => sum + value * next.orientation[index], 0) < 0 ? -1 : 1;
  const orientation = reusable?.orientation ?? [0, 0, 0, 0];
  for (let index = 0; index < orientation.length; index++) {
    orientation[index] = current.orientation[index] + (next.orientation[index] * direction - current.orientation[index]) * amount;
  }
  const length = Math.hypot(...orientation) || 1;
  for (let index = 0; index < orientation.length; index++) orientation[index] /= length;
  const position = reusable?.position ?? [0, 0, 0];
  for (let index = 0; index < position.length; index++) {
    position[index] = current.position[index] + (next.position[index] - current.position[index]) * amount;
  }
  if (reusable) {
    reusable.name = current.name;
    reusable.parent = current.parent;
    return reusable;
  }
  return { name: current.name, parent: current.parent, position, orientation };
}

export function md5AnimationInfo(source: string): Md5AnimationInfo {
  return {
    frameCount: Math.max(1, Number(source.match(/numFrames\s+(\d+)/i)?.[1] ?? 1)),
    frameRate: Math.max(1, Number(source.match(/frameRate\s+(\d+)/i)?.[1] ?? 24)),
  };
}

export function prepareMd5Animation(source: string, adjustments: ModelAdjustment[] = []): PreparedMd5Animation {
  const hierarchyBlock = source.match(/hierarchy\s*\{([\s\S]*?)\}/i)?.[1];
  const baseBlock = source.match(/baseframe\s*\{([\s\S]*?)\}/i)?.[1];
  const frameCount = md5AnimationInfo(source).frameCount;
  if (!hierarchyBlock || !baseBlock) throw new Error("MD5 animation has no readable skeleton.");
  const hierarchy = [...hierarchyBlock.matchAll(/^\s*"([^"]*)"\s+(-?\d+)\s+(\d+)\s+(\d+)/gm)].map((match) => ({
    name: match[1], parent: Number(match[2]), flags: Number(match[3]), start: Number(match[4]),
  }));
  const base = [...baseBlock.matchAll(/^\s*\(\s*([^)]*?)\s*\)\s+\(\s*([^)]*?)\s*\)/gm)].map((match) => ({
    position: flipMd5Weight(parseMd5Vector(match[1])), orientation: flipMd5Orientation(parseMd5Vector(match[2])),
  }));
  const frames = new Array<Float32Array>(frameCount);
  for (const match of source.matchAll(/frame\s+(\d+)\s*\{([\s\S]*?)\}/gi)) {
    const index = Number(match[1]);
    if (index >= 0 && index < frameCount) {
      frames[index] = Float32Array.from(match[2].match(/[-+]?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/gi)?.map(Number) ?? []);
    }
  }
  return { hierarchy, base, frames, adjustmentByBone: new Map(adjustments.map((adjustment) => [adjustment.bone, adjustment])) };
}

function sampleMd5AnimationFrame(animation: PreparedMd5Animation, animationFrame: number): ModelJointPose[] {
  return composeMd5Joints(sampleMd5AnimationLocals(animation, animationFrame));
}

function sampleMd5AnimationLocals(animation: PreparedMd5Animation, animationFrame: number): ModelJointPose[] {
  const frame = Math.min(animation.frames.length - 1, Math.max(0, Math.trunc(animationFrame)));
  const data = animation.frames[frame];
  if (!data) throw new Error(`MD5 animation has no readable frame ${frame}.`);
  const joints: ModelJointPose[] = [];
  animation.hierarchy.forEach((entry, index) => {
    const localPosition = [...animation.base[index].position] as [number, number, number];
    const localOrientation = [...animation.base[index].orientation] as [number, number, number];
    let offset = entry.start;
    if (entry.flags & 1) localPosition[0] = data[offset++];
    if (entry.flags & 2) localPosition[1] = -data[offset++];
    if (entry.flags & 4) localPosition[2] = data[offset++];
    if (entry.flags & 8) localOrientation[0] = -data[offset++];
    if (entry.flags & 16) localOrientation[1] = data[offset++];
    if (entry.flags & 32) localOrientation[2] = -data[offset++];
    const adjustment = animation.adjustmentByBone.get(entry.name);
    let position = localPosition;
    let orientation = md5Quaternion(localOrientation);
    if (adjustment) {
      ({ position, orientation } = applyMd5Adjustment(position, orientation, adjustment));
    }
    joints.push({ name: entry.name, parent: entry.parent, position, orientation });
  });
  return joints;
}

function composeMd5Joints(locals: ModelJointPose[]): ModelJointPose[] {
  const joints: ModelJointPose[] = [];
  for (const local of locals) {
    let position = [...local.position] as [number, number, number];
    let orientation = [...local.orientation] as [number, number, number, number];
    if (local.parent >= 0) {
      const parent = joints[local.parent];
      const rotated = rotateMd5Vector(position, parent.orientation);
      position = [parent.position[0] + rotated[0], parent.position[1] + rotated[1], parent.position[2] + rotated[2]];
      orientation = multiplyMd5Quaternions(parent.orientation, orientation);
    }
    joints.push({ name: local.name, parent: local.parent, position, orientation });
  }
  return joints;
}

function animationPartAssignments(joints: Array<{ name: string; parent: number }>, partRoots: string[][]): number[] {
  const assignments = new Array<number>(joints.length).fill(0);
  for (let part = 1; part < partRoots.length; part++) {
    const roots = new Set(partRoots[part]);
    for (let joint = 0; joint < joints.length; joint++) {
      if (roots.has(joints[joint].name) || joints[joint].parent >= 0 && assignments[joints[joint].parent] === part) assignments[joint] = part;
    }
  }
  return assignments;
}

function applyMd5Adjustment(position: [number, number, number], orientation: [number, number, number, number],
                            adjustment: ModelAdjustment): { position: [number, number, number]; orientation: [number, number, number, number] } {
  let dual = positionQuaternionMd5(position, orientation);
  let real = orientation;
  for (const [axis, degrees] of [
    [[0, 0, 1] as [number, number, number], adjustment.yaw],
    [[0, -1, 0] as [number, number, number], adjustment.pitch],
    [[-1, 0, 0] as [number, number, number], adjustment.roll],
  ] as const) {
    if (!degrees) continue;
    const rotation = axisAngleMd5Quaternion(axis, degrees);
    real = multiplyMd5Quaternions(rotation, real);
    dual = multiplyMd5Quaternions(invertMd5Quaternion(rotation), dual);
  }
  const [x, y, z] = adjustment.translate;
  dual[0] += 0.5 * (x * real[3] + y * real[2] - z * real[1]);
  dual[1] += 0.5 * (-x * real[2] + y * real[3] + z * real[0]);
  dual[2] += 0.5 * (x * real[1] - y * real[0] + z * real[3]);
  dual[3] += -0.5 * (x * real[0] + y * real[1] + z * real[2]);
  return { position: dualQuaternionTranslationMd5(real, dual), orientation: real };
}

function positionQuaternionMd5(position: [number, number, number], orientation: [number, number, number, number]): [number, number, number, number] {
  const [x, y, z] = position;
  return [
    0.5 * (x * orientation[3] + y * orientation[2] - z * orientation[1]),
    0.5 * (-x * orientation[2] + y * orientation[3] + z * orientation[0]),
    0.5 * (x * orientation[1] - y * orientation[0] + z * orientation[3]),
    -0.5 * (x * orientation[0] + y * orientation[1] + z * orientation[2]),
  ];
}

function dualQuaternionTranslationMd5(real: [number, number, number, number], dual: [number, number, number, number]): [number, number, number] {
  return [
    2 * (real[1] * dual[2] - real[2] * dual[1] + dual[0] * real[3] - real[0] * dual[3]),
    2 * (real[2] * dual[0] - real[0] * dual[2] + dual[1] * real[3] - real[1] * dual[3]),
    2 * (real[0] * dual[1] - real[1] * dual[0] + dual[2] * real[3] - real[2] * dual[3]),
  ];
}

function invertMd5Quaternion(quaternion: [number, number, number, number]): [number, number, number, number] {
  return [-quaternion[0], -quaternion[1], -quaternion[2], quaternion[3]];
}

function axisAngleMd5Quaternion(axis: [number, number, number], degrees: number): [number, number, number, number] {
  const halfAngle = degrees * Math.PI / 360;
  const sine = Math.sin(halfAngle);
  return [axis[0] * sine, axis[1] * sine, axis[2] * sine, Math.cos(halfAngle)];
}

function parseMd5Vector(value: string): [number, number, number] {
  const fields = value.trim().split(/\s+/).map(Number);
  return [fields[0] ?? 0, fields[1] ?? 0, fields[2] ?? 0];
}

function flipMd5Weight(vector: [number, number, number]): [number, number, number] {
  vector[1] *= -1;
  return vector;
}

function flipMd5Orientation(vector: [number, number, number]): [number, number, number] {
  vector[0] *= -1;
  vector[2] *= -1;
  return vector;
}

function md5Quaternion(vector: [number, number, number]): [number, number, number, number] {
  return [vector[0], vector[1], vector[2], -Math.sqrt(Math.max(0, 1 - vector[0] ** 2 - vector[1] ** 2 - vector[2] ** 2))];
}

function rotateMd5Vector(vector: [number, number, number], quaternion: [number, number, number, number]): [number, number, number] {
  const [x, y, z, w] = quaternion;
  const tx = 2 * (y * vector[2] - z * vector[1]);
  const ty = 2 * (z * vector[0] - x * vector[2]);
  const tz = 2 * (x * vector[1] - y * vector[0]);
  return [vector[0] + w * tx + y * tz - z * ty, vector[1] + w * ty + z * tx - x * tz,
    vector[2] + w * tz + x * ty - y * tx];
}

function multiplyMd5Quaternions(left: [number, number, number, number], right: [number, number, number, number]): [number, number, number, number] {
  return [
    left[3] * right[0] + left[0] * right[3] + left[1] * right[2] - left[2] * right[1],
    left[3] * right[1] - left[0] * right[2] + left[1] * right[3] + left[2] * right[0],
    left[3] * right[2] + left[0] * right[1] - left[1] * right[0] + left[2] * right[3],
    left[3] * right[3] - left[0] * right[0] - left[1] * right[1] - left[2] * right[2],
  ];
}

// Original: src/engine/obj.h
// Function: objmeshgroup::load()
// Sauerbraten reference: SVN r6488
export function parseObj(source: string): ModelGeometry {
  const positions: number[][] = [];
  const texCoords: number[][] = [];
  const groups: Array<{ name: string; faces: string[][] }> = [];
  let group = { name: "mesh", faces: [] as string[][] };
  groups.push(group);
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const fields = line.split(/\s+/);
    if (fields[0] === "v") positions.push(fields.slice(1, 4).map(Number));
    else if (fields[0] === "vt") texCoords.push(fields.slice(1, 3).map(Number));
    else if (fields[0] === "g" || fields[0] === "o") {
      if (group.faces.length || groups.length === 1 && group.name !== "mesh") {
        group = { name: fields.slice(1).join(" ") || "mesh", faces: [] };
        groups.push(group);
      } else group.name = fields.slice(1).join(" ") || "mesh";
    } else if (fields[0] === "f" && fields.length >= 4) group.faces.push(fields.slice(1));
  }
  return { meshes: groups.filter((item) => item.faces.length).map((item) => buildObjGroup(item.name, item.faces, positions, texCoords)) };
}

function buildObjGroup(name: string, faces: string[][], sourcePositions: number[][], sourceUvs: number[][]): ModelGeometryMesh {
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertices = new Map<string, number>();
  const vertexIndex = (token: string): number => {
    const cached = vertices.get(token);
    if (cached !== undefined) return cached;
    const fields = token.split("/");
    const positionIndex = objIndex(fields[0], sourcePositions.length);
    const uvIndex = objIndex(fields[1], sourceUvs.length);
    const position = sourcePositions[positionIndex] ?? [0, 0, 0];
    const uv = sourceUvs[uvIndex] ?? [0, 0];
    const index = positions.length / 3;
    positions.push(position[2], position[1], -position[0]);
    uvs.push(uv[0], 1 - uv[1]);
    vertices.set(token, index);
    return index;
  };
  for (const face of faces) {
    const faceIndices = face.map(vertexIndex);
    for (let index = 1; index + 1 < faceIndices.length; index++) indices.push(faceIndices[index + 1], faceIndices[index], faceIndices[0]);
  }
  return { name, positions, uvs, indices };
}

function objIndex(value: string | undefined, length: number): number {
  const parsed = Number(value);
  return !Number.isFinite(parsed) || parsed === 0 ? -1 : parsed < 0 ? length + parsed : parsed - 1;
}

// Original: src/engine/md2.h
// Function: md2::load()
// Sauerbraten reference: SVN r6488
export function parseMd2(buffer: ArrayBuffer): ModelGeometry {
  const view = new DataView(buffer);
  if (view.byteLength < 68 || view.getInt32(0, true) !== 844121161 || view.getInt32(4, true) !== 8) throw new Error("Invalid MD2 header.");
  const frameSize = view.getInt32(16, true);
  const vertexCount = view.getInt32(24, true);
  const frameCount = view.getInt32(40, true);
  const commandCount = view.getInt32(36, true);
  const frameOffset = view.getInt32(56, true);
  const commandOffset = view.getInt32(60, true);
  if (frameCount <= 0 || vertexCount <= 0 || commandCount <= 0 || frameOffset + frameSize > view.byteLength ||
      commandOffset < 68 || commandOffset + commandCount * 4 > view.byteLength) throw new Error("Invalid MD2 dimensions.");
  const scale = [view.getFloat32(frameOffset, true), view.getFloat32(frameOffset + 4, true), view.getFloat32(frameOffset + 8, true)];
  const translate = [view.getFloat32(frameOffset + 12, true), view.getFloat32(frameOffset + 16, true), view.getFloat32(frameOffset + 20, true)];
  const frameVertices: number[][] = [];
  for (let index = 0; index < vertexCount; index++) {
    const offset = frameOffset + 40 + index * 4;
    frameVertices.push([
      view.getUint8(offset) * scale[0] + translate[0],
      view.getUint8(offset + 2) * scale[2] + translate[2],
      -(view.getUint8(offset + 1) * scale[1] + translate[1]),
    ]);
  }
  const positions: number[] = [];
  const uvs: number[] = [];
  const indices: number[] = [];
  const vertexMap = new Map<string, number>();
  let offset = commandOffset;
  while (offset + 4 <= view.byteLength) {
    let count = view.getInt32(offset, true);
    offset += 4;
    if (count === 0) break;
    const fan = count < 0;
    count = Math.abs(count);
    const strip: number[] = [];
    for (let index = 0; index < count; index++, offset += 12) {
      if (offset + 12 > view.byteLength) throw new Error("Truncated MD2 command list.");
      const u = view.getFloat32(offset, true);
      const v = view.getFloat32(offset + 4, true);
      const sourceIndex = view.getInt32(offset + 8, true);
      const key = `${sourceIndex}:${u}:${v}`;
      let target = vertexMap.get(key);
      if (target === undefined) {
        target = positions.length / 3;
        positions.push(...(frameVertices[sourceIndex] ?? [0, 0, 0]));
        uvs.push(u, v);
        vertexMap.set(key, target);
      }
      strip.push(target);
    }
    for (let index = 0; index < count - 2; index++) {
      const triangle = fan ? [strip[0], strip[index + 1], strip[index + 2]]
        : index % 2 ? [strip[index], strip[index + 2], strip[index + 1]] : [strip[index], strip[index + 1], strip[index + 2]];
      indices.push(triangle[0], triangle[1], triangle[2]);
    }
  }
  if (!positions.length || !indices.length) throw new Error("MD2 model contains no renderable geometry.");
  return { meshes: [{ name: "mesh", positions, uvs, indices }] };
}

// Original: src/engine/md3.h
// Function: md3::load()
// Sauerbraten reference: SVN r6488
export function parseMd3(buffer: ArrayBuffer): ModelGeometry {
  const view = new DataView(buffer);
  if (view.byteLength < 108 || readAscii(view, 0, 4) !== "IDP3" || view.getInt32(4, true) !== 15) throw new Error("Invalid MD3 header.");
  const meshCount = view.getInt32(84, true);
  let meshOffset = view.getInt32(100, true);
  const meshes: ModelGeometryMesh[] = [];
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    if (meshOffset + 108 > view.byteLength || readAscii(view, meshOffset, 4) !== "IDP3") throw new Error("Invalid MD3 mesh header.");
    const name = readAscii(view, meshOffset + 4, 64) || `mesh-${meshIndex}`;
    const vertexCount = view.getInt32(meshOffset + 80, true);
    const triangleCount = view.getInt32(meshOffset + 84, true);
    const triangleOffset = meshOffset + view.getInt32(meshOffset + 88, true);
    const uvOffset = meshOffset + view.getInt32(meshOffset + 96, true);
    const vertexOffset = meshOffset + view.getInt32(meshOffset + 100, true);
    const meshSize = view.getInt32(meshOffset + 104, true);
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    for (let index = 0; index < vertexCount; index++) {
      positions.push(view.getInt16(vertexOffset + index * 8, true) / 64, view.getInt16(vertexOffset + index * 8 + 4, true) / 64,
        -view.getInt16(vertexOffset + index * 8 + 2, true) / 64);
      uvs.push(view.getFloat32(uvOffset + index * 8, true), view.getFloat32(uvOffset + index * 8 + 4, true));
    }
    for (let index = 0; index < triangleCount; index++) {
      const offset = triangleOffset + index * 12;
      indices.push(view.getInt32(offset, true), view.getInt32(offset + 4, true), view.getInt32(offset + 8, true));
    }
    meshes.push({ name, positions, uvs, indices });
    meshOffset += meshSize;
  }
  return { meshes };
}

// Original: src/engine/iqm.h
// Function: iqmmeshgroup::loadiqmmeshes()
// Sauerbraten reference: SVN r6488
export interface IqmAnimationInfo {
  frameCount: number;
  frameRate: number;
}

export function iqmAnimationInfo(buffer: ArrayBuffer): IqmAnimationInfo {
  const view = new DataView(buffer);
  validateIqm(view);
  const frameCount = view.getUint32(92, true);
  const animationCount = view.getUint32(84, true);
  const animationOffset = view.getUint32(88, true);
  const frameRate = animationCount && rangeWithin(animationOffset, 20, view.byteLength) ? view.getFloat32(animationOffset + 12, true) : 24;
  return { frameCount: Math.max(1, frameCount), frameRate: Math.max(1, frameRate) };
}

export function parseIqm(buffer: ArrayBuffer, animationBuffer?: ArrayBuffer, animationFrame = 0): ModelGeometry {
  return parseIqmParts(buffer, animationBuffer ? [{ buffer: animationBuffer, frame: animationFrame, roots: [] }] : []);
}

export function parseIqmParts(buffer: ArrayBuffer, parts: Array<{ buffer: ArrayBuffer; frame: number; nextFrame?: number; interpolation?: number;
  roots: string[] }>): ModelGeometry {
  const view = new DataView(buffer);
  validateIqm(view);
  const fileSize = view.getUint32(20, true);
  const textSize = view.getUint32(28, true);
  const textOffset = view.getUint32(32, true);
  const meshCount = view.getUint32(36, true);
  const meshOffset = view.getUint32(40, true);
  const vertexArrayCount = view.getUint32(44, true);
  const vertexCount = view.getUint32(48, true);
  const vertexArrayOffset = view.getUint32(52, true);
  const triangleCount = view.getUint32(56, true);
  const triangleOffset = view.getUint32(60, true);
  if (fileSize > view.byteLength || !rangeWithin(textOffset, textSize, fileSize) ||
      !rangeWithin(meshOffset, meshCount * 24, fileSize) || !rangeWithin(vertexArrayOffset, vertexArrayCount * 20, fileSize) ||
      !rangeWithin(triangleOffset, triangleCount * 12, fileSize)) throw new Error("Invalid IQM section bounds.");
  let positionOffset: number | undefined;
  let texCoordOffset: number | undefined;
  let blendIndexOffset: number | undefined;
  let blendWeightOffset: number | undefined;
  for (let index = 0; index < vertexArrayCount; index++) {
    const offset = vertexArrayOffset + index * 20;
    const type = view.getUint32(offset, true);
    const format = view.getUint32(offset + 8, true);
    const size = view.getUint32(offset + 12, true);
    const dataOffset = view.getUint32(offset + 16, true);
    if (type === 0 && format === 7 && size === 3) positionOffset = dataOffset;
    else if (type === 1 && format === 7 && size === 2) texCoordOffset = dataOffset;
    else if (type === 4 && format === 1 && size === 4) blendIndexOffset = dataOffset;
    else if (type === 5 && format === 1 && size === 4) blendWeightOffset = dataOffset;
  }
  if (positionOffset === undefined || !rangeWithin(positionOffset, vertexCount * 12, fileSize) ||
      texCoordOffset !== undefined && !rangeWithin(texCoordOffset, vertexCount * 8, fileSize)) {
    throw new Error("IQM model has invalid vertex arrays.");
  }
  const hasBlendData = blendIndexOffset !== undefined && blendWeightOffset !== undefined &&
    rangeWithin(blendIndexOffset, vertexCount * 4, fileSize) && rangeWithin(blendWeightOffset, vertexCount * 4, fileSize);
  const blendIndices = hasBlendData ? blendIndexOffset! : 0;
  const blendWeights = hasBlendData ? blendWeightOffset! : 0;
  const transforms = parts.length ? iqmPartTransforms(view, parts) : undefined;
  const animatedPositions = transforms && hasBlendData
    ? skinIqmPositions(view, positionOffset, vertexCount, blendIndices, blendWeights, transforms)
    : undefined;
  const meshes: ModelGeometryMesh[] = [];
  for (let meshIndex = 0; meshIndex < meshCount; meshIndex++) {
    const offset = meshOffset + meshIndex * 24;
    const nameOffset = view.getUint32(offset, true);
    const firstVertex = view.getUint32(offset + 8, true);
    const meshVertexCount = view.getUint32(offset + 12, true);
    const firstTriangle = view.getUint32(offset + 16, true);
    const meshTriangleCount = view.getUint32(offset + 20, true);
    if (firstVertex + meshVertexCount > vertexCount || firstTriangle + meshTriangleCount > triangleCount) {
      throw new Error("IQM mesh references data outside the model.");
    }
    const positions: number[] = [];
    const uvs: number[] = [];
    const indices: number[] = [];
    const bones: number[] = [];
    for (let index = 0; index < meshVertexCount; index++) {
      const vertexOffset = positionOffset + (firstVertex + index) * 12;
      const source = animatedPositions?.[firstVertex + index] ?? [view.getFloat32(vertexOffset, true), view.getFloat32(vertexOffset + 4, true),
        view.getFloat32(vertexOffset + 8, true)];
      positions.push(source[0], source[2], -source[1]);
      if (hasBlendData) {
        let dominantBlend = 0;
        for (let blend = 1; blend < 4; blend++) {
          if (view.getUint8(blendWeights + (firstVertex + index) * 4 + blend) >
              view.getUint8(blendWeights + (firstVertex + index) * 4 + dominantBlend)) dominantBlend = blend;
        }
        bones.push(view.getUint8(blendIndices + (firstVertex + index) * 4 + dominantBlend));
      }
      if (texCoordOffset !== undefined) {
        const uvOffset = texCoordOffset + (firstVertex + index) * 8;
        uvs.push(view.getFloat32(uvOffset, true), view.getFloat32(uvOffset + 4, true));
      } else uvs.push(0, 0);
    }
    for (let index = 0; index < meshTriangleCount; index++) {
      const indexOffset = triangleOffset + (firstTriangle + index) * 12;
      indices.push(view.getUint32(indexOffset, true) - firstVertex, view.getUint32(indexOffset + 4, true) - firstVertex,
        view.getUint32(indexOffset + 8, true) - firstVertex);
    }
    if (positions.length && indices.length) meshes.push({
      name: readAscii(view, textOffset + nameOffset, Math.max(0, textSize - nameOffset)) || `mesh-${meshIndex}`,
      positions,
      uvs,
      indices,
      bones: bones.length ? bones : undefined,
    });
  }
  if (!meshes.length) throw new Error("IQM model contains no renderable geometry.");
  const joints = iqmJointPoses(view, transforms);
  return { meshes, joints };
}

function iqmJointPoses(view: DataView, animated?: IqmTransform[]): ModelJointPose[] | undefined {
  const jointCount = view.getUint32(68, true);
  const jointOffset = view.getUint32(72, true);
  const textSize = view.getUint32(28, true);
  const textOffset = view.getUint32(32, true);
  if (!jointCount || !rangeWithin(jointOffset, jointCount * 48, view.byteLength)) return undefined;
  const transforms = animated?.length === jointCount ? animated : readIqmJoints(view, jointOffset, jointCount);
  return transforms.map((transform, index) => {
    const entry = jointOffset + index * 48;
    const nameOffset = view.getUint32(entry, true);
    const orientation = transform.orientation;
    return {
      name: readAscii(view, textOffset + nameOffset, Math.max(0, textSize - nameOffset)),
      parent: view.getInt32(entry + 4, true),
      position: [transform.position[0], -transform.position[1], transform.position[2]],
      orientation: [-orientation[0], orientation[1], -orientation[2], orientation[3]],
    };
  });
}

interface IqmTransform {
  position: [number, number, number];
  orientation: [number, number, number, number];
  scale: [number, number, number];
}

function skinIqmPositions(view: DataView, positionOffset: number, vertexCount: number, blendIndexOffset: number, blendWeightOffset: number,
                          animated: IqmTransform[]): Array<[number, number, number]> {
  const jointCount = view.getUint32(68, true);
  const jointOffset = view.getUint32(72, true);
  if (!jointCount || animated.length !== jointCount || !rangeWithin(jointOffset, jointCount * 48, view.byteLength)) return [];
  const base = readIqmJoints(view, jointOffset, jointCount);
  const result: Array<[number, number, number]> = [];
  for (let vertex = 0; vertex < vertexCount; vertex++) {
    const offset = positionOffset + vertex * 12;
    const source: [number, number, number] = [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
    const position: [number, number, number] = [0, 0, 0];
    let totalWeight = 0;
    for (let blend = 0; blend < 4; blend++) {
      const weight = view.getUint8(blendWeightOffset + vertex * 4 + blend) / 255;
      if (!weight) continue;
      const joint = view.getUint8(blendIndexOffset + vertex * 4 + blend);
      if (!base[joint] || !animated[joint]) continue;
      const transformed = applyIqmTransform(animated[joint], inverseIqmTransform(base[joint], source));
      position[0] += transformed[0] * weight;
      position[1] += transformed[1] * weight;
      position[2] += transformed[2] * weight;
      totalWeight += weight;
    }
    result.push(totalWeight > 0 ? position : source);
  }
  return result;
}

function iqmPartTransforms(model: DataView, parts: Array<{ buffer: ArrayBuffer; frame: number; nextFrame?: number; interpolation?: number;
  roots: string[] }>): IqmTransform[] | undefined {
  const jointCount = model.getUint32(68, true);
  const jointOffset = model.getUint32(72, true);
  const textSize = model.getUint32(28, true);
  const textOffset = model.getUint32(32, true);
  if (!jointCount || !rangeWithin(jointOffset, jointCount * 48, model.byteLength)) return undefined;
  const joints = Array.from({ length: jointCount }, (_, index) => {
    const offset = jointOffset + index * 48;
    const nameOffset = model.getUint32(offset, true);
    return { name: readAscii(model, textOffset + nameOffset, Math.max(0, textSize - nameOffset)), parent: model.getInt32(offset + 4, true) };
  });
  const assignments = animationPartAssignments(joints, parts.map((part) => part.roots));
  const locals = parts.map((part) => {
    const animation = new DataView(part.buffer);
    validateIqm(animation);
    if (animation.getUint32(76, true) !== jointCount) return undefined;
    const current = readIqmFrameLocals(animation, animation.getUint32(80, true), jointCount, part.frame);
    if (part.interpolation && part.nextFrame !== undefined && part.nextFrame !== part.frame) {
      const next = readIqmFrameLocals(animation, animation.getUint32(80, true), jointCount, part.nextFrame);
      current.forEach((transform, index) => interpolateIqmTransform(transform, next[index], part.interpolation!, transform));
    }
    return current;
  });
  if (!locals[0]) return undefined;
  const selected = joints.map((_, index) => locals[assignments[index]]?.[index] ?? locals[0]![index]);
  return composeIqmTransforms(selected, joints.map((joint) => joint.parent));
}

function readIqmJoints(view: DataView, offset: number, count: number): IqmTransform[] {
  const result: IqmTransform[] = [];
  for (let index = 0; index < count; index++) {
    const jointOffset = offset + index * 48;
    const parent = view.getInt32(jointOffset + 4, true);
    const transform: IqmTransform = {
      position: readIqmFloats3(view, jointOffset + 8),
      orientation: normalizeIqmQuaternion(readIqmFloats4(view, jointOffset + 20)),
      scale: readIqmFloats3(view, jointOffset + 36),
    };
    result.push(parent >= 0 ? combineIqmTransforms(result[parent], transform) : transform);
  }
  return result;
}

function readIqmFrameLocals(view: DataView, poseOffset: number, poseCount: number, requestedFrame: number): IqmTransform[] {
  const frameCount = Math.max(1, view.getUint32(92, true));
  const channelCount = view.getUint32(96, true);
  const framesOffset = view.getUint32(100, true);
  const frame = Math.min(frameCount - 1, Math.max(0, Math.trunc(requestedFrame)));
  let channel = framesOffset + frame * channelCount * 2;
  const result: IqmTransform[] = [];
  for (let index = 0; index < poseCount; index++) {
    const offset = poseOffset + index * 88;
    const mask = view.getUint32(offset + 4, true);
    const values = Array.from({ length: 10 }, (_, component) => view.getFloat32(offset + 8 + component * 4, true));
    for (let component = 0; component < 10; component++) {
      if (!(mask & 1 << component)) continue;
      values[component] += view.getUint16(channel, true) * view.getFloat32(offset + 48 + component * 4, true);
      channel += 2;
    }
    const transform: IqmTransform = {
      position: [values[0], values[1], values[2]],
      orientation: normalizeIqmQuaternion([values[3], values[4], values[5], values[6]]),
      scale: [values[7], values[8], values[9]],
    };
    result.push(transform);
  }
  return result;
}

function composeIqmTransforms(locals: IqmTransform[], parents: number[]): IqmTransform[] {
  const result: IqmTransform[] = [];
  for (let index = 0; index < locals.length; index++) {
    result.push(parents[index] >= 0 ? combineIqmTransforms(result[parents[index]], locals[index]) : locals[index]);
  }
  return result;
}

function interpolateIqmTransform(current: IqmTransform, next: IqmTransform, amount: number, result: IqmTransform): IqmTransform {
  for (let axis = 0; axis < 3; axis++) {
    result.position[axis] = current.position[axis] + (next.position[axis] - current.position[axis]) * amount;
    result.scale[axis] = current.scale[axis] + (next.scale[axis] - current.scale[axis]) * amount;
  }
  const sign = current.orientation[0] * next.orientation[0] + current.orientation[1] * next.orientation[1] +
    current.orientation[2] * next.orientation[2] + current.orientation[3] * next.orientation[3] < 0 ? -1 : 1;
  result.orientation = normalizeIqmQuaternion(current.orientation.map((value, index) =>
    value + (next.orientation[index] * sign - value) * amount) as [number, number, number, number]);
  return result;
}

function combineIqmTransforms(parent: IqmTransform, child: IqmTransform): IqmTransform {
  const scaled: [number, number, number] = [child.position[0] * parent.scale[0], child.position[1] * parent.scale[1],
    child.position[2] * parent.scale[2]];
  const rotated = rotateMd5Vector(scaled, parent.orientation);
  return {
    position: [parent.position[0] + rotated[0], parent.position[1] + rotated[1], parent.position[2] + rotated[2]],
    orientation: normalizeIqmQuaternion(multiplyMd5Quaternions(parent.orientation, child.orientation)),
    scale: [parent.scale[0] * child.scale[0], parent.scale[1] * child.scale[1], parent.scale[2] * child.scale[2]],
  };
}

function inverseIqmTransform(transform: IqmTransform, position: [number, number, number]): [number, number, number] {
  const translated: [number, number, number] = [position[0] - transform.position[0], position[1] - transform.position[1],
    position[2] - transform.position[2]];
  const rotated = rotateMd5Vector(translated, invertMd5Quaternion(transform.orientation));
  return [rotated[0] / transform.scale[0], rotated[1] / transform.scale[1], rotated[2] / transform.scale[2]];
}

function applyIqmTransform(transform: IqmTransform, position: [number, number, number]): [number, number, number] {
  const scaled: [number, number, number] = [position[0] * transform.scale[0], position[1] * transform.scale[1], position[2] * transform.scale[2]];
  const rotated = rotateMd5Vector(scaled, transform.orientation);
  return [rotated[0] + transform.position[0], rotated[1] + transform.position[1], rotated[2] + transform.position[2]];
}

function normalizeIqmQuaternion(quaternion: [number, number, number, number]): [number, number, number, number] {
  const length = Math.hypot(...quaternion) || 1;
  return [quaternion[0] / length, quaternion[1] / length, quaternion[2] / length, quaternion[3] / length];
}

function readIqmFloats3(view: DataView, offset: number): [number, number, number] {
  return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true)];
}

function readIqmFloats4(view: DataView, offset: number): [number, number, number, number] {
  return [view.getFloat32(offset, true), view.getFloat32(offset + 4, true), view.getFloat32(offset + 8, true), view.getFloat32(offset + 12, true)];
}

function validateIqm(view: DataView): void {
  if (view.byteLength < 124 || readAscii(view, 0, 16) !== "INTERQUAKEMODEL" || view.getUint32(16, true) !== 2) {
    throw new Error("Invalid IQM header.");
  }
}

function rangeWithin(offset: number, length: number, limit: number): boolean {
  return Number.isSafeInteger(offset) && Number.isSafeInteger(length) && offset >= 0 && length >= 0 && offset <= limit - length;
}

function readAscii(view: DataView, offset: number, length: number): string {
  let result = "";
  for (let index = 0; index < length && offset + index < view.byteLength; index++) {
    const value = view.getUint8(offset + index);
    if (!value) break;
    result += String.fromCharCode(value);
  }
  return result;
}
