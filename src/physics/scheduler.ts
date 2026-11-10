import { PHYSICS_FRAME_TIME_MS } from "./constants";

export interface PhysicsSchedule {
  steps: number;
  stepMilliseconds: number;
  interpolation: number;
}

/** Port of physicsframe/interppos in .Sauerbraten/src/engine/physics.cpp:1748-1775. */
export class PhysicsScheduler {
  private lastPhysicsFrame = 0;
  private frameTime = PHYSICS_FRAME_TIME_MS;

  reset(nowMilliseconds: number): void {
    this.lastPhysicsFrame = nowMilliseconds;
  }

  schedule(nowMilliseconds: number, timeScale = 100): PhysicsSchedule {
    const difference = nowMilliseconds - this.lastPhysicsFrame;
    if (difference <= 0) {
      const overshoot = Math.min(this.lastPhysicsFrame - nowMilliseconds, this.frameTime);
      return { steps: 0, stepMilliseconds: this.frameTime, interpolation: 1 - overshoot / this.frameTime };
    }
    this.frameTime = Math.min(PHYSICS_FRAME_TIME_MS, Math.max(1, Math.trunc(PHYSICS_FRAME_TIME_MS * timeScale / 100)));
    const steps = Math.ceil(difference / this.frameTime);
    this.lastPhysicsFrame += steps * this.frameTime;
    const overshoot = Math.min(this.lastPhysicsFrame - nowMilliseconds, this.frameTime);
    return { steps, stepMilliseconds: this.frameTime, interpolation: 1 - overshoot / this.frameTime };
  }
}
