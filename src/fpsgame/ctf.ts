import type { Vec3 } from "../engine/octa";
import { PacketReader, PacketWriter } from "../network/protocol";
import { ClientState } from "../engine/physics/types";
import { DMF, GameModeFlag, gameModeHas, NetworkMessage } from "./game";
import type { NetworkPlayer } from "./client";

export const CTFFLAGRADIUS = 16;

export interface CtfFlag {
  id: number;
  version: number;
  spawnIndex: number;
  spawnLoc: Vec3;
  dropLoc: Vec3;
  team: number;
  owner: number;
  dropped: boolean;
  invisible: boolean;
  pickup: boolean;
  yaw: number;
}

// Original: src/fpsgame/ctf.h, ctfclientmode.
// The server remains authoritative; this class mirrors its flag versions, owners and scores.
export class CtfClientMode {
  readonly flags: CtfFlag[] = [];
  readonly scores = [0, 0];
  private holdSpawns: Vec3[] = [];

  reset(): void {
    this.flags.length = 0;
    this.holdSpawns = [];
    this.scores.fill(0);
  }

  setup(entities: readonly { typeName: string; position: Vec3; attributes: readonly number[] }[], mode: number): void {
    const serverState = this.flags.map((flag) => ({ ...flag, spawnLoc: { ...flag.spawnLoc }, dropLoc: { ...flag.dropLoc } }));
    this.flags.length = 0;
    this.holdSpawns = [];
    if (gameModeHas(mode, GameModeFlag.Hold)) {
      this.holdSpawns = entities.filter((entity) => entity.typeName === "base").map((entity) => ({ ...entity.position }));
      if (this.holdSpawns.length) this.flags.push(this.createFlag(0, { x: 0, y: 0, z: 0 }, 0, 0));
    } else {
      for (const entity of entities) {
        const team = entity.attributes[1] ?? 0;
        if (entity.typeName === "flag" && team >= 1 && team <= 2) {
          this.flags.push(this.createFlag(this.flags.length, entity.position, team, entity.attributes[0] ?? 0));
        }
      }
    }
    for (const flag of this.flags) {
      const state = serverState[flag.id];
      if (!state) continue;
      const mapTeam = flag.team, mapYaw = flag.yaw;
      const spawnLoc = gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[state.spawnIndex]
        ? { ...this.holdSpawns[state.spawnIndex] } : flag.spawnLoc;
      Object.assign(flag, state, { spawnLoc, team: gameModeHas(mode, GameModeFlag.Hold) ? state.team : mapTeam,
        yaw: gameModeHas(mode, GameModeFlag.Hold) ? state.yaw : mapYaw });
    }
  }

  putInitFlags(packet: PacketWriter, mode: number): void {
    packet.putInt(NetworkMessage.InitFlags);
    if (gameModeHas(mode, GameModeFlag.Hold)) {
      packet.putInt(this.holdSpawns.length);
      for (const spawn of this.holdSpawns) this.putFlagEntity(packet, -1, spawn);
    } else {
      packet.putInt(this.flags.length);
      for (const flag of this.flags) this.putFlagEntity(packet, flag.team, flag.spawnLoc);
    }
  }

  parseInitFlags(packet: PacketReader, mode: number): void {
    this.scores[0] = packet.getInt();
    this.scores[1] = packet.getInt();
    const count = packet.getInt();
    for (let id = 0; id < count; id++) {
      const version = packet.getInt(), spawnIndex = packet.getInt(), owner = packet.getInt(), invisible = packet.getInt() > 0;
      let dropped = false, dropLoc = { x: 0, y: 0, z: 0 };
      if (owner < 0) {
        dropped = packet.getInt() > 0;
        if (dropped) dropLoc = this.getPosition(packet);
      }
      let holdTeam = -1;
      if (gameModeHas(mode, GameModeFlag.Hold)) {
        holdTeam = packet.getInt();
        if (holdTeam >= 0) packet.getInt();
      }
      const flag = this.flags[id] ?? this.createFlag(id, { x: 0, y: 0, z: 0 }, holdTeam > 0 ? holdTeam : 0, 0);
      if (!this.flags[id]) this.flags[id] = flag;
      Object.assign(flag, { version, spawnIndex, owner, invisible, dropped, dropLoc, pickup: false });
      if (holdTeam >= 0) flag.team = holdTeam;
      if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[spawnIndex]) flag.spawnLoc = { ...this.holdSpawns[spawnIndex] };
    }
  }

  dropFlag(id: number, version: number, dropLoc: Vec3, yaw: number): void {
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, owner: -1, dropped: true, dropLoc: { ...dropLoc }, yaw, invisible: false, pickup: false });
  }

  takeFlag(clientNumber: number, id: number, version: number): void {
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, owner: clientNumber, dropped: false, invisible: false, pickup: false });
  }

  returnFlag(id: number, version: number): void {
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, owner: -1, dropped: false, invisible: false, pickup: false });
  }

  resetFlag(id: number, version: number, spawnIndex: number, team: number, score: number, mode: number): void {
    if (team >= 1 && team <= 2) this.scores[team - 1] = score;
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, spawnIndex, owner: -1, dropped: false, invisible: false, pickup: false });
    if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[spawnIndex]) flag.spawnLoc = { ...this.holdSpawns[spawnIndex] };
  }

  scoreFlag(player: NetworkPlayer, relay: number, relayVersion: number, goal: number, goalVersion: number, goalSpawn: number,
            team: number, score: number, flags: number, mode: number): void {
    if (team >= 1 && team <= 2) this.scores[team - 1] = score;
    if (relay >= 0 && this.flags[relay]) this.flags[relay].version = relayVersion;
    const target = this.flags[relay >= 0 ? relay : goal];
    if (target) Object.assign(target, { owner: -1, dropped: false, invisible: false, pickup: false });
    const goalFlag = this.flags[goal];
    if (goalFlag) {
      goalFlag.version = goalVersion;
      goalFlag.spawnIndex = goalSpawn;
      if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[goalSpawn]) goalFlag.spawnLoc = { ...this.holdSpawns[goalSpawn] };
    }
    player.flags = flags;
  }

  setInvisible(id: number, invisible: boolean): void {
    const flag = this.flags[id];
    if (flag) flag.invisible = invisible;
  }

  checkItems(player: NetworkPlayer | undefined, feet: Vec3, mode: number, take: (id: number, version: number) => void): void {
    if (!player || player.state !== ClientState.Alive) return;
    const playerTeam = ctfTeamFlag(player.team);
    let tookFlag = false;
    for (const flag of this.flags) {
      const available = gameModeHas(mode, GameModeFlag.Hold) ? flag.spawnIndex >= 0 : flag.team > 0 && flag.team !== playerTeam;
      if (!available || flag.owner >= 0 || flag.invisible) continue;
      const location = flag.dropped ? flag.dropLoc : flag.spawnLoc;
      if (distance(feet, location) < CTFFLAGRADIUS) {
        if (!flag.pickup) { take(flag.id, flag.version); tookFlag = true; }
        flag.pickup = true;
      } else flag.pickup = false;
    }
    if (gameModeHas(mode, GameModeFlag.Hold)) return;
    for (const flag of this.flags) {
      if (flag.team !== playerTeam || flag.owner >= 0 || flag.invisible) continue;
      const location = flag.dropped ? flag.dropLoc : flag.spawnLoc;
      if (distance(feet, location) < CTFFLAGRADIUS) {
        if (tookFlag || !flag.pickup) take(flag.id, flag.version);
        flag.pickup = true;
      } else flag.pickup = false;
    }
  }

  private createFlag(id: number, spawnLoc: Vec3, team: number, yaw: number): CtfFlag {
    return { id, version: 0, spawnIndex: -1, spawnLoc: { ...spawnLoc }, dropLoc: { ...spawnLoc }, team, owner: -1, dropped: false,
      invisible: false, pickup: false, yaw };
  }

  private putFlagEntity(packet: PacketWriter, team: number, position: Vec3): void {
    packet.putInt(team).putInt(Math.trunc(position.x * DMF)).putInt(Math.trunc(position.y * DMF)).putInt(Math.trunc(position.z * DMF));
  }

  private getPosition(packet: PacketReader): Vec3 {
    return { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
  }
}

export function ctfTeamFlag(team: string): number {
  return team === "good" ? 1 : team === "evil" ? 2 : 0;
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}
