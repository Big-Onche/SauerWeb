import type { Vec3 } from "../map/types";

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

