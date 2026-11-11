export const PROTOCOL_VERSION = 260;
export const DEMO_VERSION = 1;
export const SAUERBRATEN_SERVER_PORT = 28785;
export const SAUERBRATEN_SERVINFO_PORT = 28786;
export const DMF = 16;
export const DNF = 100;
export const DVELF = 1;
export const MAXNAMELEN = 15;
export const MAXTEAMLEN = 4;

// Original: src/fpsgame/game.h
// Data: network message codes
// Sauerbraten reference: SVN r6488
export enum NetworkMessage {
  Connect, ServInfo, Welcome, InitClient, Pos, Text, Sound, ClientDisconnect,
  Shoot, Explode, Suicide, Died, Damage, HitPush, ShotEffects, ExplodeEffects,
  TrySpawn, SpawnState, Spawn, ForceDeath, GunSelect, Taunt, MapChange, MapVote,
  TeamInfo, ItemSpawn, ItemPickup, ItemAccept, Teleport, JumpPad, Ping, Pong,
  ClientPing, TimeUp, ForceIntermission, ServerMessage, ItemList, Resume, EditMode,
  EditEntity, EditFace, EditTexture, EditMaterial, Flip, Copy, Paste, Rotate,
  Replace, DeleteCube, Remip, EditVSlot, Undo, Redo, NewMap, GetMap, SendMap,
  Clipboard, EditVariable, MasterMode, Kick, ClearBans, CurrentMaster, Spectator,
  SetMaster, SetTeam, Bases, BaseInfo, BaseScore, ReplenishAmmo, BaseRegen,
  Announce, ListDemos, SendDemoList, GetDemo, SendDemo, DemoPlayback, RecordDemo,
  StopDemo, ClearDemos, TakeFlag, ReturnFlag, ResetFlag, InvisibleFlag, TryDropFlag,
  DropFlag, ScoreFlag, InitFlags, SayTeam, Client, AuthTry, AuthKick, AuthChallenge,
  AuthAnswer, RequestAuth, PauseGame, GameSpeed, AddBot, DeleteBot, InitAi, FromAi,
  BotLimit, BotBalance, MapCrc, CheckMaps, SwitchName, SwitchModel, SwitchTeam,
  InitTokens, TakeToken, ExpireTokens, DropTokens, DepositTokens, StealTokens,
  ServerCommand, DemoPacket, MessageCount,
}

export const GAME_MODE_NAMES = [
  "SP", "DMSP", "demo", "ffa", "coop edit", "teamplay", "instagib", "insta team", "efficiency", "effic team", "tactics",
  "tac team", "capture", "regen capture", "ctf", "insta ctf", "protect", "insta protect", "hold", "insta hold", "effic ctf",
  "effic protect", "effic hold", "collect", "insta collect", "effic collect",
] as const;

export function gameModeName(mode: number): string {
  return GAME_MODE_NAMES[mode + 3] ?? `mode ${mode}`;
}
