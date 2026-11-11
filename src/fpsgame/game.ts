export const PROTOCOL_VERSION = 260;
export const DEMO_VERSION = 1;
export const SAUERBRATEN_SERVER_PORT = 28785;
export const SAUERBRATEN_SERVINFO_PORT = 28786;
export const DMF = 16;
export const DNF = 100;
export const DVELF = 1;
export const MAXNAMELEN = 15;
export const MAXTEAMLEN = 4;

export enum GameModeFlag {
  Team = 1 << 0,
  NoItems = 1 << 1,
  NoAmmo = 1 << 2,
  Insta = 1 << 3,
  Efficiency = 1 << 4,
  Tactics = 1 << 5,
  Capture = 1 << 6,
  Regen = 1 << 7,
  Ctf = 1 << 8,
  Protect = 1 << 9,
  Hold = 1 << 10,
  Edit = 1 << 12,
  Demo = 1 << 13,
  Local = 1 << 14,
  Lobby = 1 << 15,
  Dmsp = 1 << 16,
  ClassicSp = 1 << 17,
  Slowmo = 1 << 18,
  Collect = 1 << 19,
}

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

// Original: src/fpsgame/game.h, gamemodes[]. Keep gameplay mode flags separate from the browser runtime mode.
export const GAME_MODE_FLAGS = [
  GameModeFlag.Local | GameModeFlag.ClassicSp,
  GameModeFlag.Local | GameModeFlag.Dmsp,
  GameModeFlag.Demo | GameModeFlag.Local,
  GameModeFlag.Lobby,
  GameModeFlag.Edit,
  GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Insta,
  GameModeFlag.NoItems | GameModeFlag.Insta | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Efficiency,
  GameModeFlag.NoItems | GameModeFlag.Efficiency | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Tactics,
  GameModeFlag.NoItems | GameModeFlag.Tactics | GameModeFlag.Team,
  GameModeFlag.NoAmmo | GameModeFlag.Tactics | GameModeFlag.Capture | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Capture | GameModeFlag.Regen | GameModeFlag.Team,
  GameModeFlag.Ctf | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Insta | GameModeFlag.Ctf | GameModeFlag.Team,
  GameModeFlag.Ctf | GameModeFlag.Protect | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Insta | GameModeFlag.Ctf | GameModeFlag.Protect | GameModeFlag.Team,
  GameModeFlag.Ctf | GameModeFlag.Hold | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Insta | GameModeFlag.Ctf | GameModeFlag.Hold | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Efficiency | GameModeFlag.Ctf | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Efficiency | GameModeFlag.Ctf | GameModeFlag.Protect | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Efficiency | GameModeFlag.Ctf | GameModeFlag.Hold | GameModeFlag.Team,
  GameModeFlag.Collect | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Insta | GameModeFlag.Collect | GameModeFlag.Team,
  GameModeFlag.NoItems | GameModeFlag.Efficiency | GameModeFlag.Collect | GameModeFlag.Team,
] as const;

export function gameModeHas(mode: number, flag: GameModeFlag): boolean {
  return ((GAME_MODE_FLAGS[mode + 3] ?? 0) & flag) !== 0;
}

export function gameModeName(mode: number): string {
  return GAME_MODE_NAMES[mode + 3] ?? `mode ${mode}`;
}
