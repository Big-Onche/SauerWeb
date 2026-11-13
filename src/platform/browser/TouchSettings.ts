export type ControlType = "auto" | "desktop" | "touch";

export interface TouchSettings {
  controlType: ControlType;
  mouseSensitivity: number;
  touchSensitivity: number;
}

interface PersistedTouchSettings extends Partial<TouchSettings> {
  sensitivity?: number;
}

export const TOUCH_SETTINGS_CHANGED = "sauerweb-touch-settings-changed";
export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = { controlType: "auto", mouseSensitivity: 100, touchSensitivity: 250 };
const STORAGE_KEY = "sauerweb.touch-settings";

export function loadTouchSettings(): TouchSettings {
  try {
    return sanitizeTouchSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as PersistedTouchSettings);
  } catch {
    return { ...DEFAULT_TOUCH_SETTINGS };
  }
}

export function saveTouchSettings(settings: TouchSettings): TouchSettings {
  const saved = sanitizeTouchSettings(settings);
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(saved));
  } catch {
    // The current session still receives the setting when storage is unavailable.
  }
  window.dispatchEvent(new CustomEvent<TouchSettings>(TOUCH_SETTINGS_CHANGED, { detail: saved }));
  return saved;
}

export function sanitizeTouchSettings(settings: PersistedTouchSettings): TouchSettings {
  const controlType = settings.controlType === "desktop" || settings.controlType === "touch" ? settings.controlType : "auto";
  const mouseSensitivity = sanitizeSensitivity(settings.mouseSensitivity, DEFAULT_TOUCH_SETTINGS.mouseSensitivity, 300);
  // The original single touch slider defaulted to 100. Treat that unmodified legacy
  // value as the new, faster default while preserving other user-selected values.
  const legacyTouchSensitivity = settings.sensitivity === 100 ? undefined : settings.sensitivity;
  const touchSensitivity = sanitizeSensitivity(settings.touchSensitivity ?? legacyTouchSensitivity, DEFAULT_TOUCH_SETTINGS.touchSensitivity, 500);
  return { controlType, mouseSensitivity, touchSensitivity };
}

export function touchControlsWanted(settings = loadTouchSettings()): boolean {
  if (settings.controlType !== "auto") return settings.controlType === "touch";
  const coarsePointer = matchMedia("(any-pointer: coarse)").matches;
  const touchCapable = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const compactViewport = Math.min(window.innerWidth, window.innerHeight) <= 820 || Math.max(window.innerWidth, window.innerHeight) <= 1366;
  return coarsePointer || touchCapable && compactViewport;
}

export function touchSettingsMarkup(settings = loadTouchSettings()): string {
  return `<label class="option-select" for="control-type"><span>control type</span><select id="control-type">
    <option value="auto" ${settings.controlType === "auto" ? "selected" : ""}>Auto</option>
    <option value="desktop" ${settings.controlType === "desktop" ? "selected" : ""}>Keyboard &amp; Mouse</option>
    <option value="touch" ${settings.controlType === "touch" ? "selected" : ""}>Touch</option>
  </select></label>
  <label class="option-slider" for="mouse-sensitivity"><span>mouse sensitivity</span><div>
    <input id="mouse-sensitivity" type="range" min="25" max="300" step="5" value="${settings.mouseSensitivity}" />
    <output for="mouse-sensitivity">${settings.mouseSensitivity}</output></div></label>
  <label class="option-slider" for="touch-sensitivity"><span>touch sensitivity</span><div>
    <input id="touch-sensitivity" type="range" min="25" max="500" step="5" value="${settings.touchSensitivity}" />
    <output for="touch-sensitivity">${settings.touchSensitivity}</output></div></label>`;
}

export function bindTouchSettings(root: ParentNode): () => void {
  const controlType = root.querySelector<HTMLSelectElement>("#control-type");
  const mouseSensitivity = root.querySelector<HTMLInputElement>("#mouse-sensitivity");
  const touchSensitivity = root.querySelector<HTMLInputElement>("#touch-sensitivity");
  if (!controlType || !mouseSensitivity || !touchSensitivity) return () => undefined;
  const update = (): void => {
    const mouseOutput = root.querySelector<HTMLOutputElement>("output[for='mouse-sensitivity']");
    const touchOutput = root.querySelector<HTMLOutputElement>("output[for='touch-sensitivity']");
    if (mouseOutput) mouseOutput.value = mouseSensitivity.value;
    if (touchOutput) touchOutput.value = touchSensitivity.value;
    saveTouchSettings({ controlType: controlType.value as ControlType, mouseSensitivity: Number(mouseSensitivity.value),
      touchSensitivity: Number(touchSensitivity.value) });
  };
  controlType.addEventListener("change", update);
  mouseSensitivity.addEventListener("input", update);
  touchSensitivity.addEventListener("input", update);
  return () => {
    controlType.removeEventListener("change", update);
    mouseSensitivity.removeEventListener("input", update);
    touchSensitivity.removeEventListener("input", update);
  };
}

function sanitizeSensitivity(value: number | undefined, fallback: number, maximum: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(25, Math.round(value))) : fallback;
}
