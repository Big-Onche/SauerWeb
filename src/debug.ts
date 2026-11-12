import "./style.css";
import { SauerMapParser } from "./engine/worldio";
import type { SauerMap } from "./engine/octa";
import { loadTextureManifest, resolveMapTextures } from "./assets/TextureResolver";
import { MapScene, type SceneStats, type ViewportTuning } from "./render/MapScene";
import { PhysicsState } from "./engine/physics/types";
import { FpsHud } from "./platform/browser/FpsHud";

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
        <div class="view-buttons">
          <button id="camera-mode" class="icon-button" type="button" aria-pressed="false" title="Use native player physics (F2)">♙</button>
          <button id="physics-pause" class="icon-button" type="button" aria-pressed="false" title="Pause player physics (P)" hidden>Ⅱ</button>
          <button id="physics-reset" class="icon-button" type="button" title="Reset player to spawn (R)" hidden>↺</button>
          <button id="entities" class="icon-button" type="button" aria-pressed="false"
            title="Toggle entity debug markers">◎</button>
          <button id="materials" class="icon-button" type="button" aria-pressed="false" title="Toggle material-volume debug view">◩</button>
          <button id="wireframe" class="icon-button" type="button" aria-pressed="false" title="Toggle wireframe">◇</button>
          <button id="settings-toggle" class="icon-button settings-toggle" type="button" aria-expanded="false" aria-controls="viewport-settings"
            title="Viewport settings">
            <svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M6 14v6" /></svg>
          </button>
        </div>
      </div>
      <section id="viewport-settings" class="viewport-settings" aria-labelledby="settings-title" hidden>
        <header>
          <div><p class="eyebrow">DISPLAY</p><h3 id="settings-title">Viewport settings</h3></div>
          <button id="settings-reset" type="button">Reset</button>
        </header>
        <label class="setting-row" for="contrast">
          <span><strong>Contrast</strong><output id="contrast-value" for="contrast">100%</output></span>
          <input id="contrast" type="range" min="0.5" max="1.5" value="1" step="0.01" />
        </label>
        <label class="setting-row" for="gamma">
          <span><strong>Gamma</strong><output id="gamma-value" for="gamma">1.00</output></span>
          <input id="gamma" type="range" min="0.5" max="2" value="1" step="0.01" />
        </label>
        <label class="setting-row" for="vibrance">
          <span><strong>Vibrance</strong><output id="vibrance-value" for="vibrance">100%</output></span>
          <input id="vibrance" type="range" min="0" max="2" value="1" step="0.01" />
        </label>
        <label class="setting-check" for="thirdperson">
          <span><strong>Third-person view</strong><small>Show your player model</small></span>
          <input id="thirdperson" type="checkbox" />
        </label>
        <label class="setting-check" for="teamskins">
          <span><strong>Team skins</strong><small>Blue allies, red enemies</small></span>
          <input id="teamskins" type="checkbox" />
        </label>
        <p class="settings-hint">Adjustments are saved on this device.</p>
      </section>
      <div id="empty-state" class="empty-state">
        <div class="octa" aria-hidden="true"><span></span></div>
        <p class="eyebrow">READY TO EXPLORE</p>
        <h2>Pick a world from the archive</h2>
        <p>Load native Sauerbraten geometry, then fly through it with WASD and the mouse.</p>
      </div>
      <div id="loading" class="loading" hidden><span></span><p>Reading octree…</p></div>
      <div id="error" class="error" hidden></div>
      <div id="stats" class="stats" hidden></div>
      <div id="physics-debug" class="physics-debug" hidden></div>
      <details id="model-report" class="model-report" hidden><summary></summary><ul></ul></details>
      <div id="controls" class="controls"><kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span><i></i><span>Mouse to look</span></div>
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
const materials = required<HTMLButtonElement>("#materials");
const entities = required<HTMLButtonElement>("#entities");
const cameraMode = required<HTMLButtonElement>("#camera-mode");
const physicsPause = required<HTMLButtonElement>("#physics-pause");
const physicsReset = required<HTMLButtonElement>("#physics-reset");
const physicsDebug = required<HTMLDivElement>("#physics-debug");
const controls = required<HTMLDivElement>("#controls");
const modelReport = required<HTMLDetailsElement>("#model-report");
const settingsToggle = required<HTMLButtonElement>("#settings-toggle");
const settingsPanel = required<HTMLElement>("#viewport-settings");
const settingsReset = required<HTMLButtonElement>("#settings-reset");
const contrastInput = required<HTMLInputElement>("#contrast");
const gammaInput = required<HTMLInputElement>("#gamma");
const vibranceInput = required<HTMLInputElement>("#vibrance");
const thirdpersonInput = required<HTMLInputElement>("#thirdperson");
const teamskinsInput = required<HTMLInputElement>("#teamskins");
const contrastValue = required<HTMLOutputElement>("#contrast-value");
const gammaValue = required<HTMLOutputElement>("#gamma-value");
const vibranceValue = required<HTMLOutputElement>("#vibrance-value");
const parser = new SauerMapParser();
const mapScene = new MapScene(canvas, "debug");
const fpsHud = new FpsHud(required<HTMLElement>(".viewport-panel"));
const launchParameters = new URLSearchParams(location.search);
const multiplayerHost = launchParameters.get("server");
const multiplayerPort = Number(launchParameters.get("port") || 28785);
if (!multiplayerHost) mapScene.enableDebugLoadout();
mapScene.setPlayerModel(savedPlayerModel());
let maps: MapListItem[] = [];
let activeMapName = "";
let multiplayerConnected = false;
const viewportSettingsStorageKey = "sauerweb.viewport-settings";
const defaultViewportTuning: ViewportTuning = { contrast: 1, gamma: 1, vibrance: 1 };
const gameplaySettingsStorageKey = "sauerweb.gameplay-settings";

void loadMapIndex();
setViewportTuning(readViewportTuning());
setGameplaySettings(readGameplaySettings());
mapScene.onMultiplayer((event) => {
  if (event.type === "map-change" && event.map && event.map.toLocaleLowerCase() !== activeMapName.toLocaleLowerCase()) {
    const available = maps.find((map) => map.supported && map.name.toLocaleLowerCase() === event.map.toLocaleLowerCase());
    if (available) void loadBundledMap(available.name);
  }
});

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
materials.addEventListener("click", () => {
  const enabled = materials.getAttribute("aria-pressed") !== "true";
  materials.setAttribute("aria-pressed", String(enabled));
  mapScene.setMaterialDebug(enabled);
});
entities.addEventListener("click", () => {
  const enabled = entities.getAttribute("aria-pressed") !== "true";
  entities.setAttribute("aria-pressed", String(enabled));
  mapScene.setEntityDebug(enabled);
});
cameraMode.addEventListener("click", () => toggleCameraMode());
physicsPause.addEventListener("click", () => togglePhysicsPause());
physicsReset.addEventListener("click", () => mapScene.resetPlayer());
settingsToggle.addEventListener("click", () => setSettingsOpen(settingsPanel.hidden));
settingsReset.addEventListener("click", () => setViewportTuning(defaultViewportTuning));
[contrastInput, gammaInput, vibranceInput].forEach((input) => input.addEventListener("input", updateViewportTuning));
thirdpersonInput.addEventListener("change", updateGameplaySettings);
teamskinsInput.addEventListener("change", updateGameplaySettings);
document.addEventListener("pointerdown", (event) => {
  if (!settingsPanel.hidden && event.target instanceof Node && !settingsPanel.contains(event.target) && !settingsToggle.contains(event.target)) {
    setSettingsOpen(false);
  }
});
window.addEventListener("keydown", (event) => {
  if (event.code === "Escape" && !settingsPanel.hidden) setSettingsOpen(false);
  else if (event.code === "F2") {
    event.preventDefault();
    toggleCameraMode();
  } else if (mapScene.currentCameraMode() === "player" && event.code === "KeyP") togglePhysicsPause();
  else if (mapScene.currentCameraMode() === "player" && event.code === "KeyR") mapScene.resetPlayer();
});
window.setInterval(() => updatePhysicsDebug(), 100);
window.addEventListener("pagehide", () => { mapScene.dispose(); fpsHud.dispose(); }, { once: true });

function setSettingsOpen(open: boolean): void {
  settingsPanel.hidden = !open;
  settingsToggle.setAttribute("aria-expanded", String(open));
  settingsToggle.classList.toggle("active", open);
  if (open) contrastInput.focus();
}

function updateViewportTuning(): void {
  setViewportTuning({
    contrast: Number(contrastInput.value),
    gamma: Number(gammaInput.value),
    vibrance: Number(vibranceInput.value),
  });
}

function setViewportTuning(tuning: ViewportTuning): void {
  contrastInput.value = String(tuning.contrast);
  gammaInput.value = String(tuning.gamma);
  vibranceInput.value = String(tuning.vibrance);
  contrastValue.value = `${Math.round(tuning.contrast * 100)}%`;
  gammaValue.value = tuning.gamma.toFixed(2);
  vibranceValue.value = `${Math.round(tuning.vibrance * 100)}%`;
  mapScene.setViewportTuning(tuning);
  try {
    localStorage.setItem(viewportSettingsStorageKey, JSON.stringify(tuning));
  } catch {
    // The viewport remains adjustable when storage is unavailable.
  }
}

function updateGameplaySettings(): void {
  setGameplaySettings({ thirdperson: thirdpersonInput.checked, teamskins: teamskinsInput.checked });
}

function setGameplaySettings(settings: { thirdperson: boolean; teamskins: boolean }): void {
  thirdpersonInput.checked = settings.thirdperson;
  teamskinsInput.checked = settings.teamskins;
  mapScene.setThirdPerson(settings.thirdperson);
  mapScene.setTeamSkins(settings.teamskins);
  try {
    localStorage.setItem(gameplaySettingsStorageKey, JSON.stringify(settings));
  } catch {
    // Gameplay settings remain adjustable when storage is unavailable.
  }
}

function readGameplaySettings(): { thirdperson: boolean; teamskins: boolean } {
  try {
    const stored = JSON.parse(localStorage.getItem(gameplaySettingsStorageKey) ?? "null") as Record<string, unknown> | null;
    return { thirdperson: stored?.thirdperson === true, teamskins: stored?.teamskins === true };
  } catch {
    return { thirdperson: false, teamskins: false };
  }
}

function readViewportTuning(): ViewportTuning {
  try {
    const stored = JSON.parse(localStorage.getItem(viewportSettingsStorageKey) ?? "null") as Partial<ViewportTuning> | null;
    return {
      contrast: settingValue(stored?.contrast, 0.5, 1.5),
      gamma: settingValue(stored?.gamma, 0.5, 2),
      vibrance: settingValue(stored?.vibrance, 0, 2),
    };
  } catch {
    return { ...defaultViewportTuning };
  }
}

function settingValue(value: unknown, minimum: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, value)) : 1;
}

async function loadMapIndex(): Promise<void> {
  try {
    const response = await fetch("/api/maps", { cache: "no-store" });
    if (!response.ok) throw new Error(`Map index returned ${response.status}.`);
    maps = await response.json() as MapListItem[];
    renderMapList();
    const requestedMap = new URLSearchParams(location.search).get("map");
    const requested = requestedMap ? maps.find((map) => map.name.toLocaleLowerCase() === requestedMap.toLocaleLowerCase() && map.supported) : undefined;
    if (requested) void loadBundledMap(requested.name);
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
    if (map.supported) button.addEventListener("click", () => void loadBundledMap(map.name));
    else button.title = `Map format ${map.version ?? "unknown"} is listed but not supported yet`;
    return button;
  }));
}

function loadBundledMap(name: string): Promise<void> {
  return loadMap(name, async () => {
    const response = await fetch(`/api/maps/${encodeURIComponent(name)}.ogz`);
    if (!response.ok) throw new Error(`Could not fetch ${name}.ogz (${response.status}).`);
    return response.arrayBuffer();
  });
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
    const sceneStats = await mapScene.loadMap(map, textures, manifest.skybox, manifest.lighting, manifest.fog, manifest.mapModels ?? [],
      manifest.entityModels?.teleporter, manifest.mapSounds ?? []);
    if (manifest.unsupported.length) console.warn("Unsupported Sauerbraten configuration commands", manifest.unsupported);
    showLoadedMap(map, sceneStats);
    activeMapName = name;
    renderMapList();
    if (multiplayerHost && !multiplayerConnected) {
      multiplayerConnected = true;
      await mapScene.connectMultiplayer({ host: multiplayerHost, port: multiplayerPort, playerName: savedPlayerName(),
        playerModel: savedPlayerModel(),
        map: name, mode: 3 });
    }
  } catch (caught) {
    const message = caught instanceof Error ? caught.message : String(caught);
    error.textContent = message;
    error.hidden = false;
  } finally {
    setBusy(false);
  }
}

function savedPlayerName(): string {
  try { return localStorage.getItem("sauerweb.player-name") || "unnamed"; } catch { return "unnamed"; }
}

function savedPlayerModel(): number {
  try {
    const model = Number(localStorage.getItem("sauerweb.player-model"));
    return Number.isInteger(model) && model >= 0 && model < 5 ? model : 0;
  } catch {
    return 0;
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
    <div><strong>${sceneStats.materialVolumes.toLocaleString()}</strong><span>material volumes</span></div>
    <div><strong>v${map.header.version}</strong><span>format</span></div>
  `;
  modelReport.hidden = sceneStats.mapModelIssues.length === 0;
  const summary = modelReport.querySelector("summary");
  const list = modelReport.querySelector("ul");
  if (summary) summary.textContent = `${sceneStats.mapModelIssues.length} mapmodel asset issue${sceneStats.mapModelIssues.length === 1 ? "" : "s"}`;
  if (list) list.innerHTML = sceneStats.mapModelIssues.map((issue) => `<li>${escapeHtml(issue)}</li>`).join("");
}

function setBusy(busy: boolean): void {
  loading.hidden = !busy;
  error.hidden = true;
  if (busy) modelReport.hidden = true;
}

function toggleCameraMode(): void {
  const playerMode = mapScene.currentCameraMode() !== "player";
  mapScene.setCameraMode(playerMode ? "player" : "free");
  cameraMode.setAttribute("aria-pressed", String(playerMode));
  cameraMode.title = playerMode ? "Use developer free camera (F2)" : "Use native player physics (F2)";
  physicsDebug.hidden = !playerMode;
  physicsPause.hidden = !playerMode;
  physicsReset.hidden = !playerMode;
  controls.innerHTML = playerMode
    ? `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Move</span><i></i><span>Mouse 1 fire · wheel/1–7 weapons</span><i></i><kbd>F2</kbd><span>Free camera</span>`
    : `<kbd>W</kbd><kbd>A</kbd><kbd>S</kbd><kbd>D</kbd><span>Fly</span><i></i><kbd>F2</kbd><span>Player physics</span>`;
}

function togglePhysicsPause(): void {
  const paused = physicsPause.getAttribute("aria-pressed") !== "true";
  physicsPause.setAttribute("aria-pressed", String(paused));
  physicsPause.textContent = paused ? "▶" : "Ⅱ";
  mapScene.setPhysicsPaused(paused);
}

function updatePhysicsDebug(): void {
  if (physicsDebug.hidden) return;
  const snapshot = mapScene.physicsDebugSnapshot();
  const player = snapshot.entity;
  const formatVector = (value: SauerMap["entities"][number]["position"]) => `${value.x.toFixed(3)} ${value.y.toFixed(3)} ${value.z.toFixed(3)}`;
  physicsDebug.innerHTML = `
    <header><strong>PHYSENT</strong><span>${snapshot.paused ? "PAUSED" : `${snapshot.steps} × ${snapshot.stepMilliseconds} ms`}</span></header>
    <dl>
      <dt>state</dt><dd>${PhysicsState[player.physicsState]}</dd>
      <dt>origin</dt><dd>${formatVector(player.position)}</dd>
      <dt>render</dt><dd>${formatVector(snapshot.renderPosition)}</dd>
      <dt>velocity</dt><dd>${formatVector(player.velocity)}</dd>
      <dt>falling</dt><dd>${formatVector(player.falling)}</dd>
      <dt>floor</dt><dd>${formatVector(player.floor)}</dd>
      <dt>air</dt><dd>${player.timeInAir} ms</dd>
      <dt>interp</dt><dd>${snapshot.interpolation.toFixed(3)}</dd>
    </dl>`;
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
