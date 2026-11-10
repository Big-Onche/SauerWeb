import type { Vec3 } from "../map/types";
import type { Damageable } from "./DamageSystem";
import type { Gun } from "./WeaponDefinitions";

export type WeaponEvent =
  | { type: "selected"; gun: Gun }
  | { type: "no-ammo"; gun: Gun }
  | { type: "shot"; gun: Gun; from: Vec3; to: Vec3; rays: Vec3[] }
  | { type: "projectile-spawned"; gun: Gun; id: number; position: Vec3 }
  | { type: "projectile-moved"; gun: Gun; id: number; position: Vec3 }
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
