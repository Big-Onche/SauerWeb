import "./menu.css";
import { MAP_MENU_PAGES } from "./menuData";

interface MapListItem {
  name: string;
  supported: boolean;
}

const app = required<HTMLDivElement>("#app");

let availableMaps: Map<string, MapListItem> | undefined;
let selectedPage = "ffa-1";
let previewMap = "aard3c";
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
  document.title = path === "/maps" ? "SauerWeb — Maps" : "SauerWeb";
  if (path === "/maps") renderMapsMenu();
  else renderMainMenu();
}

function renderMainMenu(): void {
  app.innerHTML = `
    <main class="sauer-screen">
      ${backgroundMarkup(true)}
      <section class="sauer-dialog main-dialog" aria-labelledby="main-menu-title">
        ${guiSkinMarkup()}
        <h1 id="main-menu-title" class="sr-only">Sauerbraten main menu</h1>
        <div class="identity-row">
          <button class="portrait" type="button" aria-label="Choose player model" disabled>
            <img src="/api/packages/icons/mrfixit.jpg" alt="Mr. Fixit" />
          </button>
          <div class="identity-fields">
            <label for="player-name">player name</label>
            <input id="player-name" maxlength="15" value="${escapeHtml(savedPlayerName())}" autocomplete="nickname" />
            <div class="model-row"><span>Mr. Fixit</span><img src="/api/packages/crosshairs/cross_normal.png" alt="Current crosshair" /></div>
          </div>
        </div>
        <div class="menu-rule"></div>
        <nav class="menu-actions" aria-label="Main menu">
          ${menuButton("server browser..", "server", false)}
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
  required<HTMLButtonElement>("[data-action='bot']").addEventListener("click", () => navigate("/maps"));
  const about = required<HTMLDialogElement>("#about-dialog");
  required<HTMLButtonElement>("[data-action='about']").addEventListener("click", () => about.showModal());
  about.querySelector("button")?.addEventListener("click", () => about.close());
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

function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
