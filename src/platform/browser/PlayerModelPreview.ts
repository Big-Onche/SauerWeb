import { UniversalCamera } from "@babylonjs/core/Cameras/universalCamera";
import { Engine } from "@babylonjs/core/Engines/engine";
import { HemisphericLight } from "@babylonjs/core/Lights/hemisphericLight";
import { Color4 } from "@babylonjs/core/Maths/math.color";
import { Vector3 } from "@babylonjs/core/Maths/math.vector";
import { Scene } from "@babylonjs/core/scene";
import { ClientState, PhysicsState } from "../../engine/physics/types";
import { PlayerRenderer, type RenderPlayer } from "./PlayerRenderer";

export class PlayerModelPreview {
  private readonly engine: Engine;
  private readonly scene: Scene;
  private readonly renderer: PlayerRenderer;
  private readonly resizeObserver: ResizeObserver;
  private model = 0;

  constructor(canvas: HTMLCanvasElement) {
    this.engine = new Engine(canvas, true, { preserveDrawingBuffer: false, stencil: false, alpha: true });
    this.scene = new Scene(this.engine);
    this.scene.useRightHandedSystem = true;
    this.scene.clearColor = new Color4(0, 0, 0, 0);
    const camera = new UniversalCamera("playermodel-preview-camera", new Vector3(0, 9, -29), this.scene);
    camera.setTarget(new Vector3(0, 8, 0));
    camera.fov = 0.65;
    this.scene.activeCamera = camera;
    const light = new HemisphericLight("playermodel-preview-light", new Vector3(-0.35, 1, -0.5), this.scene);
    light.intensity = 1.25;
    light.groundColor.set(0.18, 0.2, 0.22);
    this.renderer = new PlayerRenderer(this.scene);
    this.engine.runRenderLoop(() => {
      this.renderer.rendergame([this.player()], 0, false, "", performance.now());
      this.scene.render();
    });
    this.resizeObserver = new ResizeObserver(() => this.engine.resize());
    this.resizeObserver.observe(canvas);
  }

  setModel(model: number): void {
    this.model = model;
  }

  dispose(): void {
    this.resizeObserver.disconnect();
    this.engine.stopRenderLoop();
    this.renderer.clear();
    this.scene.dispose();
    this.engine.dispose();
  }

  private player(): RenderPlayer {
    return {
      id: 0,
      model: this.model,
      team: "",
      local: true,
      visible: true,
      position: { x: 0, y: 0, z: 0 },
      yaw: 180,
      pitch: 0,
      state: ClientState.Alive,
      move: 0,
      strafe: 0,
      physicsState: PhysicsState.Floor,
      timeInAir: 0,
      lastPain: -1000,
    };
  }
}
