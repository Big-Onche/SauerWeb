import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";
import { attachPresence, attachSauerRelay, configuredServers, serverListMiddleware } from "./relay/relay.mjs";
import { normalizeSauerbratenGzip } from "./sauerbratenGzip";
import { loadSauerbratenDirectory, validateSauerbratenDirectory } from "./sauerbratenDirectory";
import { isSupportedMapVersion } from "./src/engine/mapversion";

let sauerRoot = "";
let mapsDirectory = "";
let packagesDirectory = "";

function configureSauerbratenDirectory(directory: string): void {
  sauerRoot = directory;
  packagesDirectory = path.join(sauerRoot, "packages");
  mapsDirectory = path.join(packagesDirectory, "base");
}

type TextureKind = "diffuse" | "normal" | "glow" | "specular" | "depth" | "alpha" | "decal" | "environment" | "unknown";

interface ServerVSlot {
  changed: number;
  previous: number;
  scale: number;
  rotation: number;
  offset: [number, number];
  scroll: [number, number];
  layer: number;
  alpha: [number, number];
  color: [number, number, number];
}

interface ServerTextureSlot {
  index: number;
  textures: Array<{ kind: TextureKind; path: string }>;
  vslot: ServerVSlot;
  shader: { name: string; parameters: Record<string, number[]> };
  alphaConfigured: boolean;
  layerMask?: { path: string; mode: number; scale: number };
}

interface ConfigState {
  slots: ServerTextureSlot[];
  aliases: Map<string, string>;
  unsupported: Array<{ command: string; source: string; line: number; reason: string }>;
  sources: string[];
  visited: Set<string>;
  commands: number;
  skyboxBase?: string;
  skyYaw?: number;
  skySpin?: number;
  skyColor?: number;
  lighting: { ambient?: number; skylight?: number };
  fog: ServerFog;
  shaderName: string;
  shaderParameters: Record<string, number[]>;
  mapModels: string[];
  mapSounds: Array<{ path: string; volume: number; maxUses: number }>;
}

interface ServerSkybox {
  basePath?: string;
  yaw?: number;
  spin?: number;
  color?: number;
}

interface ServerFog {
  distance?: number;
  color?: number;
  domeColor?: number;
  domeHeight?: number;
  domeMin?: number;
  domeMax?: number;
  domeCap?: number;
  domeClip?: number;
  domeClouds?: number;
}

const textureKinds: Record<string, TextureKind> = {
  "0": "diffuse", c: "diffuse", n: "normal", g: "glow", s: "specular", z: "depth", a: "alpha", d: "decal", e: "environment", u: "unknown",
};
const ignoredConfigCommands = new Set(["setshader", "setshaderparam", "setshaderparamf", "autograss", "materialreset"]);
const mimeTypes: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".dds": "image/vnd-ms.dds",
  ".tga": "image/x-tga", ".ogg": "audio/ogg" };

function defaultVSlot(): ServerVSlot {
  return { changed: 0, previous: -1, scale: 1, rotation: 0, offset: [0, 0], scroll: [0, 0], layer: 0, alpha: [0.5, 0], color: [1, 1, 1] };
}

function readTextureManifest(mapName: string): {
  slots: ServerTextureSlot[];
  unsupported: ConfigState["unsupported"];
  sources: string[];
  skybox?: ServerSkybox;
  lighting: ConfigState["lighting"];
  fog: ConfigState["fog"];
  mapModels: ReturnType<typeof resolveMapModels>;
  entityModels: { teleporter: ReturnType<typeof resolveMapModels>[number]; pickups: ReturnType<typeof resolveMapModels> };
  mapSounds: ConfigState["mapSounds"];
} {
  const state: ConfigState = {
    slots: [],
    aliases: new Map(),
    unsupported: [],
    sources: [],
    visited: new Set(),
    commands: 0,
    lighting: {},
    fog: {},
    shaderName: "stdworld",
    shaderParameters: {},
    mapModels: [],
    mapSounds: [],
  };
  executeConfig("data/default_map_settings.cfg", state, 0);
  executeConfig(`packages/base/${mapName}.cfg`, state, 0);
  return {
    slots: state.slots,
    unsupported: state.unsupported,
    sources: state.sources,
    skybox: resolveSkyOverrides(state),
    lighting: state.lighting,
    fog: state.fog,
    mapModels: resolveMapModels(state.mapModels),
    entityModels: {
      teleporter: resolveMapModels(["teleporter"])[0],
      pickups: resolveMapModels(["ammo/shells", "ammo/bullets", "ammo/rockets", "ammo/rrounds", "ammo/grenades", "ammo/cartridges",
        "health", "boost", "armor/green", "armor/yellow", "quad"]),
    },
    mapSounds: state.mapSounds,
  };
}

function executeConfig(relativeName: string, state: ConfigState, depth: number): void {
  if (depth > 32 || state.visited.size >= 1024 || state.commands >= 250_000) return;
  const normalized = normalizeConfigPath(relativeName);
  if (!normalized || state.visited.has(normalized)) return;
  const filePath = path.resolve(sauerRoot, normalized);
  if (!isWithin(sauerRoot, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) return;
  state.visited.add(normalized);
  state.sources.push(normalized.replaceAll("\\", "/"));
  const source = fs.readFileSync(filePath, "utf8");
  for (const statement of splitStatements(source)) executeStatement(statement.text, normalized, statement.line, state, depth);
  state.visited.delete(normalized);
}

function executeStatement(text: string, source: string, line: number, state: ConfigState, depth: number, aliasArgs: string[] = []): void {
  if (++state.commands > 250_000) return;
  const tokens = tokenize(text).map((token) => substituteAliasArgs(token, aliasArgs));
  if (!tokens.length) return;
  if (tokens.length >= 3 && tokens[1] === "=") {
    state.aliases.set(tokens[0].toLowerCase(), stripBlock(tokens.slice(2).join(" ")));
    return;
  }
  const command = tokens[0].toLowerCase();
  const args = tokens.slice(1);
  const alias = state.aliases.get(command);
  if (alias !== undefined) {
    for (const statement of splitStatements(alias)) executeStatement(statement.text, source, line + statement.line - 1, state, depth + 1, args);
    return;
  }
  if (command === "exec") {
    if (args[0]) executeConfig(resolveExecPath(source, args[0]), state, depth + 1);
    return;
  }
  if (command === "texturereset") {
    const keep = clampInteger(numberArg(args[0], 0), 0, state.slots.length);
    state.slots.length = keep;
    return;
  }
  if (command === "texture") {
    addTexture(args, state);
    return;
  }
  if (command === "mapmodelreset") {
    state.mapModels = [];
    return;
  }
  if (command === "mmodel") {
    if (args[0]) state.mapModels.push(args[0].replaceAll("\\", "/").replace(/^\/+|\/+$/g, ""));
    return;
  }
  if (command === "mapsound") {
    if (args[0]) state.mapSounds.push({ path: resolveSoundPath(args[0]), volume: clampInteger(numberArg(args[1], 100), 0, 255),
      maxUses: Math.max(0, Math.trunc(numberArg(args[2], 0))) });
    return;
  }
  if (command === "setshader") {
    state.shaderName = args[0]?.toLowerCase() || "stdworld";
    state.shaderParameters = {};
    return;
  }
  if (command === "setshaderparam" || command === "setshaderparamf") {
    if (args[0]) state.shaderParameters[args[0].toLowerCase()] = args.slice(1).map((value) => numberArg(value, 0));
    return;
  }
  if (command === "skybox" || command === "loadsky") {
    if (args[0]) state.skyboxBase = normalizeTexturePath(args[0]);
    if (command === "loadsky") state.skySpin = numberArg(args[1], 0);
    return;
  }
  if (command === "yawsky") {
    state.skyYaw = numberArg(args[0], 0);
    return;
  }
  if (command === "spinsky") {
    state.skySpin = numberArg(args[0], 0);
    return;
  }
  if (command === "skyboxcolour") {
    state.skyColor = sauerColorArg(args, 0);
    return;
  }
  if (command === "ambient" || command === "skylight") {
    state.lighting[command] = sauerColorArg(args, command === "ambient" ? 1 : 0);
    return;
  }
  if (command === "fog") {
    state.fog.distance = clamp(numberArg(args[0], 4000), 16, 1_000_024);
    return;
  }
  if (command === "fogcolour" || command === "fogdomecolour") {
    state.fog[command === "fogcolour" ? "color" : "domeColor"] = sauerColorArg(args, 0);
    return;
  }
  const fogDomeNumbers: Record<string, keyof ServerFog> = {
    fogdomeheight: "domeHeight", fogdomemin: "domeMin", fogdomemax: "domeMax", fogdomecap: "domeCap", fogdomeclip: "domeClip",
    fogdomeclouds: "domeClouds",
  };
  if (command in fogDomeNumbers) {
    state.fog[fogDomeNumbers[command]] = numberArg(args[0], command === "fogdomeheight" ? -0.5 : command === "fogdomeclip" ? 1 : 0);
    return;
  }
  if (["texscale", "texrotate", "texoffset", "texscroll", "texlayer", "texalpha", "texcolor"].includes(command)) {
    modifyTexture(command, args, state);
    return;
  }
  if (ignoredConfigCommands.has(command)) return;
  state.unsupported.push({ command, source: source.replaceAll("\\", "/"), line, reason: "Command is outside the declarative texture subset and was not executed." });
}

function addTexture(args: string[], state: ConfigState): void {
  const kind = textureKinds[(args[0] ?? "").toLowerCase()];
  if (!kind || !args[1]) return;
  let slot = state.slots.at(-1);
  if (kind === "diffuse") {
    slot = {
      index: state.slots.length,
      textures: [],
      vslot: defaultVSlot(),
      shader: { name: state.shaderName, parameters: structuredClone(state.shaderParameters) },
      alphaConfigured: false,
    };
    slot.vslot.rotation = clampInteger(numberArg(args[2], 0), 0, 7);
    slot.vslot.offset = [Math.max(0, numberArg(args[3], 0)), Math.max(0, numberArg(args[4], 0))];
    slot.vslot.scale = positiveArg(args[5], 1);
    state.slots.push(slot);
  }
  if (!slot) return;
  slot.textures.push({ kind, path: normalizeTexturePath(args[1]) });
}

function modifyTexture(command: string, args: string[], state: ConfigState): void {
  const slot = state.slots.at(-1);
  if (!slot) return;
  if (command === "texscale") slot.vslot.scale = positiveArg(args[0], 1);
  else if (command === "texrotate") slot.vslot.rotation = clampInteger(numberArg(args[0], 0), 0, 7);
  else if (command === "texoffset") slot.vslot.offset = [Math.max(0, numberArg(args[0], 0)), Math.max(0, numberArg(args[1], 0))];
  else if (command === "texscroll") slot.vslot.scroll = [numberArg(args[0], 0) / 1000, numberArg(args[1], 0) / 1000];
  else if (command === "texalpha") {
    slot.vslot.alpha = [clamp(numberArg(args[0], 0.5), 0, 1), clamp(numberArg(args[1], 0), 0, 1)];
    slot.alphaConfigured = true;
  }
  else if (command === "texcolor") slot.vslot.color = [clamp(numberArg(args[0], 1), 0, 1), clamp(numberArg(args[1], 1), 0, 1), clamp(numberArg(args[2], 1), 0, 1)];
  else if (command === "texlayer") {
    const requested = numberArg(args[0], 0);
    slot.vslot.layer = requested < 0 ? Math.max(state.slots.length - 1 + requested, 0) : requested;
    if (args[1]) slot.layerMask = { path: normalizeTexturePath(args[1]), mode: numberArg(args[2], 0), scale: positiveArg(args[3], 1) };
  }
}

function splitStatements(source: string): Array<{ text: string; line: number }> {
  const statements: Array<{ text: string; line: number }> = [];
  let text = "";
  let line = 1;
  let startLine = 1;
  let quote = false;
  let bracketDepth = 0;
  for (let index = 0; index < source.length; index++) {
    const character = source[index];
    if (!quote && character === "/" && source[index + 1] === "/") {
      while (index < source.length && source[index] !== "\n") index++;
      if (bracketDepth === 0 && text.trim()) statements.push({ text: text.trim(), line: startLine });
      text = "";
      line++;
      startLine = line;
      continue;
    }
    if (character === "\"") quote = !quote;
    if (!quote && character === "[") bracketDepth++;
    if (!quote && character === "]") bracketDepth = Math.max(0, bracketDepth - 1);
    if (!quote && bracketDepth === 0 && (character === "\n" || character === ";")) {
      if (text.trim()) statements.push({ text: text.trim(), line: startLine });
      text = "";
      if (character === "\n") line++;
      startLine = line;
      continue;
    }
    text += character;
    if (character === "\n") line++;
  }
  if (text.trim()) statements.push({ text: text.trim(), line: startLine });
  return statements;
}

function tokenize(statement: string): string[] {
  const tokens: string[] = [];
  let token = "";
  let quote = false;
  let bracketDepth = 0;
  for (let index = 0; index < statement.length; index++) {
    const character = statement[index];
    if (character === "\"") { quote = !quote; continue; }
    if (!quote && character === "[") bracketDepth++;
    if (!quote && character === "]") bracketDepth--;
    if (!quote && bracketDepth === 0 && /\s/.test(character)) {
      if (token) tokens.push(token);
      token = "";
    } else token += character;
  }
  if (token) tokens.push(token);
  return tokens;
}

function substituteAliasArgs(token: string, args: string[]): string {
  return token.replace(/\$arg(\d+)/gi, (_match, index: string) => args[Number(index) - 1] ?? "");
}

function stripBlock(value: string): string {
  return value.startsWith("[") && value.endsWith("]") ? value.slice(1, -1) : value;
}

function resolveExecPath(source: string, requested: string): string {
  const normalized = requested.replaceAll("\\", "/");
  if (normalized.startsWith("packages/") || normalized.startsWith("data/")) return normalized;
  return path.posix.join(path.posix.dirname(source.replaceAll("\\", "/")), normalized);
}

function normalizeConfigPath(value: string): string | undefined {
  const normalized = path.posix.normalize(value.replaceAll("\\", "/").replace(/^\/+/, ""));
  return normalized.startsWith("../") || !normalized.toLowerCase().endsWith(".cfg") ? undefined : normalized;
}

function normalizeTexturePath(value: string): string {
  return path.posix.normalize(value.replace(/^<[^>]*>/, "").replaceAll("\\", "/").replace(/^packages\//, "").replace(/^\/+/, ""));
}

function resolveSoundPath(value: string): string {
  const normalized = normalizeTexturePath(value).replace(/^sounds\//, "");
  const base = `sounds/${normalized}`;
  if (path.posix.extname(base)) return base;
  for (const extension of [".wav", ".ogg"]) if (fs.existsSync(path.resolve(packagesDirectory, `${base}${extension}`))) return `${base}${extension}`;
  return base;
}

function resolveSkyOverrides(state: ConfigState): ServerSkybox | undefined {
  if (state.skyboxBase === undefined && state.skyYaw === undefined && state.skySpin === undefined && state.skyColor === undefined) return undefined;
  return { basePath: state.skyboxBase, yaw: state.skyYaw, spin: state.skySpin, color: state.skyColor };
}

function sauerColorArg(args: string[], minimum: number): number {
  if (args.length > 1) {
    const red = clampInteger(numberArg(args[0], 0), 0, 0xff);
    const green = clampInteger(numberArg(args[1], 0), 0, 0xff);
    const blue = clampInteger(numberArg(args[2], 0), 0, 0xff);
    return Math.max(minimum, red << 16 | green << 8 | blue);
  }
  const color = clampInteger(numberArg(args[0], minimum), minimum, 0xffffff);
  return color <= 0xff ? color * 0x010101 : color;
}

function numberArg(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

function positiveArg(value: string | undefined, fallback: number): number {
  const parsed = numberArg(value, fallback);
  return parsed > 0 ? parsed : fallback;
}

function clamp(value: number, minimum: number, maximum: number): number {
  return Math.min(maximum, Math.max(minimum, value));
}

function clampInteger(value: number, minimum: number, maximum: number): number {
  return Math.trunc(clamp(value, minimum, maximum));
}

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
}

interface MapListItem {
  name: string;
  size: number;
  version: number | null;
  supported: boolean;
}

function readMapVersion(filePath: string): number | null {
  try {
    const descriptor = fs.openSync(filePath, "r");
    const compressed = Buffer.alloc(1024);
    const length = fs.readSync(descriptor, compressed, 0, compressed.length, 0);
    fs.closeSync(descriptor);
    const header = zlib.gunzipSync(compressed.subarray(0, length), { finishFlush: zlib.constants.Z_SYNC_FLUSH });
    return header.subarray(0, 4).toString("ascii") === "OCTA" ? header.readInt32LE(4) : null;
  } catch {
    return null;
  }
}

function resolveMapModels(names: string[]): Array<{
  index: number;
  name: string;
  status: "ready" | "unsupported" | "missing";
  format?: string;
  configPath?: string;
  geometryPath?: string;
  skins?: Array<{ mesh: string; diffusePath: string; masksPath?: string }>;
  meshSettings?: Array<{ mesh: string; cullFace?: boolean }>;
  scale?: number;
  translate?: [number, number, number];
  yaw?: number;
  pitch?: number;
  cullFace?: boolean;
  alphaTest?: number;
  alphaBlend?: boolean;
  ambient?: number;
  specular?: number;
  glow?: number;
  collide?: boolean;
  ellipseCollide?: boolean;
  collisionRadius?: number;
  collisionHeight?: number;
  boundingBoxExtend?: [number, number, number];
  reason: string;
}> {
  const formats = [
    ["iqm.cfg", "IQM"], ["md5.cfg", "MD5"], ["obj.cfg", "OBJ"], ["md3.cfg", "MD3"], ["md2.cfg", "MD2"],
  ] as const;
  return names.map((name, index) => {
    const directory = path.resolve(packagesDirectory, "models", name);
    if (!isWithin(packagesDirectory, directory) || !fs.existsSync(directory) || !fs.statSync(directory).isDirectory()) {
      return { index, name, status: "missing", reason: `Mapmodel directory packages/models/${name} was not found.` };
    }
    const parentDirectory = path.dirname(directory);
    const detected = formats.map(([config, format]) => ({
      config,
      format,
      directory: fs.existsSync(path.join(directory, config)) ? directory : fs.existsSync(path.join(parentDirectory, config)) ? parentDirectory : undefined,
    })).find((candidate) => candidate.directory);
    if (!detected) return { index, name, status: "missing", reason: `No recognized Sauerbraten model configuration was found for ${name}.` };
    const configPath = path.join(detected.directory!, detected.config);
    if (!["MD2", "MD3", "MD5", "OBJ", "IQM"].includes(detected.format)) {
      return {
        index,
        name,
        status: "unsupported",
        format: detected.format,
        configPath: packageRelativePath(configPath),
        reason: `${detected.format} mapmodel loading is not supported by the Babylon asset pipeline yet.`,
      };
    }
    return resolveRenderableMapModel(index, name, directory, configPath, detected.format);
  });
}

function resolvePlayerModels() {
  const definitions = [
    { name: "mrfixit", ffa: "mrfixit", blueTeam: "mrfixit/blue", redTeam: "mrfixit/red", animations: "mrfixit/anims.cfg",
      ragdoll: "mrfixit/ragdoll.cfg", format: "md5" },
    { name: "snoutx10k", ffa: "snoutx10k", blueTeam: "snoutx10k/blue", redTeam: "snoutx10k/red", animations: "mrfixit/anims.cfg",
      ragdoll: "mrfixit/ragdoll.cfg", format: "md5" },
    { name: "ogro2", ffa: "ogro2", blueTeam: "ogro2/blue", redTeam: "ogro2/red", animations: "ogro2/anims.cfg",
      ragdoll: "ogro2/ragdoll.cfg", format: "iqm" },
    { name: "inky", ffa: "inky", blueTeam: "inky/blue", redTeam: "inky/red", animations: "inky/anims.cfg",
      ragdoll: "inky/ragdoll.cfg", format: "md5" },
    { name: "captaincannon", ffa: "captaincannon", blueTeam: "captaincannon/blue", redTeam: "captaincannon/red",
      animations: "captaincannon/anims.cfg", ragdoll: "captaincannon/ragdoll.cfg", format: "md5" },
  ];
  return definitions.map((definition, index) => {
    const animationConfig = path.join(packagesDirectory, "models", definition.animations);
    const animationDirectory = path.dirname(animationConfig);
    type Animation = { path: string; speed: number; priority: number; startOffset: number; endOffset: number };
    const animationParts: Array<{ roots: string[]; animations: Record<string, Animation> }> = [{ roots: [], animations: {} }];
    if (fs.existsSync(animationConfig)) {
      for (const statement of splitStatements(fs.readFileSync(animationConfig, "utf8"))) {
        const tokens = tokenize(statement.text);
        const command = tokens[0]?.toLowerCase();
        if (command === `${definition.format}animpart`) {
          animationParts.push({ roots: tokens.slice(1).flatMap((root) => root.split(/\s+/)).filter(Boolean), animations: {} });
          continue;
        }
        const animations = animationParts[animationParts.length - 1].animations;
        if (command !== `${definition.format}anim` || !tokens[1] || !tokens[2] || animations[tokens[1].toLowerCase()]) continue;
        animations[tokens[1].toLowerCase()] = {
          path: resolveModelAssetPath(animationDirectory, tokens[2]),
          speed: numberArg(tokens[3], 0),
          priority: numberArg(tokens[4], 0),
          startOffset: numberArg(tokens[5], 0),
          endOffset: numberArg(tokens[6], 0),
        };
      }
    }
    const model = (name: string) => ({ ...resolveMapModels([name])[0], index });
    return {
      index,
      name: definition.name,
      ffa: model(definition.ffa),
      blueTeam: model(definition.blueTeam),
      redTeam: model(definition.redTeam),
      animations: animationParts[0].animations,
      animationParts,
      ragdollPath: packageRelativePath(path.join(packagesDirectory, "models", definition.ragdoll)),
    };
  });
}

function resolveRenderableMapModel(index: number, name: string, modelDirectory: string, configPath: string, format: string) {
  const configDirectory = path.dirname(configPath);
  let assetDirectory = configDirectory;
  const settings = {
    scale: 0.25,
    translate: [0, 0, 0] as [number, number, number],
    yaw: 0,
    pitch: 0,
    cullFace: true,
    alphaTest: 0.9,
    alphaBlend: false,
    ambient: 0.3,
    specular: 1,
    glow: 0,
    collide: true,
    ellipseCollide: false,
    collisionRadius: 0,
    collisionHeight: 0,
    boundingBoxExtend: [0, 0, 0] as [number, number, number],
  };
  let geometryPath: string | undefined;
  const skins: Array<{ mesh: string; diffusePath: string; masksPath?: string }> = [];
  const meshSettings: Array<{ mesh: string; cullFace?: boolean }> = [];
  const tags: Record<string, string> = {};
  const source = fs.readFileSync(configPath, "utf8");
  for (const statement of splitStatements(source)) {
    const tokens = tokenize(statement.text);
    const command = tokens[0]?.toLowerCase();
    const args = tokens.slice(1);
    if (command === `${format.toLowerCase()}dir` && args[0]) assetDirectory = path.resolve(packagesDirectory, "models", args[0]);
    else if (command === `${format.toLowerCase()}load` && args[0]) geometryPath = resolveModelAssetPath(assetDirectory, args[0]);
    else if (command === `${format.toLowerCase()}skin` && args[0] && args[1]) {
      skins.push({
        mesh: args[0],
        diffusePath: resolveModelAssetPath(assetDirectory, args[1]),
        masksPath: args[2] ? resolveModelAssetPath(assetDirectory, args[2]) : undefined,
      });
    } else if (command === "mdlscale") {
      const scale = numberArg(args[0], 100) > 0 ? numberArg(args[0], 100) / 100 : 1;
      settings.scale = scale / 4;
    }
    else if (command === `${format.toLowerCase()}cullface` && args[0]) {
      meshSettings.push({ mesh: args[0], cullFace: numberArg(args[1], 1) !== 0 });
    }
    else if (command === `${format.toLowerCase()}tag` && args[0] && args[1]) tags[args[1].toLowerCase()] = args[0];
    else if (command === "mdltrans") settings.translate = [numberArg(args[0], 0), numberArg(args[1], 0), numberArg(args[2], 0)];
    else if (command === "mdlyaw") settings.yaw = numberArg(args[0], 0);
    else if (command === "mdlpitch") settings.pitch = numberArg(args[0], 0);
    else if (command === "mdlcullface") settings.cullFace = numberArg(args[0], 1) !== 0;
    else if (command === "mdlalphatest") settings.alphaTest = clamp(numberArg(args[0], 0.9), 0, 1);
    else if (command === "mdlalphablend") settings.alphaBlend = numberArg(args[0], 0) !== 0;
    else if (command === "mdlambient") settings.ambient = modelPercent(args[0], 0.3);
    else if (command === "mdlspec") settings.specular = modelPercent(args[0], 1);
    else if (command === "mdlglow") settings.glow = modelPercent(args[0], 3);
    else if (command === "mdlcollide") settings.collide = numberArg(args[0], 1) !== 0;
    else if (command === "mdlellipsecollide") settings.ellipseCollide = numberArg(args[0], 0) !== 0;
    else if (command === "mdlbb") {
      settings.collisionRadius = numberArg(args[0], 0);
      settings.collisionHeight = numberArg(args[1], 0);
    } else if (command === "mdlbbextend") {
      settings.boundingBoxExtend = [numberArg(args[0], 0), numberArg(args[1], 0), numberArg(args[2], 0)];
    }
  }
  geometryPath ??= findModelDefault(modelDirectory, configDirectory, format.toLowerCase());
  if (!geometryPath || !fs.existsSync(path.resolve(packagesDirectory, geometryPath))) {
    return {
      index,
      name,
      status: "missing" as const,
      format,
      configPath: packageRelativePath(configPath),
      reason: `${format} geometry for ${name} was not found.`,
    };
  }
  if (!skins.length) {
    const diffuse = findInheritedModelFile(modelDirectory, configDirectory, ["skin.png", "skin.jpg", "skin.jpeg"]);
    const masks = findInheritedModelFile(modelDirectory, configDirectory, ["masks.png", "masks.jpg", "masks.jpeg"]);
    if (diffuse) skins.push({ mesh: "*", diffusePath: diffuse, masksPath: masks });
  }
  if (["MD2", "MD3", "OBJ"].includes(format)) settings.translate[1] *= -1;
  return {
    index,
    name,
    status: "ready" as const,
    format,
    configPath: packageRelativePath(configPath),
    geometryPath,
    skins,
    meshSettings,
    tags,
    ...settings,
    reason: "",
  };
}

function resolveViewWeapons() {
  const names = ["fist", "shotg", "chaing", "rocket", "rifle", "gl", "pistol"];
  return names.map((model, gun) => {
    const directory = path.join(packagesDirectory, "models", "vwep", model);
    return { ...resolveRenderableMapModel(gun, `vwep/${model}`, directory, path.join(directory, "md5.cfg"), "MD5"), gun };
  });
}

function findModelDefault(modelDirectory: string, configDirectory: string, extension: string): string | undefined {
  const names = extension === "obj" ? ["tris.obj", "model.obj"] : [`tris.${extension}`];
  return findInheritedModelFile(modelDirectory, configDirectory, names);
}

function findInheritedModelFile(modelDirectory: string, parentDirectory: string, names: string[]): string | undefined {
  for (const directory of [modelDirectory, parentDirectory]) {
    for (const name of names) {
      const candidate = path.join(directory, name);
      if (fs.existsSync(candidate) && fs.statSync(candidate).isFile()) return packageRelativePath(candidate);
    }
  }
  return undefined;
}

function resolveModelAssetPath(directory: string, requested: string): string {
  const clean = requested.replace(/^<[^>]*>/, "").replaceAll("\\", "/");
  return packageRelativePath(path.resolve(directory, clean));
}

function packageRelativePath(filePath: string): string {
  return path.relative(packagesDirectory, filePath).replaceAll("\\", "/");
}

function modelPercent(value: string | undefined, fallback: number): number {
  const percent = numberArg(value, fallback * 100);
  return percent > 0 ? percent / 100 : percent < 0 ? 0 : fallback;
}

function resolveHudGuns() {
  const names = ["fist", "shotg", "chaing", "rocket", "rifle", "gl", "pistol"];
  return names.map((model, gun) => {
    const directory = path.join(packagesDirectory, "models", "hudguns", model);
    const configPath = path.join(directory, "md5.cfg");
    const weapon = resolveRenderableMapModel(gun, `hudguns/${model}`, directory, configPath, "MD5");
    const configSource = fs.readFileSync(configPath, "utf8");
    const pose = resolveHudGunPose(configSource);
    const linkTag = configSource.match(/md5link\s+0\s+1\s+(\S+)/i)?.[1] ?? "tag_weapon";
    const attachmentBone = [...configSource.matchAll(/md5tag\s+(\S+)\s+(\S+)/gi)]
      .find((match) => match[2] === linkTag)?.[1] ?? linkTag;
    const handsDirectory = path.join(packagesDirectory, "models", "mrfixit", "hudguns");
    const hands = {
      index: gun,
      name: `mrfixit/hudguns/${model}`,
      status: fs.existsSync(path.join(handsDirectory, "fixit_hands.md5mesh")) ? "ready" as const : "missing" as const,
      format: "MD5",
      configPath: "models/mrfixit/hudguns/md5.cfg",
      geometryPath: "models/mrfixit/hudguns/fixit_hands.md5mesh",
      skins: [{ mesh: "fixit_hands", diffusePath: "models/mrfixit/hudguns/fixit_hands.png",
        masksPath: "models/mrfixit/hudguns/fixit_hands_mask.png" }],
      scale: "scale" in weapon ? weapon.scale : 0.75,
      translate: "translate" in weapon ? weapon.translate : [0, 0, 0] as [number, number, number],
      cullFace: true,
      ambient: 0.3,
      specular: 1,
      reason: fs.existsSync(path.join(handsDirectory, "fixit_hands.md5mesh")) ? "" : "The HUD hands mesh was not found.",
    };
    return {
      gun,
      model,
      weapon,
      hands,
      handsAnimationPath: resolveModelAssetPath(directory, pose.animations[0]),
      weaponAnimationPath: resolveModelAssetPath(directory, pose.animations[1]),
      handsShootAnimationPath: resolveModelAssetPath(directory, pose.shootAnimations[0] || pose.animations[0]),
      weaponShootAnimationPath: resolveModelAssetPath(directory, pose.shootAnimations[1] || pose.animations[1]),
      handsShootAnimationSpeed: pose.shootAnimationSpeeds[0],
      weaponShootAnimationSpeed: pose.shootAnimationSpeeds[1],
      attachmentBone,
      handsAdjustments: pose.adjustments[0],
      weaponAdjustments: pose.adjustments[1],
    };
  });
}

function resolveHudGunPose(source: string) {
  type Adjustment = { bone: string; yaw: number; pitch: number; roll: number; translate: [number, number, number] };
  const animations = ["", ""];
  const shootAnimations = ["", ""];
  const shootAnimationSpeeds = [0, 0];
  const adjustments: [Adjustment[], Adjustment[]] = [[], []];
  let part = 0;
  let current = new Map<string, Adjustment>();
  for (const statement of splitStatements(source)) {
    const tokens = tokenize(statement.text);
    const command = tokens[0]?.toLowerCase();
    const args = tokens.slice(1);
    if (command === "md5load") {
      part = 1;
      current = new Map();
    } else if (command === "md5adjust" && args[0]) {
      current.set(args[0], {
        bone: args[0],
        yaw: numberArg(args[1], 0),
        pitch: numberArg(args[2], 0),
        roll: numberArg(args[3], 0),
        translate: [numberArg(args[4], 0) / 4, numberArg(args[5], 0) / 4, numberArg(args[6], 0) / 4],
      });
    } else if (command === "md5anim" && args[0]?.toLowerCase() === "gun idle" && !animations[part]) {
      animations[part] = args[1] ?? "";
      adjustments[part] = [...current.values()];
    } else if (command === "md5anim" && args[0]?.toLowerCase() === "gun shoot" && !shootAnimations[part]) {
      shootAnimations[part] = args[1] ?? "";
      shootAnimationSpeeds[part] = numberArg(args[2], 0);
    }
  }
  return { animations, shootAnimations, shootAnimationSpeeds, adjustments };
}

function sauerMapsPlugin(): Plugin {
  let cachedMaps: MapListItem[] | undefined;
  const relayServers = configuredServers();

  return {
    name: "sauer-maps",
    configureServer(server) {
      if (server.httpServer) {
        attachSauerRelay(server.httpServer, { servers: relayServers });
        attachPresence(server.httpServer);
      }
      server.middlewares.use("/api/servers", serverListMiddleware(relayServers));
      server.middlewares.use("/api/hudguns", (_request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(resolveHudGuns()));
      });
      server.middlewares.use("/api/bouncers", (_request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(resolveMapModels([
          "projectiles/grenade", "gibs/gib01", "gibs/gib02", "gibs/gib03", "debris/debris01", "debris/debris02",
          "debris/debris03", "debris/debris04", "barreldebris/debris01", "barreldebris/debris02", "barreldebris/debris03",
          "barreldebris/debris04",
        ])));
      });
      server.middlewares.use("/api/playermodels", (_request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(resolvePlayerModels()));
      });
      server.middlewares.use("/api/viewweapons", (_request, response) => {
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(resolveViewWeapons()));
      });
      server.middlewares.use("/api/packages", (request, response, next) => {
        let requestedPath: string;
        try {
          requestedPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/+/, ""));
        } catch {
          response.statusCode = 400;
          response.end("Invalid asset path");
          return;
        }
        const filePath = path.resolve(packagesDirectory, requestedPath);
        if (!requestedPath || !isWithin(packagesDirectory, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          next();
          return;
        }
        response.setHeader("Content-Type", mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
        response.setHeader("Content-Length", fs.statSync(filePath).size);
        response.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(filePath).pipe(response);
      });
      server.middlewares.use("/api/data", (request, response, next) => {
        let requestedPath: string;
        try {
          requestedPath = decodeURIComponent(new URL(request.url ?? "/", "http://localhost").pathname.replace(/^\/+/, ""));
        } catch {
          response.statusCode = 400;
          response.end("Invalid data asset path");
          return;
        }
        const dataDirectory = path.join(sauerRoot, "data");
        const filePath = path.resolve(dataDirectory, requestedPath);
        if (!requestedPath || !isWithin(dataDirectory, filePath) || !fs.existsSync(filePath) || !fs.statSync(filePath).isFile()) {
          next();
          return;
        }
        response.setHeader("Content-Type", mimeTypes[path.extname(filePath).toLowerCase()] ?? "application/octet-stream");
        response.setHeader("Content-Length", fs.statSync(filePath).size);
        response.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(filePath).pipe(response);
      });
      server.middlewares.use("/api/maps", (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const requestedName = requestUrl.pathname.replace(/^\/+/, "");

        if (!requestedName) {
          cachedMaps ??= fs.readdirSync(mapsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ogz"))
            .map((entry) => {
              const filePath = path.join(mapsDirectory, entry.name);
              const version = readMapVersion(filePath);
              return {
                name: path.basename(entry.name, ".ogz"), size: fs.statSync(filePath).size, version,
                supported: isSupportedMapVersion(version),
              };
            })
            .sort((left, right) => left.name.localeCompare(right.name));
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(cachedMaps));
          return;
        }

        const textureMatch = /^([a-zA-Z0-9_-]+)\/textures$/.exec(requestedName);
        if (textureMatch) {
          response.setHeader("Content-Type", "application/json");
          response.setHeader("Cache-Control", "no-store");
          response.end(JSON.stringify(readTextureManifest(textureMatch[1])));
          return;
        }

        if (!/^[a-zA-Z0-9_-]+\.ogz$/.test(requestedName)) {
          response.statusCode = 400;
          response.end("Invalid map name");
          return;
        }

        const filePath = path.join(mapsDirectory, requestedName);
        if (!fs.existsSync(filePath)) {
          next();
          return;
        }
        const version = readMapVersion(filePath);
        const mapData = version !== null && version <= 28 ? normalizeSauerbratenGzip(fs.readFileSync(filePath)) : undefined;
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", mapData?.length ?? fs.statSync(filePath).size);
        response.setHeader("Cache-Control", "no-cache");
        if (mapData) response.end(mapData);
        else fs.createReadStream(filePath).pipe(response);
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const projectRoot = process.cwd();
  const applicationVersion = fs.readFileSync(path.join(projectRoot, "VERSION"), "utf8").trim();
  const directory = loadSauerbratenDirectory(mode, projectRoot);
  validateSauerbratenDirectory(directory);
  configureSauerbratenDirectory(directory);

  return {
    define: { __SAUERWEB_VERSION__: JSON.stringify(applicationVersion) },
    plugins: [sauerMapsPlugin()],
    server: { host: "127.0.0.1" },
  };
});
