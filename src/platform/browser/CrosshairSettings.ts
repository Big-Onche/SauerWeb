export interface CrosshairDefinition {
  name: string;
  normal: string;
  hit: string;
}

export interface CrosshairSettings {
  selected: number;
  size: number;
  effects: boolean;
  colors: boolean;
  teammates: boolean;
  hitDuration: number;
}

export const CROSSHAIRS: readonly CrosshairDefinition[] = [
  crosshair("default", "/api/data/crosshair.png", "/api/data/hit.png"),
  packageCrosshair("x", "x.png", "x-hit.png"),
  packageCrosshair("x dot", "x_dot.png", "x_dot-hit.png"),
  packageCrosshair("circle", "o.png", "o-hit.png"),
  packageCrosshair("circle x", "o_x.png", "o_x-hit.png"),
  packageCrosshair("circle dot", "o_dot.png", "o_dot-hit.png"),
  packageCrosshair("dot", "dot.png", "dot-hit.png"),
  packageCrosshair("wide dot", "dot_wide.png", "dot_wide-hit.png"),
  packageCrosshair("star", "star.png", "star-hit.png"),
  packageCrosshair("wide", "wide.png", "wide-hit.png"),
  packageCrosshair("ring dot", "circle_dot.png", "circle_dot_hit.png"),
  packageCrosshair("normal cross", "cross_normal.png", "cross_normal_hit.png"),
  packageCrosshair("whole cross", "cross_whole.png", "cross_whole_hit.png"),
  packageCrosshair("normal dot", "dot_normal.png", "dot_normal_hit.png"),
  packageCrosshair("whole dot", "dot_whole.png", "dot_whole_hit.png"),
];

const STORAGE_KEY = "sauerweb.crosshair";
const DEFAULT_SETTINGS: CrosshairSettings = { selected: 0, size: 15, effects: true, colors: true, teammates: true, hitDuration: 425 };

export function loadCrosshairSettings(): CrosshairSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<CrosshairSettings>;
    return sanitizeCrosshairSettings({ ...DEFAULT_SETTINGS, ...saved });
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveCrosshairSettings(settings: CrosshairSettings): void {
  const sanitized = sanitizeCrosshairSettings(settings);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized)); } catch { /* Storage can be disabled without disabling the HUD. */ }
  window.dispatchEvent(new CustomEvent<CrosshairSettings>("sauerweb-crosshair-change", { detail: sanitized }));
}

export function crosshairSettingsMarkup(settings: CrosshairSettings): string {
  return `
    <label class="crosshair-size"><span>crosshair size</span><output>${settings.size}</output>
      <input data-crosshair-size type="range" min="0" max="50" value="${settings.size}" /></label>
    <div class="crosshair-grid" role="radiogroup" aria-label="Crosshair style">
      ${CROSSHAIRS.map((item, index) => `<button type="button" role="radio" aria-checked="${index === settings.selected}"
        aria-label="${item.name}" data-crosshair-index="${index}" class="${index === settings.selected ? "active" : ""}">
        <img src="${item.normal}" alt="" /></button>`).join("")}
    </div>
    <div class="crosshair-effects">
      <label><input data-crosshair-effects type="checkbox" ${settings.effects ? "checked" : ""} /> crosshair effects</label>
      <label><input data-crosshair-colors type="checkbox" ${settings.colors ? "checked" : ""} /> health colors</label>
      <label><input data-crosshair-teammates type="checkbox" ${settings.teammates ? "checked" : ""} /> teammates</label>
      <label class="crosshair-hit-duration"><span>hit display</span><output>${settings.hitDuration} ms</output>
        <input data-crosshair-hit-duration type="range" min="0" max="1000" step="25" value="${settings.hitDuration}" /></label>
    </div>`;
}

export function bindCrosshairSettings(root: ParentNode, onChange?: (settings: CrosshairSettings) => void): void {
  let settings = loadCrosshairSettings();
  const commit = (): void => {
    saveCrosshairSettings(settings);
    onChange?.(settings);
  };
  root.querySelectorAll<HTMLButtonElement>("[data-crosshair-index]").forEach((button) => {
    button.addEventListener("click", () => {
      settings = { ...settings, selected: Number(button.dataset.crosshairIndex) };
      root.querySelectorAll<HTMLButtonElement>("[data-crosshair-index]").forEach((item) => {
        const active = item === button;
        item.classList.toggle("active", active);
        item.setAttribute("aria-checked", String(active));
      });
      commit();
    });
  });
  bindRange(root, "[data-crosshair-size]", (value) => { settings = { ...settings, size: value }; commit(); });
  bindRange(root, "[data-crosshair-hit-duration]", (value) => { settings = { ...settings, hitDuration: value }; commit(); }, " ms");
  bindCheckbox(root, "[data-crosshair-effects]", (checked) => { settings = { ...settings, effects: checked }; commit(); });
  bindCheckbox(root, "[data-crosshair-colors]", (checked) => { settings = { ...settings, colors: checked }; commit(); });
  bindCheckbox(root, "[data-crosshair-teammates]", (checked) => { settings = { ...settings, teammates: checked }; commit(); });
}

function bindRange(root: ParentNode, selector: string, update: (value: number) => void, suffix = ""): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  if (!input) return;
  const output = input.parentElement?.querySelector("output");
  input.addEventListener("input", () => {
    const value = Number(input.value);
    if (output) output.textContent = `${value}${suffix}`;
    update(value);
  });
}

function bindCheckbox(root: ParentNode, selector: string, update: (checked: boolean) => void): void {
  const input = root.querySelector<HTMLInputElement>(selector);
  input?.addEventListener("change", () => update(input.checked));
}

function sanitizeCrosshairSettings(settings: CrosshairSettings): CrosshairSettings {
  return {
    selected: integerInRange(settings.selected, 0, CROSSHAIRS.length - 1, DEFAULT_SETTINGS.selected),
    size: integerInRange(settings.size, 0, 50, DEFAULT_SETTINGS.size),
    effects: Boolean(settings.effects),
    colors: Boolean(settings.colors),
    teammates: Boolean(settings.teammates),
    hitDuration: integerInRange(settings.hitDuration, 0, 1000, DEFAULT_SETTINGS.hitDuration),
  };
}

function integerInRange(value: number, minimum: number, maximum: number, fallback: number): number {
  return Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}

function packageCrosshair(name: string, normal: string, hit: string): CrosshairDefinition {
  return crosshair(name, `/api/packages/crosshairs/${normal}`, `/api/packages/crosshairs/${hit}`);
}

function crosshair(name: string, normal: string, hit: string): CrosshairDefinition {
  return { name, normal, hit };
}
