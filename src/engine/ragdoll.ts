import type { Vec3 } from "./octa";
import { GRAVITY } from "./physics/constants";

export const RAGDOLL_TIMESTEP_MIN = 5;
export const RAGDOLL_TIMESTEP_MAX = 10;
export const RAGDOLL_ROTATIONAL_FRICTION = 0.85;
export const RAGDOLL_ROTATIONAL_FRICTION_STOP = 0.1;
export const RAGDOLL_CONSTRAINT_ITERATIONS = 5;
export const RAGDOLL_BODY_FRICTION = 0.95;
export const RAGDOLL_BODY_FRICTION_SCALE = 2;
export const RAGDOLL_WATER_FRICTION = 0.85;
export const RAGDOLL_GROUND_FRICTION = 0.8;
export const RAGDOLL_AIR_FRICTION = 0.996;
export const RAGDOLL_UNSTICK_SPEED = 10;
export const RAGDOLL_EXPIRE_OFFSET = 1500;
export const RAGDOLL_WATER_EXPIRE_OFFSET = 3000;
export const RAGDOLL_EYE_SMOOTHING = 0.5;
export const RAGDOLL_EYE_SMOOTHING_MILLIS = 250;
export const RAGDOLL_MILLIS = 10000;
export const RAGDOLL_FADE = 1000;

export interface RagdollVertexDefinition extends Vec3 { radius: number }
export interface RagdollTriangle { vertices: [number, number, number] }
export interface RagdollJoint { bone: number; triangle: number; vertices: [number, number, number] }
export interface RagdollDistanceLimit { vertices: [number, number]; minimum: number; maximum: number }
export interface RagdollRotationLimit { triangles: [number, number]; maximumAngle: number; middle: [number, number, number, number] }

export interface RagdollSkeleton {
  vertices: RagdollVertexDefinition[];
  triangles: RagdollTriangle[];
  joints: RagdollJoint[];
  distanceLimits: RagdollDistanceLimit[];
  rotationLimits: RagdollRotationLimit[];
  eye: number;
  animateJoints: boolean;
}

export interface RagdollCollision {
  normal: Vec3;
  position: Vec3;
}

export type RagdollCollider = (from: Vec3, to: Vec3, radius: number) => RagdollCollision | undefined;

interface SimulatedVertex {
  position: Vec3;
  previous: Vec3;
  collided: boolean;
}

// Original: src/engine/rendermodel.cpp (rd*) and src/engine/ragdoll.h.
export function parseRagdoll(source: string): RagdollSkeleton {
  const skeleton: RagdollSkeleton = {
    vertices: [], triangles: [], joints: [], distanceLimits: [], rotationLimits: [], eye: -1, animateJoints: false,
  };
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.replace(/\/\/.*$/, "").trim();
    if (!line) continue;
    const [command, ...arguments_] = line.split(/\s+/);
    const values = arguments_.map(Number);
    if (values.some((value) => !Number.isFinite(value))) continue;
    switch (command.toLowerCase()) {
      case "rdvert":
        if (values.length >= 3) skeleton.vertices.push({ x: values[0], y: values[1], z: values[2], radius: values[3] > 0 ? values[3] : 1 });
        break;
      case "rdeye":
        if (values.length) skeleton.eye = values[0];
        break;
      case "rdtri":
        if (values.length >= 3) skeleton.triangles.push({ vertices: [values[0], values[1], values[2]] });
        break;
      case "rdjoint":
        if (values.length >= 2) skeleton.joints.push({ bone: values[0], triangle: values[1],
          vertices: [values[2] ?? -1, values[3] ?? -1, values[4] ?? -1] });
        break;
      case "rdlimitdist":
        if (values.length >= 3) skeleton.distanceLimits.push({ vertices: [values[0], values[1]], minimum: values[2],
          maximum: Math.max(values[3] ?? values[2], values[2]) });
        break;
      case "rdlimitrot":
        if (values.length >= 7) skeleton.rotationLimits.push({ triangles: [values[0], values[1]], maximumAngle: values[2] * Math.PI / 180,
          middle: [values[3], values[4], values[5], values[6]] });
        break;
      case "rdanimjoints":
        skeleton.animateJoints = values[0] !== 0;
        break;
    }
  }
  return skeleton;
}

export class RagdollSimulation {
  readonly vertices: SimulatedVertex[];
  lastMove: number;
  collisionExpiry = 0;
  collisions = 0;
  private floating = 0;
  private timestep = RAGDOLL_TIMESTEP_MIN / 1000;

  constructor(readonly skeleton: RagdollSkeleton, positions: readonly Vec3[], velocity: Vec3, nowMilliseconds: number,
              private readonly collider?: RagdollCollider, private readonly scale = 1) {
    const initialVelocity = scaleVector(velocity, this.timestep);
    this.vertices = positions.map((position) => ({ position: copy(position), previous: subtract(position, initialVelocity), collided: false }));
    this.lastMove = nowMilliseconds;
  }

  move(nowMilliseconds: number, inWater = false): void {
    const firstMove = this.lastMove;
    while (this.lastMove + (this.lastMove === firstMove ? RAGDOLL_TIMESTEP_MIN : RAGDOLL_TIMESTEP_MAX) <= nowMilliseconds) {
      const milliseconds = Math.min(RAGDOLL_TIMESTEP_MAX, nowMilliseconds - this.lastMove);
      this.step(milliseconds / 1000, inWater, this.lastMove + milliseconds);
      this.lastMove += milliseconds;
    }
  }

  private step(seconds: number, inWater: boolean, nowMilliseconds: number): void {
    if (this.collisionExpiry && nowMilliseconds > this.collisionExpiry) return;
    const airFriction = RAGDOLL_AIR_FRICTION + Math.min(RAGDOLL_BODY_FRICTION_SCALE * this.collisions / Math.max(this.vertices.length, 1), 1) *
      (RAGDOLL_BODY_FRICTION - RAGDOLL_AIR_FRICTION);
    this.collisions = 0;
    this.vertices.forEach((vertex, index) => {
      const displacement = subtract(vertex.position, vertex.previous);
      displacement.y -= GRAVITY * seconds * seconds;
      const friction = (inWater ? RAGDOLL_WATER_FRICTION : 1) * (vertex.collided ? RAGDOLL_GROUND_FRICTION : airFriction);
      const multiplier = Math.pow(friction, seconds * 1000 / RAGDOLL_TIMESTEP_MIN) * (this.timestep ? seconds / this.timestep : 1);
      const previous = copy(vertex.position);
      const target = add(vertex.position, scaleVector(displacement, multiplier));
      const collision = this.collider?.(previous, target, this.skeleton.vertices[index]?.radius * this.scale || this.scale);
      vertex.previous = previous;
      vertex.position = collision ? copy(collision.position) : target;
      vertex.collided = Boolean(collision);
      if (collision) {
        const reflected = reflect(displacement, collision.normal);
        vertex.previous = subtract(vertex.position, reflected);
        this.collisions++;
      }
    });
    this.timestep = seconds;
    if (this.collisions) {
      this.floating = 0;
      this.collisionExpiry ||= nowMilliseconds + (inWater ? RAGDOLL_WATER_EXPIRE_OFFSET : RAGDOLL_EXPIRE_OFFSET);
    } else if (++this.floating > 1 && nowMilliseconds < this.collisionExpiry) this.collisionExpiry = 0;
    for (let iteration = 0; iteration < RAGDOLL_CONSTRAINT_ITERATIONS; iteration++) this.constrainDistances();
  }

  private constrainDistances(): void {
    for (const limit of this.skeleton.distanceLimits) {
      const first = this.vertices[limit.vertices[0]];
      const second = this.vertices[limit.vertices[1]];
      if (!first || !second) continue;
      const delta = subtract(second.position, first.position);
      const distance = magnitude(delta);
      const modelDistance = distance / this.scale;
      const constrained = modelDistance < limit.minimum ? limit.minimum : modelDistance > limit.maximum ? limit.maximum : modelDistance;
      if (constrained === modelDistance) continue;
      const correction = distance > 1e-6 ? scaleVector(delta, (constrained * this.scale - distance) / (distance * 2))
        : { x: 0, y: this.scale * constrained / 2, z: 0 };
      first.position = subtract(first.position, correction);
      second.position = add(second.position, correction);
    }
  }
}

function copy(value: Vec3): Vec3 { return { x: value.x, y: value.y, z: value.z }; }
function add(first: Vec3, second: Vec3): Vec3 { return { x: first.x + second.x, y: first.y + second.y, z: first.z + second.z }; }
function subtract(first: Vec3, second: Vec3): Vec3 { return { x: first.x - second.x, y: first.y - second.y, z: first.z - second.z }; }
function scaleVector(value: Vec3, amount: number): Vec3 { return { x: value.x * amount, y: value.y * amount, z: value.z * amount }; }
function magnitude(value: Vec3): number { return Math.hypot(value.x, value.y, value.z); }
function reflect(value: Vec3, normal: Vec3): Vec3 {
  const amount = 2 * (value.x * normal.x + value.y * normal.y + value.z * normal.z);
  return { x: value.x - normal.x * amount, y: value.y - normal.y * amount, z: value.z - normal.z * amount };
}
