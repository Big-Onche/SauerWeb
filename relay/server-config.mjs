import fs from "node:fs";
import net from "node:net";
import path from "node:path";

const CONFIG_FILE = /^(\d{1,3}(?:\.\d{1,3}){3})(?:_(\d+))?\.cfg$/;
const KNOWN_FIELDS = new Set(["port", "name", "domain", "envvar", "autoauth", "maxclients"]);

export function loadServerConfigs(directory, environment = process.env, logger = console) {
  const configs = new Map();
  if (!fs.existsSync(directory)) {
    logger.info?.(`[server-config] No configuration directory at ${directory}; using default relay behavior.`);
    return configs;
  }
  for (const fileName of fs.readdirSync(directory).filter((name) => name.endsWith(".cfg")).sort()) {
    try {
      const config = parseServerConfig(fileName, fs.readFileSync(path.join(directory, fileName), "utf8"), environment);
      const key = serverConfigKey(config.host, config.port);
      if (configs.has(key)) throw new Error(`duplicates destination ${key}`);
      configs.set(key, config);
      logger.info?.(`[server-config] Loaded ${key}${config.autoauth ? " with native autoauth" : ""}` +
        `${config.maxclients === undefined ? "" : ` (maxclients=${config.maxclients})`}.`);
      if (config.authWarning) logger.warn?.(`[server-config] ${key}: ${config.authWarning}.`);
    } catch (error) {
      logger.error?.(`[server-config] Rejected ${fileName}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return configs;
}

export function parseServerConfig(fileName, source, environment = process.env) {
  const fileMatch = CONFIG_FILE.exec(fileName);
  if (!fileMatch || net.isIP(fileMatch[1]) !== 4) throw new Error("filename must be IPv4.cfg or IPv4_port.cfg");
  const values = new Map();
  for (const [index, rawLine] of source.split(/\r?\n/).entries()) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;
    const separator = line.indexOf("=");
    if (separator < 1) throw new Error(`line ${index + 1} must be key=value`);
    const key = line.slice(0, separator).trim().toLowerCase(), value = line.slice(separator + 1).trim();
    if (!KNOWN_FIELDS.has(key)) throw new Error(`line ${index + 1} has unknown setting '${key}'`);
    if (values.has(key)) throw new Error(`line ${index + 1} repeats '${key}'`);
    values.set(key, value);
  }
  const port = parseInteger(values.get("port"), "port", 1, 65_534);
  if (fileMatch[2] && Number(fileMatch[2]) !== port) throw new Error(`filename port ${fileMatch[2]} does not match port=${port}`);
  const autoauth = parseBoolean(values.get("autoauth"), "autoauth", false);
  const authValues = ["name", "domain", "envvar"].map((key) => values.get(key) || "");
  const anyAuth = authValues.some(Boolean), allAuth = authValues.every(Boolean);
  const [name, domain, envvar] = authValues;
  if (name && (name.length > 100 || /[\r\n\0]/.test(name))) throw new Error("name must be 1-100 safe characters");
  if (domain && (domain.length > 100 || /[\r\n\0]/.test(domain))) throw new Error("domain must be 1-100 safe characters");
  if (envvar && !/^[A-Za-z_][A-Za-z0-9_]*$/.test(envvar)) throw new Error("envvar is not a valid environment variable name");
  const privateKey = envvar ? environment[envvar] : undefined;
  let authEnabled = autoauth && allAuth;
  let authWarning = (anyAuth || autoauth) && !allAuth ? "authentication disabled because name, domain and envvar are not all configured" : undefined;
  if (authEnabled && (!privateKey || !/^[0-9a-fA-F]{1,48}$/.test(privateKey) || BigInt(`0x${privateKey}`) === 0n)) {
    authEnabled = false;
    authWarning = `autoauth disabled because ${envvar} is missing or is not a valid Sauerbraten P-192 private key`;
  }
  return {
    host: fileMatch[1], port, name: name || undefined, domain: domain || undefined, envvar: envvar || undefined,
    autoauth: authEnabled, authWarning, privateKey: authEnabled ? privateKey : undefined,
    maxclients: values.has("maxclients") ? parseInteger(values.get("maxclients"), "maxclients", 1, 1_000_000) : undefined,
  };
}

export function serverConfigKey(host, port) { return `${host}:${port}`; }

function parseInteger(value, name, minimum, maximum) {
  if (value === undefined || !/^\d+$/.test(value)) throw new Error(`${name} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${name} must be between ${minimum} and ${maximum}`);
  }
  return parsed;
}

function parseBoolean(value, name, fallback) {
  if (value === undefined) return fallback;
  if (/^(?:true|1|yes|on)$/i.test(value)) return true;
  if (/^(?:false|0|no|off)$/i.test(value)) return false;
  throw new Error(`${name} must be true or false`);
}
