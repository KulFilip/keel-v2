// keel TUI's own settings: what the person chose in keel TUI that it keeps for the next start (the sidebar on or off).
// One small JSON file: KEEL_TUI_SETTINGS, else $XDG_CONFIG_HOME/keel2/tui.json, else ~/.config/keel2/tui.json. A file
// that cannot be read or written is no error: keel TUI starts with the defaults and keeps the choice while it runs.

import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type TuiSettings = {
  /** the sidebar (Ctrl+B, /sidebar): shown on a wide terminal; false hides it */
  sidebar?: boolean;
  /** per-role colour overrides, as KEEL_TUI_COLORS: { "ok": "#3cc463", "gate": "ansi:yellow" } (the env wins) */
  colors?: Record<string, string>;
};

export type SettingsStore = {
  get: () => TuiSettings;
  set: (patch: TuiSettings) => void;
};

/** Settings kept in memory only (tests, --script): nothing is read or written. */
export function memorySettings(init: TuiSettings = {}): SettingsStore {
  let now = { ...init };
  return { get: () => now, set: (patch) => void (now = { ...now, ...patch }) };
}

type Env = Record<string, string | undefined>;

/** Where the file is. */
export function settingsPath(env: Env = process.env): string {
  return (
    env.KEEL_TUI_SETTINGS ||
    join(env.XDG_CONFIG_HOME || join(homedir(), ".config"), "keel2", "tui.json")
  );
}

/** Settings in the person's file. */
export function fileSettings(env: Env = process.env): SettingsStore {
  const file = settingsPath(env);
  let now: TuiSettings = {};
  try {
    const v = JSON.parse(readFileSync(file, "utf8"));
    if (v && typeof v === "object") now = v as TuiSettings;
  } catch {
    /* none yet, or not readable: the defaults */
  }
  return {
    get: () => now,
    set: (patch) => {
      now = { ...now, ...patch };
      try {
        mkdirSync(dirname(file), { recursive: true });
        writeFileSync(file, JSON.stringify(now, null, 1) + "\n");
      } catch {
        /* kept while keel TUI runs */
      }
    },
  };
}
