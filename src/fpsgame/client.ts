import { PhysicsSimulation } from "../engine/physics";
import { WeaponSystem } from "./weapon";

export interface FpsClient {
  physics: PhysicsSimulation;
  weapons: WeaponSystem;
}

export function createClient(physics = new PhysicsSimulation()): FpsClient {
  const weapons = new WeaponSystem({
    raycast: (origin, direction, distance, radius) => physics.raycast(origin, direction, distance, radius),
  }, physics.player);
  return { physics, weapons };
}
