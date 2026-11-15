import type { Vec3 } from "../engine/octa";
import { ClientState } from "../engine/physics/types";
import { AMMO_PICKUPS, Gun } from "./weapon/WeaponDefinitions";

export const CAPTURERADIUS = 64;
export const CAPTUREHEIGHT = 24;
export const OCCUPYBONUS = 1;
export const OCCUPYPOINTS = 1;
export const OCCUPYENEMYLIMIT = 28;
export const OCCUPYNEUTRALLIMIT = 14;
export const SCORESECS = 10;
export const AMMOSECS = 15;
export const REGENSECS = 1;
export const REGENHEALTH = 10;
export const REGENARMOUR = 10;
export const REGENAMMO = 20;
export const MAXAMMO = 5;
export const REPAMMODIST = 32;
export const RESPAWNSECS = 5;
export const MAXBASES = 100;

export interface CaptureBase {
  tag: number;
  ammoType: number;
  owner: string;
  enemy: string;
  converted: number;
  ammo: number;
  o: Vec3;
  owners: number;
  enemies: number;
  captureTime: number;
}

export interface CapturePlayer {
  clientNumber: number;
  team: string;
  state: ClientState;
  position: Vec3;
  eyeHeight: number;
  health: number;
  maxHealth: number;
  armour: number;
  armourType: number;
  ammo: Int32Array;
}

export type LocalCaptureEvent = { type: "base"; base: CaptureBase; previousOwner: string } |
  { type: "score"; base: CaptureBase; team: string; total: number } |
  { type: "regen"; player: CapturePlayer; gun: Gun } |
  { type: "ammo"; base: CaptureBase } |
  { type: "victory"; team: string };

// Original: src/fpsgame/capture.h, captureclientmode and captureservmode.
// Network games only mirror the server state through initbase/updatebase. Local games call updateLocal() for the native authority step.
export class CaptureClientMode {
  readonly bases: CaptureBase[] = [];
  readonly scores = new Map<string, number>();
  private lastUpdateSecond = -1;
  private victoryTeam = "";

  reset(): void {
    this.bases.length = 0;
    this.scores.clear();
    this.lastUpdateSecond = -1;
    this.victoryTeam = "";
  }

  setup(entities: readonly { typeName: string; position: Vec3; attributes: readonly number[] }[], random: () => number = Math.random): void {
    const serverState = this.bases.map((base) => ({ ammoType: base.ammoType, owner: base.owner, enemy: base.enemy,
      converted: base.converted, ammo: base.ammo }));
    this.bases.length = 0;
    this.lastUpdateSecond = -1;
    this.victoryTeam = "";
    const uses = new Int32Array(Gun.Pistol);
    const groups = new Map<number, number>();
    for (const entity of entities) {
      if (entity.typeName !== "base" || this.bases.length >= MAXBASES) continue;
      const configured = entity.attributes[0] ?? 0, group = Math.min(configured, 0);
      let ammoType = configured > 0 ? configured : 0;
      if (group && groups.has(group)) ammoType = groups.get(group)!;
      else if (!ammoType) {
        const minimum = Math.min(...uses), available: number[] = [];
        for (let gun = Gun.Shotgun; gun <= Gun.Pistol; gun++) if (uses[gun - 1] === minimum) available.push(gun);
        ammoType = available[Math.min(available.length - 1, Math.floor(random() * available.length))];
        if (group) { groups.set(group, ammoType); uses[ammoType - 1]++; }
      }
      const index = this.bases.length, configuredTag = entity.attributes[1] ?? 0;
      const base = this.createBase(configuredTag > 0 ? configuredTag : index + 1, ammoType, entity.position);
      if (serverState[index]) Object.assign(base, serverState[index]);
      this.bases.push(base);
    }
  }

  initializeLocal(now = 0): void {
    this.scores.clear();
    this.lastUpdateSecond = Math.floor(now / 1000);
    this.victoryTeam = "";
    for (const base of this.bases) Object.assign(base, {
      owner: "", enemy: "", converted: 0, ammo: 0, owners: 0, enemies: 0, captureTime: -1,
    });
  }

  initbase(index: number, ammoType: number, owner: string, enemy: string, converted: number, ammo: number): void {
    while (this.bases.length <= index) this.bases.push(this.createBase(this.bases.length + 1, 0, { x: 0, y: 0, z: 0 }));
    Object.assign(this.bases[index], { ammoType, owner, enemy, converted, ammo });
  }

  updatebase(index: number, owner: string, enemy: string, converted: number, ammo: number): string | undefined {
    const base = this.bases[index];
    if (!base) return undefined;
    const previousOwner = base.owner;
    Object.assign(base, { owner, enemy, converted, ammo });
    return previousOwner;
  }

  setscore(team: string, total: number): void { this.scores.set(team, total); }

  hasbases(team: string): boolean { return this.bases.some((base) => base.owner === team); }

  insidebase(base: CaptureBase, position: Vec3): boolean {
    const dx = base.o.x - position.x, dy = base.o.y - position.y, dz = base.o.z - position.z;
    return dx * dx + dy * dy <= CAPTURERADIUS * CAPTURERADIUS && Math.abs(dz) <= CAPTUREHEIGHT;
  }

  updateLocal(players: Iterable<CapturePlayer>, regenCapture: boolean, now: number,
              announce?: (event: LocalCaptureEvent) => void): void {
    const currentSecond = Math.floor(now / 1000);
    if (this.lastUpdateSecond < 0) { this.lastUpdateSecond = currentSecond; return; }
    const ticks = currentSecond - this.lastUpdateSecond;
    if (ticks < 1 || this.victoryTeam) return;
    this.lastUpdateSecond = currentSecond;
    const active = [...players].filter((player) => player.state === ClientState.Alive && Boolean(player.team));
    for (const base of this.bases) this.updateOccupants(base, active);
    const allOwner = this.endcheck();
    if (allOwner) {
      this.scores.set(allOwner, 10_000);
      this.victoryTeam = allOwner;
      announce?.({ type: "victory", team: allOwner });
      return;
    }
    for (const base of this.bases) {
      if (!this.valid(base)) continue;
      if (base.enemy) {
        if (!base.owners || !base.enemies) {
          const units = OCCUPYBONUS * (base.enemies ? 1 : -1) +
            OCCUPYPOINTS * (base.enemies ? base.enemies : -(1 + base.owners)) * ticks;
          const previousOwner = base.owner;
          this.occupy(base, base.enemy, units);
          announce?.({ type: "base", base, previousOwner });
        }
      } else if (base.owner) {
        const previous = base.captureTime;
        base.captureTime += ticks;
        const score = Math.floor(base.captureTime / SCORESECS) - Math.floor(previous / SCORESECS);
        if (score) {
          const total = (this.scores.get(base.owner) ?? 0) + score;
          this.scores.set(base.owner, total);
          announce?.({ type: "score", base, team: base.owner, total });
        }
        if (regenCapture) {
          const regen = Math.floor(base.captureTime / REGENSECS) - Math.floor(previous / REGENSECS);
          if (regen) this.regenowners(base, active, regen, announce);
        } else {
          const ammo = Math.floor(base.captureTime / AMMOSECS) - Math.floor(previous / AMMOSECS);
          if (ammo && base.ammo < MAXAMMO) {
            base.ammo = Math.min(base.ammo + ammo, MAXAMMO);
            announce?.({ type: "ammo", base });
          }
        }
      }
    }
  }

  replenishammo(player: CapturePlayer): CaptureBase | undefined {
    if (player.state !== ClientState.Alive || !player.team) return undefined;
    const feet = this.feetpos(player);
    for (const base of this.bases) {
      if (!this.valid(base) || !this.insidebase(base, feet) || base.owner !== player.team || base.ammo <= 0) continue;
      const gun = base.ammoType as Gun, pickup = AMMO_PICKUPS[gun - Gun.Shotgun];
      if (!pickup || player.ammo[gun] >= pickup.max) continue;
      base.ammo--;
      player.ammo[gun] = Math.min(player.ammo[gun] + pickup.add, pickup.max);
      return base;
    }
    return undefined;
  }

  private createBase(tag: number, ammoType: number, o: Vec3): CaptureBase {
    return { tag, ammoType, owner: "", enemy: "", converted: 0, ammo: 0, o: { ...o }, owners: 0, enemies: 0, captureTime: -1 };
  }

  private valid(base: CaptureBase): boolean { return base.ammoType >= Gun.Shotgun && base.ammoType <= Gun.Pistol; }

  private feetpos(player: CapturePlayer): Vec3 { return { ...player.position, z: player.position.z - player.eyeHeight }; }

  private updateOccupants(base: CaptureBase, players: readonly CapturePlayer[]): void {
    const teams = new Map<string, number>();
    for (const player of players) {
      if (!this.insidebase(base, this.feetpos(player))) continue;
      teams.set(player.team, (teams.get(player.team) ?? 0) + 1);
    }
    base.owners = base.owner ? teams.get(base.owner) ?? 0 : 0;
    const currentEnemies = base.enemy && base.enemy !== base.owner ? teams.get(base.enemy) ?? 0 : 0;
    if (currentEnemies > 0) base.enemies = currentEnemies;
    else {
      const attacker = [...teams.keys()].find((team) => team !== base.owner && team !== base.enemy);
      if (attacker) {
        if (base.enemy !== attacker) base.converted = 0;
        base.enemy = attacker;
        base.enemies = teams.get(attacker) ?? 0;
      } else base.enemies = currentEnemies;
    }
  }

  private occupy(base: CaptureBase, team: string, units: number): number {
    if (base.enemy !== team) return -1;
    base.converted += units;
    if (units < 0) {
      if (base.converted <= 0) this.noenemy(base);
      return -1;
    }
    if (base.converted < (base.owner ? OCCUPYENEMYLIMIT : OCCUPYNEUTRALLIMIT)) return -1;
    if (base.owner) {
      base.owner = "";
      base.converted = 0;
      base.enemy = team;
      return 0;
    }
    base.owner = team;
    base.ammo = 0;
    base.captureTime = 0;
    base.owners = base.enemies;
    this.noenemy(base);
    return 1;
  }

  private noenemy(base: CaptureBase): void { Object.assign(base, { enemy: "", enemies: 0, converted: 0 }); }

  private regenowners(base: CaptureBase, players: readonly CapturePlayer[], ticks: number,
                      announce?: (event: LocalCaptureEvent) => void): void {
    const gun = base.ammoType as Gun, pickup = AMMO_PICKUPS[gun - Gun.Shotgun];
    for (const player of players) {
      if (player.team !== base.owner || !this.insidebase(base, this.feetpos(player))) continue;
      let changed = false;
      if (player.health < player.maxHealth) { player.health = Math.min(player.health + ticks * REGENHEALTH, player.maxHealth); changed = true; }
      if (player.armourType !== 1 || player.armour < 100) {
        if (player.armourType !== 1) { player.armourType = 1; player.armour = 0; }
        player.armour = Math.min(player.armour + ticks * REGENARMOUR, 100);
        changed = true;
      }
      if (pickup && player.ammo[gun] < pickup.max) {
        player.ammo[gun] = Math.min(player.ammo[gun] + Math.floor(pickup.add * ticks * REGENAMMO / 100), pickup.max);
        changed = true;
      }
      if (changed) announce?.({ type: "regen", player, gun });
    }
  }

  private endcheck(): string {
    let team = "";
    for (const base of this.bases) {
      if (!this.valid(base) || !base.owner) return "";
      if (!team) team = base.owner;
      else if (team !== base.owner) return "";
    }
    return team;
  }
}
