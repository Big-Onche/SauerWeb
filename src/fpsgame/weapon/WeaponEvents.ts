import type { Vec3 } from "../../engine/octa";
import type { Damageable } from "./DamageSystem";
import type { Gun } from "./WeaponDefinitions";

export interface WeaponHit {
  target: Damageable;
  distance: number;
  rays: number;
  direction: Vec3;
}

export type WeaponEvent =
  | { type: "selected"; gun: Gun }
  | { type: "no-ammo"; gun: Gun }
  | { type: "shot"; gun: Gun; millis: number; from: Vec3; to: Vec3; rays: Vec3[]; hits: WeaponHit[] }
  | { type: "shot-effect"; gun: Gun; from: Vec3; to: Vec3; rays: Vec3[]; clientNumber?: number }
  | { type: "projectile-spawned"; gun: Gun; id: number; position: Vec3 }
  | { type: "projectile-moved"; gun: Gun; id: number; position: Vec3 }
  | { type: "bouncer-spawned"; key: string; id: number; ownerId: string; bouncerType: number; position: Vec3; velocity: Vec3;
      variant: number }
  | { type: "bouncer-moved"; key: string; position: Vec3; velocity: Vec3; yaw: number; roll: number; smoke: boolean; fade: number }
  | { type: "bouncer-impact"; key: string; bouncerType: number; position: Vec3; normal: Vec3; bounces: number }
  | { type: "bouncer-exploded"; key: string; id: number; ownerId: string; local: boolean; position: Vec3; hits: WeaponHit[] }
  | { type: "bouncer-removed"; key: string }
  | { type: "explosion"; gun: Gun; position: Vec3; radius: number }
  | { type: "damage"; gun: Gun; target: Damageable; amount: number; absorbed: number }
  | { type: "death"; gun: Gun; target: Damageable };

export type WeaponEventListener = (event: WeaponEvent) => void;

export class WeaponEvents {
  private readonly listeners = new Set<WeaponEventListener>();

  on(listener: WeaponEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: WeaponEvent): void {
    this.listeners.forEach((listener) => listener(event));
  }
}
