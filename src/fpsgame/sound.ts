import type { SoundSystem } from "../engine/sound";

// Original: src/fpsgame/game.h, data/sounds.cfg
// Sauerbraten reference: SVN r6488
export enum GameSound {
  Jump, Land, Rifle, Punch1, Shotgun, Chaingun, RocketFire, RocketHit, WeaponLoad, ItemAmmo, ItemHealth, ItemArmour, ItemPowerup,
  ItemSpawn, Teleport, NoAmmo, PowerupOut, Pain1, Pain2, Pain3, Pain4, Pain5, Pain6, Die1, Die2, FireballLaunch, FireballExplode,
  Splash1, Splash2, Grunt1, Grunt2, Rumble, PainO, PainR, DeathR, PainE, DeathE, PainS, DeathS, PainB, DeathB, PainP, PigGrunt2,
  PainH, DeathH, PainD, DeathD, PigGrunt1, Iceball, Slimeball, JumpPad, Pistol, VoiceBaseCaptured, VoiceBaseLost, VoiceFight,
  VoiceBoost, VoiceBoost10, VoiceQuad, VoiceQuad10, VoiceRespawnPoint, FlagPickup, FlagDrop, FlagReturn, FlagScore, FlagReset, Burn,
  ChainsawAttack, ChainsawIdle, Hit, FlagFail,
}

const GAME_SOUNDS: ReadonlyArray<readonly [string, number]> = [
  ["sounds/aard/jump.wav", 100], ["sounds/aard/land.wav", 100], ["sounds/q009/rifle.ogg", 80], ["sounds/free/punch1.wav", 100],
  ["sounds/q009/shotgun.ogg", 110], ["sounds/q009/minigun.ogg", 70], ["sounds/q009/rlauncher.ogg", 100],
  ["sounds/q009/ren.ogg", 200], ["sounds/aard/weapload.wav", 100], ["sounds/aard/itempick.wav", 100],
  ["sounds/free/itempick.wav", 100], ["sounds/free/tick.wav", 100], ["sounds/free/acid6.wav", 100],
  ["sounds/free/itemback.wav", 100], ["sounds/q009/teleport.ogg", 255], ["sounds/aard/outofammo.wav", 100],
  ["sounds/free/acid5.wav", 100], ["sounds/aard/pain1.wav", 100], ["sounds/aard/pain2.wav", 100], ["sounds/aard/pain3.wav", 100],
  ["sounds/aard/pain4.wav", 100], ["sounds/aard/pain5.wav", 100], ["sounds/aard/pain6.wav", 100], ["sounds/aard/die1.wav", 100],
  ["sounds/aard/die2.wav", 100], ["sounds/q009/glauncher.ogg", 100], ["sounds/q009/grenade.ogg", 200],
  ["sounds/free/splash1.wav", 100], ["sounds/free/splash2.wav", 100], ["sounds/aard/grunt1.wav", 100],
  ["sounds/aard/grunt2.wav", 100], ["sounds/free/rumble.wav", 100], ["sounds/ppm/paino.wav", 100], ["sounds/ppm/painr.wav", 100],
  ["sounds/ppm/deathr.wav", 100], ["sounds/ppm/paine.wav", 100], ["sounds/ppm/deathe.wav", 100], ["sounds/ppm/pains.wav", 100],
  ["sounds/ppm/deaths.wav", 100], ["sounds/ppm/painb.wav", 100], ["sounds/ppm/deathb.wav", 100], ["sounds/ppm/painp.wav", 100],
  ["sounds/free/piggrunt2.wav", 100], ["sounds/ppm/painh.wav", 100], ["sounds/ppm/deathh.wav", 100], ["sounds/ppm/paind.wav", 100],
  ["sounds/ppm/deathd.wav", 100], ["sounds/free/piggrunt1.wav", 100], ["sounds/ppm/iceball.wav", 100], ["sounds/ppm/slimeball.wav", 100],
  ["sounds/nieb/jumppad.ogg", 255], ["sounds/q009/pistol.ogg", 80], ["sounds/blindabuser/base_captured.ogg", 150],
  ["sounds/blindabuser/base_lost.ogg", 150], ["sounds/blindabuser/fight.ogg", 150], ["sounds/blindabuser/health_boost.ogg", 150],
  ["sounds/blindabuser/health_boost_in_10_seconds.ogg", 150], ["sounds/blindabuser/quad_damage.ogg", 150],
  ["sounds/blindabuser/quad_damage_in_10_seconds.ogg", 150], ["sounds/blindabuser/respawn_point_set.ogg", 150],
  ["sounds/ctf/flagpickup.wav", 100], ["sounds/ctf/flagdrop.wav", 100], ["sounds/ctf/flagreturn.wav", 100],
  ["sounds/ctf/flagscore.wav", 100], ["sounds/ctf/flagreturn.wav", 100], ["sounds/soundsnap/burn.ogg", 100],
  ["sounds/soundsnap/chainsaw_attack.ogg", 150], ["sounds/soundsnap/chainsaw_idle.ogg", 230], ["sounds/free/hit.ogg", 60],
  ["sounds/ctf/flagfail.wav", 200],
];

export function registerGameSounds(sound: SoundSystem): void {
  GAME_SOUNDS.forEach(([path, volume], id) => sound.registersound(id, path, volume));
  sound.registersound(GameSound.Rifle, "sounds/q009/rifle2.ogg", 80);
  sound.registersound(GameSound.Rifle, "sounds/q009/rifle3.ogg", 80);
  sound.registersound(GameSound.Shotgun, "sounds/q009/shotgun2.ogg", 110);
  sound.registersound(GameSound.Shotgun, "sounds/q009/shotgun3.ogg", 110);
  sound.registersound(GameSound.Chaingun, "sounds/q009/minigun2.ogg", 70);
  sound.registersound(GameSound.Chaingun, "sounds/q009/minigun3.ogg", 70);
  sound.registersound(GameSound.RocketFire, "sounds/q009/rlauncher2.ogg", 100);
  sound.registersound(GameSound.RocketFire, "sounds/q009/rlauncher3.ogg", 100);
  sound.registersound(GameSound.RocketHit, "sounds/q009/ren2.ogg", 200);
  sound.registersound(GameSound.RocketHit, "sounds/q009/ren3.ogg", 200);
  sound.registersound(GameSound.FireballExplode, "sounds/q009/grenade2.ogg", 200);
  sound.registersound(GameSound.FireballExplode, "sounds/q009/grenade3.ogg", 200);
  sound.registersound(GameSound.Pistol, "sounds/q009/pistol2.ogg", 80);
  sound.registersound(GameSound.Pistol, "sounds/q009/pistol3.ogg", 80);
}
