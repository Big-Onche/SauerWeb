import type { Vec3 } from "../engine/octa";
import { PacketReader, PacketWriter } from "../network/protocol";
import { ClientState } from "../engine/physics/types";
import { DMF, GameModeFlag, gameModeHas, NetworkMessage } from "./game";
import type { NetworkPlayer } from "./client";

export const CTFFLAGRADIUS = 16;
export const CTFBASERADIUS = 64;
export const CTFBASEHEIGHT = 24;
export const CTFFLAGLIMIT = 10;
export const CTFMAXFLAGS = 20;
export const CTFMAXHOLDSPAWNS = 100;
export const CTFHOLDSECONDS = 20;
export const CTFHOLDDEATHPENALTY = 5_000;
export const CTFRESETFLAGTIME = 10_000;
export const CTFINVISFLAGTIME = 20_000;
export const CTFRESPAWNSECONDS = 5;

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
  dropTime: number;
  ownTime: number;
  holdTime: number;
  invisibleTime: number;
  dropCount: number;
  dropper: number;
}

type LocalCtfPlayer = Pick<NetworkPlayer, "clientNumber" | "team" | "state" | "flags">;
export type LocalCtfEvent = { type: "drop" | "return" | "reset" | "score"; flag: CtfFlag } |
  { type: "take"; flag: CtfFlag; wasDropped: boolean };

// Original: src/fpsgame/ctf.h, ctfclientmode.
// The server remains authoritative; this class mirrors its flag versions, owners and scores.
export class CtfClientMode {
  readonly flags: CtfFlag[] = [];
  readonly scores = [0, 0];
  private holdSpawns: Vec3[] = [];

  get holdSpawnLocations(): readonly Vec3[] { return this.holdSpawns; }

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
      this.holdSpawns = entities.filter((entity) => entity.typeName === "base").slice(0, CTFMAXHOLDSPAWNS)
        .map((entity) => ({ ...entity.position }));
      if (this.holdSpawns.length) this.flags.push(this.createFlag(0, { x: 0, y: 0, z: 0 }, 0, 0));
    } else {
      for (const entity of entities) {
        const team = entity.attributes[1] ?? 0;
        if (entity.typeName === "flag" && team >= 1 && team <= 2) {
          if (this.flags.length < CTFMAXFLAGS) this.flags.push(this.createFlag(this.flags.length, entity.position, team,
            entity.attributes[0] ?? 0));
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

  parseInitFlags(packet: PacketReader, mode: number, now = performance.now()): void {
    const scores = [packet.getInt(), packet.getInt()], commit = gameModeHas(mode, GameModeFlag.Ctf);
    if (commit) { this.scores[0] = scores[0]; this.scores[1] = scores[1]; }
    const count = packet.getInt();
    for (let id = 0; id < count; id++) {
      const version = packet.getInt(), spawnIndex = packet.getInt(), owner = packet.getInt(), invisible = packet.getInt() > 0;
      let dropped = false, dropLoc = { x: 0, y: 0, z: 0 };
      if (owner < 0) {
        dropped = packet.getInt() > 0;
        if (dropped) dropLoc = this.getPosition(packet);
      }
      let holdTeam = -1, holdTime = 0;
      if (gameModeHas(mode, GameModeFlag.Hold)) {
        holdTeam = packet.getInt();
        if (holdTeam >= 0) holdTime = packet.getInt() * 100;
      }
      if (!commit) continue;
      const flag = this.flags[id] ?? this.createFlag(id, { x: 0, y: 0, z: 0 }, holdTeam > 0 ? holdTeam : 0, 0);
      if (!this.flags[id]) this.flags[id] = flag;
      Object.assign(flag, { version, spawnIndex, owner, invisible, dropped, dropLoc, pickup: false,
        dropTime: dropped ? now : 0, ownTime: owner >= 0 ? now - holdTime : 0, invisibleTime: invisible ? now : 0 });
      if (holdTeam >= 0) Object.assign(flag, { team: holdTeam, holdTime: now - holdTime });
      else if (gameModeHas(mode, GameModeFlag.Hold)) Object.assign(flag, { team: 0, holdTime: 0 });
      if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[spawnIndex]) flag.spawnLoc = { ...this.holdSpawns[spawnIndex] };
    }
  }

  dropFlag(id: number, version: number, dropLoc: Vec3, yaw: number, now = performance.now()): void {
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, owner: -1, dropped: true, dropLoc: { ...dropLoc }, yaw, invisible: false, pickup: false,
      dropTime: now, ownTime: 0, invisibleTime: 0 });
  }

  takeFlag(clientNumber: number, id: number, version: number, mode = 0, team = -1, now = performance.now()): void {
    const flag = this.flags[id];
    if (!flag) return;
    const transitionTime = flag.invisible ? now : flag.invisibleTime;
    this.ownFlag(flag, clientNumber, now, gameModeHas(mode, GameModeFlag.Hold) ? team : -1);
    Object.assign(flag, { version, invisible: false, pickup: false, invisibleTime: transitionTime });
  }

  returnFlag(id: number, version: number): void {
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, owner: -1, dropped: false, invisible: false, pickup: false, dropTime: 0, ownTime: 0, holdTime: 0,
      invisibleTime: 0, dropCount: 0, dropper: -1 });
  }

  resetFlag(id: number, version: number, spawnIndex: number, team: number, score: number, mode: number, now = performance.now()): void {
    if (team >= 1 && team <= 2) this.scores[team - 1] = score;
    const flag = this.flags[id];
    if (!flag) return;
    Object.assign(flag, { version, spawnIndex, owner: -1, dropped: false, invisible: gameModeHas(mode, GameModeFlag.Protect), pickup: false,
      dropTime: 0, ownTime: 0, holdTime: 0, invisibleTime: gameModeHas(mode, GameModeFlag.Protect) ? now : 0 });
    flag.dropCount = 0;
    flag.dropper = -1;
    if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[spawnIndex]) flag.spawnLoc = { ...this.holdSpawns[spawnIndex] };
  }

  scoreFlag(player: NetworkPlayer, relay: number, relayVersion: number, goal: number, goalVersion: number, goalSpawn: number,
            team: number, score: number, flags: number, mode: number, now = performance.now()): void {
    if (team >= 1 && team <= 2) this.scores[team - 1] = score;
    if (relay >= 0 && this.flags[relay]) this.flags[relay].version = relayVersion;
    const target = this.flags[relay >= 0 ? relay : goal];
    if (target) Object.assign(target, { owner: -1, dropped: false, invisible: gameModeHas(mode, GameModeFlag.Protect), pickup: false,
      dropTime: 0, ownTime: 0, holdTime: 0, invisibleTime: gameModeHas(mode, GameModeFlag.Protect) ? now : 0, dropCount: 0,
      dropper: -1 });
    const goalFlag = this.flags[goal];
    if (goalFlag) {
      Object.assign(goalFlag, { version: goalVersion, spawnIndex: goalSpawn, dropTime: 0, ownTime: 0, holdTime: 0 });
      if (gameModeHas(mode, GameModeFlag.Hold) && this.holdSpawns[goalSpawn]) goalFlag.spawnLoc = { ...this.holdSpawns[goalSpawn] };
    }
    player.flags = flags;
  }

  setInvisible(id: number, invisible: boolean, now = performance.now()): void {
    const flag = this.flags[id];
    if (flag) Object.assign(flag, { invisible, invisibleTime: now });
  }

  groundDroppedFlags(ground: (position: Vec3) => Vec3): void {
    for (const flag of this.flags) if (flag.dropped) flag.dropLoc = ground(flag.dropLoc);
  }

  initializeLocal(mode: number, now = performance.now(), random: () => number = Math.random): void {
    this.scores.fill(0);
    for (const flag of this.flags) {
      Object.assign(flag, { version: 0, owner: -1, dropped: false, invisible: gameModeHas(mode, GameModeFlag.Protect), pickup: false,
        dropTime: 0, ownTime: 0, holdTime: 0, invisibleTime: gameModeHas(mode, GameModeFlag.Protect) ? now : 0, dropCount: 0,
        dropper: -1 });
      if (gameModeHas(mode, GameModeFlag.Hold)) {
        flag.team = 0;
        this.spawnFlag(flag, random);
      }
    }
  }

  // Original: src/fpsgame/ctf.h, ctfservmode::takeflag() / scoreflag().
  // Remote games receive these transitions from the server; a vanilla-style local match performs the same authority step in process.
  takeFlagLocal(player: LocalCtfPlayer, id: number, version: number, mode: number,
                announce?: (event: LocalCtfEvent) => void, now = performance.now(), random: () => number = Math.random): boolean {
    const flag = this.flags[id];
    if (!flag || player.state !== ClientState.Alive || !player.team || flag.owner >= 0 || flag.version !== version ||
        flag.dropped && flag.dropper === player.clientNumber && flag.dropCount >= 3 ||
        (gameModeHas(mode, GameModeFlag.Hold) ? flag.spawnIndex < 0 : flag.team < 1 || flag.team > 2)) return false;
    const team = ctfTeamFlag(player.team), hold = gameModeHas(mode, GameModeFlag.Hold), protect = gameModeHas(mode, GameModeFlag.Protect);
    if (hold || protect === (flag.team === team)) {
      if (this.flags.some((candidate) => candidate.owner === player.clientNumber)) return false;
      const wasDropped = flag.dropped;
      const transitionTime = flag.invisible ? now : flag.invisibleTime;
      this.ownFlag(flag, player.clientNumber, now, hold ? team : -1);
      Object.assign(flag, { version: flag.version + 1, invisible: false, pickup: false, invisibleTime: transitionTime });
      announce?.({ type: "take", flag, wasDropped });
      return true;
    }
    if (protect) {
      if (flag.invisible) return false;
      this.scoreFlagLocal(player, flag, team, mode, now, random);
      announce?.({ type: "score", flag });
      return true;
    }
    if (flag.dropped) {
      flag.version++;
      Object.assign(flag, { owner: -1, dropped: false, invisible: false, pickup: false, dropTime: 0, ownTime: 0, holdTime: 0,
        invisibleTime: 0, dropCount: 0, dropper: -1 });
      announce?.({ type: "return", flag });
      return true;
    }
    const relay = this.flags.find((candidate) => candidate.owner === player.clientNumber);
    if (!relay) return false;
    this.scoreFlagLocal(player, relay, team, mode, now, random);
    announce?.({ type: "score", flag: relay });
    return true;
  }

  // Original: src/fpsgame/ctf.h, ctfservmode::dropflag().
  dropFlags(clientNumber: number, location: Vec3, yaw: number, mode = 0, announce?: (event: LocalCtfEvent) => void,
            now = performance.now(), death = false, dropper = clientNumber, penalty = false): boolean {
    let dropped = false;
    for (const flag of this.flags) {
      if (flag.owner !== clientNumber) continue;
      if (death && gameModeHas(mode, GameModeFlag.Hold)) this.deadFlag(flag, now);
      if (gameModeHas(mode, GameModeFlag.Protect) && this.insideBase(flag, location)) {
        Object.assign(flag, { version: flag.version + 1, owner: -1, dropped: false, invisible: false, pickup: false, dropTime: 0,
          ownTime: 0, holdTime: 0, invisibleTime: 0, dropCount: 0, dropper: -1 });
        announce?.({ type: "return", flag });
        dropped = true;
        continue;
      }
      Object.assign(flag, { version: flag.version + 1, owner: -1, dropped: true, dropLoc: { ...location }, yaw, invisible: false,
        pickup: false, dropTime: now, ownTime: 0, invisibleTime: 0, dropper, dropCount: penalty ? Number.MAX_SAFE_INTEGER : flag.dropCount });
      announce?.({ type: "drop", flag });
      dropped = true;
    }
    return dropped;
  }

  updateLocal(players: ReadonlyMap<number, LocalCtfPlayer>, mode: number, now = performance.now(), random: () => number = Math.random,
              announce?: (player: LocalCtfPlayer | undefined, event: LocalCtfEvent) => void): void {
    for (const flag of this.flags) {
      if (flag.owner < 0 && flag.dropped && now - flag.dropTime >= CTFRESETFLAGTIME) {
        const team = flag.team;
        Object.assign(flag, { version: flag.version + 1, owner: -1, dropped: false, pickup: false, dropTime: 0, ownTime: 0, holdTime: 0,
          dropCount: 0, dropper: -1 });
        if (gameModeHas(mode, GameModeFlag.Hold)) { flag.team = 0; this.spawnFlag(flag, random); }
        if (gameModeHas(mode, GameModeFlag.Protect)) {
          flag.invisible = true;
          flag.invisibleTime = now;
          if (team >= 1 && team <= 2) this.scores[team - 1]--;
        }
        announce?.(undefined, { type: "reset", flag });
      }
      if (flag.invisible && now - flag.invisibleTime >= CTFINVISFLAGTIME) Object.assign(flag, { invisible: false, invisibleTime: now });
      if (!gameModeHas(mode, GameModeFlag.Hold) || flag.owner < 0 || !flag.holdTime || now - flag.holdTime < CTFHOLDSECONDS * 1000) continue;
      const player = players.get(flag.owner);
      if (player) {
        this.scoreFlagLocal(player, flag, ctfTeamFlag(player.team), mode, now, random);
        announce?.(player, { type: "score", flag });
      } else {
        Object.assign(flag, { version: flag.version + 1, owner: -1, dropped: false, team: 0, pickup: false, dropTime: 0, ownTime: 0,
          holdTime: 0 });
        this.spawnFlag(flag, random);
      }
    }
  }

  holdSecondsRemaining(clientNumber: number, now = performance.now()): number | undefined {
    const flag = this.flags.find((candidate) => candidate.owner === clientNumber && candidate.holdTime > 0);
    return flag ? Math.max(CTFHOLDSECONDS - Math.trunc(this.holdCounter(flag, now) / 1000), 0) : undefined;
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
      invisible: false, pickup: false, yaw, dropTime: 0, ownTime: 0, holdTime: 0, invisibleTime: 0, dropCount: 0, dropper: -1 };
  }

  private scoreFlagLocal(player: LocalCtfPlayer, flag: CtfFlag, team: number, mode: number, now: number, random: () => number): void {
    Object.assign(flag, { version: flag.version + 1, owner: -1, dropped: false, invisible: gameModeHas(mode, GameModeFlag.Protect),
      pickup: false, dropTime: 0, ownTime: 0, holdTime: 0, invisibleTime: gameModeHas(mode, GameModeFlag.Protect) ? now : 0,
      dropCount: 0, dropper: -1 });
    player.flags++;
    if (team >= 1 && team <= 2) this.scores[team - 1]++;
    if (gameModeHas(mode, GameModeFlag.Hold)) { flag.team = 0; this.spawnFlag(flag, random); }
  }

  private ownFlag(flag: CtfFlag, owner: number, now: number, ownTeam: number): void {
    flag.dropCount = owner === flag.dropper ? Math.min(flag.dropCount + 1, Number.MAX_SAFE_INTEGER) : 0;
    flag.dropper = -1;
    flag.owner = owner;
    flag.ownTime = now;
    if (flag.holdTime && flag.team === ownTeam) {
      if (flag.dropTime && flag.dropTime < now) flag.holdTime += 2 * (now - flag.dropTime);
      flag.holdTime = Math.min(flag.holdTime, now);
    } else {
      flag.holdTime = now;
      if (ownTeam >= 0) flag.team = ownTeam;
    }
    flag.dropped = false;
    flag.dropTime = 0;
  }

  private deadFlag(flag: CtfFlag, now: number): void {
    if (!flag.holdTime) return;
    const limit = flag.owner < 0 && flag.dropTime >= flag.holdTime ? flag.dropTime : now;
    flag.holdTime += CTFHOLDDEATHPENALTY;
    if (flag.holdTime >= limit) flag.holdTime = 0;
  }

  private holdCounter(flag: CtfFlag, now: number): number {
    if (!flag.holdTime) return 0;
    if (flag.owner < 0 && flag.dropTime >= flag.holdTime) return Math.max((flag.dropTime - flag.holdTime) - (now - flag.dropTime), 0);
    return now - flag.holdTime;
  }

  private spawnFlag(flag: CtfFlag, random: () => number): void {
    if (!this.holdSpawns.length) return;
    let spawnIndex = flag.spawnIndex;
    for (let attempt = 0; attempt < 4; attempt++) {
      spawnIndex = Math.floor(random() * this.holdSpawns.length);
      if (spawnIndex !== flag.spawnIndex) break;
    }
    flag.spawnIndex = spawnIndex;
    flag.spawnLoc = { ...this.holdSpawns[spawnIndex] };
  }

  private insideBase(flag: CtfFlag, position: Vec3): boolean {
    const x = flag.spawnLoc.x - position.x, y = flag.spawnLoc.y - position.y, z = flag.spawnLoc.z - position.z;
    return x * x + y * y <= CTFBASERADIUS * CTFBASERADIUS && Math.abs(z) <= CTFBASEHEIGHT;
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
