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

export function configuredServers(environment = process.env) {
  const value = environment.SAUER_RELAY_SERVERS || "127.0.0.1:28785";
  return value.split(",").map((entry) => entry.trim()).filter(Boolean).map((entry) => {
    const [address, label] = entry.split("=", 2);
    const match = /^(.+):(\d+)$/.exec(address);
    if (!match) throw new Error(`Invalid SAUER_RELAY_SERVERS entry: ${entry}`);
    const port = Number(match[2]);
    if (!Number.isInteger(port) || port < 1 || port > 65_534) throw new Error(`Invalid Sauerbraten port: ${match[2]}`);
    return { host: match[1], port, label: label || match[1] };
  });
}

export function attachSauerRelay(httpServer, options = {}) {
  const servers = options.servers || configuredServers();
  const allowedOrigins = new Set((process.env.SAUER_RELAY_ORIGINS || "").split(",").map((value) => value.trim()).filter(Boolean));
  const connectionsByAddress = new Map();
  const webSockets = new WebSocketServer({ noServer: true, maxPayload: MAX_DATAGRAM_BYTES, perMessageDeflate: false });

  httpServer.on("upgrade", (request, socket, head) => {
    const url = new URL(request.url || "/", "http://relay.invalid");
    if (url.pathname !== "/relay") return;
    const origin = request.headers.origin || "";
    const remoteAddress = request.socket.remoteAddress || "unknown";
    const remoteConnections = connectionsByAddress.get(remoteAddress) || 0;
    const key = `${url.searchParams.get("server") || ""}:${Number(url.searchParams.get("port"))}`;
    const target = servers.find((server) => `${server.host}:${server.port}` === key);
    if (!target || webSockets.clients.size >= MAX_CONNECTIONS || remoteConnections >= MAX_CONNECTIONS_PER_ADDRESS ||
        (allowedOrigins.size && !allowedOrigins.has(origin))) {
      socket.write("HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n");
      socket.destroy();
      return;
    }
    webSockets.handleUpgrade(request, socket, head, (webSocket) => {
      connectionsByAddress.set(remoteAddress, remoteConnections + 1);
      webSockets.emit("connection", webSocket, request, target, remoteAddress);
    });
  });

  webSockets.on("connection", (webSocket, _request, target, remoteAddress) => {
    const udp = dgram.createSocket("udp4");
    let closed = false;
    let windowStarted = Date.now();
    let packets = 0;
    let bytes = 0;
    const close = () => {
      if (closed) return;
      closed = true;
      try { udp.close(); } catch {}
      if (webSocket.readyState === WebSocket.OPEN) webSocket.close(1000);
      const remaining = (connectionsByAddress.get(remoteAddress) || 1) - 1;
      if (remaining > 0) connectionsByAddress.set(remoteAddress, remaining);
      else connectionsByAddress.delete(remoteAddress);
    };
    udp.on("message", (datagram) => {
      if (datagram.length <= MAX_DATAGRAM_BYTES && webSocket.readyState === WebSocket.OPEN) webSocket.send(datagram, { binary: true });
    });
    udp.on("error", close);
    udp.connect(target.port, target.host);
    webSocket.on("message", (payload, isBinary) => {
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
  });

  return { servers, close: () => webSockets.close() };
}

export async function queryConfiguredServers(servers = configuredServers()) {
  return Promise.all(servers.map(async (server) => ({ ...server, ...await queryServer(server) })));
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
  const keepservers = [...servers];
  return async (_request, response) => {
    try {
      try {
        const updated = await updatefrommaster(keepservers, environment);
        servers.splice(0, servers.length, ...updated);
      } catch (error) {
        console.warn(`Could not update from Sauerbraten master server: ${error instanceof Error ? error.message : String(error)}`);
      }
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(await queryConfiguredServers(servers)));
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
        const reader = packetReader(datagram);
        reader.int();
        const numPlayers = reader.int();
        const attributeCount = reader.int();
        const attributes = Array.from({ length: Math.max(0, Math.min(64, attributeCount)) }, () => reader.int());
        finish({ ping: Date.now() - started, online: true, numPlayers, attributes, map: reader.string(), description: reader.string() });
      } catch {
        finish({ ping: null, online: false });
      }
    });
    udp.send(Buffer.from([1]), server.port + 1, server.host);
  });
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
  server.listen(port, () => console.log(`SauerWeb relay listening on ${port}`));
}
