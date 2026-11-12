export interface HudSettings {
  showFps: boolean;
}

const STORAGE_KEY = "sauerweb.hud-settings";
const DEFAULT_SETTINGS: HudSettings = { showFps: true };

export function loadHudSettings(): HudSettings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<HudSettings>;
    return { showFps: saved.showFps === undefined ? DEFAULT_SETTINGS.showFps : Boolean(saved.showFps) };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

export function saveHudSettings(settings: HudSettings): void {
  const sanitized = { showFps: Boolean(settings.showFps) };
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitized)); } catch { /* The default remains usable without storage. */ }
  window.dispatchEvent(new CustomEvent<HudSettings>("sauerweb-hud-settings-change", { detail: sanitized }));
}
