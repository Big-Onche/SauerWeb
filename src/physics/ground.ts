import type { Vec3 } from "../map/types";
import { FLOOR_Z, SLOPE_Z, STAIR_HEIGHT, WALL_Z } from "./constants";
import { OctreeCollisionWorld, type CollisionResult } from "./collision";
import { type PhysicsEntity, PhysicsState } from "./types";
import { copyVec3, dot, magnitude, projectAgainst, projectXY, rescale, vec3 } from "./vector";

/** Ports the state machine around move/findfloor/landing/trystepup/trystepdown/slideagainst. */
export class GroundMover {
  constructor(private readonly world: OctreeCollisionWorld) {}

  move(entity: PhysicsEntity, displacement: Vec3): boolean {
    const origin = copyVec3(entity.position);
    entity.position.x += displacement.x;
    entity.position.y += displacement.y;
    entity.position.z += displacement.z;
    const collision = this.world.collide(entity, displacement);
    if (collision) {
      entity.position = origin;
      if (this.canStep(entity) && this.tryStepUp(entity, displacement, collision.normal)) return true;
      this.slide(entity, displacement, collision);
      entity.blocked = true;
      return false;
    }
    if (entity.physicsState === PhysicsState.StepDown && dot(displacement, entity.floor) <= 1e-6 && this.tryStepDown(entity, displacement)) return true;
    const floor = this.findFloor(entity, 0.1);
    if (floor) this.land(entity, floor.normal, displacement);
    else if (this.canStep(entity) && this.tryStepDown(entity, displacement)) return true;
    else this.fallOrSlide(entity, vec3());
    return true;
  }

  initialize(entity: PhysicsEntity): void {
    const floor = this.findFloor(entity, STAIR_HEIGHT);
    if (floor) this.land(entity, floor.normal);
  }

  private canStep(entity: PhysicsEntity): boolean {
    return entity.physicsState >= PhysicsState.Slope && entity.physicsState <= PhysicsState.StepDown;
  }

  private tryStepUp(entity: PhysicsEntity, displacement: Vec3, obstacle: Vec3): boolean {
    const origin = copyVec3(entity.position);
    const stairDirection = obstacle.z >= 0 && obstacle.z < SLOPE_Z
      ? { x: -obstacle.x, y: -obstacle.y, z: 0 }
      : { x: displacement.x, y: displacement.y, z: 0 };
    rescale(stairDirection, 1);
    let canSmooth = true;
    if (entity.physicsState !== PhysicsState.StepUp) {
      entity.position = {
        x: origin.x + stairDirection.x * 0.1,
        y: origin.y + stairDirection.y * 0.1,
        z: origin.z + STAIR_HEIGHT + 0.1,
      };
      if (this.world.collide(entity, vec3())) {
        entity.position = origin;
        if (!this.findFloor(entity, 0.1)) return false;
        canSmooth = false;
      }
    }
    if (canSmooth) {
      const checkDirection = { x: stairDirection.x * STAIR_HEIGHT, y: stairDirection.y * STAIR_HEIGHT, z: STAIR_HEIGHT };
      entity.position = {
        x: origin.x + checkDirection.x,
        y: origin.y + checkDirection.y,
        z: origin.z + checkDirection.z,
      };
      let scale = 2;
      if (this.world.collide(entity, checkDirection)) {
        if (!this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) {
          entity.position = origin;
          return false;
        }
        entity.position.x += checkDirection.x;
        entity.position.y += checkDirection.y;
        entity.position.z += checkDirection.z;
        if (this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) scale = 1;
      }
      if (scale !== 1) {
        entity.position = {
          x: origin.x - checkDirection.x * 2,
          y: origin.y - checkDirection.y * 2,
          z: origin.z - checkDirection.z,
        };
        if (!this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) scale = 1;
      }
      entity.position = origin;
      const smoothDirection = { x: displacement.x, y: displacement.y, z: 0 };
      const horizontalLength = magnitude(smoothDirection);
      if (horizontalLength > 1e-9) {
        if (horizontalLength > scale * displacement.z) {
          rescale(smoothDirection, 1);
          smoothDirection.z = 1 / scale;
          rescale(smoothDirection, magnitude(displacement));
        } else smoothDirection.z = displacement.z;
        entity.position = {
          x: origin.x + smoothDirection.x,
          y: origin.y + smoothDirection.y,
          z: origin.z + smoothDirection.z + STAIR_HEIGHT + 0.1,
        };
        if (!this.world.collide(entity, smoothDirection)) {
          entity.position.z -= STAIR_HEIGHT + 0.1;
          this.switchFloor(entity, displacement, entity.floor);
          entity.physicsState = PhysicsState.StepUp;
          entity.timeInAir = 0;
          return true;
        }
      }
    }
    entity.position = { ...origin, z: origin.z + magnitude(displacement) };
    if (!this.world.collide(entity, { x: 0, y: 0, z: 1 })) {
      this.switchFloor(entity, displacement, entity.floor);
      if (canSmooth) entity.physicsState = PhysicsState.StepUp;
      entity.timeInAir = 0;
      return true;
    }
    entity.position = origin;
    return false;
  }

  private tryStepDown(entity: PhysicsEntity, displacement: Vec3): boolean {
    if (entity.move === 0 && entity.strafe === 0) return false;
    const origin = copyVec3(entity.position);
    const stepDirection = { x: displacement.x, y: displacement.y, z: 0 };
    stepDirection.z = -Math.hypot(stepDirection.x, stepDirection.y) / 4;
    if (stepDirection.z === 0) return false;
    rescale(stepDirection, 1);
    const probeScale = STAIR_HEIGHT / Math.abs(stepDirection.z);
    entity.position = {
      x: origin.x + stepDirection.x * probeScale,
      y: origin.y + stepDirection.y * probeScale,
      z: origin.z + stepDirection.z * probeScale - STAIR_HEIGHT,
    };
    if (this.world.collide(entity, { x: 0, y: 0, z: -1 }, SLOPE_Z)) {
      const stepLength = magnitude(displacement);
      entity.position = {
        x: origin.x + stepDirection.x * stepLength,
        y: origin.y + stepDirection.y * stepLength,
        z: origin.z + stepDirection.z * stepLength,
      };
      if (!this.world.collide(entity, { x: 0, y: 0, z: -1 })) {
        const stepFloor = { x: stepDirection.x * -stepDirection.z, y: stepDirection.y * -stepDirection.z,
          z: 1 - stepDirection.z * stepDirection.z };
        rescale(stepFloor, 1);
        this.switchFloor(entity, displacement, stepFloor);
        entity.floor = stepFloor;
        entity.physicsState = PhysicsState.StepDown;
        entity.timeInAir = 0;
        return true;
      }
    }
    entity.position = origin;
    return false;
  }

  private findFloor(entity: PhysicsEntity, distance: number): CollisionResult | undefined {
    const origin = copyVec3(entity.position);
    entity.position.z -= distance;
    const result = this.world.collide(entity, { x: 0, y: 0, z: -distance },
      entity.physicsState === PhysicsState.Slope || entity.physicsState === PhysicsState.StepDown ? SLOPE_Z : FLOOR_Z);
    entity.position = origin;
    return result && result.normal.z > 0 ? result : undefined;
  }

  private land(entity: PhysicsEntity, floor: Vec3, displacement?: Vec3): void {
    if (displacement) this.switchFloor(entity, displacement, floor);
    else if (floor.z >= FLOOR_Z) entity.falling = vec3();
    entity.timeInAir = 0;
    entity.floor = copyVec3(floor);
    if (entity.physicsState !== PhysicsState.StepUp && entity.physicsState !== PhysicsState.StepDown) {
      entity.physicsState = floor.z >= FLOOR_Z ? PhysicsState.Floor : PhysicsState.Slope;
    }
  }

  private switchFloor(entity: PhysicsEntity, displacement: Vec3, floor: Vec3): void {
    if (floor.z >= FLOOR_Z) entity.falling = vec3();
    const oldVelocity = { x: entity.velocity.x + entity.falling.x, y: entity.velocity.y + entity.falling.y,
      z: entity.velocity.z + entity.falling.z };
    if (dot(displacement, floor) >= 0) {
      if (entity.physicsState < PhysicsState.Slide || Math.abs(dot(displacement, entity.floor)) > 0.01 * magnitude(displacement)) return;
      projectXY(entity.velocity, floor, 0);
    } else projectXY(entity.velocity, floor);
    projectAgainst(entity.falling, floor);
    this.recalculateDirection(entity, oldVelocity, displacement);
  }

  private recalculateDirection(entity: PhysicsEntity, oldVelocity: Vec3, displacement: Vec3): void {
    const speed = magnitude(oldVelocity);
    if (speed <= 1e-6) return;
    const step = magnitude(displacement);
    displacement.x = entity.velocity.x + entity.falling.x;
    displacement.y = entity.velocity.y + entity.falling.y;
    displacement.z = entity.velocity.z + entity.falling.z;
    rescale(displacement, step * magnitude(displacement) / speed);
  }

  private fallOrSlide(entity: PhysicsEntity, floor: Vec3): void {
    if (floor.z > 0 && floor.z < SLOPE_Z) {
      if (floor.z >= WALL_Z) {
        projectAgainst(entity.velocity, floor);
        projectAgainst(entity.falling, floor);
      }
      entity.timeInAir = 0;
      entity.physicsState = PhysicsState.Slide;
      entity.floor = copyVec3(floor);
    } else entity.physicsState = PhysicsState.Fall;
  }

  private slide(entity: PhysicsEntity, displacement: Vec3, collision: CollisionResult): void {
    if (collision.normal.z >= SLOPE_Z) {
      this.land(entity, collision.normal, displacement);
      return;
    }
    const normal = { ...collision.normal };
    if (normal.z > 0) {
      normal.z = 0;
      const length = magnitude(normal);
      if (length > 0) { normal.x /= length; normal.y /= length; }
    }
    const oldVelocity = { x: entity.velocity.x + entity.falling.x, y: entity.velocity.y + entity.falling.y,
      z: entity.velocity.z + entity.falling.z };
    projectAgainst(entity.velocity, normal);
    projectAgainst(entity.falling, normal);
    this.recalculateDirection(entity, oldVelocity, displacement);
    this.fallOrSlide(entity, collision.normal);
  }
}
