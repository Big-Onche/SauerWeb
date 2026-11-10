import type { Vec3 } from "../map/types";
import { PLAYER_ABOVE_EYE, PLAYER_EYE_HEIGHT, PLAYER_MAX_SPEED, PLAYER_RADIUS } from "./constants";
import { copyVec3, vec3 } from "./vector";

/** Values and ordering match PHYS_* in .Sauerbraten/src/shared/ents.h:62. */
export enum PhysicsState {
  Float,
  Fall,
  Slide,
  Slope,
  Floor,
  StepUp,
  StepDown,
  Bounce,
}

/** Values and ordering match CS_* in .Sauerbraten/src/shared/ents.h:60. */
export enum ClientState {
  Alive,
  Dead,
  Spawning,
  Lagged,
  Editing,
  Spectator,
}

/** Values and ordering match COLLIDE_* in .Sauerbraten/src/shared/ents.h:66. */
export enum CollisionType {
  None,
  Ellipse,
  Obb,
  EllipsePrecise,
}

/** Values and ordering match ENT_* in .Sauerbraten/src/shared/ents.h:64. */
export enum PhysicsEntityType {
  Player,
  Ai,
  Inanimate,
  Camera,
  Bounce,
}

export interface PhysicsEntity {
  /** Authoritative Sauerbraten eye-origin position. */
  position: Vec3;
  previousPosition: Vec3;
  velocity: Vec3;
  falling: Vec3;
  floor: Vec3;
  yaw: number;
  pitch: number;
  roll: number;
  maxSpeed: number;
  radius: number;
  eyeHeight: number;
  aboveEye: number;
  xRadius: number;
  yRadius: number;
  zMargin: number;
  timeInAir: number;
  inWater: number;
  jumping: boolean;
  move: -1 | 0 | 1;
  strafe: -1 | 0 | 1;
  physicsState: PhysicsState;
  clientState: ClientState;
  collisionType: CollisionType;
  entityType: PhysicsEntityType;
  blocked: boolean;
}

export function createPlayer(position: Vec3 = vec3()): PhysicsEntity {
  return {
    position: copyVec3(position),
    previousPosition: copyVec3(position),
    velocity: vec3(),
    falling: vec3(),
    floor: vec3(0, 0, 1),
    yaw: 0,
    pitch: 0,
    roll: 0,
    maxSpeed: PLAYER_MAX_SPEED,
    radius: PLAYER_RADIUS,
    eyeHeight: PLAYER_EYE_HEIGHT,
    aboveEye: PLAYER_ABOVE_EYE,
    xRadius: PLAYER_RADIUS,
    yRadius: PLAYER_RADIUS,
    zMargin: 0,
    timeInAir: 0,
    inWater: 0,
    jumping: false,
    move: 0,
    strafe: 0,
    physicsState: PhysicsState.Fall,
    clientState: ClientState.Alive,
    collisionType: CollisionType.Ellipse,
    entityType: PhysicsEntityType.Player,
    blocked: false,
  };
}

export function resetPlayer(entity: PhysicsEntity, position: Vec3, yaw = 0): void {
  entity.position = copyVec3(position);
  entity.previousPosition = copyVec3(position);
  entity.velocity = vec3();
  entity.falling = vec3();
  entity.floor = vec3(0, 0, 1);
  entity.yaw = yaw;
  entity.pitch = 0;
  entity.roll = 0;
  entity.timeInAir = 0;
  entity.inWater = 0;
  entity.jumping = false;
  entity.move = 0;
  entity.strafe = 0;
  entity.physicsState = PhysicsState.Fall;
  entity.clientState = ClientState.Alive;
  entity.blocked = false;
}
