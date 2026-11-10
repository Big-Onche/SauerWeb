import type { Vec3 } from "../map/types";
import { GRAVITY } from "./constants";
import type { PhysicsInputState } from "./input";
import { movementAxis } from "./input";
import { PhysicsScheduler } from "./scheduler";
import { type PhysicsEntity, PhysicsState, createPlayer, resetPlayer } from "./types";
import { addScaled, copyVec3, lerpVec3, normalize, scaleVec3, vec3 } from "./vector";

export interface PhysicsDebugSnapshot {
  paused: boolean;
  steps: number;
  stepMilliseconds: number;
  interpolation: number;
  entity: PhysicsEntity;
  renderPosition: Vec3;
}

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

  spawn(position: Vec3, yaw = 0, nowMilliseconds = performance.now()): void {
    this.spawnPosition = copyVec3(position);
    this.spawnYaw = yaw;
    resetPlayer(this.player, position, yaw);
    this.renderPosition = copyVec3(position);
    this.scheduler.reset(nowMilliseconds);
  }

  reset(nowMilliseconds = performance.now()): void {
    this.spawn(this.spawnPosition, this.spawnYaw, nowMilliseconds);
  }

  setPaused(paused: boolean, nowMilliseconds = performance.now()): void {
    this.paused = paused;
    this.scheduler.reset(nowMilliseconds);
  }

  update(nowMilliseconds: number, input: PhysicsInputState): Vec3 {
    this.applyInput(input);
    if (this.paused) return this.renderPosition;
    this.lastSchedule = this.scheduler.schedule(nowMilliseconds, this.timeScale);
    for (let index = 0; index < this.lastSchedule.steps; index++) this.step(this.lastSchedule.stepMilliseconds);
    this.renderPosition = lerpVec3(this.player.previousPosition, this.player.position, this.lastSchedule.interpolation);
    return this.renderPosition;
  }

  debugSnapshot(): PhysicsDebugSnapshot {
    return { ...this.lastSchedule, paused: this.paused, entity: this.player, renderPosition: copyVec3(this.renderPosition) };
  }

  private applyInput(input: PhysicsInputState): void {
    this.player.move = movementAxis(input.forward, input.backward);
    // Native commands map left to +1 and right to -1 (physics.cpp:2017-2018).
    this.player.strafe = movementAxis(input.left, input.right);
    this.player.jumping = input.jump;
    this.player.yaw = (this.player.yaw + input.yawDelta * 0.1 + 360) % 360;
    this.player.pitch = Math.min(90, Math.max(-90, this.player.pitch - input.pitchDelta * 0.1));
  }

  private step(milliseconds: number): void {
    const player = this.player;
    player.previousPosition = copyVec3(player.position);
    const seconds = milliseconds / 1000;
    if (player.physicsState === PhysicsState.Fall) {
      player.falling.z -= GRAVITY * seconds;
      player.timeInAir = Math.min(player.timeInAir + milliseconds, 1000);
    }
    const yaw = player.yaw * Math.PI / 180;
    const desired = vec3(
      player.move * -Math.sin(yaw) + player.strafe * Math.cos(yaw),
      player.move * Math.cos(yaw) + player.strafe * Math.sin(yaw),
      0,
    );
    normalize(desired);
    scaleVec3(desired, player.maxSpeed * (player.move !== 0 && player.strafe === 0 ? 1.3 : 1) * 1.3);
    const friction = player.physicsState >= PhysicsState.Slope ? 6 : 30;
    const blend = 1 - Math.pow(1 - 1 / friction, milliseconds / 20);
    player.velocity.x += (desired.x - player.velocity.x) * blend;
    player.velocity.y += (desired.y - player.velocity.y) * blend;
    player.velocity.z += (desired.z - player.velocity.z) * blend;
    addScaled(player.position, player.velocity, seconds);
    addScaled(player.position, player.falling, seconds);
    player.blocked = false;
  }
}
