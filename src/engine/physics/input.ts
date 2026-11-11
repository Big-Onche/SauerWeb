export interface PhysicsInputState {
  forward: boolean;
  backward: boolean;
  left: boolean;
  right: boolean;
  jump: boolean;
  yawDelta: number;
  pitchDelta: number;
}

export function createInputState(): PhysicsInputState {
  return { forward: false, backward: false, left: false, right: false, jump: false, yawDelta: 0, pitchDelta: 0 };
}

export function movementAxis(positive: boolean, negative: boolean): -1 | 0 | 1 {
  return positive === negative ? 0 : positive ? 1 : -1;
}
