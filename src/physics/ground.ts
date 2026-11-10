import type { Vec3 } from "../map/types";
import { FLOOR_Z, SLOPE_Z, STAIR_HEIGHT, WALL_Z } from "./constants";
import { OctreeCollisionWorld } from "./collision";
import { PhysicsEntityType, type PhysicsEntity, PhysicsState } from "./types";
import { copyVec3, dot, magnitude, projectAgainst, projectXY, rescale, vec3 } from "./vector";

interface FloorResult {
  floor: Vec3;
  found: boolean;
  slide: boolean;
}

/** Behavioral port of move/findfloor/landing/trystepup/trystepdown/slideagainst from Sauerbraten physics.cpp. */
export class GroundMover {
  constructor(private readonly world: OctreeCollisionWorld) {}

  move(entity: PhysicsEntity, direction: Vec3): boolean {
    const old = copyVec3(entity.position);
    let collided = false;
    let slideCollide = false;
    let obstacle = vec3();
    add(entity.position, direction);

    const collision = this.world.collide(entity, direction);
    if (collision) {
      obstacle = copyVec3(collision.normal);
      if (entity.entityType === PhysicsEntityType.Player &&
          ((collision.normal.z >= SLOPE_Z && direction.z < 0) || (collision.normal.z <= -SLOPE_Z && direction.z > 0)) &&
          (direction.x !== 0 || direction.y !== 0)) {
        const horizontalCollision = this.world.collide(entity, { x: direction.x, y: direction.y, z: 0 });
        if (horizontalCollision) {
          if (dot(horizontalCollision.normal, direction) >= 0) slideCollide = true;
          obstacle = copyVec3(horizontalCollision.normal);
        }
      }

      entity.position = { ...old, z: old.z - STAIR_HEIGHT };
      entity.zMargin = -STAIR_HEIGHT;
      const floorProbe = this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z);
      const canTryStep = entity.physicsState === PhysicsState.Slope || entity.physicsState === PhysicsState.Floor ||
        !!floorProbe && (entity.physicsState === PhysicsState.StepUp || entity.physicsState === PhysicsState.StepDown ||
          floorProbe.normal.z >= FLOOR_Z);
      entity.position = old;
      entity.zMargin = 0;
      if (canTryStep) {
        const floor = entity.physicsState === PhysicsState.Slope || entity.physicsState === PhysicsState.Floor
          ? entity.floor
          : floorProbe!.normal;
        if (this.tryStepUp(entity, direction, obstacle, STAIR_HEIGHT, floor)) return true;
      }
      collided = true;
    } else if (entity.physicsState === PhysicsState.StepUp) {
      const floorProbe = this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z);
      if (floorProbe) {
        entity.position = old;
        if (this.tryStepUp(entity, direction, { x: 0, y: 0, z: 1 }, STAIR_HEIGHT, floorProbe.normal)) return true;
        entity.position = copyVec3(old);
        add(entity.position, direction);
      }
    } else if (entity.physicsState === PhysicsState.StepDown && dot(direction, entity.floor) <= 1e-6) {
      const moved = copyVec3(entity.position);
      entity.position = old;
      if (this.tryStepDown(entity, direction)) return true;
      entity.position = moved;
    }

    const floorResult = this.findFloor(entity, collided, obstacle, collided);
    if (floorResult.slide || (!collided && floorResult.floor.z > 0 && floorResult.floor.z < WALL_Z)) {
      this.slideAgainst(entity, direction, floorResult.slide ? obstacle : floorResult.floor, floorResult.found, slideCollide);
      entity.blocked = true;
    }
    if (floorResult.found) this.land(entity, direction, floorResult.floor, collided);
    else this.fall(entity, direction, floorResult.floor);
    return !collided;
  }

  initialize(entity: PhysicsEntity): void {
    const floorResult = this.findFloor(entity, false, vec3(), false);
    if (floorResult.found) this.land(entity, vec3(), floorResult.floor, false);
  }

  private tryStepUp(entity: PhysicsEntity, direction: Vec3, obstacle: Vec3, maxStep: number, floor: Vec3): boolean {
    const old = copyVec3(entity.position);
    const stairDirection = obstacle.z >= 0 && obstacle.z < SLOPE_Z
      ? { x: -obstacle.x, y: -obstacle.y, z: 0 }
      : { x: direction.x, y: direction.y, z: 0 };
    rescale(stairDirection, 1);
    let canSmooth = true;

    if (entity.physicsState !== PhysicsState.StepUp) {
      const checkDirection = { x: stairDirection.x * 0.1, y: stairDirection.y * 0.1, z: maxStep + 0.1 };
      entity.position = copyVec3(old);
      add(entity.position, checkDirection);
      if (this.world.collide(entity, vec3())) {
        entity.position = old;
        if (!this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) return false;
        canSmooth = false;
      }
    }

    if (canSmooth) {
      const checkDirection = { x: stairDirection.x * maxStep, y: stairDirection.y * maxStep, z: maxStep };
      entity.position = copyVec3(old);
      add(entity.position, checkDirection);
      let scale = 2;
      if (this.world.collide(entity, checkDirection)) {
        if (!this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) {
          entity.position = old;
          return false;
        }
        add(entity.position, checkDirection);
        if (this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) scale = 1;
      }
      if (scale !== 1) {
        entity.position = {
          x: old.x - checkDirection.x * 2,
          y: old.y - checkDirection.y * 2,
          z: old.z - checkDirection.z,
        };
        if (!this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) scale = 1;
      }

      entity.position = old;
      const smoothDirection = { x: direction.x, y: direction.y, z: 0 };
      const horizontalMagnitude = magnitude(smoothDirection);
      if (horizontalMagnitude > 1e-9) {
        if (horizontalMagnitude > scale * direction.z) {
          rescale(smoothDirection, 1);
          smoothDirection.z = 1 / scale;
          rescale(smoothDirection, magnitude(direction));
        } else smoothDirection.z = direction.z;
        entity.position = copyVec3(old);
        add(entity.position, smoothDirection);
        entity.position.z += maxStep + 0.1;
        if (!this.world.collide(entity, smoothDirection)) {
          entity.position.z -= maxStep + 0.1;
          this.prepareStepUp(entity, direction, floor);
          entity.physicsState = PhysicsState.StepUp;
          return true;
        }
      }
    }

    entity.position = { ...old, z: old.z + magnitude(direction) };
    if (!this.world.collide(entity, { x: 0, y: 0, z: 1 })) {
      this.prepareStepUp(entity, direction, floor);
      if (canSmooth) entity.physicsState = PhysicsState.StepUp;
      return true;
    }
    entity.position = old;
    return false;
  }

  private prepareStepUp(entity: PhysicsEntity, direction: Vec3, floor: Vec3): void {
    if (entity.physicsState === PhysicsState.Fall || !sameVector(entity.floor, floor)) {
      entity.timeInAir = 0;
      entity.floor = copyVec3(floor);
      this.switchFloor(entity, direction, entity.floor);
    }
  }

  private tryStepDown(entity: PhysicsEntity, direction: Vec3, initialize = false): boolean {
    if (entity.move === 0 && entity.strafe === 0) return false;
    const old = copyVec3(entity.position);
    entity.position.z -= STAIR_HEIGHT;
    entity.zMargin = -STAIR_HEIGHT;
    const floorProbe = this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z);
    entity.position = old;
    entity.zMargin = 0;
    if (!floorProbe) return false;
    return this.tryStepDownSlope(entity, direction, magnitude(direction), 4, 1, initialize);
  }

  private tryStepDownSlope(entity: PhysicsEntity, direction: Vec3, step: number, xy: number, z: number, initialize: boolean): boolean {
    const stepDirection = { x: direction.x, y: direction.y, z: -Math.hypot(direction.x, direction.y) * z / xy };
    if (stepDirection.z === 0) return false;
    rescale(stepDirection, 1);
    const old = copyVec3(entity.position);
    const probeScale = STAIR_HEIGHT / Math.abs(stepDirection.z);
    entity.position = {
      x: old.x + stepDirection.x * probeScale,
      y: old.y + stepDirection.y * probeScale,
      z: old.z + stepDirection.z * probeScale - STAIR_HEIGHT,
    };
    entity.zMargin = -STAIR_HEIGHT;
    if (this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) {
      entity.position = {
        x: old.x + stepDirection.x * step,
        y: old.y + stepDirection.y * step,
        z: old.z + stepDirection.z * step,
      };
      entity.zMargin = 0;
      if (!this.world.collide(entity, { x: 0, y: 0, z: -1 })) {
        const stepFloor = copyVec3(stepDirection);
        const vertical = stepFloor.z;
        stepFloor.x *= -vertical;
        stepFloor.y *= -vertical;
        stepFloor.z = 1 - vertical * vertical;
        rescale(stepFloor, 1);
        if (entity.physicsState >= PhysicsState.Slope && !sameVector(entity.floor, stepFloor)) {
          const stepped = copyVec3(entity.position);
          entity.position.z -= 0.5;
          entity.zMargin = -0.5;
          const repeatedFloor = this.world.collide(entity, stepDirection);
          if (repeatedFloor && sameVector(repeatedFloor.normal, entity.floor)) {
            entity.position = copyVec3(old);
            if (!initialize) {
              entity.position.x += direction.x;
              entity.position.y += direction.y;
              if (direction.z <= 0 || this.world.collide(entity, direction)) entity.position.z += direction.z;
            }
            entity.zMargin = 0;
            entity.physicsState = PhysicsState.StepDown;
            entity.timeInAir = 0;
            return true;
          }
          entity.position = initialize ? old : stepped;
          entity.zMargin = 0;
        } else if (initialize) entity.position = old;
        this.switchFloor(entity, direction, stepFloor);
        entity.floor = stepFloor;
        entity.physicsState = PhysicsState.StepDown;
        entity.timeInAir = 0;
        return true;
      }
    }
    entity.position = old;
    entity.zMargin = 0;
    return false;
  }

  private findFloor(entity: PhysicsEntity, collided: boolean, obstacle: Vec3, slide: boolean): FloorResult {
    let found = false;
    let floor = vec3();
    const moved = copyVec3(entity.position);
    entity.position.z -= 0.1;
    const directFloor = this.world.collide(entity, { x: 0, y: 0, z: -1 },
      entity.physicsState === PhysicsState.Slope || entity.physicsState === PhysicsState.StepDown ? SLOPE_Z : FLOOR_Z);
    if (directFloor) {
      floor = copyVec3(directFloor.normal);
      found = true;
    } else if (collided && obstacle.z >= SLOPE_Z) {
      floor = copyVec3(obstacle);
      found = true;
      slide = false;
    } else if (entity.physicsState === PhysicsState.StepUp || entity.physicsState === PhysicsState.Slide) {
      const looseFloor = this.world.collide(entity, { x: 0, y: 0, z: -1 });
      if (looseFloor && looseFloor.normal.z > 0) {
        floor = copyVec3(looseFloor.normal);
        if (floor.z >= SLOPE_Z) found = true;
      }
    } else if (entity.physicsState >= PhysicsState.Slope && entity.floor.z < 1) {
      const oldFloor = this.world.collide(entity, { x: -entity.floor.x, y: -entity.floor.y, z: -entity.floor.z }, 0.95) ??
        this.world.collide(entity, { x: 0, y: 0, z: -1 });
      if (oldFloor) {
        floor = copyVec3(oldFloor.normal);
        if (floor.z >= SLOPE_Z && floor.z < 1) found = true;
      }
    }
    if (collided && (!found || obstacle.z > floor.z)) {
      floor = copyVec3(obstacle);
      slide = !found && (floor.z < WALL_Z || floor.z >= SLOPE_Z);
    }
    entity.position = moved;
    return { floor, found, slide };
  }

  private fall(entity: PhysicsEntity, direction: Vec3, floor: Vec3): void {
    if (floor.z > 0 && floor.z < SLOPE_Z) {
      if (floor.z >= WALL_Z) this.switchFloor(entity, direction, floor);
      entity.timeInAir = 0;
      entity.physicsState = PhysicsState.Slide;
      entity.floor = copyVec3(floor);
    } else if (entity.physicsState < PhysicsState.Slope || dot(direction, entity.floor) > 0.01 * magnitude(direction) ||
        (floor.z !== 0 && floor.z !== 1) || !this.tryStepDown(entity, direction, true)) {
      entity.physicsState = PhysicsState.Fall;
    }
  }

  private land(entity: PhysicsEntity, direction: Vec3, floor: Vec3, collided: boolean): void {
    this.switchFloor(entity, direction, floor);
    entity.timeInAir = 0;
    if ((entity.physicsState !== PhysicsState.StepUp && entity.physicsState !== PhysicsState.StepDown) || !collided) {
      entity.physicsState = floor.z >= FLOOR_Z ? PhysicsState.Floor : PhysicsState.Slope;
    }
    entity.floor = copyVec3(floor);
  }

  private switchFloor(entity: PhysicsEntity, direction: Vec3, floor: Vec3): void {
    if (floor.z >= FLOOR_Z) entity.falling = vec3();
    const oldVelocity = combinedVelocity(entity);
    if (dot(direction, floor) >= 0) {
      if (entity.physicsState < PhysicsState.Slide || Math.abs(dot(direction, entity.floor)) > 0.01 * magnitude(direction)) return;
      projectXY(entity.velocity, floor, 0);
    } else projectXY(entity.velocity, floor);
    projectAgainst(entity.falling, floor);
    this.recalculateDirection(entity, oldVelocity, direction);
  }

  private slideAgainst(entity: PhysicsEntity, direction: Vec3, obstacle: Vec3, foundFloor: boolean, slideCollide: boolean): void {
    const wall = copyVec3(obstacle);
    if (foundFloor ? wall.z > 0 : slideCollide) {
      wall.z = 0;
      rescale(wall, 1);
    }
    const oldVelocity = combinedVelocity(entity);
    projectAgainst(entity.velocity, wall);
    projectAgainst(entity.falling, wall);
    this.recalculateDirection(entity, oldVelocity, direction);
  }

  private recalculateDirection(entity: PhysicsEntity, oldVelocity: Vec3, direction: Vec3): void {
    const speed = magnitude(oldVelocity);
    if (speed <= 1e-6) return;
    const step = magnitude(direction);
    const velocity = combinedVelocity(entity);
    direction.x = velocity.x * step / speed;
    direction.y = velocity.y * step / speed;
    direction.z = velocity.z * step / speed;
  }
}

function add(target: Vec3, value: Vec3): void {
  target.x += value.x;
  target.y += value.y;
  target.z += value.z;
}

function combinedVelocity(entity: PhysicsEntity): Vec3 {
  return {
    x: entity.velocity.x + entity.falling.x,
    y: entity.velocity.y + entity.falling.y,
    z: entity.velocity.z + entity.falling.z,
  };
}

function sameVector(first: Vec3, second: Vec3): boolean {
  return first.x === second.x && first.y === second.y && first.z === second.z;
}
