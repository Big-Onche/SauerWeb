export type ControlType = "auto" | "desktop" | "touch";

export interface TouchSettings {
  controlType: ControlType;
  sensitivity: number;
}

export const TOUCH_SETTINGS_CHANGED = "sauerweb-touch-settings-changed";
export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = { controlType: "auto", sensitivity: 100 };
const STORAGE_KEY = "sauerweb.touch-settings";

export function loadTouchSettings(): TouchSettings {
  try {
    return sanitizeTouchSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<TouchSettings>);
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

export function sanitizeTouchSettings(settings: Partial<TouchSettings>): TouchSettings {
  const controlType = settings.controlType === "desktop" || settings.controlType === "touch" ? settings.controlType : "auto";
  const sensitivity = typeof settings.sensitivity === "number" && Number.isFinite(settings.sensitivity)
    ? Math.min(200, Math.max(25, Math.round(settings.sensitivity))) : DEFAULT_TOUCH_SETTINGS.sensitivity;
  return { controlType, sensitivity };
}

export function touchControlsWanted(settings = loadTouchSettings()): boolean {
  if (settings.controlType !== "auto") return settings.controlType === "touch";
  return navigator.maxTouchPoints > 0 || matchMedia("(any-pointer: coarse)").matches;
}

export function touchSettingsMarkup(settings = loadTouchSettings()): string {
  return `<label class="option-select" for="control-type"><span>control type</span><select id="control-type">
    <option value="auto" ${settings.controlType === "auto" ? "selected" : ""}>automatic</option>
    <option value="desktop" ${settings.controlType === "desktop" ? "selected" : ""}>keyboard &amp; mouse</option>
    <option value="touch" ${settings.controlType === "touch" ? "selected" : ""}>touch</option>
  </select></label>
  <label class="option-slider" for="touch-sensitivity"><span>touch sensitivity</span><div>
    <input id="touch-sensitivity" type="range" min="25" max="200" step="5" value="${settings.sensitivity}" />
    <output for="touch-sensitivity">${settings.sensitivity}</output></div></label>`;
}

export function bindTouchSettings(root: ParentNode): () => void {
  const controlType = root.querySelector<HTMLSelectElement>("#control-type");
  const sensitivity = root.querySelector<HTMLInputElement>("#touch-sensitivity");
  const output = root.querySelector<HTMLOutputElement>("output[for='touch-sensitivity']");
  if (!controlType || !sensitivity) return () => undefined;
  const update = (): void => {
    if (output) output.value = sensitivity.value;
    saveTouchSettings({ controlType: controlType.value as ControlType, sensitivity: Number(sensitivity.value) });
  };
  controlType.addEventListener("change", update);
  sensitivity.addEventListener("input", update);
  return () => {
    controlType.removeEventListener("change", update);
    sensitivity.removeEventListener("input", update);
  };
}
