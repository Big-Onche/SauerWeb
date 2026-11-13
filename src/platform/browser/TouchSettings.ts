export type ControlType = "auto" | "desktop" | "touch";

export interface TouchSettings {
  controlType: ControlType;
  mouseSensitivity: number;
  touchSensitivity: number;
  aimHorizontalSensitivity: number;
  aimVerticalSensitivity: number;
  movementDeadzone: number;
  controlSize: number;
  controlOpacity: number;
  gyroEnabled: boolean;
  gyroSensitivity: number;
  gyroSmoothing: number;
  gyroInvertHorizontal: boolean;
  gyroInvertVertical: boolean;
  fullGyroEnabled: boolean;
  mobileHudScale: number;
}

interface PersistedTouchSettings extends Partial<TouchSettings> { sensitivity?: number }

export const TOUCH_SETTINGS_CHANGED = "sauerweb-touch-settings-changed";
export const GYRO_RECENTER_REQUESTED = "sauerweb-gyro-recenter-requested";
export const DEFAULT_TOUCH_SETTINGS: Readonly<TouchSettings> = {
  controlType: "auto", mouseSensitivity: 100, touchSensitivity: 250, aimHorizontalSensitivity: 260,
  aimVerticalSensitivity: 210, movementDeadzone: 18, controlSize: 100, controlOpacity: 65, gyroEnabled: false,
  gyroSensitivity: 100, gyroSmoothing: 35, gyroInvertHorizontal: false, gyroInvertVertical: false,
  fullGyroEnabled: false, mobileHudScale: 100,
};
const STORAGE_KEY = "sauerweb.touch-settings";

export function loadTouchSettings(): TouchSettings {
  try { return sanitizeTouchSettings(JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as PersistedTouchSettings); }
  catch { return { ...DEFAULT_TOUCH_SETTINGS }; }
}

export function saveTouchSettings(settings: TouchSettings): TouchSettings {
  const saved = sanitizeTouchSettings(settings);
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(saved)); }
  catch { /* The current session still receives the setting when storage is unavailable. */ }
  window.dispatchEvent(new CustomEvent<TouchSettings>(TOUCH_SETTINGS_CHANGED, { detail: saved }));
  return saved;
}

export function sanitizeTouchSettings(settings: PersistedTouchSettings): TouchSettings {
  const controlType = settings.controlType === "desktop" || settings.controlType === "touch" ? settings.controlType : "auto";
  const legacyTouchSensitivity = settings.sensitivity === 100 ? undefined : settings.sensitivity;
  const touchSensitivity = numberSetting(settings.touchSensitivity ?? legacyTouchSensitivity, 25, 500,
    DEFAULT_TOUCH_SETTINGS.touchSensitivity);
  return {
    controlType,
    mouseSensitivity: numberSetting(settings.mouseSensitivity, 25, 300, DEFAULT_TOUCH_SETTINGS.mouseSensitivity),
    touchSensitivity,
    aimHorizontalSensitivity: numberSetting(settings.aimHorizontalSensitivity, 50, 500,
      touchSensitivity || DEFAULT_TOUCH_SETTINGS.aimHorizontalSensitivity),
    aimVerticalSensitivity: numberSetting(settings.aimVerticalSensitivity, 50, 500, DEFAULT_TOUCH_SETTINGS.aimVerticalSensitivity),
    movementDeadzone: numberSetting(settings.movementDeadzone, 0, 45, DEFAULT_TOUCH_SETTINGS.movementDeadzone),
    controlSize: numberSetting(settings.controlSize, 70, 140, DEFAULT_TOUCH_SETTINGS.controlSize),
    controlOpacity: numberSetting(settings.controlOpacity, 25, 100, DEFAULT_TOUCH_SETTINGS.controlOpacity),
    gyroEnabled: settings.gyroEnabled === true,
    gyroSensitivity: numberSetting(settings.gyroSensitivity, 25, 300, DEFAULT_TOUCH_SETTINGS.gyroSensitivity),
    gyroSmoothing: numberSetting(settings.gyroSmoothing, 0, 90, DEFAULT_TOUCH_SETTINGS.gyroSmoothing),
    gyroInvertHorizontal: settings.gyroInvertHorizontal === true,
    gyroInvertVertical: settings.gyroInvertVertical === true,
    fullGyroEnabled: settings.fullGyroEnabled === true,
    mobileHudScale: numberSetting(settings.mobileHudScale, 75, 130, DEFAULT_TOUCH_SETTINGS.mobileHudScale),
  };
}

export function touchControlsWanted(settings: { controlType: ControlType; mouseSensitivity?: number;
  touchSensitivity?: number } = loadTouchSettings()): boolean {
  if (settings.controlType !== "auto") return settings.controlType === "touch";
  const coarsePointer = matchMedia("(any-pointer: coarse)").matches;
  const touchCapable = navigator.maxTouchPoints > 0 || "ontouchstart" in window;
  const compactViewport = Math.min(window.innerWidth, window.innerHeight) <= 820 || Math.max(window.innerWidth, window.innerHeight) <= 1366;
  return coarsePointer || touchCapable && compactViewport;
}

export function touchSettingsMarkup(settings = loadTouchSettings()): string {
  return `<label class="option-select" for="control-type"><span>control type</span><select id="control-type">
    <option value="auto" ${settings.controlType === "auto" ? "selected" : ""}>Auto</option>
    <option value="desktop" ${settings.controlType === "desktop" ? "selected" : ""}>Keyboard + Mouse</option>
    <option value="touch" ${settings.controlType === "touch" ? "selected" : ""}>Mobile Double Claw</option>
  </select></label>
  ${slider("mouse sensitivity", "mouse-sensitivity", 25, 300, 5, settings.mouseSensitivity)}
  ${slider("aim horizontal", "aim-horizontal-sensitivity", 50, 500, 5, settings.aimHorizontalSensitivity)}
  ${slider("aim vertical", "aim-vertical-sensitivity", 50, 500, 5, settings.aimVerticalSensitivity)}
  ${slider("movement deadzone", "movement-deadzone", 0, 45, 1, settings.movementDeadzone)}
  ${slider("control size", "control-size", 70, 140, 5, settings.controlSize)}
  ${slider("control opacity", "control-opacity", 25, 100, 5, settings.controlOpacity)}
  ${slider("mobile HUD scale", "mobile-hud-scale", 75, 130, 5, settings.mobileHudScale)}
  ${checkbox("precision gyroscope", "gyro-enabled", settings.gyroEnabled)}
  ${slider("gyro sensitivity", "gyro-sensitivity", 25, 300, 5, settings.gyroSensitivity)}
  ${slider("gyro smoothing", "gyro-smoothing", 0, 90, 5, settings.gyroSmoothing)}
  ${checkbox("invert gyro horizontal", "gyro-invert-horizontal", settings.gyroInvertHorizontal)}
  ${checkbox("invert gyro vertical", "gyro-invert-vertical", settings.gyroInvertVertical)}
  ${checkbox("full gyro spectator", "full-gyro-enabled", settings.fullGyroEnabled)}
  <button class="option-action gyro-recenter" type="button" data-action="recenter-gyro"><span><strong>recenter gyro</strong>
    <small>Use the current device direction as forward</small></span><b>recenter</b></button>`;
}

export function bindTouchSettings(root: ParentNode): () => void {
  const controlType = root.querySelector<HTMLSelectElement>("#control-type");
  if (!controlType) return () => undefined;
  const listeners: Array<{ element: Element; type: string; listener: EventListener }> = [];
  const update = (): void => {
    const current = loadTouchSettings();
    const value = (id: string): number => Number(root.querySelector<HTMLInputElement>(`#${id}`)?.value);
    const checked = (id: string): boolean => root.querySelector<HTMLInputElement>(`#${id}`)?.checked ?? false;
    root.querySelectorAll<HTMLInputElement>("input[type='range']").forEach((input) => {
      const output = root.querySelector<HTMLOutputElement>(`output[for='${input.id}']`);
      if (output) output.value = input.value;
    });
    saveTouchSettings({ ...current, controlType: controlType.value as ControlType, mouseSensitivity: value("mouse-sensitivity"),
      aimHorizontalSensitivity: value("aim-horizontal-sensitivity"), aimVerticalSensitivity: value("aim-vertical-sensitivity"),
      movementDeadzone: value("movement-deadzone"), controlSize: value("control-size"), controlOpacity: value("control-opacity"),
      mobileHudScale: value("mobile-hud-scale"), gyroEnabled: checked("gyro-enabled"), gyroSensitivity: value("gyro-sensitivity"),
      gyroSmoothing: value("gyro-smoothing"), gyroInvertHorizontal: checked("gyro-invert-horizontal"),
      gyroInvertVertical: checked("gyro-invert-vertical"), fullGyroEnabled: checked("full-gyro-enabled") });
  };
  [controlType, ...root.querySelectorAll<HTMLInputElement>("input")].forEach((element) => {
    const type = element instanceof HTMLSelectElement || element.type === "checkbox" ? "change" : "input";
    element.addEventListener(type, update);
    listeners.push({ element, type, listener: update });
  });
  const recenter = root.querySelector<HTMLButtonElement>("[data-action='recenter-gyro']");
  const requestRecenter = (): void => { window.dispatchEvent(new Event(GYRO_RECENTER_REQUESTED)); };
  if (recenter) {
    recenter.addEventListener("click", requestRecenter);
    listeners.push({ element: recenter, type: "click", listener: requestRecenter });
  }
  return () => listeners.forEach(({ element, type, listener }) => element.removeEventListener(type, listener));
}

function slider(label: string, id: string, minimum: number, maximum: number, step: number, value: number): string {
  return `<label class="option-slider" for="${id}"><span>${label}</span><div><input id="${id}" type="range" min="${minimum}"
    max="${maximum}" step="${step}" value="${value}" /><output for="${id}">${value}</output></div></label>`;
}

function checkbox(label: string, id: string, checked: boolean): string {
  return `<label class="option-select option-check" for="${id}"><span>${label}</span><input id="${id}" type="checkbox"
    ${checked ? "checked" : ""} /></label>`;
}

function numberSetting(value: number | undefined, minimum: number, maximum: number, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.min(maximum, Math.max(minimum, Math.round(value))) : fallback;
}
