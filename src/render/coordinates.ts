import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import type { Vec3 } from "../engine/octa";

/** Sauerbraten is Z-up; Babylon is Y-up. This is the only axis conversion used by the renderer. */
export function toBabylonPosition(position: Vec3): Vector3 {
  return new Vector3(position.x, position.z, position.y);
}

export function toBabylonArray(position: Vec3): [number, number, number] {
  return [position.x, position.z, position.y];
}

export function toBabylonDirection(direction: Vec3): Vector3 {
  return new Vector3(direction.x, direction.z, direction.y);
}

/** Mirrors Sauerbraten's vecfromyawpitch(yaw, 0, 1, 0). */
export function toBabylonYawDirection(yawDegrees: number): Vector3 {
  const yaw = yawDegrees * Math.PI / 180;
  return new Vector3(-Math.sin(yaw), 0, Math.cos(yaw));
}
