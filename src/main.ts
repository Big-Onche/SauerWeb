import "./menu.css";
import "./guiSkin.css";
import { refreshservers, servercompatible, servermodename, sortservers, type ServerListItem } from "./engine/serverbrowser";
import { GAME_MODE_DESCRIPTIONS } from "./fpsgame/game";
import { MAP_MENU_PAGES, mapMenuPagesForMode } from "./menuData";
import { PLAYER_MODEL_INFO, PLAYER_MODEL_NAMES } from "./fpsgame/render";
import { guiSkinMarkup } from "./guiSkin";
import { bindCrosshairSettings, CROSSHAIRS, crosshairSettingsMarkup, loadCrosshairSettings } from "./platform/browser/CrosshairSettings";
import { loadHudSettings, saveHudSettings } from "./platform/browser/HudSettings";
import { loadMusicVolume, musicPlayer } from "./platform/browser/MusicPlayer";
import { isBindableKey, keyBindingLabel, keyForEvent, loadMovementBindings, MOVEMENT_BINDING_ACTIONS, resetMovementBindings,
  saveMovementBindings, type MovementBindingAction } from "./platform/browser/KeyBindings";
import { bindTouchSettings, loadTouchSettings, touchSettingsMarkup } from "./platform/browser/TouchSettings";
import { requestMobileLandscapeFullscreen } from "./platform/browser/TouchControls";
import { onlinePlayersLabel, OnlinePresence } from "./presence";
import { sauerFormattedMarkup } from "./sauerFormatting";
import { TEAMKILL_PROTECTION_MESSAGE } from "./fpsgame/teamkillProtection";
import { loadWaterQuality, saveWaterQuality, waterQualityLabel, type WaterQuality } from "./render/WaterSettings";

interface MapListItem {
  name: string;
  supported: boolean;
}

const OPTION_TABS = ["game", "hud", "gfx", "display", "res", "sound", "mouse", "binds", "console"] as const;
type OptionTab = typeof OPTION_TABS[number];

const EXPERIMENTAL_DISCLAIMER_KEY = "sauerweb.experimental-disclaimer-dismissed";
const REPORT_ISSUE_URL = "https://github.com/Big-Onche/SauerWeb/issues";

const app = required<HTMLDivElement>("#app");
const onlinePresence = new OnlinePresence();

let availableMaps: Map<string, MapListItem> | undefined;
let selectedPage = "ffa-1";
let selectedBotMode = 0;
let botMatchCount = 5;
let botMatchMinSkill = 50;
let botMatchMaxSkill = 100;
let previewMap = "aard3c";
let serverBrowserServers: ServerListItem[] = [];
let serverBrowserLoaded = false;
let serverBrowserRequest = 0;
let experimentalDisclaimerDismissed = false;
const serverBrowserOptions = { searchlan: false, autoupdateservers: true, autosortservers: true };
const backgroundDecals = createBackgroundDecals();

onlinePresence.addEventListener("change", updateOnlinePlayerCounter);

route();
window.addEventListener("popstate", route);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && ["/maps", "/options"].includes(normalizePath(location.pathname))) navigate("/");
});

function route(): void {
  const path = normalizePath(location.pathname);
  if (path === "/debug") {
    void import("./debug");
    return;
  }
  if (path === "/game") {
    dismissExperimentalDisclaimer();
    void import("./gameRuntime");
    return;
  }
  musicPlayer.playMenu();
  document.title = path === "/maps" ? "SauerWeb — Maps" : path === "/servers" ? "SauerWeb — Servers"
    : path === "/options" ? "SauerWeb — Options" : "SauerWeb";
  if (path === "/options") renderOptionsMenu();
  else if (path === "/bots") renderBotMatchMenu();
  else if (path === "/modes") renderGameModeMenu();
  else if (path === "/maps") renderMapsMenu();
  else if (path === "/servers") renderServersMenu();
  else renderMainMenu();
}

function renderMainMenu(): void {
  const playerModel = savedPlayerModel();
  const playerModelInfo = PLAYER_MODEL_INFO[playerModel];
  const showTeamkillProtection = new URLSearchParams(location.search).get("notice") === "teamkill-protection";
  const showServerCapacity = new URLSearchParams(location.search).get("notice") === "server-capacity";
  app.innerHTML = `
    <main class="sauer-screen">
      ${backgroundMarkup(true)}
      <div class="main-menu-status">
        <div class="online-players" hidden><i aria-hidden="true"></i><span></span></div>
        <div class="application-version">${escapeHtml(__SAUERWEB_VERSION__)}</div>
      </div>
      <section class="sauer-dialog main-dialog" aria-labelledby="main-menu-title">
        ${guiSkinMarkup()}
        <h1 id="main-menu-title" class="sr-only">Sauerbraten main menu</h1>
        <div class="identity-row">
          <button class="portrait" type="button" data-action="player-model" aria-label="Choose player model">
            <img src="/api/packages/icons/${playerModelInfo.icon}.jpg" alt="${playerModelInfo.name}" />
          </button>
          <div class="identity-fields">
            <label for="player-name">player name</label>
            <input id="player-name" maxlength="15" value="${escapeHtml(savedPlayerName())}" autocomplete="nickname" />
            <div class="model-row"><button type="button" data-action="player-model">${playerModelInfo.name}</button>
              <button class="crosshair-shortcut" type="button" data-action="crosshair" aria-label="Customize crosshair">
                <img src="${currentCrosshair().normal}" alt="Current crosshair" /></button></div>
          </div>
        </div>
        <div class="menu-rule"></div>
        <nav class="menu-actions" aria-label="Main menu">
          ${menuButton("server browser..", "server", true)}
          ${menuButton("bot match..", "bot", true)}
          ${menuButton("campaign..", "campaign", false)}
          <div class="menu-rule compact"></div>
          ${menuButton("options..", "options", true)}
          ${menuButton("about..", "about", true)}
          ${menuLink("Report an issue", REPORT_ISSUE_URL, "info")}
        </nav>
      </section>
      <dialog id="playermodel-dialog" class="playermodel-dialog" aria-labelledby="playermodel-title">
        ${guiSkinMarkup()}
        <div class="playermodel-layout">
          <nav class="playermodel-list" aria-label="Player models">
            ${PLAYER_MODEL_INFO.map((model, index) => `<button type="button" data-player-model="${index}"
              class="${index === playerModel ? "active" : ""}"><img src="/api/packages/icons/${model.icon}.jpg" alt="" />
              <span>${model.name}</span></button>`).join("")}
          </nav>
          <div class="playermodel-rule" aria-hidden="true"></div>
          <section class="playermodel-preview">
            <div class="player-preview-frame"><canvas id="player-model-preview" aria-label="Animated player model preview"></canvas></div>
            <h2 id="playermodel-title">${playerModelInfo.name}</h2>
            <p id="playermodel-story">${playerModelInfo.story}</p>
          </section>
        </div>
        <footer><span>Choose your player model</span><button type="button" data-action="close-playermodel">back</button></footer>
      </dialog>
      <dialog id="crosshair-dialog" class="crosshair-dialog" aria-labelledby="crosshair-title">
        ${guiSkinMarkup()}
        <h2 id="crosshair-title">crosshair</h2>
        ${crosshairSettingsMarkup(loadCrosshairSettings())}
        <footer><span>Vanilla Sauerbraten crosshairs</span><button type="button" data-action="close-crosshair">back</button></footer>
      </dialog>
      <dialog id="about-dialog" class="about-dialog">
        ${guiSkinMarkup()}
        <h2>Cube 2: Sauerbraten</h2>
        <p>By Wouter “Aardappel” van Oortmerssen, Lee “eihrul” Salzman, Mike “Gilt” Dysart, Robert “baby-rabbit” Pointon, John “geartrooper” Siar, Quinton “Quin” Reeves, and others.</p>
        <p>SauerWeb brings the native maps and gameplay systems to the browser.</p>
        <button type="button">back</button>
      </dialog>
      <dialog id="experimental-disclaimer" class="experimental-disclaimer" aria-labelledby="experimental-disclaimer-title"
        aria-describedby="experimental-disclaimer-description">
        ${guiSkinMarkup()}
        <div class="experimental-disclaimer-content">
          <h2 id="experimental-disclaimer-title">SauerWeb is experimental!</h2>
          <div id="experimental-disclaimer-description">
            <p>SauerWeb is an experimental browser-based port of Cube 2: Sauerbraten, currently under active development.</p>
            <ul>
              <li><strong>Bugs &amp; instability:</strong> Expect glitches, performance issues, crashes, and unexpected behavior.</li>
              <li><strong>Multiplayer limitations:</strong> Some servers may reject connections due to SauerWeb's proxy-based networking or
                compatibility/anti-cheat restrictions.</li>
              <li><strong>Missing features:</strong> Not all original Sauerbraten features, mechanics, and options have been implemented yet.</li>
              <li><strong>Work in progress:</strong> Compatibility, performance, stability, and features are continuously being improved.</li>
            </ul>
            <p class="experimental-disclaimer-thanks">Thanks for testing SauerWeb and helping the project grow!</p>
          </div>
          <footer><button type="button" data-action="dismiss-experimental-disclaimer" autofocus>I Understand</button></footer>
        </div>
      </dialog>
      <dialog id="teamkill-disclaimer" class="experimental-disclaimer teamkill-disclaimer" aria-labelledby="teamkill-disclaimer-title"
        aria-describedby="teamkill-disclaimer-description">
        ${guiSkinMarkup()}
        <div class="experimental-disclaimer-content">
          <h2 id="teamkill-disclaimer-title">Multiplayer safety disconnect</h2>
          <p id="teamkill-disclaimer-description">${escapeHtml(TEAMKILL_PROTECTION_MESSAGE)}</p>
          <footer><button type="button" data-action="dismiss-teamkill-disclaimer" autofocus>Back to main menu</button></footer>
        </div>
      </dialog>
      <dialog id="server-capacity" class="experimental-disclaimer" aria-labelledby="server-capacity-title"
        aria-describedby="server-capacity-description">
        ${guiSkinMarkup()}
        <div class="experimental-disclaimer-content">
          <h2 id="server-capacity-title">Server capacity reached</h2>
          <p id="server-capacity-description">Server capacity reached. Try another server or use the original Sauerbraten client.</p>
          <footer><button type="button" data-action="dismiss-server-capacity" autofocus>Back to main menu</button></footer>
        </div>
      </dialog>
    </main>`;

  updateOnlinePlayerCounter();

  const playerName = required<HTMLInputElement>("#player-name");
  playerName.addEventListener("change", () => savePlayerName(playerName.value));
  const playermodelDialog = required<HTMLDialogElement>("#playermodel-dialog");
  let preview: { setModel(model: number): void; dispose(): void } | undefined;
  let previewModel = playerModel;
  const showPreview = (model: number): void => {
    previewModel = model;
    const info = PLAYER_MODEL_INFO[model];
    required<HTMLHeadingElement>("#playermodel-title").textContent = info.name;
    required<HTMLParagraphElement>("#playermodel-story").textContent = info.story;
    preview?.setModel(model);
    playermodelDialog.querySelectorAll<HTMLButtonElement>("[data-player-model]").forEach((button) => {
      button.classList.toggle("previewing", Number(button.dataset.playerModel) === model);
    });
  };
  const openPlayermodel = async (): Promise<void> => {
    savePlayerName(playerName.value);
    playermodelDialog.showModal();
    showPreview(playerModel);
    const module = await import("./platform/browser/PlayerModelPreview");
    if (!playermodelDialog.open) return;
    preview = new module.PlayerModelPreview(required<HTMLCanvasElement>("#player-model-preview"));
    preview.setModel(previewModel);
  };
  document.querySelectorAll<HTMLButtonElement>("[data-action='player-model']").forEach((button) => {
    button.addEventListener("click", () => void openPlayermodel());
  });
  playermodelDialog.querySelectorAll<HTMLButtonElement>("[data-player-model]").forEach((button) => {
    const model = Number(button.dataset.playerModel);
    button.addEventListener("mouseenter", () => showPreview(model));
    button.addEventListener("focus", () => showPreview(model));
    button.addEventListener("click", () => {
      savePlayerModel(model);
      preview?.dispose();
      preview = undefined;
      playermodelDialog.close();
      renderMainMenu();
    });
  });
  required<HTMLButtonElement>("[data-action='close-playermodel']").addEventListener("click", () => playermodelDialog.close());
  playermodelDialog.addEventListener("close", () => {
    preview?.dispose();
    preview = undefined;
  });
  required<HTMLButtonElement>("[data-action='bot']").addEventListener("click", () => navigate("/bots"));
  required<HTMLButtonElement>("[data-action='server']").addEventListener("click", () => navigate("/servers"));
  const crosshairDialog = required<HTMLDialogElement>("#crosshair-dialog");
  bindCrosshairSettings(crosshairDialog, (settings) => {
    const preview = document.querySelector<HTMLImageElement>(".crosshair-shortcut img");
    if (preview) preview.src = currentCrosshair(settings.selected).normal;
  });
  document.querySelectorAll<HTMLButtonElement>("[data-action='crosshair']").forEach((button) => button.addEventListener("click", () => crosshairDialog.showModal()));
  required<HTMLButtonElement>("[data-action='options']").addEventListener("click", () => navigate("/options"));
  required<HTMLButtonElement>("[data-action='close-crosshair']").addEventListener("click", () => crosshairDialog.close());
  const about = required<HTMLDialogElement>("#about-dialog");
  required<HTMLButtonElement>("[data-action='about']").addEventListener("click", () => about.showModal());
  about.querySelector("button")?.addEventListener("click", () => about.close());
  const experimentalDisclaimer = required<HTMLDialogElement>("#experimental-disclaimer");
  experimentalDisclaimer.addEventListener("cancel", (event) => event.preventDefault());
  required<HTMLButtonElement>("[data-action='dismiss-experimental-disclaimer']").addEventListener("click", () => {
    musicPlayer.resumeAfterUserGesture();
    dismissExperimentalDisclaimer();
    experimentalDisclaimer.close();
  });
  const teamkillDisclaimer = required<HTMLDialogElement>("#teamkill-disclaimer");
  teamkillDisclaimer.addEventListener("cancel", (event) => event.preventDefault());
  required<HTMLButtonElement>("[data-action='dismiss-teamkill-disclaimer']").addEventListener("click", () => teamkillDisclaimer.close());
  const serverCapacity = required<HTMLDialogElement>("#server-capacity");
  serverCapacity.addEventListener("cancel", (event) => event.preventDefault());
  required<HTMLButtonElement>("[data-action='dismiss-server-capacity']").addEventListener("click", () => serverCapacity.close());
  if (showTeamkillProtection || showServerCapacity) {
    history.replaceState(null, "", "/");
    (showTeamkillProtection ? teamkillDisclaimer : serverCapacity).showModal();
  } else if (shouldShowExperimentalDisclaimer()) experimentalDisclaimer.showModal();
}

function updateOnlinePlayerCounter(): void {
  const counter = document.querySelector<HTMLDivElement>(".online-players");
  if (!counter) return;
  const count = onlinePresence.count;
  counter.hidden = count === undefined;
  const label = counter.querySelector("span");
  if (label && count !== undefined) label.textContent = onlinePlayersLabel(count);
}

function renderOptionsMenu(activeTab: OptionTab = "game"): void {
  const hud = loadHudSettings();
  app.innerHTML = `
    <main class="sauer-screen options-screen">
      ${backgroundMarkup(false)}
      <section class="sauer-dialog options-dialog" aria-labelledby="options-title">
        ${guiSkinMarkup()}
        <header class="maps-heading"><div><p>configuration</p><h1 id="options-title">options</h1></div>
          <button id="options-back" class="back-button" type="button">‹ main menu</button></header>
        <nav class="option-tabs" role="tablist" aria-label="Option categories">
          ${OPTION_TABS.map((tab) => `<button type="button" role="tab" data-option-tab="${tab}" aria-selected="${tab === activeTab}"
            class="${tab === activeTab ? "active" : ""}">${tab}</button>`).join("")}
        </nav>
        <section class="option-content" aria-live="polite">${optionTabMarkup(activeTab, hud.showFps)}</section>
        <footer><span>Settings are saved on this device</span><span>Cube 2: Sauerbraten</span></footer>
      </section>
    </main>`;
  required<HTMLButtonElement>("#options-back").addEventListener("click", () => navigate("/"));
  document.querySelectorAll<HTMLButtonElement>("[data-option-tab]").forEach((button) => button.addEventListener("click", () => {
    renderOptionsMenu(button.dataset.optionTab as OptionTab);
  }));
  const showFps = document.querySelector<HTMLInputElement>("#show-fps");
  showFps?.addEventListener("change", () => saveHudSettings({ showFps: showFps.checked }));
  const musicVolume = document.querySelector<HTMLInputElement>("#music-volume");
  musicVolume?.addEventListener("input", () => {
    musicPlayer.setVolume(Number(musicVolume.value));
    syncSliderOutput(musicVolume);
  });
  const waterQuality = document.querySelector<HTMLInputElement>("#water-quality");
  waterQuality?.addEventListener("input", () => {
    const quality = Number(waterQuality.value) as WaterQuality;
    saveWaterQuality(quality);
    const output = document.querySelector<HTMLOutputElement>("output[for='water-quality']");
    if (output) output.value = waterQualityLabel(quality);
  });
  document.querySelector<HTMLButtonElement>("[data-action='open-crosshair']")?.addEventListener("click", () => {
    navigate("/");
    document.querySelector<HTMLButtonElement>("[data-action='crosshair']")?.click();
  });
  document.querySelector<HTMLButtonElement>("[data-action='fullscreen']")?.addEventListener("click", () => {
    if (document.fullscreenElement) void document.exitFullscreen();
    else void document.documentElement.requestFullscreen();
  });
  bindMovementBindingControls();
  bindTouchSettings(document);
}

function optionTabMarkup(tab: OptionTab, showFps: boolean): string {
  if (tab === "game") return optionGroup("game", [
    optionInfo("player model", PLAYER_MODEL_INFO[savedPlayerModel()].name),
    optionInfo("player name", escapeHtml(savedPlayerName())),
    optionNote("Player identity can be changed from the main menu."),
  ]);
  if (tab === "hud") return optionGroup("heads-up display", [
    optionCheck("show FPS", "show-fps", showFps, "Display the current frame rate in the lower-right corner."),
    `<button class="option-action" type="button" data-action="open-crosshair"><span><strong>crosshair</strong><small>Style, size and hit effects</small></span><b>adjust..</b></button>`,
  ]);
  if (tab === "gfx") return optionGroup("graphics", [
    optionInfo("renderer", "WebGL"), optionSlider("water quality", "water-quality", loadWaterQuality(), 0, 3,
      waterQualityLabel(loadWaterQuality())), optionInfo("dynamic lights", "enabled"),
    optionNote("Low disables planar reflections. Medium, high and ultra use progressively sharper real-time water reflections."),
  ]);
  if (tab === "display") return optionGroup("display", [
    `<button class="option-action" type="button" data-action="fullscreen"><span><strong>fullscreen</strong><small>Toggle browser fullscreen mode</small></span><b>toggle</b></button>`,
    optionInfo("v-sync", "browser controlled"), optionInfo("field of view", "100"),
  ]);
  if (tab === "res") return optionGroup("resolution", [
    optionInfo("current", `${window.innerWidth} × ${window.innerHeight}`),
    optionInfo("device pixel ratio", window.devicePixelRatio.toFixed(2)),
    optionNote("The viewport follows the browser window and scales automatically."),
  ]);
  if (tab === "sound") return optionGroup("sound", [
    optionInfo("sound effects", "enabled"), optionSlider("music volume", "music-volume", loadMusicVolume(), 0, 100),
    optionNote("Music follows Sauerbraten's menu and map rotation playlist."),
  ]);
  if (tab === "mouse") return optionGroup("mouse", [
    optionInfo("mouse capture", "pointer lock"), optionInfo("weapon selection", "mouse wheel"),
    optionNote("Click the game viewport to capture the mouse; press Escape to release it."),
  ]);
  if (tab === "binds") return optionGroup("binds", [
    touchSettingsMarkup(loadTouchSettings()),
    movementBindingsMarkup(),
    `<button class="option-reset-binds" type="button" data-action="reset-binds">reset movement binds</button>`,
    optionInfo("1–7 / wheel", "select weapon"),
    optionInfo("T / Y", "chat / team chat"), optionInfo("F11", "console"), optionInfo("Escape", "pause"),
  ]);
  return optionGroup("console", [
    optionInfo("F11", "open full console"), optionInfo("Page Up / Page Down", "scroll console"),
    optionInfo("/", "enter command"), optionNote("The in-game console reports map, network and gameplay messages."),
  ]);
}

function movementBindingsMarkup(): string {
  const bindings = loadMovementBindings();
  return MOVEMENT_BINDING_ACTIONS.map((action) => `<div class="option-bind"><span>${action}</span><button type="button"
    data-bind-action="${action}" aria-label="Change ${action} key">${keyBindingLabel(bindings[action])}</button></div>`).join("");
}

function bindMovementBindingControls(): void {
  let bindings = loadMovementBindings();
  document.querySelectorAll<HTMLButtonElement>("[data-bind-action]").forEach((button) => {
    button.addEventListener("click", () => {
      document.querySelectorAll<HTMLButtonElement>("[data-bind-action]").forEach((candidate) => {
        candidate.classList.remove("capturing");
        const action = candidate.dataset.bindAction as MovementBindingAction;
        candidate.textContent = keyBindingLabel(bindings[action]);
      });
      button.classList.add("capturing");
      button.textContent = "press a key…";
      button.focus();
    });
    button.addEventListener("keydown", (event) => {
      if (!button.classList.contains("capturing")) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        button.classList.remove("capturing");
        button.textContent = keyBindingLabel(bindings[button.dataset.bindAction as MovementBindingAction]);
        return;
      }
      if (!isBindableKey(event)) return;
      const action = button.dataset.bindAction as MovementBindingAction;
      const key = keyForEvent(event);
      bindings = { ...bindings, [action]: key };
      saveMovementBindings(bindings);
      button.classList.remove("capturing");
      button.textContent = keyBindingLabel(key);
    });
  });
  document.querySelector<HTMLButtonElement>("[data-action='reset-binds']")?.addEventListener("click", () => {
    bindings = resetMovementBindings();
    document.querySelectorAll<HTMLButtonElement>("[data-bind-action]").forEach((button) => {
      button.classList.remove("capturing");
      button.textContent = keyBindingLabel(bindings[button.dataset.bindAction as MovementBindingAction]);
    });
  });
}

function optionGroup(title: string, rows: string[]): string {
  return `<div class="option-group"><h2>${title}</h2>${rows.join("")}</div>`;
}

function optionCheck(label: string, id: string, checked: boolean, description: string): string {
  return `<label class="option-check" for="${id}"><span><strong>${label}</strong><small>${description}</small></span>
    <input id="${id}" type="checkbox" ${checked ? "checked" : ""} /></label>`;
}

function optionSlider(label: string, id: string, value: number, minimum: number, maximum: number, output = String(value)): string {
  return `<label class="option-slider" for="${id}"><span>${label}</span><div><input id="${id}" type="range" min="${minimum}" max="${maximum}"
    value="${value}" /><output for="${id}">${output}</output></div></label>`;
}

function optionInfo(label: string, value: string): string {
  return `<div class="option-info"><span>${label}</span><strong>${value}</strong></div>`;
}

function optionNote(text: string): string {
  return `<p class="option-note">${text}</p>`;
}

// Original: data/menus.cfg, newgui botmatch / startbotmatch.
function renderBotMatchMenu(): void {
  app.innerHTML = `
    <main class="sauer-screen">
      ${backgroundMarkup(false)}
      <section class="sauer-dialog botmatch-dialog" aria-labelledby="botmatch-title">
        ${guiSkinMarkup()}
        <header class="maps-heading"><div><p>bot match</p><h1 id="botmatch-title">bot settings</h1></div>
          <button id="botmatch-back" class="back-button" type="button">‹ main menu</button></header>
        <div class="botmatch-controls">
          ${botSlider("bot amount", "botmatch-count", botMatchCount, 0, 32)}
          ${botSlider("bot minimum skill", "botmatch-min-skill", botMatchMinSkill, 50, 101)}
          ${botSlider("bot maximum skill", "botmatch-max-skill", botMatchMaxSkill, 50, 101)}
          <button id="start-bot-match" class="primary-map-action" type="button">choose game mode</button>
        </div>
        <footer><span>Configure the number and skill level of your opponents</span></footer>
      </section>
    </main>`;
  required<HTMLButtonElement>("#botmatch-back").addEventListener("click", () => navigate("/"));
  const count = required<HTMLInputElement>("#botmatch-count"), minimum = required<HTMLInputElement>("#botmatch-min-skill"),
    maximum = required<HTMLInputElement>("#botmatch-max-skill");
  bindBotSlider(count, (value) => { botMatchCount = value; });
  bindBotSlider(minimum, (value) => {
    botMatchMinSkill = value;
    if (botMatchMaxSkill < value) { botMatchMaxSkill = value; maximum.value = String(value); syncSliderOutput(maximum); }
  });
  bindBotSlider(maximum, (value) => {
    botMatchMaxSkill = value;
    if (botMatchMinSkill > value) { botMatchMinSkill = value; minimum.value = String(value); syncSliderOutput(minimum); }
  });
  required<HTMLButtonElement>("#start-bot-match").addEventListener("click", () => navigate("/modes"));
}

// Original: data/menus.cfg, newgui gamemode. Ordering and labels intentionally match the two native columns.
function renderGameModeMenu(): void {
  const columns: Array<Array<[number, string]>> = [
    [[0, "ffa"], [1, "coop-edit"], [2, "teamplay"], [3, "instagib"], [4, "instagib team"], [5, "efficiency"],
      [6, "efficiency team"], [7, "tactics"], [8, "tactics team"], [9, "capture"], [10, "regen capture"]],
    [[11, "ctf"], [12, "insta ctf"], [17, "efficiency ctf"], [13, "protect"], [14, "insta protect"], [18, "efficiency protect"],
      [15, "hold"], [16, "insta hold"], [19, "efficiency hold"], [20, "collect"], [21, "insta collect"], [22, "efficiency collect"]],
  ];
  const choices = columns.flat();
  const initialChoice = choices.find(([mode]) => mode === selectedBotMode) ?? choices[0];
  app.innerHTML = `
    <main class="sauer-screen">${backgroundMarkup(false)}
      <section class="sauer-dialog gamemode-dialog" aria-labelledby="gamemode-title">${guiSkinMarkup()}
        <header class="maps-heading"><div><p>bot match</p><h1 id="gamemode-title">game mode</h1></div>
          <button id="gamemode-back" class="back-button" type="button">‹ bot match</button></header>
        <div class="gamemode-layout">
          <div class="gamemode-columns" role="listbox" aria-label="Game modes">${columns.map((column) => `<div>${column.map(([mode, label]) =>
            `<button type="button" role="option" data-bot-mode="${mode}" aria-selected="${mode === initialChoice[0]}">${label}</button>`)
            .join("")}</div>`).join("")}</div>
          <aside class="gamemode-details" aria-live="polite">
            <p>mode briefing</p>
            <h2 id="gamemode-name">${initialChoice[1]}</h2>
            <div id="gamemode-description">${gameModeDescription(initialChoice[0])}</div>
          </aside>
        </div>
        <footer><span>Hover over a mode to read its rules, click to select</span><span>Descriptions from Sauerbraten</span></footer>
      </section>
    </main>`;
  required<HTMLButtonElement>("#gamemode-back").addEventListener("click", () => navigate("/bots"));
  const modeName = required<HTMLHeadingElement>("#gamemode-name");
  const modeDescription = required<HTMLDivElement>("#gamemode-description");
  const modeButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-bot-mode]")];
  const previewModeChoice = (button: HTMLButtonElement): void => {
    const mode = Number(button.dataset.botMode);
    const label = button.textContent?.trim() || "mode";
    modeName.textContent = label;
    modeDescription.innerHTML = gameModeDescription(mode);
  };
  modeButtons.forEach((button) => {
    button.addEventListener("mouseenter", () => previewModeChoice(button));
    button.addEventListener("focus", () => previewModeChoice(button));
    button.addEventListener("click", () => {
      selectedBotMode = Number(button.dataset.botMode);
      selectedPage = [9, 10, 15, 16, 19].includes(selectedBotMode) ? "capture-1"
        : selectedBotMode >= 11 ? "ctf-1" : "ffa-1";
      previewMap = "";
      navigate("/maps");
    });
  });
}

function gameModeDescription(mode: number): string {
  return sauerFormattedMarkup(GAME_MODE_DESCRIPTIONS[mode + 3] ?? "No description is available for this mode.");
}

function botSlider(label: string, id: string, value: number, minimum: number, maximum: number): string {
  return `<label for="${id}"><span>${label}</span><div><input id="${id}" type="range" min="${minimum}" max="${maximum}" value="${value}" />
    <output for="${id}">${value}</output></div></label>`;
}

function bindBotSlider(input: HTMLInputElement, changed: (value: number) => void): void {
  input.addEventListener("input", () => { changed(Number(input.value)); syncSliderOutput(input); });
}

function syncSliderOutput(input: HTMLInputElement): void {
  const output = input.parentElement?.querySelector("output");
  if (output) output.value = input.value;
}

function currentCrosshair(selected = loadCrosshairSettings().selected) {
  return CROSSHAIRS[selected] ?? CROSSHAIRS[0];
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
  launchGame(`/game?${query}`);
}

function renderMapsMenu(): void {
  const availablePages = mapMenuPagesForMode(selectedBotMode);
  const page = availablePages.find((candidate) => candidate.id === selectedPage) ?? availablePages[0] ?? MAP_MENU_PAGES[0];
  selectedPage = page.id;
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
          <button id="maps-back" class="back-button" type="button">‹ game mode</button>
        </header>
        <nav class="map-tabs" role="tablist" aria-label="Map pages">
          ${availablePages.map((item) => `<button type="button" role="tab" data-page="${item.id}" aria-selected="${item.id === page.id}"
            class="${item.id === page.id ? "active" : ""}">${item.label}</button>`).join("")}
        </nav>
        <div class="map-browser">
          <div class="map-columns" role="listbox" aria-label="${page.label} maps">
            ${page.columns.map((column) => `<div>${column.map(mapButton).join("")}</div>`).join("")}
          </div>
          <aside class="map-preview" aria-live="polite">
            <div class="preview-frame">
              <img id="preview-map-image" src="/api/packages/base/${encodeURIComponent(previewMap)}.jpg" alt="${escapeHtml(previewMap)} map preview" />
              <img class="preview-overlay" src="/api/data/guioverlay.png" alt="" />
            </div>
            <strong id="preview-map-name">${escapeHtml(previewMap)}</strong>
            <span id="preview-map-status">${availableMaps === undefined ? "checking map…" : preview?.supported ? "ready to play" : "unavailable in this build"}</span>
          </aside>
        </div>
        <footer><span>${page.category.toUpperCase()} MAPS</span><span>Hover to preview · click to launch</span></footer>
      </section>
    </main>`;

  required<HTMLButtonElement>("#maps-back").addEventListener("click", () => navigate("/modes"));
  document.querySelectorAll<HTMLButtonElement>("[data-page]").forEach((button) => button.addEventListener("click", () => {
    selectedPage = button.dataset.page ?? selectedPage;
    previewMap = "";
    renderMapsMenu();
  }));
  const previewImage = required<HTMLImageElement>("#preview-map-image");
  const previewName = required<HTMLElement>("#preview-map-name");
  const previewStatus = required<HTMLElement>("#preview-map-status");
  const mapButtons = [...document.querySelectorAll<HTMLButtonElement>("[data-map]")];
  const previewMapChoice = (button: HTMLButtonElement): void => {
    const name = button.dataset.map ?? previewMap;
    const map = availableMaps?.get(name);
    previewMap = name;
    mapButtons.forEach((candidate) => candidate.classList.toggle("selected", candidate === button));
    previewImage.src = `/api/packages/base/${encodeURIComponent(name)}.jpg`;
    previewImage.alt = `${name} map preview`;
    previewName.textContent = name;
    previewStatus.textContent = availableMaps === undefined ? "checking map…" : map?.supported ? "ready to play" : "unavailable in this build";
  };
  mapButtons.forEach((button) => {
    button.addEventListener("mouseenter", () => previewMapChoice(button));
    button.addEventListener("focus", () => previewMapChoice(button));
    button.addEventListener("click", () => launchMap(button.dataset.map ?? ""));
  });
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
  const query = new URLSearchParams({ map: name, mode: String(selectedBotMode), bots: String(botMatchCount),
    minskill: String(botMatchMinSkill), maxskill: String(botMatchMaxSkill) });
  launchGame(`/game?${query}`);
}

function launchGame(url: string): void {
  void requestMobileLandscapeFullscreen();
  // Keep the launch click's user activation in this document. The game transfers
  // this temporary lock to its canvas once the asynchronous map load completes.
  try {
    const request = document.documentElement.requestPointerLock();
    if (request) void request.catch(() => undefined);
  } catch {
    // The viewport click remains a fallback where pointer lock is unavailable.
  }
  history.pushState(null, "", url);
  route();
}

function menuButton(label: string, action: string, enabled: boolean, icon = "menu"): string {
  return `<button type="button" data-action="${action}" ${enabled ? "" : "disabled"}><img src="/api/packages/icons/${icon}.jpg" alt="" /><span>${label}</span></button>`;
}

function menuLink(label: string, href: string, icon = "menu"): string {
  return `<a href="${href}" target="_blank" rel="noopener noreferrer"><img src="/api/packages/icons/${icon}.jpg" alt="" /><span>${label}</span></a>`;
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

function navigate(path: string): void {
  history.pushState(null, "", path);
  route();
}

function shouldShowExperimentalDisclaimer(): boolean {
  if (experimentalDisclaimerDismissed) return false;
  try {
    return sessionStorage.getItem(EXPERIMENTAL_DISCLAIMER_KEY) !== "true";
  } catch {
    return true;
  }
}

function dismissExperimentalDisclaimer(): void {
  experimentalDisclaimerDismissed = true;
  try {
    sessionStorage.setItem(EXPERIMENTAL_DISCLAIMER_KEY, "true");
  } catch {
    // The in-memory fallback still prevents the popup from repeating while the page remains loaded.
  }
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


function required<ElementType extends Element>(selector: string): ElementType {
  const element = document.querySelector<ElementType>(selector);
  if (!element) throw new Error(`Missing required element ${selector}.`);
  return element;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>'"]/g, (character) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", "'": "&#39;", "\"": "&quot;" })[character] ?? character);
}
