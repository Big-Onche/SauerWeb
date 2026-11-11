import { ClientState, PhysicsState } from "../engine/physics/types";

export const PLAYER_MODEL_NAMES = ["mrfixit", "snoutx10k", "ogro2", "inky", "captaincannon"] as const;
export type PlayerModelName = typeof PLAYER_MODEL_NAMES[number];
export type PlayerAnimation = "dead" | "dying" | "idle" | "forward" | "backward" | "left" | "right" | "pain" | "jump" | "sink" |
  "swim" | "edit" | "lag";
export type PlayerSkin = "ffa" | "blueTeam" | "redTeam";

export interface RenderClientState {
  state: ClientState;
  move: -1 | 0 | 1;
  strafe: -1 | 0 | 1;
  physicsState: PhysicsState;
  inWater?: number;
  timeInAir?: number;
  velocityZ?: number;
  lastPain?: number;
  deadAt?: number;
}

// Original: src/fpsgame/render.cpp
// Functions: getplayermodelinfo(), renderplayer(), rendergame()
// Sauerbraten reference: SVN r6488
export function getplayermodelinfo(model: number, fallback = 0): { index: number; name: PlayerModelName } {
  const safeFallback = validModel(fallback) ? fallback : 0;
  const index = validModel(model) ? model : safeFallback;
  return { index, name: PLAYER_MODEL_NAMES[index] };
}

export function isTeamMode(gameMode: number): boolean {
  return gameMode === 2 || gameMode === 4 || gameMode === 6 || gameMode >= 8 && gameMode <= 22;
}

export function playerSkin(gameMode: number, teamskins: boolean, localTeam: string, playerTeam: string, localPlayer = false): PlayerSkin {
  if (!teamskins && !isTeamMode(gameMode)) return "ffa";
  if (localPlayer || localTeam && playerTeam === localTeam) return "blueTeam";
  return "redTeam";
}

// Original: src/engine/rendermodel.cpp
// Function: renderclient() (ragdoll branch intentionally omitted)
export function renderclient(player: RenderClientState, nowMilliseconds: number): PlayerAnimation {
  if (player.state === ClientState.Dead) return nowMilliseconds - (player.deadAt ?? 0) > 1000 ? "dead" : "dying";
  if (player.state === ClientState.Editing || player.state === ClientState.Spectator) return "edit";
  if (player.state === ClientState.Lagged) return "lag";
  if (nowMilliseconds - (player.lastPain ?? 0) < 300) return "pain";
  if (player.inWater && player.physicsState <= PhysicsState.Fall) {
    return player.move || player.strafe || (player.velocityZ ?? 0) > 0 ? "swim" : "sink";
  }
  if ((player.timeInAir ?? (player.physicsState <= PhysicsState.Fall ? 101 : 0)) > 100) return "jump";
  if (player.move > 0) return "forward";
  if (player.strafe) {
    if (player.move < 0) return player.strafe > 0 ? "right" : "left";
    return player.strafe > 0 ? "left" : "right";
  }
  if (player.move < 0) return "backward";
  return "idle";
}

function validModel(model: number): boolean {
  return Number.isInteger(model) && model >= 0 && model < PLAYER_MODEL_NAMES.length;
}
