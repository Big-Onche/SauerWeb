import type { Vec3 } from "../engine/octa";

export const NETWORK_SMOOTH_MILLISECONDS = 75;
export const NETWORK_SMOOTH_DISTANCE = 32;

export interface NetworkInterpolation {
  initialized: boolean;
  targetPosition: Vec3;
  positionDelta: Vec3;
  targetYaw: number;
  targetPitch: number;
  targetRoll: number;
  yawDelta: number;
  pitchDelta: number;
  rollDelta: number;
  startedAt: number;
  predictedAt: number;
}

export interface InterpolatedNetworkEntity {
  position: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  velocity?: Vec3;
  falling?: Vec3;
  interpolation: NetworkInterpolation;
}

export function createNetworkInterpolation(position: Vec3): NetworkInterpolation {
  return {
    initialized: false,
    targetPosition: { ...position },
    positionDelta: { x: 0, y: 0, z: 0 },
    targetYaw: 0,
    targetPitch: 0,
    targetRoll: 0,
    yawDelta: 0,
    pitchDelta: 0,
    rollDelta: 0,
    startedAt: 0,
    predictedAt: 0,
  };
}

// Mirrors client.cpp's N_POS smoothing setup. The entity retains its current rendered transform while the new packet becomes its target.
export function applyNetworkPosition(entity: InterpolatedNetworkEntity, position: Vec3, yaw: number, pitch: number, roll: number,
                                     nowMilliseconds: number, allowSmoothing = true): void {
  const interpolation = entity.interpolation;
  const distance = Math.hypot(entity.position.x - position.x, entity.position.y - position.y, entity.position.z - position.z);
  if (allowSmoothing && interpolation.initialized && distance < NETWORK_SMOOTH_DISTANCE) {
    interpolation.targetPosition = { ...position };
    interpolation.positionDelta = {
      x: entity.position.x - position.x,
      y: entity.position.y - position.y,
      z: entity.position.z - position.z,
    };
    interpolation.targetYaw = yaw;
    interpolation.targetPitch = pitch;
    interpolation.targetRoll = roll;
    interpolation.yawDelta = shortestAngleDelta(entity.yaw - yaw);
    interpolation.pitchDelta = entity.pitch - pitch;
    interpolation.rollDelta = entity.roll - roll;
    interpolation.startedAt = nowMilliseconds;
    interpolation.predictedAt = nowMilliseconds;
  } else {
    entity.position = { ...position };
    entity.yaw = yaw;
    entity.pitch = pitch;
    entity.roll = roll;
    interpolation.targetPosition = { ...position };
    interpolation.positionDelta = { x: 0, y: 0, z: 0 };
    interpolation.targetYaw = yaw;
    interpolation.targetPitch = pitch;
    interpolation.targetRoll = roll;
    interpolation.yawDelta = interpolation.pitchDelta = interpolation.rollDelta = 0;
    interpolation.startedAt = 0;
    interpolation.predictedAt = nowMilliseconds;
  }
  interpolation.initialized = true;
}

// Mirrors fps.cpp's predictplayer interpolation portion. Remote collision prediction remains server-owned in SauerWeb.
export function interpolateNetworkEntity(entity: InterpolatedNetworkEntity, nowMilliseconds: number): void {
  const interpolation = entity.interpolation;
  if (!interpolation.initialized) return;
  const predictedMilliseconds = Math.max(0, nowMilliseconds - interpolation.predictedAt);
  if (predictedMilliseconds > 0) {
    const seconds = predictedMilliseconds / 1000;
    interpolation.targetPosition.x += ((entity.velocity?.x ?? 0) + (entity.falling?.x ?? 0)) * seconds;
    interpolation.targetPosition.y += ((entity.velocity?.y ?? 0) + (entity.falling?.y ?? 0)) * seconds;
    interpolation.targetPosition.z += ((entity.velocity?.z ?? 0) + (entity.falling?.z ?? 0)) * seconds;
    interpolation.predictedAt = nowMilliseconds;
  }
  const amount = Math.max(0, 1 - (nowMilliseconds - interpolation.startedAt) / NETWORK_SMOOTH_MILLISECONDS);
  entity.position = {
    x: interpolation.targetPosition.x + interpolation.positionDelta.x * amount,
    y: interpolation.targetPosition.y + interpolation.positionDelta.y * amount,
    z: interpolation.targetPosition.z + interpolation.positionDelta.z * amount,
  };
  entity.yaw = wrapYaw(interpolation.targetYaw + interpolation.yawDelta * amount);
  entity.pitch = interpolation.targetPitch + interpolation.pitchDelta * amount;
  entity.roll = interpolation.targetRoll + interpolation.rollDelta * amount;
}

export function resetNetworkInterpolation(entity: InterpolatedNetworkEntity): void {
  entity.interpolation.initialized = false;
  entity.interpolation.startedAt = 0;
  entity.interpolation.predictedAt = 0;
}

function shortestAngleDelta(delta: number): number {
  if (delta > 180) return delta - 360;
  if (delta < -180) return delta + 360;
  return delta;
}

function wrapYaw(yaw: number): number {
  return (yaw % 360 + 360) % 360;
}
