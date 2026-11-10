import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { defineConfig, type Plugin } from "vite";

const mapsDirectory = path.resolve(".Sauerbraten/packages/base");

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
          response.end(JSON.stringify(cachedMaps));
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
        fs.createReadStream(filePath).pipe(response);
      });
    },
  };
}

export default defineConfig({
  plugins: [sauerMapsPlugin()],
  server: { host: "127.0.0.1" },
});
