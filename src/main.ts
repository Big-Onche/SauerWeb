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
      <div class="menu-vignette"></div>
      <section class="sauer-dialog main-dialog" aria-labelledby="main-menu-title">
        <img class="cube-logo" src="/api/packages/textures/fatum/cube2logo.jpg" alt="Cube 2: Sauerbraten" />
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
        <p class="menu-status">Browser port · main menu from <code>data/menus.cfg</code></p>
      </section>
      <dialog id="about-dialog" class="about-dialog">
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
      <div class="menu-vignette"></div>
      <section class="sauer-dialog maps-dialog" aria-labelledby="maps-title">
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
