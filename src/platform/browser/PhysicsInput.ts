import { createInputState, type PhysicsInputState } from "../../engine/physics/input";
import type { ICameraInput } from "@babylonjs/core/Cameras/cameraInputsManager";
import type { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { keyForEvent, loadMovementBindings, type MovementBindings } from "./KeyBindings";
import { GYRO_RECENTER_REQUESTED, loadTouchSettings, TOUCH_SETTINGS_CHANGED, touchControlsWanted, type TouchSettings } from "./TouchSettings";

export class BrowserPhysicsInput {
  readonly state = createInputState();
  enabled = false;
  private readonly pressed = new Set<string>();
  private readonly bindings = loadMovementBindings();
  private settings = loadTouchSettings();
  private touchX = 0;
  private touchY = 0;
  private touchJump = false;
  private touchLookX = 0;
  private touchLookY = 0;
  private lastSampleTime = performance.now();
  private gyroYaw = 0;
  private gyroPitch = 0;
  private filteredGyroYaw = 0;
  private filteredGyroPitch = 0;
  private previousGyro?: { alpha: number; beta: number; gamma: number };
  private gyroPermissionRequested = false;
  private fullGyroContext = false;

  constructor(private readonly canvas: HTMLCanvasElement) {
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    document.addEventListener("mousemove", this.onMouseMove);
    canvas.addEventListener("click", this.onCanvasClick);
    window.addEventListener("pointerdown", this.requestGyroPermission);
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    window.addEventListener(GYRO_RECENTER_REQUESTED, this.recenterGyro);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
  }

  sample(): PhysicsInputState {
    const now = performance.now(), elapsed = Math.min(0.05, Math.max(0, (now - this.lastSampleTime) / 1000));
    this.lastSampleTime = now;
    this.state.forward = this.pressed.has(this.bindings.forward) || this.touchY < -.25;
    this.state.backward = this.pressed.has(this.bindings.backward) || this.touchY > .25;
    this.state.left = this.pressed.has(this.bindings.left) || this.touchX < -.25;
    this.state.right = this.pressed.has(this.bindings.right) || this.touchX > .25;
    this.state.jump = this.pressed.has(this.bindings.jump) || this.touchJump;
    // At full displacement the aiming stick can turn more than 180 degrees per second.
    this.state.yawDelta += this.touchLookX * this.settings.aimHorizontalSensitivity * elapsed * 10;
    this.state.pitchDelta += this.touchLookY * this.settings.aimVerticalSensitivity * elapsed * 10;
    this.state.yawDelta += this.gyroYaw;
    this.state.pitchDelta += this.gyroPitch;
    this.gyroYaw = this.gyroPitch = 0;
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

  setTouchLookVelocity(x: number, y: number): void { this.touchLookX = x; this.touchLookY = y; }

  setFullGyroContext(enabled: boolean): void { if (enabled !== this.fullGyroContext) this.recenterGyro(); this.fullGyroContext = enabled; }

  addTouchLook(yawDelta: number, pitchDelta: number): void {
    this.state.yawDelta += yawDelta;
    this.state.pitchDelta += pitchDelta;
  }

  clearTouch(): void {
    this.touchX = this.touchY = 0;
    this.touchJump = false;
    this.touchLookX = this.touchLookY = 0;
    this.state.yawDelta = this.state.pitchDelta = 0;
  }

  dispose(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clear);
    document.removeEventListener("mousemove", this.onMouseMove);
    this.canvas.removeEventListener("click", this.onCanvasClick);
    window.removeEventListener("pointerdown", this.requestGyroPermission);
    window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    window.removeEventListener(GYRO_RECENTER_REQUESTED, this.recenterGyro);
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

  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => {
    this.settings = event.detail;
    this.requestGyroPermission();
  };

  private readonly onCanvasClick = (): void => {
    this.capture();
  };

  private readonly requestGyroPermission = (): void => {
    if (this.gyroPermissionRequested || !this.settings.gyroEnabled && !this.settings.fullGyroEnabled || !touchControlsWanted(this.settings)) return;
    this.gyroPermissionRequested = true;
    const orientation = DeviceOrientationEvent as typeof DeviceOrientationEvent & { requestPermission?: () => Promise<string> };
    if (orientation.requestPermission) void orientation.requestPermission().catch(() => undefined);
  };

  private readonly onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    const gyroActive = this.fullGyroContext ? this.settings.fullGyroEnabled : this.settings.gyroEnabled;
    if (!this.enabled || !touchControlsWanted(this.settings) || !gyroActive ||
        event.alpha === null || event.beta === null || event.gamma === null) return;
    const current = landscapeOrientation(event.alpha, event.beta, event.gamma);
    const previous = this.previousGyro;
    this.previousGyro = current;
    if (!previous) return;
    const smoothing = this.settings.gyroSmoothing / 100;
    const scale = this.settings.gyroSensitivity / 100 * (this.fullGyroContext ? 2.2 : 1);
    const yaw = shortestAngle(current.alpha - previous.alpha) * scale * (this.settings.gyroInvertHorizontal ? -1 : 1);
    const pitch = (current.beta - previous.beta) * scale * (this.settings.gyroInvertVertical ? -1 : 1);
    this.filteredGyroYaw = this.filteredGyroYaw * smoothing + yaw * (1 - smoothing);
    this.filteredGyroPitch = this.filteredGyroPitch * smoothing + pitch * (1 - smoothing);
    this.gyroYaw += this.filteredGyroYaw * 10;
    this.gyroPitch += this.filteredGyroPitch * 10;
  };

  private readonly recenterGyro = (): void => {
    this.previousGyro = undefined;
    this.gyroYaw = this.gyroPitch = this.filteredGyroYaw = this.filteredGyroPitch = 0;
  };

  private readonly clear = (): void => {
    this.pressed.clear();
    this.clearTouch();
    Object.assign(this.state, createInputState());
    this.recenterGyro();
  };
}

function landscapeOrientation(alpha: number, beta: number, gamma: number): { alpha: number; beta: number; gamma: number } {
  const angle = screen.orientation?.angle ?? 0;
  if (angle === 90) return { alpha, beta: -gamma, gamma: beta };
  if (angle === 270 || angle === -90) return { alpha, beta: gamma, gamma: -beta };
  return { alpha, beta, gamma };
}

function shortestAngle(value: number): number { return (value + 540) % 360 - 180; }

export class BrowserFreeCameraInput implements ICameraInput<UniversalCamera> {
  camera: UniversalCamera | null = null;
  private readonly pressed = new Set<string>();
  private readonly bindings: MovementBindings = loadMovementBindings();
  private noPreventDefault = false;
  private settings = loadTouchSettings();
  private previousGyro?: { alpha: number; beta: number; gamma: number };
  private filteredGyroYaw = 0;
  private filteredGyroPitch = 0;

  getClassName(): string { return "BrowserFreeCameraInput"; }

  getSimpleName(): string { return "keyboard"; }

  attachControl(noPreventDefault = false): void {
    this.noPreventDefault = noPreventDefault;
    window.addEventListener("keydown", this.onKeyDown);
    window.addEventListener("keyup", this.onKeyUp);
    window.addEventListener("blur", this.clear);
    window.addEventListener("deviceorientation", this.onDeviceOrientation);
    window.addEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    window.addEventListener(GYRO_RECENTER_REQUESTED, this.recenterGyro);
  }

  detachControl(): void {
    window.removeEventListener("keydown", this.onKeyDown);
    window.removeEventListener("keyup", this.onKeyUp);
    window.removeEventListener("blur", this.clear);
    window.removeEventListener("deviceorientation", this.onDeviceOrientation);
    window.removeEventListener(TOUCH_SETTINGS_CHANGED, this.onSettingsChanged as EventListener);
    window.removeEventListener(GYRO_RECENTER_REQUESTED, this.recenterGyro);
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
  private readonly onSettingsChanged = (event: CustomEvent<TouchSettings>): void => { this.settings = event.detail; this.recenterGyro(); };
  private readonly onDeviceOrientation = (event: DeviceOrientationEvent): void => {
    if (!this.settings.fullGyroEnabled || !touchControlsWanted(this.settings) || !this.camera || event.alpha === null || event.beta === null ||
        event.gamma === null) return;
    const current = landscapeOrientation(event.alpha, event.beta, event.gamma), previous = this.previousGyro;
    this.previousGyro = current;
    if (!previous) return;
    const smoothing = this.settings.gyroSmoothing / 100;
    const scale = this.settings.gyroSensitivity / 100 * 2.2 * Math.PI / 180;
    const horizontal = this.settings.gyroInvertHorizontal ? -1 : 1, vertical = this.settings.gyroInvertVertical ? -1 : 1;
    const yaw = shortestAngle(current.alpha - previous.alpha) * scale * horizontal;
    const pitch = (current.beta - previous.beta) * scale * vertical;
    this.filteredGyroYaw = this.filteredGyroYaw * smoothing + yaw * (1 - smoothing);
    this.filteredGyroPitch = this.filteredGyroPitch * smoothing + pitch * (1 - smoothing);
    this.camera.rotation.y += this.filteredGyroYaw;
    this.camera.rotation.x = Math.min(Math.PI / 2, Math.max(-Math.PI / 2,
      this.camera.rotation.x + this.filteredGyroPitch));
  };
  private readonly recenterGyro = (): void => { this.previousGyro = undefined; this.filteredGyroYaw = this.filteredGyroPitch = 0; };
  private readonly clear = (): void => { this.pressed.clear(); this.recenterGyro(); };
}
