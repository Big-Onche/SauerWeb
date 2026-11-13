import { createInputState, type PhysicsInputState } from "../../engine/physics/input";
import type { ICameraInput } from "@babylonjs/core/Cameras/cameraInputsManager";
import type { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { keyForEvent, loadMovementBindings, type MovementBindings } from "./KeyBindings";
import { loadTouchSettings, TOUCH_SETTINGS_CHANGED, type TouchSettings } from "./TouchSettings";

export class BrowserPhysicsInput {
  readonly state = createInputState();
  enabled = false;
  private readonly pressed = new Set<string>();
  private readonly bindings = loadMovementBindings();
  private settings = loadTouchSettings();
  private touchX = 0;
  private touchY = 0;
  private touchJump = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("click", this.onCanvasClick);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
  }

  sample(): PhysicsInputState {
    this.state.forward = this.pressed.has(this.bindings.forward) || this.touchY < -.25;
    this.state.backward = this.pressed.has(this.bindings.backward) || this.touchY > .25;
    this.state.left = this.pressed.has(this.bindings.left) || this.touchX < -.25;
    this.state.right = this.pressed.has(this.bindings.right) || this.touchX > .25;
    this.state.jump = this.pressed.has(this.bindings.jump) || this.touchJump;
    const sampled = { ...this.state };
    this.state.yawDelta = 0;
    this.state.pitchDelta = 0;
    return sampled;
  }

  capture(): void {
    if (!this.enabled || document.pointerLockElement === this.canvas) return;
    try {
      const request = this.canvas.requestPointerLock();
      if (request) void request.catch(() => undefined);
    } catch {
      // Browsers require a user activation for the first pointer lock. Entry makes a
      // best-effort request; respawn/resume handlers call this again from their gesture.
    }
  }

  setTouchMovement(x: number, y: number): void { this.touchX = x; this.touchY = y; }

  setTouchJumping(jumping: boolean): void { this.touchJump = jumping; }

  addTouchLook(yawDelta: number, pitchDelta: number): void {
    this.state.yawDelta += yawDelta;
    this.state.pitchDelta += pitchDelta;
  }

  clearTouch(): void {
    this.touchX = this.touchY = 0;
    this.touchJump = false;
    this.state.yawDelta = this.state.pitchDelta = 0;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("click", this.onCanvasClick);
    window.removeEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    this.clear();
  }

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    if (!this.enabled) return;
    const key = keyForEvent(event);
    this.pressed.add(key);
    if (Object.values(this.bindings).includes(key)) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => {
    this.pressed.delete(keyForEvent(event));
  };

  private readonly onMouseMove = (event: MouseEvent): void => {
    if (!this.enabled || document.pointerLockElement !== this.canvas) return;
    const scale = this.settings.mouseSensitivity / 100;
    this.state.yawDelta += event.movementX * scale;
    this.state.pitchDelta += event.movementY * scale;
  };

  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => { this.settings = event.detail; };

  private readonly onCanvasClick = (): void => {
    this.capture();
  };

  private readonly clear = (): void => {
    this.pressed.clear();
    this.clearTouch();
    Object.assign(this.state, createInputState());
  };
}

export class BrowserFreeCameraInput implements ICameraInput<UniversalCamera> {
  camera: UniversalCamera | null = null;
  private readonly pressed = new Set<string>();
  private readonly bindings: MovementBindings = loadMovementBindings();
  private noPreventDefault = false;

  getClassName(): string { return "BrowserFreeCameraInput"; }

  getSimpleName(): string { return "keyboard"; }

  attachControl(noPreventDefault = false): void {
    this.noPreventDefault = noPreventDefault;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
  }

  detachControl(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clear);
    this.clear();
  }

  readonly checkInputs = (): void => {
    const camera = this.camera;
    if (!camera) return;
    const speed = camera._computeLocalCameraSpeed();
    const localDirection = Vector3.Zero();
    if (this.pressed.has(this.bindings.left)) localDirection.x -= speed;
    if (this.pressed.has(this.bindings.right)) localDirection.x += speed;
    if (this.pressed.has(this.bindings.forward)) localDirection.z += speed;
    if (this.pressed.has(this.bindings.backward)) localDirection.z -= speed;
    if (!localDirection.lengthSquared()) return;
    if (camera.getScene().useRightHandedSystem) localDirection.z *= -1;
    camera.getViewMatrix().invertToRef(camera._cameraTransformMatrix);
    Vector3.TransformNormalToRef(localDirection, camera._cameraTransformMatrix, camera._transformedDirection);
    camera.cameraDirection.addInPlace(camera._transformedDirection);
  };

  private readonly onKeyDown = (event: KeyboardEvent): void => {
    const key = keyForEvent(event);
    if (!Object.values(this.bindings).includes(key) || key === this.bindings.jump) return;
    this.pressed.add(key);
    if (!this.noPreventDefault) event.preventDefault();
  };

  private readonly onKeyUp = (event: KeyboardEvent): void => { this.pressed.delete(keyForEvent(event)); };
  private readonly clear = (): void => { this.pressed.clear(); };
}
