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

// Original: src/fpsgame/game.h, gamemodes[]. Formatting escapes are retained for browser-side rendering.
export const GAME_MODE_DESCRIPTIONS = [
  null,
  null,
  null,
  "Free For All: Collect items for ammo. Frag everyone to score points.",
  "Cooperative Editing: Edit maps with multiple players simultaneously.",
  "Teamplay: Collect items for ammo. Frag \fs\f3the enemy team\fr to score points for \fs\f1your team\fr.",
  "Instagib: You spawn with full rifle ammo and die instantly from one shot. There are no items. Frag everyone to score points.",
  "Instagib Team: You spawn with full rifle ammo and die instantly from one shot. There are no items. Frag \fs\f3the enemy team\fr to score points for \fs\f1your team\fr.",
  "Efficiency: You spawn with all weapons and armour. There are no items. Frag everyone to score points.",
  "Efficiency Team: You spawn with all weapons and armour. There are no items. Frag \fs\f3the enemy team\fr to score points for \fs\f1your team\fr.",
  "Tactics: You spawn with two random weapons and armour. There are no items. Frag everyone to score points.",
  "Tactics Team: You spawn with two random weapons and armour. There are no items. Frag \fs\f3the enemy team\fr to score points for \fs\f1your team\fr.",
  "Capture: Capture neutral bases or steal \fs\f3enemy bases\fr by standing next to them. \fs\f1Your team\fr scores points for every 10 seconds it holds a base. You spawn with two random weapons and armour. Collect extra ammo that spawns at \fs\f1your bases\fr. There are no ammo items.",
  "Regen Capture: Capture neutral bases or steal \fs\f3enemy bases\fr by standing next to them. \fs\f1Your team\fr scores points for every 10 seconds it holds a base. Regenerate health and ammo by standing next to \fs\f1your bases\fr. There are no items.",
  "Capture The Flag: Capture \fs\f3the enemy flag\fr and bring it back to \fs\f1your flag\fr to score points for \fs\f1your team\fr. Collect items for ammo.",
  "Instagib Capture The Flag: Capture \fs\f3the enemy flag\fr and bring it back to \fs\f1your flag\fr to score points for \fs\f1your team\fr. You spawn with full rifle ammo and die instantly from one shot. There are no items.",
  "Protect The Flag: Touch \fs\f3the enemy flag\fr to score points for \fs\f1your team\fr. Pick up \fs\f1your flag\fr to protect it. \fs\f1Your team\fr loses points if a dropped flag resets. Collect items for ammo.",
  "Instagib Protect The Flag: Touch \fs\f3the enemy flag\fr to score points for \fs\f1your team\fr. Pick up \fs\f1your flag\fr to protect it. \fs\f1Your team\fr loses points if a dropped flag resets. You spawn with full rifle ammo and die instantly from one shot. There are no items.",
  "Hold The Flag: Hold \fs\f7the flag\fr for 20 seconds to score points for \fs\f1your team\fr. Collect items for ammo.",
  "Instagib Hold The Flag: Hold \fs\f7the flag\fr for 20 seconds to score points for \fs\f1your team\fr. You spawn with full rifle ammo and die instantly from one shot. There are no items.",
  "Efficiency Capture The Flag: Capture \fs\f3the enemy flag\fr and bring it back to \fs\f1your flag\fr to score points for \fs\f1your team\fr. You spawn with all weapons and armour. There are no items.",
  "Efficiency Protect The Flag: Touch \fs\f3the enemy flag\fr to score points for \fs\f1your team\fr. Pick up \fs\f1your flag\fr to protect it. \fs\f1Your team\fr loses points if a dropped flag resets. You spawn with all weapons and armour. There are no items.",
  "Efficiency Hold The Flag: Hold \fs\f7the flag\fr for 20 seconds to score points for \fs\f1your team\fr. You spawn with all weapons and armour. There are no items.",
  "Skull Collector: Frag \fs\f3the enemy team\fr to drop \fs\f3skulls\fr. Collect them and bring them to \fs\f3the enemy base\fr to score points for \fs\f1your team\fr or steal back \fs\f1your skulls\fr. Collect items for ammo.",
  "Instagib Skull Collector: Frag \fs\f3the enemy team\fr to drop \fs\f3skulls\fr. Collect them and bring them to \fs\f3the enemy base\fr to score points for \fs\f1your team\fr or steal back \fs\f1your skulls\fr. You spawn with full rifle ammo and die instantly from one shot. There are no items.",
  "Efficiency Skull Collector: Frag \fs\f3the enemy team\fr to drop \fs\f3skulls\fr. Collect them and bring them to \fs\f3the enemy base\fr to score points for \fs\f1your team\fr or steal back \fs\f1your skulls\fr. You spawn with all weapons and armour. There are no items.",
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
