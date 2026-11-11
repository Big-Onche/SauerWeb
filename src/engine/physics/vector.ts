import type { Vec3 } from "../octa";

export function vec3(x = 0, y = 0, z = 0): Vec3 {
  return { x, y, z };
}

export function copyVec3(value: Vec3): Vec3 {
  return { x: value.x, y: value.y, z: value.z };
}

export function addScaled(target: Vec3, value: Vec3, scale: number): void {
  target.x += value.x * scale;
  target.y += value.y * scale;
  target.z += value.z * scale;
}

export function scaleVec3(target: Vec3, scale: number): void {
  target.x *= scale;
  target.y *= scale;
  target.z *= scale;
}

export function magnitude(value: Vec3): number {
  return Math.hypot(value.x, value.y, value.z);
}

export function dot(first: Vec3, second: Vec3): number {
  return first.x * second.x + first.y * second.y + first.z * second.z;
}

export function subtract(first: Vec3, second: Vec3): Vec3 {
  return { x: first.x - second.x, y: first.y - second.y, z: first.z - second.z };
}

export function projectAgainst(target: Vec3, normal: Vec3): void {
  const amount = dot(target, normal);
  target.x -= normal.x * amount;
  target.y -= normal.y * amount;
  target.z -= normal.z * amount;
}

/** Matches vec::projectxy in src/shared/geom.h:148-160. */
export function projectXY(target: Vec3, normal: Vec3, threshold?: number): void {
  const squaredLength = dot(target, target);
  const rawDot = dot(target, normal);
  const removed = threshold === undefined ? rawDot : Math.min(rawDot, threshold);
  if (normal.z !== 0) target.z = -(target.x * normal.x / normal.z + target.y * normal.y / normal.z);
  const wantedLength = Math.sqrt(Math.max(squaredLength - removed * removed, 0));
  const currentLength = magnitude(target);
  if (currentLength > 1e-12) scaleVec3(target, wantedLength / currentLength);
}

export function rescale(target: Vec3, length: number): void {
  const currentLength = magnitude(target);
  if (currentLength > 1e-12) scaleVec3(target, length / currentLength);
}

export function normalize(value: Vec3): void {
  const length = magnitude(value);
  if (length > 0) scaleVec3(value, 1 / length);
}

export function lerpVec3(from: Vec3, to: Vec3, amount: number): Vec3 {
  return {
    x: from.x + (to.x - from.x) * amount,
    y: from.y + (to.y - from.y) * amount,
    z: from.z + (to.z - from.z) * amount,
  };
}
