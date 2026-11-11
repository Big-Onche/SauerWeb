import "./style.css";
import "./guiSkin.css";
import { loadTextureManifest, resolveMapTextures } from "./assets/TextureResolver";
import { crc32 } from "./engine/crc32";
import { SauerMapParser } from "./engine/worldio";
import { gameModeName } from "./fpsgame/game";
import { guiSkinMarkup } from "./guiSkin";
import { GameConsole } from "./platform/browser/GameConsole";
import { MapScene } from "./render/MapScene";
import { bindCrosshairSettings, crosshairSettingsMarkup, loadCrosshairSettings } from "./platform/browser/CrosshairSettings";

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
      <form id="chat" class="game-chat" hidden><label id="chat-prompt">&gt;</label>
        <input id="chat-input" maxlength="200" autocomplete="off" aria-label="Chat message" /></form>
      <section id="death-menu" class="game-death" hidden aria-label="Respawn menu">
        <p>you died</p>
        <button type="button" data-action="respawn">respawn</button>
        <small>press any key to respawn</small>
      </section>
      <section id="pause-menu" class="game-pause" hidden aria-label="Pause menu">
        <div class="pause-dialog">
          ${guiSkinMarkup()}
          <h1>paused</h1>
          <div class="pause-actions">
            <button type="button" data-action="resume"><img src="/api/packages/icons/menu.jpg" alt="" /><span>resume game</span></button>
            <button type="button" data-action="switch-team" ${server ? "" : "hidden"}>
              <img src="/api/packages/icons/menu.jpg" alt="" /><span>switch team</span>
            </button>
            <button type="button" data-action="spectator" ${server ? "" : "hidden"}>
              <img src="/api/packages/icons/spectator.jpg" alt="" /><span>spectate</span>
            </button>
            <button type="button" data-action="crosshair"><img src="/api/packages/crosshairs/cross_normal.png" alt="" />
              <span>crosshair..</span></button>
            <button type="button" data-action="menu"><img src="/api/packages/icons/exit.jpg" alt="" /><span>main menu</span></button>
          </div>
        </div>
      </section>
      <dialog id="crosshair-dialog" class="crosshair-dialog game-crosshair-dialog" aria-labelledby="crosshair-title">
        ${guiSkinMarkup()}
        <h2 id="crosshair-title">crosshair</h2>
        ${crosshairSettingsMarkup(loadCrosshairSettings())}
        <footer><span>Vanilla Sauerbraten crosshairs</span><button type="button" data-action="close-crosshair">back</button></footer>
      </dialog>
    </section>
  </main>`;

const canvas = required<HTMLCanvasElement>("#viewport");
const loading = required<HTMLDivElement>("#game-loading");
const error = required<HTMLDivElement>("#game-error");
const deathMenu = required<HTMLElement>("#death-menu");
const respawnButton = required<HTMLButtonElement>("[data-action='respawn']");
const pauseMenu = required<HTMLElement>("#pause-menu");
const spectatorButton = required<HTMLButtonElement>("[data-action='spectator']");
const chat = required<HTMLFormElement>("#chat");
const chatInput = required<HTMLInputElement>("#chat-input");
const chatPrompt = required<HTMLLabelElement>("#chat-prompt");
const gameConsole = new GameConsole(required<HTMLElement>(".viewport-panel"));
const scene = new MapScene(canvas, "game");
const parser = new SauerMapParser();
let activeMap = "";
let disposed = false;
let respawnPending = false;
let teamChat = false;

scene.setPlayerModel(savedPlayerModel());
scene.setLocalGameMode(localGameMode);
gameConsole.add(`game mode is ${gameModeName(localGameMode)}`, "game-info");
scene.onMultiplayer((event) => {
  if (event.type === "map-change" && event.map && event.map.toLocaleLowerCase() !== activeMap.toLocaleLowerCase()) void loadMap(event.map);
  if (event.type === "players" || event.type === "spawn") {
    syncDeathMenu();
    syncSpectatorButton();
  }
  if (event.type === "console") gameConsole.add(event.text, event.consoleType);
  if (event.type === "status") gameConsole.add(event.status, event.error ? "error" : "info");
});
respawnButton.addEventListener("click", requestRespawn);
required<HTMLButtonElement>("[data-action='resume']").addEventListener("click", () => setPaused(false));
required<HTMLButtonElement>("[data-action='switch-team']").addEventListener("click", () => { scene.switchTeam(); setPaused(false); });
spectatorButton.addEventListener("click", () => {
  scene.setSpectator(!scene.isLocalPlayerSpectator());
  setPaused(false);
});
const crosshairDialog = required<HTMLDialogElement>("#crosshair-dialog");
bindCrosshairSettings(crosshairDialog);
required<HTMLButtonElement>("[data-action='crosshair']").addEventListener("click", () => crosshairDialog.showModal());
required<HTMLButtonElement>("[data-action='close-crosshair']").addEventListener("click", () => crosshairDialog.close());
required<HTMLButtonElement>("[data-action='menu']").addEventListener("click", () => location.assign("/"));
chat.addEventListener("submit", (event) => {
  event.preventDefault();
  scene.sendChat(chatInput.value, teamChat);
  chatInput.value = "";
  chat.hidden = true;
  canvas.focus();
});
window.addEventListener("keydown", onKeyDown, { capture: true });
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
    const mapData = await decompressGzip(await response.arrayBuffer());
    const map = parser.parse(mapData, name);
    const manifest = await loadTextureManifest(name);
    await scene.loadMap(map, resolveMapTextures(map, manifest), manifest.skybox, manifest.lighting, manifest.fog, manifest.mapModels ?? [],
      manifest.entityModels?.teleporter);
    scene.setMultiplayerMapInfo(name, crc32(new Uint8Array(mapData)));
    activeMap = name;
    document.title = `${name} — SauerWeb`;
    gameConsole.add(`read map ${name}`);
  } catch (caught) {
    fail(caught instanceof Error ? caught.message : String(caught));
  } finally {
    loading.hidden = true;
  }
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.target === chatInput) {
    if (event.code === "Escape") {
      event.preventDefault();
      chat.hidden = true;
      canvas.focus();
    }
    event.stopImmediatePropagation();
    return;
  }
  const consoleKey = event.code === "KeyT" || event.code === "KeyY" || event.code === "F11" || event.code === "PageUp" ||
    event.code === "PageDown" || event.code === "NumpadAdd" || event.code === "NumpadSubtract";
  if (!deathMenu.hidden && !event.repeat && !consoleKey) {
    event.preventDefault();
    event.stopImmediatePropagation();
    requestRespawn();
  } else if (event.code === "Escape") {
    if (!chat.hidden) { chat.hidden = true; canvas.focus(); }
    else if (gameConsole.isFull) gameConsole.toggle();
    else setPaused(pauseMenu.hidden);
  } else if (event.code === "F11") {
    event.preventDefault();
    gameConsole.toggle();
  } else if (gameConsole.isFull && (event.code === "PageUp" || event.code === "NumpadSubtract")) {
    event.preventDefault();
    gameConsole.scroll(5);
  } else if (gameConsole.isFull && (event.code === "PageDown" || event.code === "NumpadAdd")) {
    event.preventDefault();
    gameConsole.scroll(-5);
  } else if (server && (event.code === "KeyT" || event.code === "KeyY") && chat.hidden && pauseMenu.hidden) {
    event.preventDefault();
    if (document.pointerLockElement === canvas) void document.exitPointerLock();
    teamChat = event.code === "KeyY";
    chatPrompt.textContent = teamChat ? "[team]" : ">";
    chat.hidden = false;
    chatInput.focus();
  } else if (server && event.code === "KeyG" && chat.hidden && pauseMenu.hidden) {
    scene.tryDropFlag();
  }
}

function requestRespawn(): void {
  if (!scene.requestRespawn()) return;
  respawnPending = true;
  respawnButton.disabled = true;
  respawnButton.textContent = "respawning…";
}

function syncDeathMenu(): void {
  const dead = scene.isLocalPlayerDead();
  const wasDead = !deathMenu.hidden;
  deathMenu.hidden = !dead;
  respawnButton.disabled = respawnPending;
  respawnButton.textContent = respawnPending ? "respawning…" : "respawn";
  if (dead) {
    chat.hidden = true;
    if (document.pointerLockElement === canvas) void document.exitPointerLock();
  } else {
    respawnPending = false;
    respawnButton.disabled = false;
    respawnButton.textContent = "respawn";
    if (wasDead) canvas.focus();
  }
}

function syncSpectatorButton(): void {
  const label = spectatorButton.querySelector("span");
  if (label) label.textContent = scene.isLocalPlayerSpectator() ? "unspectate" : "spectate";
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
  window.removeEventListener("keydown", onKeyDown, { capture: true });
  scene.dispose();
  gameConsole.dispose();
}

function fail(message: string): void {
  gameConsole.add(message, "error");
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
