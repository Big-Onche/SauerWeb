import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const MAX_DATAGRAM_BYTES = 65_535;
const RETRIEVELIMIT = 20_000;
const MAX_MASTER_RESPONSE_BYTES = 1_048_576;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_ADDRESS = 4;
const MAX_PACKETS_PER_SECOND = 256;
const MAX_BYTES_PER_SECOND = 1_048_576;
const DEFAULT_MASTER_NAME = "master.sauerbraten.org";
const DEFAULT_MASTER_PORT = 28787;
const DEFAULT_LAN_INFO_PORT = 28786;
const DEFAULT_TRUSTED_PROXIES = "127.0.0.1/32,::1/128";
const PRESENCE_STALE_MILLISECONDS = 45_000;
const PRESENCE_SWEEP_MILLISECONDS = 5_000;
const DEFAULT_TEAMKILL_WARNING_THRESHOLD = 2;
const DEFAULT_TEAMKILL_DISCONNECT_THRESHOLD = 3;
const DEFAULT_TEAMKILL_WINDOW_MILLISECONDS = 5 * 60_000;
const DEFAULT_TEAMKILL_COOLDOWN_MILLISECONDS = 10 * 60_000;

export function configuredServers(environment = process.env) {
  const value = environment.SAUER_RELAY_SERVERS || "127.0.0.1:28785";
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [address, label] = entry.split("=", 2);
    const match = /^(.+):(\d+)$/.exec(address);
    if (!match) throw new Error(`Invalid SAUER_RELAY_SERVERS entry: ${entry}`);
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_534) throw new Error(`Invalid Sauerbraten port: ${match[2]}`);
    return { host: match[1], port, label: label || match[1], keep: true };
  });
}

export function attachSauerRelay(httpServer, options = {}) {
  const servers = options.servers || configuredServers();
  const keepservers = [...servers];
  const updateServers = options.updateServers || updatefrommaster;
  let serverRefresh;
  let connectionCount = 0;
  const allowedOrigins = new Set((process.env.SAUER_RELAY_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
  const trustedProxies = parseTrustedProxies(options.trustedProxies ?? process.env.SAUER_RELAY_TRUSTED_PROXIES ?? DEFAULT_TRUSTED_PROXIES);
  const connectionsByAddress = new Map();
  const connectionsByProtectionKey = new Map();
  const teamkillsByProtectionKey = new Map();
  const cooldownsByProtectionKey = new Map();
  const teamkillProtection = resolveTeamkillProtection(options.teamkillProtection);
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_DATAGRAM_BYTES, perMessageDeflate: false });
  const refreshAllowedServers = () => {
    serverRefresh ??= updateServers(keepservers).then((updated) => {
      servers.splice(0, servers.length, ...updated);
    }).finally(() => { serverRefresh = undefined; });
    return serverRefresh;
  };

  void refreshAllowedServers().catch((error) => {
    console.warn(`Could not initialize Sauerbraten master server list: ${error instanceof Error ? error.message : String(error)}`);
  });

  httpServer.on("upgrade", async (request, socket, head) => {
    const url = new URL(request.url || "/", "http://relay.invalid");
    if (url.pathname !== "/relay") return;
    const origin = request.headers.origin || "";
    const remoteAddress = resolveClientAddress(request, trustedProxies);
    const key = `${url.searchParams.get("server") || ""}:${Number(url.searchParams.get("port"))}`;
    const serverInfo = url.searchParams.get("info") === "1";
    let target = servers.find((server) => `${server.host}:${server.port}` === key);
    if (!target) {
      try { await refreshAllowedServers(); } catch {}
      target = servers.find((server) => `${server.host}:${server.port}` === key);
    }
    const remoteConnections = connectionsByAddress.get(remoteAddress) || 0;
    if (!target || connectionCount >= MAX_CONNECTIONS || remoteConnections >= MAX_CONNECTIONS_PER_ADDRESS ||
        (allowedOrigins.size && !allowedOrigins.has(origin)) || socket.destroyed) {
      if (socket.destroyed) return;
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    connectionCount++;
    connectionsByAddress.set(remoteAddress, remoteConnections + 1);
    try {
      webSockets.handleUpgrade(request, socket, head, (webSocket) => {
        webSockets.emit("connection", webSocket, request, target, remoteAddress, `${remoteAddress}|${key}`, serverInfo);
      });
    } catch (error) {
      releaseConnection(remoteAddress);
      throw error;
    }
  });

  const releaseConnection = (remoteAddress) => {
    connectionCount = Math.max(0, connectionCount - 1);
    const remaining = (connectionsByAddress.get(remoteAddress) || 1) - 1;
    if (remaining > 0) connectionsByAddress.set(remoteAddress, remaining);
    else connectionsByAddress.delete(remoteAddress);
  };

  webSockets.on("connection", (webSocket, _request, target, remoteAddress, protectionKey, serverInfo) => {
    const udp = dgram.createSocket("udp4");
    let closed = false;
    let windowStarted = Date.now();
    let packets = 0;
    let bytes = 0;
    const protectedConnections = connectionsByProtectionKey.get(protectionKey) ?? new Set();
    protectedConnections.add(webSocket);
    connectionsByProtectionKey.set(protectionKey, protectedConnections);
    const close = () => {
      if (closed) return;
      closed = true;
      try { udp.close(); } catch {}
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000);
      protectedConnections.delete(webSocket);
      if (!protectedConnections.size) connectionsByProtectionKey.delete(protectionKey);
      releaseConnection(remoteAddress);
    };
    udp.on("message", (datagram) => {
      if (datagram.length <= MAX_DATAGRAM_BYTES && webSocket.readyState === WebSocket.OPEN) webSocket.send(datagram, { binary: true });
    });
    udp.on("error", close);
    webSocket.on("message", (payload, isBinary) => {
      if (!isBinary) {
        handleTeamkillReport(payload, protectionKey);
        return;
      }
      const datagram = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
      const now = Date.now();
      if (now - windowStarted >= 1000) {
        windowStarted = now;
        packets = bytes = 0;
      }
      packets++;
      bytes += datagram.length;
      if (!isBinary || !datagram.length || datagram.length > MAX_DATAGRAM_BYTES || packets > MAX_PACKETS_PER_SECOND ||
          bytes > MAX_BYTES_PER_SECOND) {
        webSocket.close(1008, "Relay traffic limit exceeded");
        return;
      }
      udp.send(datagram);
    });
    webSocket.on("close", close);
    webSocket.on("error", close);
    const cooldownRemaining = (cooldownsByProtectionKey.get(protectionKey) ?? 0) - Date.now();
    if (cooldownRemaining > 0) {
      const notify = setTimeout(() => {
        if (webSocket.readyState !== WebSocket.OPEN) return;
        webSocket.send(JSON.stringify({ type: "teamkill-disconnect", cooldownMilliseconds: cooldownRemaining }));
        const disconnect = setTimeout(() => webSocket.close(4001, "Teamkill protection cooldown"), 250);
        disconnect.unref();
      }, 10);
      notify.unref();
      return;
    }
    udp.connect(target.port + (serverInfo ? 1 : 0), target.host);
  });

  return { servers, close: () => webSockets.close() };

  function handleTeamkillReport(payload, protectionKey) {
    if (payload.length > 128) return;
    let report;
    try { report = JSON.parse(payload.toString()); } catch { return; }
    if (report?.type !== "teamkill") return;
    const now = Date.now();
    if ((cooldownsByProtectionKey.get(protectionKey) ?? 0) > now) return;
    const cutoff = now - teamkillProtection.windowMilliseconds;
    const timestamps = (teamkillsByProtectionKey.get(protectionKey) ?? []).filter((timestamp) => timestamp > cutoff && timestamp <= now);
    timestamps.push(now);
    teamkillsByProtectionKey.set(protectionKey, timestamps);
    if (timestamps.length === teamkillProtection.warningThreshold) {
      broadcastControl(protectionKey, { type: "teamkill-warning", count: timestamps.length });
    }
    if (timestamps.length < teamkillProtection.disconnectThreshold) return;
    cooldownsByProtectionKey.set(protectionKey, now + teamkillProtection.cooldownMilliseconds);
    broadcastControl(protectionKey, { type: "teamkill-disconnect", cooldownMilliseconds: teamkillProtection.cooldownMilliseconds });
    for (const connection of connectionsByProtectionKey.get(protectionKey) ?? []) {
      const timer = setTimeout(() => connection.close(4001, "Teamkill protection cooldown"), 250);
      timer.unref();
    }
  }

  function broadcastControl(protectionKey, message) {
    const payload = JSON.stringify(message);
    for (const connection of connectionsByProtectionKey.get(protectionKey) ?? []) {
      if (connection.readyState === WebSocket.OPEN) connection.send(payload);
    }
  }
}

export function resolveTeamkillProtection(config = {}, environment = process.env) {
  const integer = (value, fallback) => {
    const parsed = Number(value);
    return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
  };
  const warningThreshold = integer(config.warningThreshold ?? environment.SAUER_RELAY_TEAMKILL_WARNING,
    DEFAULT_TEAMKILL_WARNING_THRESHOLD);
  const disconnectThreshold = integer(config.disconnectThreshold ?? environment.SAUER_RELAY_TEAMKILL_DISCONNECT,
    DEFAULT_TEAMKILL_DISCONNECT_THRESHOLD);
  if (disconnectThreshold <= warningThreshold) throw new Error("The relay teamkill disconnect threshold must exceed its warning threshold.");
  return {
    warningThreshold,
    disconnectThreshold,
    windowMilliseconds: integer(config.windowMilliseconds ?? environment.SAUER_RELAY_TEAMKILL_WINDOW_MS,
      DEFAULT_TEAMKILL_WINDOW_MILLISECONDS),
    cooldownMilliseconds: integer(config.cooldownMilliseconds ?? environment.SAUER_RELAY_TEAMKILL_COOLDOWN_MS,
      DEFAULT_TEAMKILL_COOLDOWN_MILLISECONDS),
  };
}

export function attachPresence(httpServer, options = {}) {
  const staleMilliseconds = options.staleMilliseconds ?? PRESENCE_STALE_MILLISECONDS;
  const sweepMilliseconds = options.sweepMilliseconds ?? PRESENCE_SWEEP_MILLISECONDS;
  const allowedOrigins = new Set((process.env.SAUER_RELAY_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
  const sessions = new Map();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: 32, perMessageDeflate: false });
  const broadcast = () => {
    const message = JSON.stringify({ type: "presence", count: sessions.size });
    for (const session of sessions.values()) if (session.webSocket.readyState === WebSocket.OPEN) session.webSocket.send(message);
  };
  const remove = (id, webSocket) => {
    if (sessions.get(id)?.webSocket !== webSocket) return;
    sessions.delete(id);
    broadcast();
  };

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://relay.invalid");
    if (url.pathname !== "/presence") return;
    const id = url.searchParams.get("session") || "";
    const origin = request.headers.origin || "";
    if (!/^[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i.test(id) || (allowedOrigins.size && !allowedOrigins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => webSockets.emit("connection", webSocket, request, id));
  });

  webSockets.on("connection", (webSocket, _request, id) => {
    const previous = sessions.get(id)?.webSocket;
    sessions.set(id, { webSocket, lastHeartbeat: Date.now() });
    if (previous && previous !== webSocket) previous.terminate();
    webSocket.on("message", (payload, isBinary) => {
      if (isBinary || payload.toString() !== "heartbeat") {
        webSocket.close(1008, "Invalid presence heartbeat");
        return;
      }
      const session = sessions.get(id);
      if (session?.webSocket === webSocket) session.lastHeartbeat = Date.now();
    });
    webSocket.on("close", () => remove(id, webSocket));
    webSocket.on("error", () => remove(id, webSocket));
    broadcast();
  });

  const sweep = setInterval(() => {
    const cutoff = Date.now() - staleMilliseconds;
    let changed = false;
    for (const [id, session] of sessions) {
      if (session.lastHeartbeat >= cutoff) continue;
      sessions.delete(id);
      session.webSocket.terminate();
      changed = true;
    }
    if (changed) broadcast();
  }, sweepMilliseconds);
  sweep.unref();

  return {
    close: () => {
      clearInterval(sweep);
      for (const session of sessions.values()) session.webSocket.terminate();
      sessions.clear();
      webSockets.close();
    },
  };
}

export function resolveClientAddress(request, trustedProxies = parseTrustedProxies(DEFAULT_TRUSTED_PROXIES)) {
  const peerAddress = normalizeIpAddress(request.socket.remoteAddress) || "unknown";
  if (peerAddress === "unknown" || !isTrustedProxy(peerAddress, trustedProxies)) return peerAddress;
  const forwarded = request.headers["x-forwarded-for"];
  if (typeof forwarded !== "string" || !forwarded.trim()) return peerAddress;
  let address = peerAddress;
  for (const value of forwarded.split(",").map((entry) => entry.trim()).reverse()) {
    const candidate = normalizeIpAddress(value);
    if (!candidate) return peerAddress;
    address = candidate;
    if (!isTrustedProxy(address, trustedProxies)) return address;
  }
  return address;
}

export function parseTrustedProxies(value) {
  const entries = Array.isArray(value) ? value : String(value || "").split(",");
  return entries.map((entry) => parseNetwork(String(entry).trim())).filter(Boolean);
}

export async function queryConfiguredServers(servers = configuredServers()) {
  return Promise.all(servers.map(async (server) => ({ ...server, ...await queryServer(server) })));
}

// Original: src/engine/serverbrowser.cpp, pingservers() searchlan branch
export function discoverLanServers(timeout = 400) {
  return new Promise((resolve) => {
    const udp = dgram.createSocket("udp4");
    const servers = new Map();
    const started = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      try { udp.close(); } catch {}
      resolve([...servers.values()]);
    };
    const timer = setTimeout(finish, timeout);
    udp.on("message", (datagram, remote) => {
      try {
        const port = remote.port - 1;
        if (port < 1) return;
        const server = { host: remote.address, port, label: remote.address, keep: false, ...decodeServerInfo(datagram, Date.now() - started) };
        servers.set(`${server.host}:${server.port}`, server);
      } catch {}
    });
    udp.once("error", () => {
      clearTimeout(timer);
      finish();
    });
    udp.bind(0, () => {
      try {
        udp.setBroadcast(true);
        udp.send(Buffer.from([1]), DEFAULT_LAN_INFO_PORT, "255.255.255.255");
      } catch {
        clearTimeout(timer);
        finish();
      }
    });
  });
}

// Original: src/engine/serverbrowser.cpp, retrieveservers()
export function retrieveservers(environment = process.env) {
  const mastername = environment.SAUER_MASTER_SERVER || DEFAULT_MASTER_NAME;
  const masterport = parsePort(environment.SAUER_MASTER_PORT, DEFAULT_MASTER_PORT, "SAUER_MASTER_PORT");
  const timeout = parsePositiveInteger(environment.SAUER_MASTER_TIMEOUT, RETRIEVELIMIT, "SAUER_MASTER_TIMEOUT");
  return new Promise((resolve, reject) => {
    const chunks = [];
    let length = 0;
    let settled = false;
    const socket = net.createConnection({ host: mastername, port: masterport });
    const finish = (error) => {
      if (settled) return;
      settled = true;
      socket.destroy();
      if (error) reject(error);
      else resolve(Buffer.concat(chunks, length).toString("utf8"));
    };
    socket.setTimeout(timeout, () => finish(new Error(`Master server ${mastername}:${masterport} timed out.`)));
    socket.once("connect", () => socket.write("list\n"));
    socket.on("data", (chunk) => {
      length += chunk.length;
      if (length > MAX_MASTER_RESPONSE_BYTES) {
        finish(new Error(`Master server ${mastername}:${masterport} returned too much data.`));
        return;
      }
      chunks.push(chunk);
    });
    socket.once("end", () => finish());
    socket.once("error", (error) => finish(error));
  });
}

export function parseMasterServerList(data) {
  const servers = [];
  const seen = new Set();
  for (const line of data.split("\n")) {
    const match = /^addserver\s+(\S+)\s+(\d+)\s*$/.exec(line.trim());
    if (!match) continue;
    const host = match[1];
    const port = Number(match[2]);
    if (!validMasterHost(host) || !Number.isInteger(port) || port < 1 || port > 65_534) continue;
    const key = `${host}:${port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    servers.push({ host, port, label: host });
  }
  return servers;
}

// Original: src/engine/serverbrowser.cpp, updatefrommaster()
export async function updatefrommaster(keepservers = configuredServers(), environment = process.env) {
  const discovered = parseMasterServerList(await retrieveservers(environment));
  const result = [];
  const seen = new Set();
  for (const server of [...keepservers, ...discovered]) {
    const key = `${server.host}:${server.port}`;
    if (seen.has(key)) continue;
    seen.add(key);
    result.push(server);
  }
  return result;
}

export function serverListMiddleware(servers = configuredServers(), environment = process.env) {
  const keepservers = servers.map((server) => ({ ...server, keep: true }));
  return async (request, response) => {
    try {
      try {
        const updated = await updatefrommaster(keepservers, environment);
        servers.splice(0, servers.length, ...updated);
      } catch (error) {
        console.warn(`Could not update from Sauerbraten master server: ${error instanceof Error ? error.message : String(error)}`);
      }
      const searchlan = new URL(request.url || "/", "http://relay.invalid").searchParams.get("searchlan") === "1";
      const targetsOnly = new URL(request.url || "/", "http://relay.invalid").searchParams.get("targets") === "1";
      if (targetsOnly) {
        if (searchlan) {
          const lanServers = await discoverLanServers();
          for (const server of lanServers) {
            if (!servers.some((candidate) => candidate.host === server.host && candidate.port === server.port)) servers.push(server);
          }
        }
        response.setHeader("Content-Type", "application/json; charset=utf-8");
        response.setHeader("Cache-Control", "no-store");
        response.end(JSON.stringify(servers));
        return;
      }
      const queried = await queryConfiguredServers(servers);
      if (searchlan) {
        const lanServers = await discoverLanServers();
        const known = new Set(queried.map((server) => `${server.host}:${server.port}`));
        for (const server of lanServers) {
          if (!known.has(`${server.host}:${server.port}`)) queried.push(server);
          if (!servers.some((candidate) => candidate.host === server.host && candidate.port === server.port)) servers.push(server);
        }
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(queried));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
}

function validMasterHost(host) {
  return host.length <= 253 && !/[\s/\\?#@\[\]]/.test(host) && (net.isIP(host) !== 0 ||
    host.split(".").every((label) => label.length > 0 && label.length <= 63 && /^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(label)));
}

function normalizeIpAddress(value) {
  if (typeof value !== "string") return undefined;
  let address = value.trim();
  if (address.startsWith("[") && address.endsWith("]")) address = address.slice(1, -1);
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  const mapped = /^::ffff:(\d+\.\d+\.\d+\.\d+)$/i.exec(address);
  if (mapped && net.isIP(mapped[1]) === 4) return mapped[1];
  return net.isIP(address) ? address.toLowerCase() : undefined;
}

function parseNetwork(entry) {
  if (!entry) return undefined;
  const slash = entry.indexOf("/");
  const address = normalizeIpAddress(slash === -1 ? entry : entry.slice(0, slash));
  if (!address) throw new Error(`Invalid trusted proxy address: ${entry}`);
  const parsed = ipToBigInt(address);
  const prefix = slash === -1 ? parsed.bits : Number(entry.slice(slash + 1));
  if (!Number.isInteger(prefix) || prefix < 0 || prefix > parsed.bits) throw new Error(`Invalid trusted proxy network: ${entry}`);
  const shift = BigInt(parsed.bits - prefix);
  return { family: parsed.family, prefix, network: (parsed.value >> shift) << shift };
}

function isTrustedProxy(address, networks) {
  const parsed = ipToBigInt(address);
  return networks.some((network) => {
    if (network.family !== parsed.family) return false;
    const shift = BigInt(parsed.bits - network.prefix);
    return ((parsed.value >> shift) << shift) === network.network;
  });
}

function ipToBigInt(address) {
  if (net.isIP(address) === 4) {
    return { family: 4, bits: 32, value: address.split(".").reduce((value, octet) => value << 8n | BigInt(octet), 0n) };
  }
  let source = address;
  if (source.includes(".")) {
    const lastColon = source.lastIndexOf(":");
    const ipv4 = ipToBigInt(source.slice(lastColon + 1)).value;
    source = `${source.slice(0, lastColon)}:${(ipv4 >> 16n).toString(16)}:${(ipv4 & 0xFFFFn).toString(16)}`;
  }
  const halves = source.split("::");
  if (halves.length > 2) throw new Error(`Invalid IP address: ${address}`);
  const left = halves[0] ? halves[0].split(":") : [];
  const right = halves.length === 2 && halves[1] ? halves[1].split(":") : [];
  const zeros = halves.length === 2 ? 8 - left.length - right.length : 0;
  const groups = [...left, ...Array.from({ length: zeros }, () => "0"), ...right];
  if (groups.length !== 8) throw new Error(`Invalid IP address: ${address}`);
  return { family: 6, bits: 128, value: groups.reduce((value, group) => value << 16n | BigInt(`0x${group}`), 0n) };
}

function parsePort(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const port = Number(value);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) throw new Error(`Invalid ${name}: ${value}`);
  return port;
}

function parsePositiveInteger(value, fallback, name) {
  if (value === undefined || value === "") return fallback;
  const number = Number(value);
  if (!Number.isInteger(number) || number < 1) throw new Error(`Invalid ${name}: ${value}`);
  return number;
}

async function queryServer(server) {
  const started = Date.now();
  return new Promise((resolve) => {
    const udp = dgram.createSocket("udp4");
    const finish = (value) => {
      clearTimeout(timer);
      try { udp.close(); } catch {}
      resolve(value);
    };
    const timer = setTimeout(() => finish({ ping: null, online: false }), 1200);
    udp.once("error", () => finish({ ping: null, online: false }));
    udp.once("message", (datagram) => {
      try {
        finish(decodeServerInfo(datagram, Date.now() - started));
      } catch {
        finish({ ping: null, online: false });
      }
    });
    udp.send(Buffer.from([1]), server.port + 1, server.host);
  });
}

function decodeServerInfo(datagram, ping) {
  const reader = packetReader(datagram);
  reader.int();
  const numPlayers = reader.int();
  const attributeCount = reader.int();
  const attributes = Array.from({ length: Math.max(0, Math.min(64, attributeCount)) }, () => reader.int());
  return { ping, online: true, numPlayers, attributes, map: reader.string(), description: reader.string() };
}

function packetReader(bytes) {
  let offset = 0;
  const byte = () => {
    if (offset >= bytes.length) throw new RangeError("Truncated server info packet");
    return bytes[offset++];
  };
  const int = () => {
    const marker = byte() << 24 >> 24;
    if (marker === -128) return (byte() | ((byte() << 24 >> 24) << 8)) << 16 >> 16;
    if (marker === -127) return byte() | (byte() << 8) | (byte() << 16) | (byte() << 24);
    return marker;
  };
  const string = () => {
    const result = [];
    for (let value = int(); value; value = int()) if (result.length < 259) result.push(value & 0xFF);
    return new TextDecoder().decode(Uint8Array.from(result));
  };
  return { int, string };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const port = Number(process.env.SAUER_RELAY_PORT || 8080);
  const servers = configuredServers();
  const listServers = serverListMiddleware(servers);
  const handler = (request, response) => {
    const url = new URL(request.url || "/", "http://relay.invalid");
    if (url.pathname === "/api/servers") void listServers(request, response);
    else if (url.pathname === "/health") { response.statusCode = 204; response.end(); }
    else { response.statusCode = 404; response.end("Not found"); }
  };
  const server = process.env.SAUER_RELAY_TLS_KEY && process.env.SAUER_RELAY_TLS_CERT ? https.createServer({
    key: fs.readFileSync(process.env.SAUER_RELAY_TLS_KEY), cert: fs.readFileSync(process.env.SAUER_RELAY_TLS_CERT),
  }, handler) : http.createServer(handler);
  attachSauerRelay(server, { servers });
  attachPresence(server);
  server.listen(port, () => console.log(`SauerWeb relay listening on ${port}`));
}
