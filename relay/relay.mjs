import dgram from "node:dgram";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import { fileURLToPath } from "node:url";
import { WebSocket, WebSocketServer } from "ws";

const MAX_DATAGRAM_BYTES = 65_535;
const MAX_CONNECTIONS = 64;
const MAX_CONNECTIONS_PER_ADDRESS = 4;
const MAX_PACKETS_PER_SECOND = 256;
const MAX_BYTES_PER_SECOND = 1_048_576;

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
  const allowed = new Map(servers.map((server) => [`${server.host}:${server.port}`, server]));
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
    const target = allowed.get(key);
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

export function serverListMiddleware(servers = configuredServers()) {
  return async (_request, response) => {
    try {
      response.setHeader("Content-Type", "application/json; charset=utf-8");
      response.setHeader("Cache-Control", "no-store");
      response.end(JSON.stringify(await queryConfiguredServers(servers)));
    } catch (error) {
      response.statusCode = 500;
      response.end(JSON.stringify({ error: error instanceof Error ? error.message : String(error) }));
    }
  };
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
  const handler = (request, response) => {
    const url = new URL(request.url || "/", "http://relay.invalid");
    if (url.pathname === "/api/servers") void serverListMiddleware()(request, response);
    else if (url.pathname === "/health") { response.statusCode = 204; response.end(); }
    else { response.statusCode = 404; response.end("Not found"); }
  };
  const server = process.env.SAUER_RELAY_TLS_KEY && process.env.SAUER_RELAY_TLS_CERT ? https.createServer({
    key: fs.readFileSync(process.env.SAUER_RELAY_TLS_KEY), cert: fs.readFileSync(process.env.SAUER_RELAY_TLS_CERT),
  }, handler) : http.createServer(handler);
  attachSauerRelay(server);
  server.listen(port, () => console.log(`SauerWeb relay listening on ${port}`));
}
