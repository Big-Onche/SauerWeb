import "./menu.css";
import { refreshservers, servercompatible, servermodename, sortservers, type ServerListItem } from "./engine/serverbrowser";
import { MAP_MENU_PAGES } from "./menuData";
import { PLAYER_MODEL_NAMES } from "./fpsgame/render";

interface MapListItem {
  name: string;
  supported: boolean;
}

const app = required<HTMLDivElement>("#app");

let availableMaps: Map<string, MapListItem> | undefined;
let selectedPage = "ffa-1";
let previewMap = "aard3c";
let serverBrowserServers: ServerListItem[] = [];
let serverBrowserLoaded = false;
let serverBrowserRequest = 0;
const serverBrowserOptions = { searchlan: false, autoupdateservers: true, autosortservers: true };
const backgroundDecals = createBackgroundDecals();
let guiSkinSequence = 0;

route();
window.addEventListener("popstate", route);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && normalizePath(location.pathname) === "/maps") navigate("/");
});

function route(): void {
  const path = normalizePath(location.pathname);
  if (path === "/debug") {
    void import("./debug");
    return;
  }
  document.title = path === "/maps" ? "SauerWeb — Maps" : path === "/servers" ? "SauerWeb — Servers" : "SauerWeb";
  if (path === "/maps") renderMapsMenu();
  else if (path === "/servers") renderServersMenu();
  else renderMainMenu();
}

function renderMainMenu(): void {
  const playerModel = savedPlayerModel();
  const playerModelName = PLAYER_MODEL_NAMES[playerModel];
  const playerModelIcon = playerModelName === "ogro2" ? "ogro" : playerModelName;
  app.innerHTML = `
    <main class="sauer-screen">
      ${backgroundMarkup(true)}
      <section class="sauer-dialog main-dialog" aria-labelledby="main-menu-title">
        ${guiSkinMarkup()}
        <h1 id="main-menu-title" class="sr-only">Sauerbraten main menu</h1>
        <div class="identity-row">
          <button class="portrait" type="button" data-action="player-model" aria-label="Choose player model">
            <img src="/api/packages/icons/${playerModelIcon}.jpg" alt="${playerModelLabel(playerModel)}" />
          </button>
          <div class="identity-fields">
            <label for="player-name">player name</label>
            <input id="player-name" maxlength="15" value="${escapeHtml(savedPlayerName())}" autocomplete="nickname" />
            <div class="model-row"><span>${playerModelLabel(playerModel)}</span>
              <img src="/api/packages/crosshairs/cross_normal.png" alt="Current crosshair" /></div>
          </div>
        </div>
        <div class="menu-rule"></div>
        <nav class="menu-actions" aria-label="Main menu">
          ${menuButton("server browser..", "server", true)}
          ${menuButton("bot match..", "bot", true)}
          ${menuButton("campaign..", "campaign", false)}
          <div class="menu-rule compact"></div>
          ${menuButton("options..", "options", false)}
          ${menuButton("about..", "about", true)}
          ${menuButton("quit", "quit", false, "exit")}
        </nav>
      </section>
      <dialog id="about-dialog" class="about-dialog">
        ${guiSkinMarkup()}
        <h2>Cube 2: Sauerbraten</h2>
        <p>By Wouter “Aardappel” van Oortmerssen, Lee “eihrul” Salzman, Mike “Gilt” Dysart, Robert “baby-rabbit” Pointon, John “geartrooper” Siar, Quinton “Quin” Reeves, and others.</p>
        <p>SauerWeb brings the native maps and gameplay systems to the browser.</p>
        <button type="button">back</button>
      </dialog>
    </main>`;

  const playerName = required<HTMLInputElement>("#player-name");
  playerName.addEventListener("change", () => savePlayerName(playerName.value));
  required<HTMLButtonElement>("[data-action='player-model']").addEventListener("click", () => {
    savePlayerName(playerName.value);
    savePlayerModel((playerModel + 1) % PLAYER_MODEL_NAMES.length);
    renderMainMenu();
  });
  required<HTMLButtonElement>("[data-action='bot']").addEventListener("click", () => navigate("/maps"));
  required<HTMLButtonElement>("[data-action='server']").addEventListener("click", () => navigate("/servers"));
  const about = required<HTMLDialogElement>("#about-dialog");
  required<HTMLButtonElement>("[data-action='about']").addEventListener("click", () => about.showModal());
  about.querySelector("button")?.addEventListener("click", () => about.close());
}

function renderServersMenu(): void {
  app.innerHTML = `
    <main class="sauer-screen servers-screen">
      ${backgroundMarkup(false)}
      <section class="sauer-dialog servers-dialog" aria-labelledby="servers-title">
        ${guiSkinMarkup()}
        <header class="maps-heading"><div><p>multiplayer</p><h1 id="servers-title">server browser</h1></div>
          <button id="servers-back" class="back-button" type="button">‹ main menu</button></header>
        <div class="server-controls" aria-label="Server browser options">
          <button id="update-from-master" type="button">update from master server</button>
          <label><input id="search-lan" type="checkbox" ${serverBrowserOptions.searchlan ? "checked" : ""} /> search LAN</label>
          <label><input id="auto-update-servers" type="checkbox" ${serverBrowserOptions.autoupdateservers ? "checked" : ""} /> auto-update</label>
          <label><input id="auto-sort-servers" type="checkbox" ${serverBrowserOptions.autosortservers ? "checked" : ""} /> auto-sort</label>
          <button id="sort-servers" type="button" ${serverBrowserOptions.autosortservers ? "hidden" : ""}>sort</button>
        </div>
        <div class="server-heading"><span>server</span><span>map</span><span>mode</span><span>players ↓</span><span>ping</span></div>
        <div id="server-list" class="server-list"><p>Querying configured Sauerbraten servers…</p></div>
        <footer><span>PROTOCOL 260 · ENET 1.3.17</span><span id="server-count"></span></footer>
      </section>
    </main>`;
  required<HTMLButtonElement>("#servers-back").addEventListener("click", () => navigate("/"));
  required<HTMLButtonElement>("#update-from-master").addEventListener("click", () => void loadServers());
  const searchlan = required<HTMLInputElement>("#search-lan");
  searchlan.addEventListener("change", () => {
    serverBrowserOptions.searchlan = searchlan.checked;
    void loadServers();
  });
  const autoupdateservers = required<HTMLInputElement>("#auto-update-servers");
  autoupdateservers.addEventListener("change", () => { serverBrowserOptions.autoupdateservers = autoupdateservers.checked; });
  const autosortservers = required<HTMLInputElement>("#auto-sort-servers");
  const sortButton = required<HTMLButtonElement>("#sort-servers");
  autosortservers.addEventListener("change", () => {
    serverBrowserOptions.autosortservers = autosortservers.checked;
    sortButton.hidden = autosortservers.checked;
    if (autosortservers.checked) {
      serverBrowserServers = sortservers(serverBrowserServers);
      renderServerList();
    }
  });
  sortButton.addEventListener("click", () => {
    serverBrowserServers = sortservers(serverBrowserServers);
    renderServerList();
  });
  if (!serverBrowserLoaded || serverBrowserOptions.autoupdateservers) void loadServers();
  else renderServerList();
}

async function loadServers(): Promise<void> {
  const list = required<HTMLDivElement>("#server-list");
  const request = ++serverBrowserRequest;
  list.innerHTML = "<p>Querying configured Sauerbraten servers…</p>";
  try {
    const servers = await refreshservers(serverBrowserOptions.searchlan);
    if (request !== serverBrowserRequest || normalizePath(location.pathname) !== "/servers") return;
    serverBrowserServers = serverBrowserOptions.autosortservers ? sortservers(servers) : servers;
    serverBrowserLoaded = true;
    renderServerList();
  } catch (caught) {
    if (request !== serverBrowserRequest || normalizePath(location.pathname) !== "/servers") return;
    list.innerHTML = `<p>${escapeHtml(caught instanceof Error ? caught.message : String(caught))}</p>`;
  }
}

function renderServerList(): void {
  const list = required<HTMLDivElement>("#server-list");
  if (!serverBrowserServers.length) {
    list.innerHTML = "<p>No Sauerbraten servers found.</p>";
  } else {
    list.replaceChildren(...serverBrowserServers.map((server) => {
      const attributes = server.attributes ?? [];
      const compatible = servercompatible(server);
      const button = document.createElement("button");
      button.type = "button";
      button.disabled = !compatible || !server.map;
      const description = escapeHtml(server.description || server.label);
      const address = `${escapeHtml(server.host)}:${server.port}`;
      button.innerHTML = `<span><strong>${description}</strong><small>${address}</small></span>` +
        `<span>${escapeHtml(server.map || "—")}</span><span>${escapeHtml(servermodename(attributes[1]))}</span>` +
        `<span>${server.numPlayers ?? 0}/${attributes[3] ?? "?"}</span><span>${server.ping ?? "—"}</span>`;
      if (compatible && server.map) button.addEventListener("click", () => launchServer(server));
      return button;
    }));
  }
  const serverSuffix = serverBrowserServers.length === 1 ? "" : "s";
  required<HTMLSpanElement>("#server-count").textContent = `${serverBrowserServers.length} server${serverSuffix}`;
}

function launchServer(server: ServerListItem): void {
  const query = new URLSearchParams({ map: server.map ?? "", server: server.host, port: String(server.port) });
  location.assign(`/debug?${query}`);
}

function renderMapsMenu(): void {
  const page = MAP_MENU_PAGES.find((candidate) => candidate.id === selectedPage) ?? MAP_MENU_PAGES[0];
  const initialPreview = page.columns.flat()[0] ?? previewMap;
  if (!page.columns.flat().includes(previewMap)) previewMap = initialPreview;
  const preview = availableMaps?.get(previewMap);
  app.innerHTML = `
    <main class="sauer-screen maps-screen">
      ${backgroundMarkup(false)}
      <section class="sauer-dialog maps-dialog" aria-labelledby="maps-title">
        ${guiSkinMarkup()}
        <header class="maps-heading">
          <div><p>bot match</p><h1 id="maps-title">choose a map</h1></div>
          <button id="maps-back" class="back-button" type="button">‹ main menu</button>
        </header>
        <nav class="map-tabs" aria-label="Map pages">
          ${MAP_MENU_PAGES.map((item) => `<button type="button" data-page="${item.id}" class="${item.id === page.id ? "active" : ""}">${item.label}</button>`).join("")}
        </nav>
        <div class="map-browser">
          <div class="map-columns" role="listbox" aria-label="${page.label} maps">
            ${page.columns.map((column) => `<div>${column.map(mapButton).join("")}</div>`).join("")}
          </div>
          <aside class="map-preview" aria-live="polite">
            <div class="preview-frame">
              <img src="/api/packages/base/${encodeURIComponent(previewMap)}.jpg" alt="${escapeHtml(previewMap)} map preview" />
              <img class="preview-overlay" src="/api/data/guioverlay.png" alt="" />
            </div>
            <strong>${escapeHtml(previewMap)}</strong>
            <span>${availableMaps === undefined ? "checking map…" : preview?.supported ? "ready to play" : "unavailable in this build"}</span>
            <button id="play-map" type="button" ${availableMaps !== undefined && !preview?.supported ? "disabled" : ""}>play map</button>
          </aside>
        </div>
        <footer><span>${page.category.toUpperCase()} MAPS</span><span>Hover to preview · click to launch</span></footer>
      </section>
    </main>`;

  required<HTMLButtonElement>("#maps-back").addEventListener("click", () => navigate("/"));
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.addEventListener("click", () => {
    selectedPage = button.dataset.page ?? selectedPage;
    previewMap = "";
    renderMapsMenu();
  }));
  document.querySelectorAll<HTMLButtonElement>("[data-map]").forEach((button) => {
    const select = (): void => {
      previewMap = button.dataset.map ?? previewMap;
      renderMapsMenu();
    };
    button.addEventListener("mouseenter", select);
    button.addEventListener("focus", select);
    button.addEventListener("click", () => launchMap(button.dataset.map ?? ""));
  });
  required<HTMLButtonElement>("#play-map").addEventListener("click", () => launchMap(previewMap));
  if (!availableMaps) void loadAvailableMaps();
}

function mapButton(name: string): string {
  const map = availableMaps?.get(name);
  const unavailable = availableMaps !== undefined && !map?.supported;
  return `<button type="button" role="option" data-map="${escapeHtml(name)}" class="${name === previewMap ? "selected" : ""}" ${unavailable ? "disabled" : ""}>
    <img src="/api/packages/icons/map.jpg" alt="" /><span>${escapeHtml(name)}</span>
  </button>`;
}

async function loadAvailableMaps(): Promise<void> {
  try {
    const response = await fetch("/api/maps", { cache: "no-store" });
    if (!response.ok) throw new Error(`Map index returned ${response.status}.`);
    const maps = await response.json() as MapListItem[];
    availableMaps = new Map(maps.map((map) => [map.name, map]));
  } catch {
    availableMaps = new Map();
  }
  if (normalizePath(location.pathname) === "/maps") renderMapsMenu();
}

function launchMap(name: string): void {
  if (!name || (availableMaps && !availableMaps.get(name)?.supported)) return;
  location.assign(`/debug?map=${encodeURIComponent(name)}`);
}

function menuButton(label: string, action: string, enabled: boolean, icon = "menu"): string {
  return `<button type="button" data-action="${action}" ${enabled ? "" : "disabled"}><img src="/api/packages/icons/${icon}.jpg" alt="" /><span>${label}</span></button>`;
}

function backgroundMarkup(showLogo: boolean): string {
  return `<div class="sauer-background" aria-hidden="true">
    <div class="background-base"></div>
    <div class="background-detail"></div>
    <div class="background-decals">${backgroundDecals}</div>
    <div class="background-shade"></div>
  </div>
  ${showLogo ? `<img class="sauer-logo" src="/api/data/logo_1024.png" alt="Cube 2: Sauerbraten" />` : ""}`;
}

function createBackgroundDecals(): string {
  const count = 4 + Math.floor(Math.random() * 9);
  const maximumSize = Math.min(window.innerWidth, window.innerHeight) / 8;
  return Array.from({ length: count }, () => {
    const size = maximumSize / 2 + Math.random() * maximumSize / 2;
    const halfWidth = size / window.innerWidth * 50;
    const halfHeight = size / window.innerHeight * 50;
    const x = halfWidth + Math.random() * (100 - 2 * halfWidth);
    const y = halfHeight + Math.random() * (100 - 2 * halfHeight);
    const flip = Math.random() < 0.5 ? -1 : 1;
    return `<img src="/api/data/background_decal.png" style="left:${x.toFixed(3)}%;top:${y.toFixed(3)}%;width:${size.toFixed(1)}px;--flip:${flip}" alt="" />`;
  }).join("");
}

function guiSkinMarkup(): string {
  const skinId = guiSkinSequence++;
  const pieces = [
    ["corner top-left", "11 104 12 13"], ["edge top", "23 104 206 13"], ["corner top-right", "229 104 17 13"],
    ["edge left", "11 56 12 48"], ["center", "23 56 206 48"], ["edge right", "229 56 17 48"],
    ["corner bottom-left", "11 104 12 13"], ["edge bottom", "23 104 206 13"], ["corner bottom-right", "229 104 17 13"],
  ];
  const tileSizes: Record<string, [number, number]> = {
    "edge top": [412, 26], "edge left": [24, 96], center: [412, 96], "edge right": [34, 96], "edge bottom": [412, 26],
  };
  return `<div class="gui-skin" aria-hidden="true">${pieces.map(([className, viewBox], index) => {
    const classes = `skin-${className.replaceAll(" ", " skin-")}`;
    const tileSize = tileSizes[className];
    if (tileSize) {
      const patternId = `skin-piece-${skinId}-${index}`;
      return `<svg class="${classes}"><defs><pattern id="${patternId}" width="${tileSize[0]}" height="${tileSize[1]}" patternUnits="userSpaceOnUse"><svg width="${tileSize[0]}" height="${tileSize[1]}" viewBox="${viewBox}" preserveAspectRatio="none"><image href="/api/data/guiskin.png" width="256" height="128" /></svg></pattern></defs><rect width="100%" height="100%" fill="url(#${patternId})" /></svg>`;
    }
    return `<svg class="${classes}" viewBox="${viewBox}" preserveAspectRatio="none"><image href="/api/data/guiskin.png" width="256" height="128" /></svg>`;
  }).join("")}</div>`;
}

function navigate(path: string): void {
  history.pushState(null, "", path);
  route();
}

function normalizePath(path: string): string {
  const normalized = path.replace(/\/+$/, "") || "/";
  return normalized.toLowerCase();
}

function savedPlayerName(): string {
  try {
    return localStorage.getItem("sauerweb.player-name") || "unnamed";
  } catch {
    return "unnamed";
  }
}

function savePlayerName(name: string): void {
  try {
    localStorage.setItem("sauerweb.player-name", name.trim() || "unnamed");
  } catch {
    // The name remains editable when browser storage is unavailable.
  }
}

function savedPlayerModel(): number {
  try {
    const model = Number(localStorage.getItem("sauerweb.player-model"));
    return Number.isInteger(model) && model >= 0 && model < PLAYER_MODEL_NAMES.length ? model : 0;
  } catch {
    return 0;
  }
}

function savePlayerModel(model: number): void {
  try {
    localStorage.setItem("sauerweb.player-model", String(model));
  } catch {
    // The default model remains available when browser storage is unavailable.
  }
}

function playerModelLabel(model: number): string {
  return ["Mr. Fixit", "Snout X10K", "Ogro", "Inky", "Captain Cannon"][model] ?? "Mr. Fixit";
}

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
