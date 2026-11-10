import type { Vec3 } from "../map/types";
import { FLOOR_Z, SLOPE_Z, STAIR_HEIGHT, WALL_Z } from "./constants";
import { OctreeCollisionWorld, type CollisionResult } from "./collision";
import { type PhysicsEntity, PhysicsState } from "./types";
import { copyVec3, dot, magnitude, projectAgainst, vec3 } from "./vector";

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
      if (this.canStep(entity) && this.tryStepUp(entity, displacement)) return true;
      this.slide(entity, displacement, collision);
      entity.blocked = true;
      return false;
    }
    if (entity.physicsState === PhysicsState.StepDown && dot(displacement, entity.floor) <= 1e-6 && this.tryStepDown(entity)) return true;
    const floor = this.findFloor(entity, 0.1);
    if (floor) this.land(entity, floor.normal);
    else if (this.canStep(entity) && this.tryStepDown(entity)) return true;
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

  private tryStepUp(entity: PhysicsEntity, displacement: Vec3): boolean {
    const origin = copyVec3(entity.position);
    // Find the lowest collision-free elevation. Fine increments avoid stair-height pops.
    for (let height = 0.25; height <= STAIR_HEIGHT + 1e-6; height += 0.25) {
      entity.position = { x: origin.x + displacement.x, y: origin.y + displacement.y, z: origin.z + displacement.z + height };
      if (this.world.collide(entity, { x: displacement.x, y: displacement.y, z: height })) continue;
      const floor = this.findFloor(entity, Math.min(STAIR_HEIGHT, height + 0.35));
      if (!floor || floor.normal.z < SLOPE_Z) continue;
      this.land(entity, floor.normal);
      entity.physicsState = PhysicsState.StepUp;
      return true;
    }
    entity.position = origin;
    return false;
  }

  private tryStepDown(entity: PhysicsEntity): boolean {
    const origin = copyVec3(entity.position);
    let clearDistance = 0;
    for (let probe = 0.25; probe <= STAIR_HEIGHT + 0.25; probe += 0.25) {
      const distance = Math.min(probe, STAIR_HEIGHT);
      entity.position = { x: origin.x, y: origin.y, z: origin.z - distance };
      const collision = this.world.collide(entity, { x: 0, y: 0, z: -distance }, SLOPE_Z);
      if (!collision) {
        clearDistance = distance;
        continue;
      }
      if (collision.normal.z < SLOPE_Z) break;
      let lower = clearDistance, upper = distance;
      for (let iteration = 0; iteration < 8; iteration++) {
        const middle = (lower + upper) / 2;
        entity.position = { x: origin.x, y: origin.y, z: origin.z - middle };
        if (this.world.collide(entity, { x: 0, y: 0, z: -middle }, SLOPE_Z)) upper = middle;
        else lower = middle;
      }
      entity.position = { x: origin.x, y: origin.y, z: origin.z - lower };
      this.land(entity, collision.normal);
      entity.physicsState = PhysicsState.StepDown;
      return true;
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

  private land(entity: PhysicsEntity, floor: Vec3): void {
    if (floor.z >= FLOOR_Z) entity.falling = vec3();
    else {
      projectAgainst(entity.velocity, floor);
      projectAgainst(entity.falling, floor);
    }
    entity.timeInAir = 0;
    entity.floor = copyVec3(floor);
    if (entity.physicsState !== PhysicsState.StepUp && entity.physicsState !== PhysicsState.StepDown) {
      entity.physicsState = floor.z >= FLOOR_Z ? PhysicsState.Floor : PhysicsState.Slope;
    }
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
      projectAgainst(displacement, collision.normal);
      this.land(entity, collision.normal);
      return;
    }
    const normal = { ...collision.normal };
    if (normal.z > 0) {
      normal.z = 0;
      const length = magnitude(normal);
      if (length > 0) { normal.x /= length; normal.y /= length; }
    }
    projectAgainst(entity.velocity, normal);
    projectAgainst(entity.falling, normal);
    projectAgainst(displacement, normal);
    this.fallOrSlide(entity, collision.normal);
  }
}
