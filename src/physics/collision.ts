import { MATF_CLIP, MAT_CLIP, MAT_NOCLIP } from "../map/materials";
import type { OctreeCube, SauerMap, Vec3 } from "../map/types";
import type { PhysicsEntity } from "./types";
import { dot, magnitude, normalize, subtract } from "./vector";

export interface CollisionResult {
  normal: Vec3;
  distance: number;
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

  constructor(private readonly map: SauerMap) {}

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
    if (clip === MAT_NOCLIP || (cube.kind === "empty" && clip !== MAT_CLIP)) return undefined;
    return this.collidePlanes(entity, direction, cutoff, clip === MAT_CLIP ? axisPlanes(cube) : this.planes(cube));
  }

  private collidePlanes(entity: PhysicsEntity, direction: Vec3, cutoff: number, planes: Plane[]): CollisionResult | undefined {
    let best: CollisionResult | undefined;
    const directionLength = magnitude(direction);
    for (const plane of planes) {
      const support = capsuleSupport(entity, { x: -plane.x, y: -plane.y, z: -plane.z });
      const distance = dot(plane, support) + plane.offset;
      if (distance >= 0) return undefined;
      if (best && distance <= best.distance) continue;
      if (directionLength > 0 && dot(plane, direction) >= -cutoff * directionLength) continue;
      best = { normal: { x: plane.x, y: plane.y, z: plane.z }, distance };
    }
    return best;
  }

  private planes(cube: OctreeCube): Plane[] {
    const cached = this.planeCache.get(cube);
    if (cached) return cached;
    if (cube.kind === "solid") {
      const planes = axisPlanes(cube);
      this.planeCache.set(cube, planes);
      return planes;
    }
    const vertices = cubeVertices(cube);
    const center = vertices.reduce((sum, vertex) => ({ x: sum.x + vertex.x / 8, y: sum.y + vertex.y / 8, z: sum.z + vertex.z / 8 }),
      { x: 0, y: 0, z: 0 });
    const planes: Plane[] = [];
    FACE_VERTICES.forEach((face) => {
      addTrianglePlane(planes, vertices[face[0]], vertices[face[1]], vertices[face[2]], center);
      addTrianglePlane(planes, vertices[face[0]], vertices[face[2]], vertices[face[3]], center);
    });
    this.planeCache.set(cube, planes);
    return planes;
  }
}

function axisPlanes(cube: OctreeCube): Plane[] {
  const { x, y, z } = cube.origin;
  const size = cube.size;
  return [plane(-1, 0, 0, x), plane(1, 0, 0, -(x + size)), plane(0, -1, 0, y), plane(0, 1, 0, -(y + size)),
    plane(0, 0, -1, z), plane(0, 0, 1, -(z + size))];
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

function addTrianglePlane(planes: Plane[], first: Vec3, second: Vec3, third: Vec3, center: Vec3): void {
  const ab = subtract(second, first), ac = subtract(third, first);
  const normal = { x: ab.y * ac.z - ab.z * ac.y, y: ab.z * ac.x - ab.x * ac.z, z: ab.x * ac.y - ab.y * ac.x };
  if (magnitude(normal) < 1e-8) return;
  normalize(normal);
  let offset = -dot(normal, first);
  if (dot(normal, center) + offset > 0) {
    normal.x *= -1; normal.y *= -1; normal.z *= -1; offset *= -1;
  }
  if (!planes.some((candidate) => Math.abs(dot(candidate, normal) - 1) < 1e-5 && Math.abs(candidate.offset - offset) < 1e-4)) {
    planes.push({ ...normal, offset });
  }
}

function overlapsCube(cube: OctreeCube, minimum: Vec3, maximum: Vec3): boolean {
  return maximum.x >= cube.origin.x && minimum.x <= cube.origin.x + cube.size && maximum.y >= cube.origin.y &&
    minimum.y <= cube.origin.y + cube.size && maximum.z >= cube.origin.z && minimum.z <= cube.origin.z + cube.size;
}

function plane(x: number, y: number, z: number, offset: number): Plane {
  return { x, y, z, offset };
}
