import { MATF_CLIP, MATF_VOLUME, MAT_CLIP, MAT_GAMECLIP, MAT_GLASS, MAT_NOCLIP } from "../material";
import type { OctreeCube, SauerMap, Vec3 } from "../octa";
import { type PhysicsEntity, PhysicsEntityType } from "./types";
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

const FACE_VERTICES = [
  [0, 4, 6, 2], [1, 3, 7, 5], [0, 1, 5, 4], [2, 6, 7, 3], [0, 2, 3, 1], [4, 5, 7, 6],
];

/** Physics-only octree queries. No Babylon mesh or picking data enters this class. */
export class OctreeCollisionWorld {
  private readonly planeCache = new WeakMap<OctreeCube, Plane[]>();
  private readonly rayPlaneCache = new WeakMap<OctreeCube, Plane[]>();
  private readonly hiddenFaces: WeakMap<OctreeCube, number>;

  constructor(private readonly map: SauerMap) {
    this.hiddenFaces = findCoincidentFaces(map.world);
  }

  private mapModels: MapModelCollision[] = [];

  setMapModels(mapModels: MapModelCollision[]): void {
    this.mapModels = mapModels;
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
    for (const model of this.mapModels) {
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
    let best: CollisionResult | undefined;
    this.map.world.forEach((cube) => {
      const result = this.visit(cube, entity, direction, cutoff, minimum, maximum);
      if (result && (!best || result.distance > best.distance)) best = result;
    });
    for (const model of this.mapModels) {
      const result = collideMapModel(entity, direction, model);
      if (result && (!best || result.distance > best.distance)) best = result;
    }
    return best;
  }

  private visit(cube: OctreeCube, entity: PhysicsEntity, direction: Vec3, cutoff: number, minimum: Vec3,
                maximum: Vec3): CollisionResult | undefined {
    if (!overlapsCube(cube, minimum, maximum)) return undefined;
    if (cube.children) {
      let best: CollisionResult | undefined;
      cube.children.forEach((child) => {
        const result = this.visit(child, entity, direction, cutoff, minimum, maximum);
        if (result && (!best || result.distance > best.distance)) best = result;
      });
      return best;
    }
    const clip = cube.material & MATF_CLIP;
    if (clip === MAT_NOCLIP) return undefined;
    const forcedSolid = clip === MAT_CLIP && ((cube.material & MATF_VOLUME) === MAT_GLASS || entity.entityType < PhysicsEntityType.Camera) ||
      clip === MAT_GAMECLIP && entity.entityType === PhysicsEntityType.Ai;
    if (cube.kind === "empty" && !forcedSolid) return undefined;
    return this.collidePlanes(entity, direction, cutoff, forcedSolid ? axisPlanes(cube) : this.planes(cube));
  }

  private collidePlanes(entity: PhysicsEntity, direction: Vec3, cutoff: number, planes: Plane[]): CollisionResult | undefined {
    let best: CollisionResult | undefined;
    let bestDistance = -Infinity;
    const directionLength = magnitude(direction);
    for (const plane of planes) {
      const support = capsuleSupport(entity, { x: -plane.x, y: -plane.y, z: -plane.z });
      const distance = dot(plane, support) + plane.offset;
      if (distance >= 0) return undefined;
      if (distance <= bestDistance) continue;
      bestDistance = distance;
      best = undefined;
      if (directionLength > 0) {
        if (dot(plane, direction) >= -cutoff * directionLength) continue;
        if (entity.entityType < PhysicsEntityType.Camera && distance < collisionMargin(entity, direction, plane)) continue;
      }
      best = { normal: { x: plane.x, y: plane.y, z: plane.z }, distance };
    }
    return best;
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
    const center = vertices.reduce((sum, vertex) => ({ x: sum.x + vertex.x / 8, y: sum.y + vertex.y / 8, z: sum.z + vertex.z / 8 }),
      { x: 0, y: 0, z: 0 });
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
      const firstAdded = addTrianglePlane(planes, first, second, third, center);
      if ((!firstAdded || convexity !== 0) && !samePosition(first, fourth) && !samePosition(third, fourth)) {
        addTrianglePlane(planes, first, third, fourth, center);
      }
    });
    cache.set(cube, planes);
    return planes;
  }
}

function rayIntersectsPlanes(origin: Vec3, direction: Vec3, planes: Plane[], maximumDistance: number,
                             radius = 0): RaycastResult | undefined {
  let entering = 0, leaving = maximumDistance;
  let normal = { x: -direction.x, y: -direction.y, z: -direction.z };
  for (const candidate of planes) {
    const offset = dot(candidate, origin) + candidate.offset - radius;
    const slope = dot(candidate, direction);
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
    const angle = Math.atan2(-localY, -localX);
    const modelRadius = Math.hypot(model.radius.x * Math.cos(angle), model.radius.y * Math.sin(angle));
    const distance = Math.hypot(dx, dy) - entity.radius - modelRadius;
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

function addTrianglePlane(planes: Plane[], first: Vec3, second: Vec3, third: Vec3, center: Vec3): boolean {
  const ab = subtract(second, first), ac = subtract(third, first);
  const normal = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
  if (magnitude(normal) < 1e-8) return false;
  normalize(normal);
  let offset = -dot(normal, first);
  if (dot(normal, center) + offset > 0) {
    normal.x *= -1; normal.y *= -1; normal.z *= -1; offset *= -1;
  }
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
    if (!entries.some((candidate) => candidate !== entry && candidate.orientation === (entry.orientation ^ 1))) return;
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
