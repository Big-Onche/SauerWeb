import "./style.css";
import { SauerMapParser } from "./map/SauerMapParser";
import type { SauerMap } from "./map/types";
import { loadTextureManifest, resolveMapTextures } from "./assets/TextureResolver";
import { MapScene, type SceneStats } from "./render/MapScene";

interface MapListItem {
  name: string;
  size: number;
  version: number | null;
  supported: boolean;
}

const app = document.querySelector<HTMLDivElement>("#app");
if (!app) throw new Error("Missing app root.");

app.innerHTML = `
  <main class="shell">
    <aside class="sidebar">
      <header class="brand">
        <div class="brand-mark" aria-hidden="true">S</div>
        <div><h1>SauerWeb</h1><p>Octree map explorer</p></div>
      </header>
      <div class="toolbar">
        <label class="search"><span aria-hidden="true">⌕</span><input id="search" type="search" placeholder="Filter 331 maps…" autocomplete="off" /></label>
        <label class="upload" for="map-file">Open .ogz</label>
        <input id="map-file" type="file" accept=".ogz,application/gzip" hidden />
      </div>
      <div class="map-summary"><span id="map-count">Loading maps…</span><span class="legend"><i></i> v33</span></div>
      <div id="map-list" class="map-list" role="listbox" aria-label="Bundled maps"></div>
    </aside>
    <section class="viewport-panel">
      <canvas id="viewport" aria-label="Interactive 3D map viewport"></canvas>
      <div class="topbar">
        <div>
          <p class="eyebrow">CURRENT MAP</p>
          <h2 id="map-title">Choose a map</h2>
        </div>
        <button id="wireframe" class="icon-button" type="button" aria-pressed="false" title="Toggle wireframe">◇</button>
      </div>
      <div id="empty-state" class="empty-state">
        <div class="octa" aria-hidden="true"><span></span></div>
        <p class="eyebrow">READY TO EXPLORE</p>
        <h2>Pick a world from the archive</h2>
        <p>Load native Sauerbraten geometry, then fly through it with WASD and the mouse.</p>
      </div>
      <div id="loading" class="loading" hidden><span></span><p>Reading octree…</p></div>
      <div id="error" class="error" hidden></div>
      <div id="stats" class="stats" hidden></div>
      <div class="controls"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span><i></i><span>Mouse to look</span></div>
    </section>
  </main>
`;

const canvas = required<HTMLCanvasElement>("#viewport");
const mapList = required<HTMLDivElement>("#map-list");
const search = required<HTMLInputElement>("#search");
const fileInput = required<HTMLInputElement>("#map-file");
const title = required<HTMLHeadingElement>("#map-title");
const mapCount = required<HTMLSpanElement>("#map-count");
const emptyState = required<HTMLDivElement>("#empty-state");
const loading = required<HTMLDivElement>("#loading");
const error = required<HTMLDivElement>("#error");
const stats = required<HTMLDivElement>("#stats");
const wireframe = required<HTMLButtonElement>("#wireframe");
const parser = new SauerMapParser();
const mapScene = new MapScene(canvas);
let maps: MapListItem[] = [];
let activeMapName = "";

void loadMapIndex();

search.addEventListener("input", () => renderMapList());
fileInput.addEventListener("change", () => {
  const file = fileInput.files?.[0];
  if (file) void loadMap(file.name.replace(/\.ogz$/i, ""), () => file.arrayBuffer());
});
wireframe.addEventListener("click", () => {
  const enabled = wireframe.getAttribute("aria-pressed") !== "true";
  wireframe.setAttribute("aria-pressed", String(enabled));
  mapScene.setWireframe(enabled);
});

async function loadMapIndex(): Promise<void> {
  try {
    const response = await fetch("/api/maps", { cache: "no-store" });
    if (!response.ok) throw new Error(`Map index returned ${response.status}.`);
    maps = await response.json() as MapListItem[];
    renderMapList();
  } catch {
    mapCount.textContent = "Local archive unavailable";
    mapList.innerHTML = `<p class="list-message">Run the Vite dev server to browse bundled maps, or open an .ogz file above.</p>`;
  }
}

function renderMapList(): void {
  const query = search.value.trim().toLocaleLowerCase();
  const filtered = maps.filter((map) => map.name.toLocaleLowerCase().includes(query));
  const supported = maps.filter((map) => map.supported).length;
  mapCount.textContent = query ? `${filtered.length} matches` : `${maps.length} maps · ${supported} ready`;
  mapList.replaceChildren(...filtered.map((map) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `map-row${map.name === activeMapName ? " active" : ""}`;
    button.role = "option";
    button.setAttribute("aria-selected", String(map.name === activeMapName));
    button.disabled = !map.supported;
    button.innerHTML = `<span class="map-glyph">${map.supported ? "⬡" : "·"}</span><span><strong>${escapeHtml(map.name)}</strong><small>${formatBytes(map.size)}</small></span><em>v${map.version ?? "?"}</em>`;
    if (map.supported) button.addEventListener("click", () => void loadMap(map.name, async () => {
      const response = await fetch(`/api/maps/${encodeURIComponent(map.name)}.ogz`);
      if (!response.ok) throw new Error(`Could not fetch ${map.name}.ogz (${response.status}).`);
      return response.arrayBuffer();
    }));
    else button.title = `Map format ${map.version ?? "unknown"} is listed but not supported yet`;
    return button;
  }));
}

async function loadMap(name: string, readCompressed: () => Promise<ArrayBuffer>): Promise<void> {
  setBusy(true);
  try {
    const compressed = await readCompressed();
    const decompressed = await decompressGzip(compressed);
    await yieldToBrowser();
    const map = parser.parse(decompressed, name);
    const manifest = await loadTextureManifest(name);
    const textures = resolveMapTextures(map, manifest);
    const sceneStats = await mapScene.loadMap(map, textures, manifest.skybox, manifest.lighting);
    if (manifest.unsupported.length) console.warn("Unsupported Sauerbraten configuration commands", manifest.unsupported);
    showLoadedMap(map, sceneStats);
    activeMapName = name;
    renderMapList();
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error.textContent = message;
    error.hidden = false;
  } finally {
    setBusy(false);
  }
}

async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  if (!("DecompressionStream" in window)) throw new Error("This browser does not support gzip decompression streams.");
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
}

function showLoadedMap(map: SauerMap, sceneStats: SceneStats): void {
  title.textContent = map.name;
  emptyState.hidden = true;
  error.hidden = true;
  stats.hidden = false;
  stats.innerHTML = `
    <div><strong>${map.header.worldSize.toLocaleString()}</strong><span>world size</span></div>
    <div><strong>${sceneStats.triangles.toLocaleString()}</strong><span>triangles</span></div>
    <div><strong>${map.entities.length.toLocaleString()}</strong><span>entities</span></div>
    <div><strong>v${map.header.version}</strong><span>format</span></div>
  `;
}

function setBusy(busy: boolean): void {
  loading.hidden = !busy;
  error.hidden = true;
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function formatBytes(bytes: number): string {
  if (bytes < 1024 * 1024) return `${Math.round(bytes / 1024)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}

function yieldToBrowser(): Promise<void> {
  return new Promise((resolve) => requestAnimationFrame(() => resolve()));
}
