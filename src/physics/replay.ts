import type { Vec3 } from "../map/types";
import type { PhysicsInputState } from "./input";
import { PhysicsSimulation } from "./simulation";
import { copyVec3 } from "./vector";

export interface PhysicsReplayFrame {
  nowMilliseconds: number;
  input: PhysicsInputState;
}

export interface PhysicsReplay {
  spawn: Vec3;
  yaw: number;
  frames: PhysicsReplayFrame[];
}

export interface PhysicsReplayResult {
  position: Vec3;
  velocity: Vec3;
  falling: Vec3;
  timeInAir: number;
}

/** Runs timestamped input samples without depending on rendering or browser frame cadence. */
export function runReplay(replay: PhysicsReplay): PhysicsReplayResult {
  const simulation = new PhysicsSimulation();
  simulation.spawn(replay.spawn, replay.yaw, 0);
  replay.frames.forEach((frame) => simulation.update(frame.nowMilliseconds, { ...frame.input }));
  return {
    position: copyVec3(simulation.player.position),
    velocity: copyVec3(simulation.player.velocity),
    falling: copyVec3(simulation.player.falling),
    timeInAir: simulation.player.timeInAir,
  };
}

