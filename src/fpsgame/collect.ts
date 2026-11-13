import { ClientState } from "../engine/physics/types";
import type { Vec3 } from "../engine/octa";
import { DMF } from "./game";
import type { NetworkPlayer } from "./client";
import { PacketReader, PacketWriter } from "../network/protocol";

// Original: src/fpsgame/collect.h, collectclientmode / collectservmode.
export const COLLECT_BASE_RADIUS = 16;
export const COLLECT_BASE_HEIGHT = 16;
export const COLLECT_MAX_BASES = 20;
export const COLLECT_TOKEN_RADIUS = 16;
export const COLLECT_TOKEN_LIMIT = 5;
export const COLLECT_UNOWNED_TOKEN_LIMIT = 15;
export const COLLECT_TOKEN_DISTANCE = 16;
export const COLLECT_SCORE_LIMIT = 50;
export const COLLECT_RESPAWN_SECONDS = 5;
export const COLLECT_EXPIRE_TOKEN_TIME = 10_000;
export const COLLECT_STEAL_TOKEN_TIME = 5_000;

export interface CollectBase {
  id: number;
  team: number;
  o: Vec3;
  tokenPos: Vec3;
  lastSteal: number;
}

export interface CollectToken {
  id: number;
  team: number;
  o: Vec3;
  yaw: number;
  dropTime: number;
  dropper: number;
}

export type CollectLocalEvent =
  | { type: "take"; player: NetworkPlayer; token: CollectToken; friendly: boolean }
  | { type: "expire"; token: CollectToken }
  | { type: "drop"; player: NetworkPlayer; tokens: CollectToken[] }
  | { type: "deposit"; player: NetworkPlayer; base: CollectBase; deposited: number; team: number; score: number }
  | { type: "steal"; player: NetworkPlayer; base: CollectBase; token: CollectToken; enemyTeam: number; score: number };

export interface CollectCheckCallbacks {
  takeToken: (id: number) => void;
  depositTokens: (base: number) => void;
  lookupMaterial?: (position: Vec3) => number;
  gameClipMask?: number;
  gameClipValue?: number;
}

export class CollectClientMode {
  readonly bases: CollectBase[] = [];
  readonly tokens: CollectToken[] = [];
  readonly scores = [0, 0];
  private readonly lastCollect = new Map<number, Vec3>();
  private nextToken = 0;

  constructor(private readonly moveToken: (origin: Vec3, yaw: number) => Vec3 | undefined = defaultMoveToken) {}

  reset(): void {
    this.bases.length = 0;
    this.tokens.length = 0;
    this.scores.fill(0);
    this.lastCollect.clear();
    this.nextToken = 0;
  }

  setup(entities: readonly { typeName: string; position: Vec3; attributes: readonly number[] }[]): void {
    const scores = [...this.scores], tokens = this.tokens.map((token) => ({ ...token, o: { ...token.o } }));
    this.bases.length = 0;
    for (const entity of entities) {
      const team = entity.attributes[1] ?? 0;
      if (entity.typeName !== "flag" || team < 1 || team > 2 || this.bases.length >= COLLECT_MAX_BASES) continue;
      this.addBase(this.bases.length, entity.position, team);
    }
    this.scores[0] = scores[0];
    this.scores[1] = scores[1];
    this.tokens.splice(0, this.tokens.length, ...tokens);
  }

  addBase(id: number, position: Vec3, team: number): boolean {
    if (id < 0 || id >= COLLECT_MAX_BASES) return false;
    const base = { id, team, o: { ...position }, tokenPos: { ...position, z: position.z + 3 }, lastSteal: 0 };
    this.bases[id] = base;
    return true;
  }

  putInitTokens(packet: PacketWriter): void {
    packet.putInt(this.bases.length);
    for (const base of this.bases) {
      packet.putInt(base.team).putInt(Math.trunc(base.o.x * DMF)).putInt(Math.trunc(base.o.y * DMF)).putInt(Math.trunc(base.o.z * DMF));
    }
  }

  parseInitTokens(packet: PacketReader, now: number): Array<{ clientNumber: number; tokens: number }> {
    this.scores[0] = packet.getInt();
    this.scores[1] = packet.getInt();
    this.tokens.length = 0;
    const count = packet.getInt();
    for (let index = 0; index < count; index++) {
      const id = packet.getInt(), team = packet.getInt(), yaw = packet.getInt();
      const origin = readPosition(packet);
      this.dropToken(id, origin, team, yaw, now, Number.MIN_SAFE_INTEGER);
    }
    const carried: Array<{ clientNumber: number; tokens: number }> = [];
    for (let clientNumber = packet.getInt(); clientNumber >= 0; clientNumber = packet.getInt()) {
      carried.push({ clientNumber, tokens: packet.getInt() });
    }
    return carried;
  }

  findToken(id: number): CollectToken | undefined { return this.tokens.find((token) => token.id === id); }

  removeToken(id: number): CollectToken | undefined {
    const index = this.tokens.findIndex((token) => token.id === id);
    return index < 0 ? undefined : this.tokens.splice(index, 1)[0];
  }

  dropToken(id: number, origin: Vec3, team: number, yaw: number, now: number, dropper = Number.MIN_SAFE_INTEGER): CollectToken | undefined {
    const position = this.moveToken(origin, yaw);
    if (!position || position.z < 0) return undefined;
    const token = { id, team, o: position, yaw, dropTime: now, dropper };
    this.tokens.push(token);
    return token;
  }

  expireToken(id: number): CollectToken | undefined { return this.removeToken(id); }

  takeToken(player: NetworkPlayer, id: number, total: number): { token?: CollectToken; friendly: boolean } {
    const token = this.removeToken(id), team = collectTeamBase(player.team);
    player.tokens = total;
    return { token, friendly: Boolean(token && (token.team === team || token.team < 0 && -token.team !== team)) };
  }

  depositTokens(player: NetworkPlayer, baseNumber: number, _deposited: number, team: number, score: number, flags: number, now: number): void {
    const base = this.bases[baseNumber];
    if (base) base.lastSteal = now;
    player.tokens = 0;
    player.flags = flags;
    this.setScore(team, score);
  }

  stealToken(_player: NetworkPlayer, id: number, origin: Vec3, team: number, yaw: number, index: number, baseNumber: number,
             enemyTeam: number, score: number, now: number): CollectToken | undefined {
    if (!index) {
      this.setScore(enemyTeam, score);
      const base = this.bases[baseNumber];
      if (base) base.lastSteal = now;
    }
    return this.dropToken(id, origin, team, yaw, now, -1 - baseNumber);
  }

  checkItems(player: NetworkPlayer, feet: Vec3, callbacks: CollectCheckCallbacks): void {
    if (player.state !== ClientState.Alive) return;
    const previous = this.lastCollect.get(player.clientNumber) ?? { x: -1e10, y: -1e10, z: -1e10 };
    if (player.tokens > 0 || !samePosition(feet, previous)) {
      const team = collectTeamBase(player.team);
      for (const base of this.bases) {
        if (!collectBaseTeam(base.team) || base.team === team || !this.insideBase(base, feet)) continue;
        if (player.tokens > 0 || !this.insideBase(base, previous)) {
          callbacks.depositTokens(base.id);
          player.tokens = 0;
        }
      }
    }
    if (player.tokens < COLLECT_TOKEN_LIMIT) {
      for (const token of this.tokens) {
        if (distance(feet, token.o) >= COLLECT_TOKEN_RADIUS || distance(previous, token.o) < COLLECT_TOKEN_RADIUS) continue;
        if (callbacks.lookupMaterial && callbacks.gameClipMask !== undefined && callbacks.gameClipValue !== undefined &&
            (callbacks.lookupMaterial(feet) & callbacks.gameClipMask) === callbacks.gameClipValue) continue;
        if (callbacks.lookupMaterial && callbacks.gameClipMask !== undefined && callbacks.gameClipValue !== undefined &&
            (callbacks.lookupMaterial(token.o) & callbacks.gameClipMask) === callbacks.gameClipValue) continue;
        callbacks.takeToken(token.id);
      }
    }
    this.lastCollect.set(player.clientNumber, { ...feet });
  }

  insideBase(base: CollectBase, position: Vec3): boolean {
    const dx = base.o.x - position.x, dy = base.o.y - position.y, dz = base.o.z - position.z;
    return dx * dx + dy * dy <= COLLECT_BASE_RADIUS * COLLECT_BASE_RADIUS && Math.abs(dz) <= COLLECT_BASE_HEIGHT;
  }

  totalScore(team: number): number { return team >= 1 && team <= 2 ? this.scores[team - 1] : 0; }

  setScore(team: number, score: number): number {
    if (team >= 1 && team <= 2) this.scores[team - 1] = score;
    return team >= 1 && team <= 2 ? this.scores[team - 1] : 0;
  }

  updateLocal(now: number, announce?: (event: CollectLocalEvent) => void): void {
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      if (now - this.tokens[index].dropTime < COLLECT_EXPIRE_TOKEN_TIME) continue;
      const [token] = this.tokens.splice(index, 1);
      announce?.({ type: "expire", token });
    }
  }

  dropTokensLocal(player: NetworkPlayer, origin: Vec3, penalty: boolean, now: number, random: () => number = Math.random,
                  announce?: (event: CollectLocalEvent) => void): CollectToken[] {
    const team = collectTeamBase(player.team);
    let totalEnemy = penalty ? 0 : player.tokens, totalFriendly = 1;
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index];
      if (token.dropper !== player.clientNumber) continue;
      const exceeds = token.team === team ? ++totalFriendly > COLLECT_TOKEN_LIMIT : ++totalEnemy > COLLECT_TOKEN_LIMIT;
      if (!exceeds) continue;
      this.tokens.splice(index, 1);
      announce?.({ type: "expire", token });
    }
    const count = 1 + (penalty ? 0 : player.tokens), yaw = Math.floor(random() * 360), dropped: CollectToken[] = [];
    for (let index = 0; index < count; index++) {
      const id = this.allocateTokenId();
      const token = this.dropToken(id, origin, index ? -team : team, yaw + index * 360 / count, now, player.clientNumber);
      if (token) dropped.push(token);
    }
    player.tokens = 0;
    announce?.({ type: "drop", player, tokens: dropped });
    return dropped;
  }

  takeTokenLocal(player: NetworkPlayer, id: number, announce?: (event: CollectLocalEvent) => void): boolean {
    if (player.state !== ClientState.Alive || !player.team) return false;
    const token = this.findToken(id);
    if (!token) return false;
    const team = collectTeamBase(player.team), eligible = token.team !== team && (token.team > 0 || -token.team === team) &&
      player.tokens < COLLECT_TOKEN_LIMIT;
    if (eligible) player.tokens++;
    this.removeToken(id);
    announce?.({ type: "take", player, token, friendly: !eligible });
    return true;
  }

  depositTokensLocal(player: NetworkPlayer, baseNumber: number, now: number, random: () => number = Math.random,
                     announce?: (event: CollectLocalEvent) => void): boolean {
    const base = this.bases[baseNumber];
    if (!base || player.state !== ClientState.Alive || !player.team) return false;
    const team = collectTeamBase(player.team);
    if (!collectBaseTeam(base.team) || base.team === team) return false;
    if (player.tokens > 0) {
      const deposited = player.tokens;
      base.lastSteal = now;
      player.flags += deposited;
      const score = this.setScore(team, this.totalScore(team) + deposited);
      player.tokens = 0;
      announce?.({ type: "deposit", player, base, deposited, team, score });
      return true;
    }
    if (now < base.lastSteal + COLLECT_STEAL_TOKEN_TIME || this.totalScore(base.team) <= 0) return false;
    if (this.tokens.filter((token) => token.dropper === -1 - baseNumber).length >= COLLECT_TOKEN_LIMIT) return false;
    base.lastSteal = now;
    const score = this.setScore(base.team, this.totalScore(base.team) - 1);
    const token = this.dropToken(this.allocateTokenId(), base.o, team, Math.floor(random() * 360), now, -1 - baseNumber);
    if (!token) return false;
    announce?.({ type: "steal", player, base, token, enemyTeam: base.team, score });
    return true;
  }

  leaveGameLocal(player: NetworkPlayer, disconnecting: boolean, announce?: (event: CollectLocalEvent) => void): void {
    player.tokens = 0;
    if (!disconnecting) return;
    const team = collectTeamBase(player.team);
    let friendly = 0, enemy = 0;
    for (let index = this.tokens.length - 1; index >= 0; index--) {
      const token = this.tokens[index];
      if (token.dropper === player.clientNumber) token.dropper = Number.MIN_SAFE_INTEGER;
      else if (token.dropper > Number.MIN_SAFE_INTEGER) continue;
      if (token.team === team ? ++friendly <= COLLECT_UNOWNED_TOKEN_LIMIT : ++enemy <= COLLECT_UNOWNED_TOKEN_LIMIT) continue;
      this.tokens.splice(index, 1);
      announce?.({ type: "expire", token });
    }
  }

  private allocateTokenId(): number {
    this.nextToken++;
    if (this.nextToken > 0x7FFFFFFF) this.nextToken = 1;
    return this.nextToken;
  }
}

export function collectTeamBase(team: string): number { return team === "good" ? 1 : team === "evil" ? 2 : 0; }
export function collectBaseTeam(team: number): string | undefined { return team === 1 ? "good" : team === 2 ? "evil" : undefined; }

function readPosition(packet: PacketReader): Vec3 {
  return { x: packet.getInt() / DMF, y: packet.getInt() / DMF, z: packet.getInt() / DMF };
}

function defaultMoveToken(origin: Vec3, yaw: number): Vec3 {
  const radians = yaw * Math.PI / 180;
  return { x: origin.x - Math.sin(radians) * COLLECT_TOKEN_DISTANCE, y: origin.y + Math.cos(radians) * COLLECT_TOKEN_DISTANCE, z: origin.z };
}

function distance(left: Vec3, right: Vec3): number {
  return Math.hypot(left.x - right.x, left.y - right.y, left.z - right.z);
}

function samePosition(left: Vec3, right: Vec3): boolean { return left.x === right.x && left.y === right.y && left.z === right.z; }
