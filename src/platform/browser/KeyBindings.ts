export const MOVEMENT_BINDING_ACTIONS = ["forward", "backward", "left", "right", "jump"] as const;

export type MovementBindingAction = typeof MOVEMENT_BINDING_ACTIONS[number];
export type MovementBindings = Record<MovementBindingAction, string>;

export const DEFAULT_MOVEMENT_BINDINGS: Readonly<MovementBindings> = {
  forward: "w",
  backward: "s",
  left: "a",
  right: "d",
  jump: " ",
};

const STORAGE_KEY = "sauerweb.key-bindings";

export function loadMovementBindings(): MovementBindings {
  try {
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "{}") as Partial<MovementBindings>;
    return sanitizeMovementBindings(saved);
  } catch {
    return { ...DEFAULT_MOVEMENT_BINDINGS };
  }
}

export function saveMovementBindings(bindings: MovementBindings): void {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(sanitizeMovementBindings(bindings)));
  } catch {
    // Defaults remain usable when browser storage is unavailable.
  }
}

export function resetMovementBindings(): MovementBindings {
  const bindings = { ...DEFAULT_MOVEMENT_BINDINGS };
  saveMovementBindings(bindings);
  return bindings;
}

export function sanitizeMovementBindings(saved: Partial<MovementBindings>): MovementBindings {
  return Object.fromEntries(MOVEMENT_BINDING_ACTIONS.map((action) => [action,
    typeof saved[action] === "string" && saved[action] ? migrateLegacyCode(saved[action]) : DEFAULT_MOVEMENT_BINDINGS[action]])) as MovementBindings;
}

export function keyBindingLabel(key: string): string {
  if (key === " ") return "Space";
  if (key.length === 1) return key.toLocaleUpperCase();
  return key.replace(/([a-z])([A-Z])/g, "$1 $2");
}

export function keyForEvent(event: KeyboardEvent): string {
  return event.key.length === 1 ? event.key.toLocaleLowerCase() : event.key;
}

export function isBindableKey(event: KeyboardEvent): boolean {
  return Boolean(event.key) && !["Escape", "Tab", "CapsLock", "Meta", "Control", "Alt", "Shift", "Dead", "Unidentified", "Process"].includes(event.key);
}

function migrateLegacyCode(binding: string): string {
  if (/^Key[A-Z]$/.test(binding)) return binding.slice(3).toLocaleLowerCase();
  if (/^Digit[0-9]$/.test(binding)) return binding.slice(5);
  if (binding === "Space") return " ";
  return binding.length === 1 ? binding.toLocaleLowerCase() : binding;
}
