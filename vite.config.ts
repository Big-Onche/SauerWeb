import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";

const mapsDirectory = path.resolve(".Sauerbraten/packages/base");
const sauerRoot = path.resolve(".Sauerbraten");
const packagesDirectory = path.join(sauerRoot, "packages");

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
  shaderName: string;
  shaderParameters: Record<string, number[]>;
}

interface ServerSkybox {
  basePath?: string;
  yaw?: number;
  spin?: number;
  color?: number;
}

const textureKinds: Record<string, TextureKind> = {
  "0": "diffuse", c: "diffuse", n: "normal", g: "glow", s: "specular", z: "depth", a: "alpha", d: "decal", e: "environment", u: "unknown",
};
const ignoredConfigCommands = new Set(["setshader", "setshaderparam", "setshaderparamf", "autograss", "materialreset", "mapmodelreset", "mmodel"]);
const mimeTypes: Record<string, string> = { ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".png": "image/png", ".dds": "image/vnd-ms.dds", ".tga": "image/x-tga" };

function defaultVSlot(): ServerVSlot {
  return { changed: 0, previous: -1, scale: 1, rotation: 0, offset: [0, 0], scroll: [0, 0], layer: 0, alpha: [0.5, 0], color: [1, 1, 1] };
}

function readTextureManifest(mapName: string): {
  slots: ServerTextureSlot[];
  unsupported: ConfigState["unsupported"];
  sources: string[];
  skybox?: ServerSkybox;
  lighting: ConfigState["lighting"];
} {
  const state: ConfigState = {
    slots: [],
    aliases: new Map(),
    unsupported: [],
    sources: [],
    visited: new Set(),
    commands: 0,
    lighting: {},
    shaderName: "stdworld",
    shaderParameters: {},
  };
  executeConfig("data/default_map_settings.cfg", state, 0);
  executeConfig(`packages/base/${mapName}.cfg`, state, 0);
  return {
    slots: state.slots,
    unsupported: state.unsupported,
    sources: state.sources,
    skybox: resolveSkyOverrides(state),
    lighting: state.lighting,
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

function sauerMapsPlugin(): Plugin {
  let cachedMaps: MapListItem[] | undefined;

  return {
    name: "sauer-maps",
    configureServer(server) {
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
      server.middlewares.use("/api/maps", (request, response, next) => {
        const requestUrl = new URL(request.url ?? "/", "http://localhost");
        const requestedName = requestUrl.pathname.replace(/^\/+/, "");

        if (!requestedName) {
          cachedMaps ??= fs.readdirSync(mapsDirectory, { withFileTypes: true })
            .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".ogz"))
            .map((entry) => {
              const filePath = path.join(mapsDirectory, entry.name);
              const version = readMapVersion(filePath);
              return { name: path.basename(entry.name, ".ogz"), size: fs.statSync(filePath).size, version, supported: version === 33 };
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
        response.setHeader("Content-Type", "application/gzip");
        response.setHeader("Content-Length", fs.statSync(filePath).size);
        response.setHeader("Cache-Control", "no-cache");
        fs.createReadStream(filePath).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [sauerMapsPlugin()],
  server: { host: "127.0.0.1" },
});
