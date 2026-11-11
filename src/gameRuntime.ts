import "./style.css";
import { loadTextureManifest, resolveMapTextures } from "./assets/TextureResolver";
import { SauerMapParser } from "./engine/worldio";
import { gameModeName } from "./fpsgame/game";
import { MapScene } from "./render/MapScene";

const app = required<HTMLDivElement>("#app");
const parameters = new URLSearchParams(location.search);
const requestedMap = parameters.get("map") ?? "";
const server = parameters.get("server");
const port = Number(parameters.get("port") || 28785);
const requestedMode = Number(parameters.get("mode"));
const localGameMode = validGameMode(requestedMode) ? requestedMode : 0;

app.innerHTML = `
  <main class="game-shell">
    <section class="viewport-panel">
      <canvas id="viewport" aria-label="Sauerbraten game viewport"></canvas>
      <div id="game-loading" class="loading"><span></span><p>Loading ${escapeHtml(requestedMap || "map")}…</p></div>
      <div id="game-error" class="error" hidden></div>
      <div class="game-mode-label" ${server ? "hidden" : ""}>${escapeHtml(gameModeName(localGameMode))}</div>
      <form id="chat" class="game-chat" hidden><input id="chat-input" maxlength="200" autocomplete="off" aria-label="Chat message" /></form>
      <section id="pause-menu" class="game-pause" hidden aria-label="Pause menu">
        <h1>paused</h1>
        <button type="button" data-action="resume">resume game</button>
        <button type="button" data-action="menu">main menu</button>
      </section>
    </section>
  </main>`;

const canvas = required<HTMLCanvasElement>("#viewport");
const loading = required<HTMLDivElement>("#game-loading");
const error = required<HTMLDivElement>("#game-error");
const pauseMenu = required<HTMLElement>("#pause-menu");
const chat = required<HTMLFormElement>("#chat");
const chatInput = required<HTMLInputElement>("#chat-input");
const scene = new MapScene(canvas, "game");
const parser = new SauerMapParser();
let activeMap = "";
let disposed = false;

scene.setPlayerModel(savedPlayerModel());
scene.setLocalGameMode(localGameMode);
scene.onMultiplayer((event) => {
  if (event.type === "map-change" && event.map && event.map.toLocaleLowerCase() !== activeMap.toLocaleLowerCase()) void loadMap(event.map);
});
required<HTMLButtonElement>("[data-action='resume']").addEventListener("click", () => setPaused(false));
required<HTMLButtonElement>("[data-action='menu']").addEventListener("click", () => location.assign("/"));
chat.addEventListener("submit", (event) => {
  event.preventDefault();
  scene.sendChat(chatInput.value);
  chatInput.value = "";
  chat.hidden = true;
  canvas.focus();
});
window.addEventListener("keydown", onKeyDown);
window.addEventListener("pagehide", dispose, { once: true });
void start();

async function start(): Promise<void> {
  if (!requestedMap) return fail("No map was selected. Return to the main menu and choose a map or server.");
  await loadMap(requestedMap);
  if (server && activeMap) {
    await scene.connectMultiplayer({ host: server, port, playerName: savedPlayerName(), playerModel: savedPlayerModel(), map: activeMap });
  }
}

async function loadMap(name: string): Promise<void> {
  loading.hidden = false;
  error.hidden = true;
  try {
    const response = await fetch(`/api/maps/${encodeURIComponent(name)}.ogz`);
    if (!response.ok) throw new Error(`Could not fetch ${name}.ogz (${response.status}).`);
    const map = parser.parse(await decompressGzip(await response.arrayBuffer()), name);
    const manifest = await loadTextureManifest(name);
    await scene.loadMap(map, resolveMapTextures(map, manifest), manifest.skybox, manifest.lighting, manifest.fog, manifest.mapModels ?? []);
    activeMap = name;
    document.title = `${name} — SauerWeb`;
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : String(caught));
  } finally {
    loading.hidden = true;
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.code === "Escape") {
    if (!chat.hidden) { chat.hidden = true; canvas.focus(); }
    else setPaused(pauseMenu.hidden);
  } else if (server && event.code === "KeyT" && chat.hidden && pauseMenu.hidden) {
    event.preventDefault();
    if (document.pointerLockElement === canvas) void document.exitPointerLock();
    chat.hidden = false;
    chatInput.focus();
  }
}

function setPaused(paused: boolean): void {
  pauseMenu.hidden = !paused;
  scene.setPhysicsPaused(paused && !server);
  if (paused && document.pointerLockElement === canvas) void document.exitPointerLock();
  if (!paused) canvas.focus();
}

function dispose(): void {
  if (disposed) return;
  disposed = true;
  window.removeEventListener("keydown", onKeyDown);
  scene.dispose();
}

function fail(message: string): void {
  error.textContent = message;
  error.hidden = false;
}

async function decompressGzip(compressed: ArrayBuffer): Promise<ArrayBuffer> {
  const stream = new Blob([compressed]).stream().pipeThrough(new DecompressionStream("gzip"));
  return new Response(stream).arrayBuffer();
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

function validGameMode(mode: number): boolean {
  return Number.isInteger(mode) && mode >= 0 && mode <= 22;
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element: ${selector}`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
