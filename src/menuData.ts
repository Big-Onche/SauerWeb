export type MapMenuCategory = "ffa" | "capture" | "ctf" | "concept";

export interface MapMenuPage {
  id: string;
  label: string;
  category: MapMenuCategory;
  columns: string[][];
}

const ffa = [
  "aard3c abyss academy access albatross akaritori akimiski alithia alloy antel anubis aod aqueducts arbana asenatra asthma averas",
  "awoken bvdm_01 carbide cartel castle_trap catacombs cavefire church51 clash collusion colony complex conflict corruption crypta curvedm curvy_castle",
  "darkdeath deathtek depot dirtndust dispute DM_BS1 dock dopamine douze duel5 duel7 duel8 dune elegy exist exo fallen",
  "fanatic_quake fdm6 ferguson force frag-lab frag2 fragplaza frostbyte frozen fubuki fury ghetto gorge gothic-df guacamole gubo hades",
  "hashi hator haze hdm3 headroom helligsted hektik hillfort hog2 horus idyll3 imhotep industry infernal injustice insipid island",
  "janela justice kalking1 kastro katrez_d kffa killfactory kmap5 konkuri-to ksauer1 legacy legazzo lost_soul lost_world lostinspace maple masdm",
  "mbt2 mbt9 mbt10 memento memoria metl2 metl3 metl4 mood moonlite neondevastation neonpanic nessus nmp8 nmp10 nucleus oasis",
  "oddworld ognjen ogrosupply oldschool orbe orion osiris ot outpost paradigm pariah park pgdm phosgene phrantic pitch_black powerplant",
  "purgatory refuge renegade rm1 rm5 roughinery ruby ruine saffier sandstorm sauerowalk sauerstruck sdm1 shadowed shindou shinmei1 shiva",
  "simplicity skrdm1 skycastle-r slingshot souls spcr2 stahlbox stemple stronghold suburb suisei tartech teahupoo tejen thetowers thor torment",
  "toxicity tumwalk turbine turmoil unworld unworld2 ventania waltz wake5 wdcd zamak zavial zdm2 ztn",
].map(words);

const capture = [
  "aastha abbey access akimiski akroseum alithia anubis aod arabic asenatra asgard asteroids averas bklyn c_egypt c_lone c_valley",
  "campo capture_night caribbean casa collide collusion core_refuge core_transfer corruption croma cwcastle damnation destiny dirtndust disc disruption donya",
  "duomo dust2 earthstation eris eternal_valley evilness face-capture fallen fb_capture fc3 fc4 fc5 forge fragnostic frostbyte fusion genesis",
  "ghetto gorge gothic-df hades hallo harbor haste hidden imhotep infamy infernal killcore3 kopenhagen laucin lostinspace luna mbt12",
  "mc-lab meltdown2 mercury metro monastery nevil_c new_energy nitro nmp4 nmp9 nucleus ogrosupply overdrive ow pandora paradigm pariah",
  "ph-capture pul1ctf reissen relic risk river_c river_keep ruby ruebli rust serenity skycastle-r snapper_rocks spcr stadium stronghold subterra",
  "suburb surge tempest tortuga triforts turbulence turmoil twinforts urban_c valhalla venice waltz xenon zamak",
].map(words);

const ctf = [
  "aastha abbey akimiski akroseum arbana asgard authentic autumn bad_moon berlin_wall bklyn breakout bt_falls campo capture_night casa catch22",
  "collide core_refuge core_transfer croma ctf_suite daemex damnation desecration destiny disc disruption divine duomo dust2 earthsea earthstation enigma",
  "eris eternal_valley europium evilness face-capture fire_keep flagstone forge forgotten fortress fragnostic fusion garden hallo harbor haste hidden",
  "idris infamy kiryu kopenhagen l_ctf laucin luna mach2 mbt1 mbt4 mbt12 mc-lab meltdown2 mercury metro mill new_energy",
  "nitro nucleus overdrive ow pandora pul1ctf ra recovery redemption regal reissen risk river_keep ruebli rust sacrifice shellshock2",
  "shipwreck siberia snapper_rocks spcr stadium stronghold subterra suburb surge tatooine tectonic tejen tempest tortuga triforts tubes turbulence",
  "twinforts unworld3 urban_c valhalla warlock wdcd xenon",
].map(words);

const concept = words("box_demo canyon door_demo firstevermap ladder platform_demo sauerbraten secondevermap spiralz");

export const MAP_MENU_PAGES: readonly MapMenuPage[] = [
  page("ffa-1", "ffa 1", "ffa", ffa.slice(0, 3)),
  page("ffa-2", "ffa 2", "ffa", ffa.slice(3, 6)),
  page("ffa-3", "ffa 3", "ffa", ffa.slice(6, 9)),
  page("ffa-4", "ffa 4", "ffa", [ffa[9], ffa[10], []]),
  page("capture-1", "capture 1", "capture", capture.slice(0, 3)),
  page("capture-2", "capture 2", "capture", capture.slice(3, 6)),
  page("capture-3", "capture 3", "capture", [capture[6], [], []]),
  page("ctf-1", "ctf 1", "ctf", ctf.slice(0, 3)),
  page("ctf-2", "ctf 2", "ctf", ctf.slice(3, 6)),
  page("ctf-3", "ctf 3", "ctf", [ctf[6], [], []]),
  page("concept", "concept", "concept", [concept, [], []]),
];

const CAPTURE_MODES = new Set([9, 10, 15, 16, 19]);

export function mapMenuPagesForMode(mode: number): readonly MapMenuPage[] {
  if (mode >= 0 && mode <= 8) return MAP_MENU_PAGES;
  if (CAPTURE_MODES.has(mode)) return MAP_MENU_PAGES.filter((page) => page.category === "capture");
  if (mode >= 11) return MAP_MENU_PAGES.filter((page) => page.category === "ctf");
  return MAP_MENU_PAGES.filter((page) => page.category === "ffa");
}

function words(value: string): string[] {
  return value.split(/\s+/);
}

function page(id: string, label: string, category: MapMenuCategory, columns: string[][]): MapMenuPage {
  return { id, label, category, columns };
}
