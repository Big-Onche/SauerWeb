import type { SauerMap, Vec3 } from "./octa";
import { FLOOR_Z, GRAVITY, JUMP_VELOCITY, SLOPE_Z } from "./physics/constants";
import { OctreeCollisionWorld } from "./physics/collision";
import type { MapModelCollision, RaycastResult } from "./physics/collision";
import { MAT_DEATH, MATF_VOLUME, MAT_LAVA, MAT_WATER } from "./material";
import { GroundMover } from "./physics/ground";
import type { PhysicsInputState } from "./physics/input";
import { movementAxis } from "./physics/input";
import { PhysicsScheduler } from "./physics/scheduler";
import { ClientState, type PhysicsEntity, PhysicsState, createPlayer, resetPlayer } from "./physics/types";
import { addScaled, copyVec3, lerpVec3, normalize, projectAgainst, scaleVec3, vec3 } from "./physics/vector";

export interface PhysicsDebugSnapshot {
  paused: boolean;
  steps: number;
  stepMilliseconds: number;
  interpolation: number;
  entity: PhysicsEntity;
  renderPosition: Vec3;
}

export type PhysicsSoundEvent = "jump" | "land" | "splash-in" | "splash-out" | "burn";

/** Milestone-00 simulation shell. Collision resolution is intentionally delegated to the next milestone. */
export class PhysicsSimulation {
  readonly player = createPlayer();
  readonly scheduler = new PhysicsScheduler();
  paused = false;
  timeScale = 100;
  private spawnPosition = vec3();
  private spawnYaw = 0;
  private renderPosition = vec3();
  private lastSchedule = { steps: 0, stepMilliseconds: 5, interpolation: 1 };
  private groundMover?: GroundMover;
  private collisionWorld?: OctreeCollisionWorld;
  raycastPerformanceRecorder?: (milliseconds: number) => void;
  raycastPerformanceEnabled?: () => boolean;
  soundEvent?: (event: PhysicsSoundEvent, player: PhysicsEntity) => void;

  setMap(map: SauerMap): void {
    this.collisionWorld = new OctreeCollisionWorld(map);
    this.groundMover = new GroundMover(this.collisionWorld);
  }

  setMapModels(mapModels: MapModelCollision[]): void {
    this.collisionWorld?.setMapModels(mapModels);
  }

  raycast(origin: Vec3, direction: Vec3, maximumDistance: number, radius = 0, skipFirst = false): RaycastResult | undefined {
    if (!this.raycastPerformanceRecorder || !this.raycastPerformanceEnabled?.()) {
      return this.collisionWorld?.raycast(origin, direction, maximumDistance, radius, skipFirst);
    }
    const startedAt = performance.now();
    try {
      return this.collisionWorld?.raycast(origin, direction, maximumDistance, radius, skipFirst);
    } finally {
      this.raycastPerformanceRecorder(performance.now() - startedAt);
    }
  }

  lookupMaterial(position: Vec3): number {
    return this.collisionWorld?.lookupMaterial(position) ?? 0;
  }

  collideBouncer(position: Vec3, radius: number, direction: Vec3): { normal: Vec3 } | undefined {
    return this.collisionWorld?.collideBouncer(position, radius, direction);
  }

  spawn(position: Vec3, yaw: number, nowMilliseconds: number): void {
    this.spawnPosition = copyVec3(position);
    this.spawnYaw = yaw;
    resetPlayer(this.player, position, yaw);
    this.groundMover?.initialize(this.player);
    this.renderPosition = copyVec3(position);
    this.scheduler.reset(nowMilliseconds);
  }

  reset(nowMilliseconds: number): void {
    this.spawn(this.spawnPosition, this.spawnYaw, nowMilliseconds);
  }

  // Original: src/engine/physics.cpp
  // Function: entinmap()
  // Sauerbraten reference: SVN r6488
  entinmap(position: Vec3): void {
    this.player.position = { ...position, z: position.z + this.player.eyeHeight };
    this.player.previousPosition = copyVec3(this.player.position);
    this.groundMover?.initialize(this.player);
    this.renderPosition = copyVec3(this.player.position);
  }

  setPaused(paused: boolean, nowMilliseconds: number): void {
    this.paused = paused;
    this.scheduler.reset(nowMilliseconds);
  }

  update(nowMilliseconds: number, input: PhysicsInputState): Vec3 {
    return this.physicsframe(nowMilliseconds, input);
  }

  // Original: src/engine/physics.cpp
  // Function: physicsframe()
  // Sauerbraten reference: SVN r6488
  physicsframe(nowMilliseconds: number, input: PhysicsInputState): Vec3 {
    if (!this.player.alive && this.player.clientState !== ClientState.Spectator) this.player.clientState = ClientState.Dead;
    this.applyInput(input);
    if (this.paused) return this.renderPosition;
    this.lastSchedule = this.scheduler.schedule(nowMilliseconds, this.timeScale);
    for (let index = 0; index < this.lastSchedule.steps; index++) this.moveplayer(this.player, this.lastSchedule.stepMilliseconds);
    this.renderPosition = lerpVec3(this.player.previousPosition, this.player.position, this.lastSchedule.interpolation);
    return this.renderPosition;
  }

  debugSnapshot(): PhysicsDebugSnapshot {
    return { ...this.lastSchedule, paused: this.paused, entity: this.player, renderPosition: copyVec3(this.renderPosition) };
  }

  private applyInput(input: PhysicsInputState): void {
    if (!this.player.alive && this.player.clientState !== ClientState.Spectator) {
      this.player.move = this.player.strafe = 0;
      this.player.jumping = false;
      return;
    }
    this.player.move = movementAxis(input.forward, input.backward);
    // Native commands map left to +1 and right to -1 (physics.cpp:2017-2018).
    this.player.strafe = movementAxis(input.left, input.right);
    this.player.jumping = input.jump;
    this.player.yaw = (this.player.yaw + input.yawDelta * 0.1 + 360) % 360;
    this.player.pitch = Math.min(90, Math.max(-90, this.player.pitch - input.pitchDelta * 0.1));
  }

  // Original: src/engine/physics.cpp
  // Function: moveplayer()
  // Sauerbraten reference: SVN r6488
  /** Advances an AI-owned actor through the same native movement and collision path as the local player. */
  simulateEntity(player: PhysicsEntity, milliseconds: number): void {
    this.moveplayer(player, milliseconds);
  }

  private moveplayer(player: PhysicsEntity, milliseconds: number): void {
    player.previousPosition = copyVec3(player.position);
    const previousPhysicsState = player.physicsState, previousTimeInAir = player.timeInAir, previousWater = player.inWater;
    const seconds = milliseconds / 1000;
    const floating = player.clientState === ClientState.Editing || player.clientState === ClientState.Spectator;
    const materialPosition = {
      x: player.position.x,
      y: player.position.y,
      z: player.position.z + (3 * player.aboveEye - player.eyeHeight) / 4,
    };
    const material = this.collisionWorld?.lookupMaterial(materialPosition) ?? 0;
    const volume = material & MATF_VOLUME;
    const water = volume === MAT_WATER || volume === MAT_LAVA;
    const enteredWater = water && player.inWater === 0;
    if (!floating) {
      if (player.physicsState === PhysicsState.Fall) {
        if (!water || (player.move === 0 && player.strafe === 0)) player.falling.z -= GRAVITY * seconds;
        player.timeInAir = Math.min(player.timeInAir + milliseconds, 1000);
      } else if (player.floor.z > 0 && player.floor.z < FLOOR_Z) {
        const slopeGravity = vec3(0, 0, -1);
        projectAgainst(slopeGravity, player.floor);
        normalize(slopeGravity);
        if (!water || (player.move === 0 && player.strafe === 0)) addScaled(player.falling, slopeGravity, GRAVITY * seconds);
      }
    }
    if (!floating && (water || player.physicsState >= PhysicsState.Slope)) {
      const coefficient = water ? 1 : Math.min(1, Math.max(0, (player.floor.z - SLOPE_Z) / (FLOOR_Z - SLOPE_Z)));
      scaleVec3(player.falling, Math.pow(1 - coefficient / (water ? 2 : 6), milliseconds / 20));
    }
    if (!floating && enteredWater) scaleVec3(player.velocity, 1 / 8);
    if (player.jumping && (floating || player.physicsState >= PhysicsState.Slope || water)) {
      player.jumping = false;
      player.velocity.z = Math.max(player.velocity.z, JUMP_VELOCITY);
      if (!floating && water) { player.velocity.x /= 8; player.velocity.y /= 8; }
      if (!floating) this.soundEvent?.("jump", player);
    }
    const yaw = player.yaw * Math.PI / 180;
    const pitch = floating || water ? player.pitch * Math.PI / 180 : 0;
    const desired = vec3(
      player.move * -Math.sin(yaw) * Math.cos(pitch) + player.strafe * Math.cos(yaw),
      player.move * Math.cos(yaw) * Math.cos(pitch) + player.strafe * Math.sin(yaw),
      player.move * Math.sin(pitch),
    );
    normalize(desired);
    if (!floating && player.physicsState >= PhysicsState.Slope && player.floor.z > 0 && player.floor.z < 1) {
      const slopeZ = -(desired.x * player.floor.x + desired.y * player.floor.y) / player.floor.z;
      desired.z = water ? Math.max(desired.z, slopeZ) : slopeZ;
      normalize(desired);
    }
    const speedScale = floating || water ? 1 : (player.move !== 0 && player.strafe === 0 ? 1.3 : 1) *
      (player.physicsState < PhysicsState.Slope ? 1.3 : 1);
    scaleVec3(desired, player.maxSpeed * speedScale);
    const friction = floating || player.physicsState >= PhysicsState.Slope ? 6 : water ? 20 : 30;
    const blend = 1 - Math.pow(1 - 1 / friction, milliseconds / 20);
    player.velocity.x += (desired.x - player.velocity.x) * blend;
    player.velocity.y += (desired.y - player.velocity.y) * blend;
    player.velocity.z += (desired.z - player.velocity.z) * blend;
    const displacement = copyVec3(player.velocity);
    if (!floating && water) scaleVec3(displacement, 0.5);
    displacement.x += player.falling.x;
    displacement.y += player.falling.y;
    displacement.z += player.falling.z;
    scaleVec3(displacement, seconds / 10);
    player.blocked = false;
    if (floating) {
      player.physicsState = PhysicsState.Float;
      player.timeInAir = 0;
      player.falling = vec3();
      addScaled(player.position, player.velocity, seconds);
    } else if (this.groundMover) {
      let collisions = 0;
      for (let index = 0; index < 10; index++) {
        if (!this.groundMover.move(player, displacement) && ++collisions < 5) index--;
      }
    } else {
      addScaled(player.position, player.velocity, seconds);
      addScaled(player.position, player.falling, seconds);
    }
    player.inWater = !floating && water ? volume : 0;
    if (enteredWater) this.soundEvent?.("splash-in", player);
    else if (previousWater && !player.inWater) this.soundEvent?.(previousWater === MAT_LAVA ? "burn" : "splash-out", player);
    if (previousPhysicsState === PhysicsState.Fall && player.physicsState >= PhysicsState.Slope && previousTimeInAir > 50) {
      this.soundEvent?.("land", player);
    }
    if (player.clientState === ClientState.Alive && (player.position.z < 0 || (material & MAT_DEATH) !== 0)) {
      player.clientState = ClientState.Dead;
      player.move = player.strafe = 0;
    }
  }
}
