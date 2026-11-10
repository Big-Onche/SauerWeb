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

export class BrowserPhysicsInput {
  readonly state = createInputState();
  enabled = false;
  private readonly pressed = new Set<string>();

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("click", this.onCanvasClick);
  }

  sample(): PhysicsInputState {
    this.state.forward = this.pressed.has("KeyW") || this.pressed.has("ArrowUp");
    this.state.backward = this.pressed.has("KeyS") || this.pressed.has("ArrowDown");
    this.state.left = this.pressed.has("KeyA") || this.pressed.has("ArrowLeft");
    this.state.right = this.pressed.has("KeyD") || this.pressed.has("ArrowRight");
    this.state.jump = this.pressed.has("Space");
    const sampled = { ...this.state };
    this.state.yawDelta = 0;
    this.state.pitchDelta = 0;
    return sampled;
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    this.pressed.add(event.code);
    if (["KeyW", "KeyA", "KeyS", "KeyD", "ArrowUp", "ArrowDown", "ArrowLeft", "ArrowRight", "Space"].includes(event.code)) {
      event.preventDefault();
    }
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(event.code);
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    this.state.yawDelta += event.movementX;
    this.state.pitchDelta += event.movementY;
  };

  private readonly onCanvasClick = (): void => {
    if (this.enabled && document.pointerLockElement !== this.canvas) void this.canvas.requestPointerLock();
  };

  private readonly clear = (): void => {
    this.pressed.clear();
    Object.assign(this.state, createInputState());
  };
}

