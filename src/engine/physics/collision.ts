import { MATF_CLIP, MATF_VOLUME, MAT_CLIP, MAT_GAMECLIP, MAT_GLASS, MAT_NOCLIP } from "../material";
import type { OctreeCube, SauerMap, Vec3 } from "../octa";
import { CollisionType, type PhysicsEntity, PhysicsEntityType } from "./types";
import { dot, magnitude, normalize, subtract } from "./vector";

export interface CollisionResult {
  normal: Vec3;
  distance: number;
}

export interface RaycastResult {
  position: Vec3;
  normal: Vec3;
  distance: number;
}

export interface MapModelCollision {
  entityIndex: number;
  origin: Vec3;
  yaw: number;
  center: Vec3;
  radius: Vec3;
  ellipse: boolean;
}

interface Plane extends Vec3 {
  offset: number;
}

interface ClipGeometry {
  minimum: Vec3;
  maximum: Vec3;
  center: Vec3;
  radius: Vec3;
  axisPlanes: Plane[];
  planes: Plane[];
}

interface AxisCollisionResult {
  collision?: CollisionResult;
  separated: boolean;
}

interface Bounds {
  minimum: Vec3;
  maximum: Vec3;
}

interface MapModelBounds extends Bounds {
  index: number;
}

interface MapModelBroadphaseNode extends Bounds {
  left?: MapModelBroadphaseNode;
  right?: MapModelBroadphaseNode;
  models?: MapModelBounds[];
}

const FACE_VERTICES = [
  [0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6],
];

/** Physics-only octree queries. No Babylon mesh or picking data enters this class. */
export class OctreeCollisionWorld {
  private readonly planeCache = new WeakMap<OctreeCube, Plane[]>();
  private readonly rayPlaneCache = new WeakMap<OctreeCube, Plane[]>();
  private readonly clipGeometryCache = new WeakMap<OctreeCube, ClipGeometry>();
  private readonly hiddenFaces: WeakMap<OctreeCube, number>;

  constructor(private readonly map: SauerMap) {
    this.hiddenFaces = findCoincidentFaces(map.world);
  }

  private mapModels: MapModelCollision[] = [];
  private mapModelBroadphase?: MapModelBroadphaseNode;
  private readonly mapModelCandidates: number[] = [];

  setMapModels(mapModels: MapModelCollision[]): void {
    this.mapModels = mapModels;
    this.mapModelBroadphase = buildMapModelBroadphase(mapModels);
  }

  lookupMaterial(position: Vec3): number {
    if (position.x < 0 || position.y < 0 || position.z < 0 || position.x >= this.map.header.worldSize ||
        position.y >= this.map.header.worldSize || position.z >= this.map.header.worldSize) return 0;
    for (const root of this.map.world) {
      if (!contains(root, position)) continue;
      let cube = root;
      while (cube.children) {
        const child = cube.children.find((candidate) => contains(candidate, position));
        if (!child) break;
        cube = child;
      }
      return cube.material;
    }
    return 0;
  }

  raycast(origin: Vec3, direction: Vec3, maximumDistance: number, radius = 0, skipFirst = false): RaycastResult | undefined {
    return this.raycube(origin, direction, maximumDistance, radius, skipFirst);
  }

  // Original: src/engine/physics.cpp
  // Function: raycube()
  // Sauerbraten reference: SVN r6488
  raycube(origin: Vec3, direction: Vec3, maximumDistance: number, radius = 0, skipFirst = false): RaycastResult | undefined {
    let best: RaycastResult | undefined;
    const visit = (cube: OctreeCube): void => {
      if (!rayIntersectsBounds(origin, direction, cube.origin, cube.size, best?.distance ?? maximumDistance, radius)) return;
      if (cube.children) {
        cube.children.forEach(visit);
        return;
      }
      const clippedGlass = (cube.material & MATF_VOLUME) === MAT_GLASS;
      if (cube.kind === "empty" && !clippedGlass) return;
      const planes = clippedGlass && cube.kind === "empty" ? axisPlanes(cube) : this.planes(cube, false);
      const result = rayIntersectsPlanes(origin, direction, planes, best?.distance ?? maximumDistance, radius);
      if (result && (!skipFirst || result.distance > 0)) best = result;
    };
    this.map.world.forEach(visit);
    const candidates = this.rayMapModelCandidates(origin, direction, maximumDistance, radius);
    for (const index of candidates) {
      const model = this.mapModels[index];
      const result = rayIntersectsMapModel(origin, direction, model, best?.distance ?? maximumDistance, radius);
      if (result && (!skipFirst || result.distance > 0)) best = result;
    }
    return best;
  }

  collide(entity: PhysicsEntity, direction: Vec3, cutoff = 0): CollisionResult | undefined {
    const minimum = {
      x: Math.floor(entity.position.x - entity.radius),
      y: Math.floor(entity.position.y - entity.radius),
      z: Math.floor(entity.position.z - entity.eyeHeight),
    };
    const maximum = {
      x: Math.floor(entity.position.x + entity.radius) + 1,
      y: Math.floor(entity.position.y + entity.radius) + 1,
      z: Math.floor(entity.position.z + entity.aboveEye) + 1,
    };
    const candidates = this.collisionMapModelCandidates(entity);
    for (const index of candidates) {
      const model = this.mapModels[index];
      const result = collideMapModel(entity, direction, model);
      if (result) return result;
    }
    for (const cube of this.map.world) {
      const result = this.visit(cube, entity, direction, cutoff, minimum, maximum);
      if (result) return result;
    }
    return undefined;
  }

  collideBouncer(position: Vec3, radius: number, direction: Vec3): CollisionResult | undefined {
    const entity = {
      position, radius, xRadius: radius, yRadius: radius, eyeHeight: radius, aboveEye: radius,
      collisionType: CollisionType.EllipsePrecise, entityType: PhysicsEntityType.Bounce,
    } as PhysicsEntity;
    return this.collide(entity, direction);
  }

  private collisionMapModelCandidates(entity: PhysicsEntity): readonly number[] {
    if (!this.mapModelBroadphase) return allIndices(this.mapModels.length, this.mapModelCandidates);
    const horizontalRadius = Math.max(entity.radius, entity.xRadius, entity.yRadius);
    const bounds: Bounds = {
      minimum: { x: entity.position.x - horizontalRadius, y: entity.position.y - horizontalRadius,
        z: entity.position.z - entity.eyeHeight },
      maximum: { x: entity.position.x + horizontalRadius, y: entity.position.y + horizontalRadius,
        z: entity.position.z + entity.aboveEye },
    };
    this.mapModelCandidates.length = 0;
    queryMapModelBounds(this.mapModelBroadphase, bounds, this.mapModelCandidates);
    this.mapModelCandidates.sort(ascending);
    return this.mapModelCandidates;
  }

  private rayMapModelCandidates(origin: Vec3, direction: Vec3, maximumDistance: number, radius: number): readonly number[] {
    if (!this.mapModelBroadphase) return allIndices(this.mapModels.length, this.mapModelCandidates);
    this.mapModelCandidates.length = 0;
    queryMapModelRay(this.mapModelBroadphase, origin, direction, maximumDistance, radius, this.mapModelCandidates);
    this.mapModelCandidates.sort(ascending);
    return this.mapModelCandidates;
  }

  private visit(cube: OctreeCube, entity: PhysicsEntity, direction: Vec3, cutoff: number, minimum: Vec3,
                maximum: Vec3): CollisionResult | undefined {
    if (!overlapsCube(cube, minimum, maximum)) return undefined;
    if (cube.children) {
      for (const child of cube.children) {
        const result = this.visit(child, entity, direction, cutoff, minimum, maximum);
        if (result) return result;
      }
      return undefined;
    }
    const clip = cube.material & MATF_CLIP;
    if (clip === MAT_NOCLIP) return undefined;
    const forcedSolid = clip === MAT_CLIP && ((cube.material & MATF_VOLUME) === MAT_GLASS || entity.entityType < PhysicsEntityType.Camera) ||
      clip === MAT_GAMECLIP && entity.entityType === PhysicsEntityType.Ai;
    if (cube.kind === "empty" && !forcedSolid) return undefined;
    if (forcedSolid || cube.kind === "solid") {
      return collideSolid(entity, direction, cutoff, cube, this.hiddenFaces.get(cube) ?? 0);
    }
    return collideDeformed(entity, direction, cutoff, this.clipGeometry(cube));
  }

  private clipGeometry(cube: OctreeCube): ClipGeometry {
    const cached = this.clipGeometryCache.get(cube);
    if (cached) return cached;
    const geometry = buildClipGeometry(cube, this.hiddenFaces.get(cube) ?? 0);
    this.clipGeometryCache.set(cube, geometry);
    return geometry;
  }

  private planes(cube: OctreeCube, hideCoincidentFaces = true): Plane[] {
    const cache = hideCoincidentFaces ? this.planeCache : this.rayPlaneCache;
    const cached = cache.get(cube);
    if (cached) return cached;
    if (cube.kind === "solid") {
      const planes = axisPlanes(cube, hideCoincidentFaces ? this.hiddenFaces.get(cube) ?? 0 : 0);
      cache.set(cube, planes);
      return planes;
    }
    const vertices = cubeVertices(cube);
    const planes: Plane[] = [];
    const hidden = hideCoincidentFaces ? this.hiddenFaces.get(cube) ?? 0 : 0;
    FACE_VERTICES.forEach((face, orientation) => {
      if (hidden & (1 << orientation)) return;
      const corners = face.map((index) => vertices[index]);
      const convexity = faceConvexity(corners);
      const order = convexity < 0 ? 1 : 0;
      const first = corners[order];
      const second = corners[order + 1];
      const third = corners[order + 2];
      const fourth = corners[(order + 3) & 3];
      const firstAdded = addTrianglePlane(planes, first, second, third);
      if ((!firstAdded || convexity !== 0) && !samePosition(first, fourth) && !samePosition(third, fourth)) {
        addTrianglePlane(planes, first, third, fourth);
      }
    });
    cache.set(cube, planes);
    return planes;
  }
}

const MAPMODEL_BROADPHASE_LEAF_SIZE = 8;

function buildMapModelBroadphase(models: readonly MapModelCollision[]): MapModelBroadphaseNode | undefined {
  if (!models.length) return undefined;
  const entries = models.map((model, index) => ({ ...mapModelBounds(model), index }));
  return buildMapModelBroadphaseNode(entries);
}

function buildMapModelBroadphaseNode(entries: MapModelBounds[]): MapModelBroadphaseNode {
  const bounds = combineBounds(entries);
  if (entries.length <= MAPMODEL_BROADPHASE_LEAF_SIZE) return { ...bounds, models: entries };
  const size = {
    x: bounds.maximum.x - bounds.minimum.x,
    y: bounds.maximum.y - bounds.minimum.y,
    z: bounds.maximum.z - bounds.minimum.z,
  };
  const axis: keyof Vec3 = size.x >= size.y && size.x >= size.z ? "x" : size.y >= size.z ? "y" : "z";
  entries.sort((left, right) => boundsCenter(left, axis) - boundsCenter(right, axis) || left.index - right.index);
  const middle = Math.floor(entries.length / 2);
  return {
    ...bounds,
    left: buildMapModelBroadphaseNode(entries.slice(0, middle)),
    right: buildMapModelBroadphaseNode(entries.slice(middle)),
  };
}

function mapModelBounds(model: MapModelCollision): Bounds {
  const yaw = model.yaw * Math.PI / 180;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const center = {
    x: model.center.x * cosine - model.center.y * sine + model.origin.x,
    y: model.center.y * cosine + model.center.x * sine + model.origin.y,
    z: model.center.z + model.origin.z,
  };
  const maximumEllipseRadius = Math.max(Math.abs(model.radius.x), Math.abs(model.radius.y));
  const boxRadiusX = Math.abs(cosine) * Math.abs(model.radius.x) + Math.abs(sine) * Math.abs(model.radius.y);
  const boxRadiusY = Math.abs(sine) * Math.abs(model.radius.x) + Math.abs(cosine) * Math.abs(model.radius.y);
  const radius = {
    x: model.ellipse ? Math.max(maximumEllipseRadius, boxRadiusX) : boxRadiusX,
    y: model.ellipse ? Math.max(maximumEllipseRadius, boxRadiusY) : boxRadiusY,
    z: Math.abs(model.radius.z),
  };
  return {
    minimum: { x: center.x - radius.x, y: center.y - radius.y, z: center.z - radius.z },
    maximum: { x: center.x + radius.x, y: center.y + radius.y, z: center.z + radius.z },
  };
}

function combineBounds(entries: readonly Bounds[]): Bounds {
  const minimum = { x: Number.POSITIVE_INFINITY, y: Number.POSITIVE_INFINITY, z: Number.POSITIVE_INFINITY };
  const maximum = { x: Number.NEGATIVE_INFINITY, y: Number.NEGATIVE_INFINITY, z: Number.NEGATIVE_INFINITY };
  for (const entry of entries) {
    minimum.x = Math.min(minimum.x, entry.minimum.x);
    minimum.y = Math.min(minimum.y, entry.minimum.y);
    minimum.z = Math.min(minimum.z, entry.minimum.z);
    maximum.x = Math.max(maximum.x, entry.maximum.x);
    maximum.y = Math.max(maximum.y, entry.maximum.y);
    maximum.z = Math.max(maximum.z, entry.maximum.z);
  }
  return { minimum, maximum };
}

function boundsCenter(bounds: Bounds, axis: keyof Vec3): number {
  return (bounds.minimum[axis] + bounds.maximum[axis]) * 0.5;
}

function queryMapModelBounds(node: MapModelBroadphaseNode, bounds: Bounds, result: number[]): void {
  if (!boundsOverlap(node, bounds)) return;
  if (node.models) {
    for (const model of node.models) if (boundsOverlap(model, bounds)) result.push(model.index);
    return;
  }
  if (node.left) queryMapModelBounds(node.left, bounds, result);
  if (node.right) queryMapModelBounds(node.right, bounds, result);
}

function queryMapModelRay(node: MapModelBroadphaseNode, origin: Vec3, direction: Vec3, maximumDistance: number, radius: number,
                          result: number[]): void {
  if (!rayIntersectsAabb(origin, direction, node, maximumDistance, radius)) return;
  if (node.models) {
    for (const model of node.models) {
      if (rayIntersectsAabb(origin, direction, model, maximumDistance, radius)) result.push(model.index);
    }
    return;
  }
  if (node.left) queryMapModelRay(node.left, origin, direction, maximumDistance, radius, result);
  if (node.right) queryMapModelRay(node.right, origin, direction, maximumDistance, radius, result);
}

function rayIntersectsAabb(origin: Vec3, direction: Vec3, bounds: Bounds, maximumDistance: number, radius: number): boolean {
  let entering = 0, leaving = maximumDistance;
  for (const axis of ["x", "y", "z"] as const) {
    const minimum = bounds.minimum[axis] - radius, maximum = bounds.maximum[axis] + radius;
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < minimum || origin[axis] > maximum) return false;
      continue;
    }
    let first = (minimum - origin[axis]) / direction[axis], second = (maximum - origin[axis]) / direction[axis];
    if (first > second) [first, second] = [second, first];
    entering = Math.max(entering, first);
    leaving = Math.min(leaving, second);
    if (entering > leaving) return false;
  }
  return leaving >= 0;
}

function boundsOverlap(left: Bounds, right: Bounds): boolean {
  return left.maximum.x >= right.minimum.x && left.minimum.x <= right.maximum.x && left.maximum.y >= right.minimum.y &&
    left.minimum.y <= right.maximum.y && left.maximum.z >= right.minimum.z && left.minimum.z <= right.maximum.z;
}

function allIndices(length: number, result: number[]): readonly number[] {
  result.length = length;
  for (let index = 0; index < length; index++) result[index] = index;
  return result;
}

function ascending(left: number, right: number): number {
  return left - right;
}

function collideSolid(entity: PhysicsEntity, direction: Vec3, cutoff: number, cube: OctreeCube,
                      hidden: number): CollisionResult | undefined {
  if (Math.abs(entity.position.x - cube.origin.x - cube.size / 2) > entity.radius + cube.size / 2 ||
      Math.abs(entity.position.y - cube.origin.y - cube.size / 2) > entity.radius + cube.size / 2 ||
      entity.position.z + entity.aboveEye < cube.origin.z || entity.position.z - entity.eyeHeight > cube.origin.z + cube.size) {
    return undefined;
  }
  return collideAxisPlanes(entity, direction, cutoff, axisPlanes(cube, hidden)).collision;
}

function collideDeformed(entity: PhysicsEntity, direction: Vec3, cutoff: number,
                         geometry: ClipGeometry): CollisionResult | undefined {
  if (Math.abs(entity.position.x - geometry.center.x) > geometry.radius.x + entity.radius ||
      Math.abs(entity.position.y - geometry.center.y) > geometry.radius.y + entity.radius ||
      entity.position.z + entity.aboveEye < geometry.minimum.z || entity.position.z - entity.eyeHeight > geometry.maximum.z) {
    return undefined;
  }

  const axisResult = collideAxisPlanes(entity, direction, cutoff, geometry.axisPlanes);
  if (axisResult.separated) return undefined;
  let best = axisResult.collision;
  let bestDistance = best?.distance ?? -Infinity;
  const directionLength = magnitude(direction);
  for (const candidate of geometry.planes) {
    const support = capsuleSupport(entity, { x: -candidate.x, y: -candidate.y, z: -candidate.z });
    const distance = dot(candidate, support) + candidate.offset;
    if (distance >= 0) return undefined;
    if (distance <= bestDistance) continue;

    // This ordering is deliberate: cubecollideplanes()/fuzzycollideplanes() invalidate the previous candidate before
    // testing the newly closest plane. A rejected closest plane therefore also rejects an older collision normal.
    best = undefined;
    bestDistance = distance;
    if (directionLength > 0) {
      if (dot(candidate, direction) >= -cutoff * directionLength) continue;
      if (entity.entityType < PhysicsEntityType.Camera && distance < collisionMargin(entity, direction, candidate)) continue;
    }
    if (clampCollide(geometry, entity, candidate, support)) continue;
    best = { normal: { x: candidate.x, y: candidate.y, z: candidate.z }, distance };
  }
  return best;
}

function collideAxisPlanes(entity: PhysicsEntity, direction: Vec3, cutoff: number, planes: Plane[]): AxisCollisionResult {
  let best: CollisionResult | undefined;
  let bestDistance = -Infinity;
  const directionLength = magnitude(direction);
  for (const candidate of planes) {
    const support = capsuleSupport(entity, { x: -candidate.x, y: -candidate.y, z: -candidate.z });
    const distance = dot(candidate, support) + candidate.offset;
    if (distance > 0) return { separated: true };
    if (distance <= bestDistance) continue;
    if (directionLength > 0) {
      if (dot(candidate, direction) >= -cutoff * directionLength) continue;
      if (entity.entityType < PhysicsEntityType.Camera && distance < collisionMargin(entity, direction, candidate)) continue;
    }
    bestDistance = distance;
    best = { normal: { x: candidate.x, y: candidate.y, z: candidate.z }, distance };
  }
  return { collision: best, separated: false };
}

function clampCollide(geometry: ClipGeometry, entity: PhysicsEntity, candidate: Plane, support: Vec3): boolean {
  const center = {
    x: entity.position.x,
    y: entity.position.y,
    z: entity.position.z + (entity.aboveEye - entity.eyeHeight) / 2,
  };
  const axes = ["x", "y", "z"] as const;
  for (const axis of axes) {
    const other = axes.filter((value) => value !== axis);
    if (candidate[axis] === 0 || candidate[other[0]] === 0 && candidate[other[1]] === 0 ||
        Math.abs(support[axis] - geometry.center[axis]) <= geometry.radius[axis]) continue;
    const fixed = support[axis] < geometry.center[axis]
      ? geometry.center[axis] - geometry.radius[axis]
      : geometry.center[axis] + geometry.radius[axis];
    const denominator = candidate[other[0]] ** 2 + candidate[other[1]] ** 2;
    const planeDistance = (candidate[axis] * fixed + candidate[other[0]] * center[other[0]] +
      candidate[other[1]] * center[other[1]] + candidate.offset) / denominator;
    const projected = { ...center, [axis]: fixed };
    projected[other[0]] -= candidate[other[0]] * planeDistance;
    projected[other[1]] -= candidate[other[1]] * planeDistance;
    const projectionDirection = subtract(projected, center);
    if ((support[other[0]] - projected[other[0]]) * candidate[other[0]] +
        (support[other[1]] - projected[other[1]]) * candidate[other[1]] >= 0) {
      const entitySupport = capsuleSupport(entity, projectionDirection);
      if (squaredDistance(entitySupport, center) < dot(projectionDirection, projectionDirection)) return true;
    }
  }
  return false;
}

function buildClipGeometry(cube: OctreeCube, hidden: number): ClipGeometry {
  const vertices = cubeVertices(cube);
  const minimum = vertices.reduce((result, vertex) => ({
    x: Math.min(result.x, vertex.x), y: Math.min(result.y, vertex.y), z: Math.min(result.z, vertex.z),
  }), { x: Infinity, y: Infinity, z: Infinity });
  const maximum = vertices.reduce((result, vertex) => ({
    x: Math.max(result.x, vertex.x), y: Math.max(result.y, vertex.y), z: Math.max(result.z, vertex.z),
  }), { x: -Infinity, y: -Infinity, z: -Infinity });
  const center = {
    x: (minimum.x + maximum.x) / 2, y: (minimum.y + maximum.y) / 2, z: (minimum.z + maximum.z) / 2,
  };
  const radius = {
    x: (maximum.x - minimum.x) / 2, y: (maximum.y - minimum.y) / 2, z: (maximum.z - minimum.z) / 2,
  };
  const planes: Plane[] = [];
  const axisVisible: number[] = [];
  FACE_VERTICES.forEach((face, orientation) => {
    if (hidden & (1 << orientation)) return;
    const corners = face.map((index) => vertices[index]);
    if (isFlatAxisFace(corners, orientation)) {
      if (faceAreaSquared(corners) > 1e-12) axisVisible.push(orientation);
      return;
    }
    appendFacePlanes(planes, corners);
  });
  const boundsPlanes = [plane(-1, 0, 0, minimum.x), plane(1, 0, 0, -maximum.x),
    plane(0, -1, 0, minimum.y), plane(0, 1, 0, -maximum.y),
    plane(0, 0, -1, minimum.z), plane(0, 0, 1, -maximum.z)];
  return { minimum, maximum, center, radius, axisPlanes: axisVisible.map((orientation) => boundsPlanes[orientation]), planes };
}

function appendFacePlanes(planes: Plane[], corners: Vec3[]): void {
  const convexity = faceConvexity(corners);
  const order = convexity < 0 ? 1 : 0;
  const first = corners[order];
  const second = corners[order + 1];
  const third = corners[order + 2];
  const fourth = corners[(order + 3) & 3];
  const firstAdded = addTrianglePlane(planes, first, second, third);
  if ((!firstAdded || convexity !== 0) && !samePosition(first, fourth) && !samePosition(third, fourth)) {
    addTrianglePlane(planes, first, third, fourth);
  }
}

function isFlatAxisFace(corners: Vec3[], orientation: number): boolean {
  const axis = ["x", "x", "y", "y", "z", "z"][orientation] as keyof Vec3;
  return corners.every((corner) => Math.abs(corner[axis] - corners[0][axis]) < 1e-9);
}

function faceAreaSquared(corners: Vec3[]): number {
  const first = subtract(corners[1], corners[0]), second = subtract(corners[2], corners[0]);
  const third = subtract(corners[3], corners[0]);
  return crossSquared(first, second) + crossSquared(second, third);
}

function crossSquared(first: Vec3, second: Vec3): number {
  const cross = { x: first.y * second.z - first.z * second.y, y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x };
  return dot(cross, cross);
}

function squaredDistance(first: Vec3, second: Vec3): number {
  const difference = subtract(first, second);
  return dot(difference, difference);
}

function rayIntersectsPlanes(origin: Vec3, direction: Vec3, planes: Plane[], maximumDistance: number,
                             radius = 0): RaycastResult | undefined {
  let entering = 0, leaving = maximumDistance;
  let normal = { x: -direction.x, y: -direction.y, z: -direction.z };
  let boundarySlope = Number.POSITIVE_INFINITY;
  for (const candidate of planes) {
    const offset = dot(candidate, origin) + candidate.offset - radius;
    const slope = dot(candidate, direction);
    if (Math.abs(offset) <= 1e-7 && slope < boundarySlope) {
      normal = { x: candidate.x, y: candidate.y, z: candidate.z };
      boundarySlope = slope;
    }
    if (Math.abs(slope) < 1e-9) {
      if (offset > 0) return undefined;
      continue;
    }
    const distance = -offset / slope;
    if (slope < 0) {
      if (distance > entering) {
        entering = distance;
        normal = { x: candidate.x, y: candidate.y, z: candidate.z };
      }
    } else leaving = Math.min(leaving, distance);
    if (entering > leaving) return undefined;
  }
  if (entering < 0 || entering > maximumDistance) return undefined;
  return { distance: entering, normal, position: {
    x: origin.x + direction.x * entering, y: origin.y + direction.y * entering, z: origin.z + direction.z * entering,
  } };
}

function rayIntersectsBounds(origin: Vec3, direction: Vec3, minimum: Vec3, size: number, maximumDistance: number, radius: number): boolean {
  let entering = 0, leaving = maximumDistance;
  for (const axis of ["x", "y", "z"] as const) {
    if (Math.abs(direction[axis]) < 1e-9) {
      if (origin[axis] < minimum[axis] - radius || origin[axis] > minimum[axis] + size + radius) return false;
      continue;
    }
    let first = (minimum[axis] - radius - origin[axis]) / direction[axis];
    let second = (minimum[axis] + size + radius - origin[axis]) / direction[axis];
    if (first > second) [first, second] = [second, first];
    entering = Math.max(entering, first);
    leaving = Math.min(leaving, second);
    if (entering > leaving) return false;
  }
  return leaving >= 0;
}

function rayIntersectsMapModel(origin: Vec3, direction: Vec3, model: MapModelCollision,
                               maximumDistance: number, radius: number): RaycastResult | undefined {
  const yaw = model.yaw * Math.PI / 180;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const relative = { x: origin.x - model.origin.x, y: origin.y - model.origin.y, z: origin.z - model.origin.z };
  const localOrigin = {
    x: relative.x * cosine + relative.y * sine - model.center.x,
    y: -relative.x * sine + relative.y * cosine - model.center.y,
    z: relative.z - model.center.z,
  };
  const localDirection = {
    x: direction.x * cosine + direction.y * sine,
    y: -direction.x * sine + direction.y * cosine,
    z: direction.z,
  };
  const planes = [plane(-1, 0, 0, -model.radius.x), plane(1, 0, 0, -model.radius.x),
    plane(0, -1, 0, -model.radius.y), plane(0, 1, 0, -model.radius.y),
    plane(0, 0, -1, -model.radius.z), plane(0, 0, 1, -model.radius.z)];
  const hit = rayIntersectsPlanes(localOrigin, localDirection, planes, maximumDistance, radius);
  if (!hit) return undefined;
  const normal = { x: hit.normal.x * cosine - hit.normal.y * sine, y: hit.normal.x * sine + hit.normal.y * cosine, z: hit.normal.z };
  return { distance: hit.distance, normal, position: {
    x: origin.x + direction.x * hit.distance, y: origin.y + direction.y * hit.distance, z: origin.z + direction.z * hit.distance,
  } };
}

function collideMapModel(entity: PhysicsEntity, direction: Vec3, model: MapModelCollision): CollisionResult | undefined {
  const yaw = model.yaw * Math.PI / 180;
  const cosine = Math.cos(yaw), sine = Math.sin(yaw);
  const rotatedCenter = {
    x: model.center.x * cosine - model.center.y * sine + model.origin.x,
    y: model.center.y * cosine + model.center.x * sine + model.origin.y,
    z: model.center.z + model.origin.z,
  };
  const below = rotatedCenter.z - model.radius.z - (entity.position.z + entity.aboveEye);
  const above = entity.position.z - entity.eyeHeight - (rotatedCenter.z + model.radius.z);
  if (below >= 0 || above >= 0) return undefined;
  const dx = entity.position.x - rotatedCenter.x, dy = entity.position.y - rotatedCenter.y;
  const localX = dx * cosine + dy * sine, localY = -dx * sine + dy * cosine;
  let normal: Vec3 | undefined;
  let penetration = 0;
  if (model.ellipse) {
    const angle = Math.atan2(-dy, -dx);
    const entityAngle = angle - (entity.yaw + 90) * Math.PI / 180;
    const modelAngle = angle - (model.yaw + 90) * Math.PI / 180;
    const entityRadius = Math.hypot(entity.xRadius * Math.cos(entityAngle), entity.yRadius * Math.sin(entityAngle));
    const modelRadius = Math.hypot(model.radius.x * Math.cos(modelAngle), model.radius.y * Math.sin(modelAngle));
    const distance = Math.hypot(dx, dy) - entityRadius - modelRadius;
    if (distance >= 0) return undefined;
    penetration = distance;
    if (distance > (entity.position.z < rotatedCenter.z ? below : above) &&
        (magnitude(direction) === 0 || -dx * direction.x - dy * direction.y > 0)) {
      normal = { x: dx, y: dy, z: 0 };
      normalize(normal);
    }
  } else {
    const offsetX = Math.max(-model.radius.x, Math.min(model.radius.x, localX)) - localX;
    const offsetY = Math.max(-model.radius.y, Math.min(model.radius.y, localY)) - localY;
    const distance = Math.hypot(offsetX, offsetY) - entity.radius;
    if (distance >= 0) return undefined;
    penetration = distance;
    const sideX = localX <= -model.radius.x ? -1 : localX >= model.radius.x ? 1 : 0;
    const sideY = localY <= -model.radius.y ? -1 : localY >= model.radius.y ? 1 : 0;
    if (distance > (entity.position.z < rotatedCenter.z ? below : above) && (sideX || sideY)) {
      const localDirection = { x: direction.x * cosine + direction.y * sine, y: -direction.x * sine + direction.y * cosine };
      if (sideX * localX - model.radius.x > sideY * localY - model.radius.y) {
        if (magnitude(direction) === 0 || sideX * localDirection.x < -1e-6) {
          normal = { x: sideX * cosine, y: sideX * sine, z: 0 };
        }
      } else if (magnitude(direction) === 0 || sideY * localDirection.y < -1e-6) {
        normal = { x: -sideY * sine, y: sideY * cosine, z: 0 };
      }
    }
  }
  if (!normal) {
    if (entity.position.z < rotatedCenter.z) {
      if (magnitude(direction) !== 0 && (direction.z <= 0 || entity.entityType < PhysicsEntityType.Inanimate &&
          below < entity.zMargin - (entity.eyeHeight + entity.aboveEye) / 4)) return undefined;
      normal = { x: 0, y: 0, z: -1 };
    } else {
      if (magnitude(direction) !== 0 && (direction.z >= 0 || entity.entityType < PhysicsEntityType.Inanimate &&
          above < entity.zMargin - (entity.eyeHeight + entity.aboveEye) / 3)) return undefined;
      normal = { x: 0, y: 0, z: 1 };
    }
  }
  if (magnitude(direction) > 0 && dot(normal, direction) >= 0) return undefined;
  return { normal, distance: penetration };
}

function axisPlanes(cube: OctreeCube, hidden = 0): Plane[] {
  const { x, y, z } = cube.origin;
  const size = cube.size;
  const planes = [plane(-1, 0, 0, x), plane(1, 0, 0, -(x + size)), plane(0, -1, 0, y), plane(0, 1, 0, -(y + size)),
    plane(0, 0, -1, z), plane(0, 0, 1, -(z + size))];
  return planes.filter((_, orientation) => !(hidden & (1 << orientation)));
}

function capsuleSupport(entity: PhysicsEntity, direction: Vec3): Vec3 {
  const normal = { ...direction };
  normalize(normal);
  return {
    x: entity.position.x + normal.x * entity.radius,
    y: entity.position.y + normal.y * entity.radius,
    z: entity.position.z + (direction.z > 0 ? entity.aboveEye - entity.radius : -(entity.eyeHeight - entity.radius)) + normal.z * entity.radius,
  };
}

function collisionMargin(entity: PhysicsEntity, direction: Vec3, plane: Plane): number {
  if (direction.z * plane.z < 0) {
    return entity.zMargin - (entity.eyeHeight + entity.aboveEye) / (direction.z < 0 ? 3 : 4);
  }
  if (direction.x * plane.x < 0 || direction.y * plane.y < 0) return -entity.radius;
  return 0;
}

function cubeVertices(cube: OctreeCube): Vec3[] {
  const result: Vec3[] = [];
  for (let index = 0; index < 8; index++) {
    const x = index & 1, y = index >> 1 & 1, z = index >> 2 & 1;
    const edge = (dimension: number, first: number, second: number) => cube.edges[dimension * 4 + second * 2 + first];
    const value = (encoded: number, high: number) => (high ? encoded >> 4 : encoded & 0x0f) * cube.size / 8;
    result.push({
      x: cube.origin.x + value(edge(0, y, z), x),
      y: cube.origin.y + value(edge(1, z, x), y),
      z: cube.origin.z + value(edge(2, x, y), z),
    });
  }
  return result;
}

function addTrianglePlane(planes: Plane[], first: Vec3, second: Vec3, third: Vec3): boolean {
  const ab = subtract(second, first), ac = subtract(third, first);
  const normal = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
  if (magnitude(normal) < 1e-8) return false;
  normalize(normal);
  const offset = -dot(normal, first);
  if (!planes.some((candidate) => Math.abs(dot(candidate, normal) - 1) < 1e-5 && Math.abs(candidate.offset - offset) < 1e-4)) {
    planes.push({ ...normal, offset });
  }
  return true;
}

function faceConvexity(vertices: Vec3[]): number {
  const first = subtract(vertices[1], vertices[0]);
  const second = subtract(vertices[2], vertices[0]);
  const normal = {
    x: first.y * second.z - first.z * second.y,
    y: first.z * second.x - first.x * second.z,
    z: first.x * second.y - first.y * second.x,
  };
  return dot(subtract(vertices[0], vertices[3]), normal);
}

function findCoincidentFaces(cubes: OctreeCube[]): WeakMap<OctreeCube, number> {
  const faces = new Map<string, Array<{ cube: OctreeCube; orientation: number }>>();
  visitLeaves(cubes, (cube) => {
    const vertices = cubeVertices(cube);
    FACE_VERTICES.forEach((face, orientation) => {
      const key = face.map((index) => positionKey(vertices[index])).sort().join("|");
      const entries = faces.get(key) ?? [];
      entries.push({ cube, orientation });
      faces.set(key, entries);
    });
  });
  const hidden = new WeakMap<OctreeCube, number>();
  faces.forEach((entries) => entries.forEach((entry) => {
    if (!entries.some((candidate) => candidate !== entry && candidate.orientation === (entry.orientation ^ 1) &&
        (candidate.cube.material & MATF_CLIP) !== MAT_NOCLIP)) return;
    hidden.set(entry.cube, (hidden.get(entry.cube) ?? 0) | (1 << entry.orientation));
  }));
  return hidden;
}

function visitLeaves(cubes: OctreeCube[], callback: (cube: OctreeCube) => void): void {
  cubes.forEach((cube) => {
    if (cube.children) visitLeaves(cube.children, callback);
    else if (cube.kind !== "empty") callback(cube);
  });
}

function positionKey(position: Vec3): string {
  return `${position.x},${position.y},${position.z}`;
}

function samePosition(first: Vec3, second: Vec3): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}

function overlapsCube(cube: OctreeCube, minimum: Vec3, maximum: Vec3): boolean {
  return maximum.x >= cube.origin.x && minimum.x <= cube.origin.x + cube.size && maximum.y >= cube.origin.y &&
    minimum.y <= cube.origin.y + cube.size && maximum.z >= cube.origin.z && minimum.z <= cube.origin.z + cube.size;
}

function contains(cube: OctreeCube, point: Vec3): boolean {
  return point.x >= cube.origin.x && point.y >= cube.origin.y && point.z >= cube.origin.z && point.x < cube.origin.x + cube.size &&
    point.y < cube.origin.y + cube.size && point.z < cube.origin.z + cube.size;
}

function plane(x: number, y: number, z: number, offset: number): Plane {
  return { x, y, z, offset };
}
