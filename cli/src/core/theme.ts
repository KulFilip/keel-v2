// keel's colours in the terminal: the dashboard's own palette (web/src/styles.css, the dark and the light tokens), as
// truecolor, with a 256- or 16-colour fallback (chalk picks the closest the terminal has) and none with NO_COLOR.
//
//   KEEL_TUI_THEME=dark|light   which palette (default: the terminal's background from COLORFGBG, else dark)
//   NO_COLOR=1                  no colour at all (https://no-color.org); FORCE_COLOR=1|2|3 forces a level
//
// No UI here: a Paint turns text into styled text for any terminal front end; keel TUI's Ink parts read the palette.

import chalk, { Chalk } from "chalk";

export type Role =
  | "fg" | "dim" | "faint" | "border" | "accent" | "run" | "ok" | "warn" | "bad" | "gate"
  | "kw" | "str" | "num" | "com" | "fn" | "attr" | "type" | "add" | "del";
export type Palette = Record<Role, string> & { bg: string };

/** The dashboard's dark tokens (styles.css [data-theme=dark] and the code view's --hl-*). */
export const DARK: Palette = {
  bg: "#131314", fg: "#f7f6f3", dim: "#9a958c", faint: "#6b675f", border: "#3d3d43",
  accent: "#a48bff", run: "#57aeff", ok: "#4ec07c", warn: "#e0a13a", bad: "#f0685a", gate: "#e9b53a",
  kw: "#c3a6ff", str: "#8fd19e", num: "#f0b46a", com: "#8a857c", fn: "#7cc2ff", attr: "#e8c07a", type: "#f59ac2",
  add: "#4ec07c", del: "#f0685a",
};

/** The dashboard's light tokens. */
export const LIGHT: Palette = {
  bg: "#f7f6f3", fg: "#131314", dim: "#5f5b54", faint: "#8a857c", border: "#b9b4aa",
  accent: "#6a4ee6", run: "#0b62a8", ok: "#1f7a45", warn: "#9a5b00", bad: "#b03024", gate: "#8a5a00",
  kw: "#7a3fd1", str: "#1f7a45", num: "#a35a00", com: "#7d786f", fn: "#0b62a8", attr: "#9a5b00", type: "#b03a6f",
  add: "#1f7a45", del: "#b03024",
};

type Fn = (s: string) => string;
export type Paint = Record<Role, Fn> & { bold: Fn; italic: Fn; underline: Fn; inverse: Fn; colored: boolean };

const id: Fn = (s) => s;
const ROLES = Object.keys(DARK).filter((k) => k !== "bg") as Role[];

/** No colour, no style: what -c prints into a pipe, and what NO_COLOR asks for. */
export const PLAIN: Paint = { ...(Object.fromEntries(ROLES.map((r) => [r, id])) as Record<Role, Fn>), bold: id, italic: id, underline: id,
  inverse: id, colored: false };

export function makePaint(p: Palette, level: 0 | 1 | 2 | 3): Paint {
  if (level === 0) return PLAIN;
  const c = new Chalk({ level });
  return { ...(Object.fromEntries(ROLES.map((r) => [r, (s: string) => c.hex(p[r])(s)])) as Record<Role, Fn>),
    bold: (s) => c.bold(s), italic: (s) => c.italic(s), underline: (s) => c.underline(s), inverse: (s) => c.inverse(s), colored: true };
}

export type Theme = { name: "dark" | "light"; palette: Palette; level: 0 | 1 | 2 | 3; paint: Paint; ascii: boolean };

type Env = Record<string, string | undefined>;

/** dark or light: KEEL_TUI_THEME, else the background COLORFGBG says ("15;0" is light text on dark), else dark. */
export function themeName(env: Env): "dark" | "light" {
  const want = (env.KEEL_TUI_THEME ?? "").toLowerCase();
  if (want === "light" || want === "dark") return want;
  const bg = Number((env.COLORFGBG ?? "").split(";").pop());
  return bg === 7 || bg === 15 ? "light" : "dark";
}

/** The colour level: 0 with NO_COLOR, else what chalk found (FORCE_COLOR, COLORTERM=truecolor, TERM). */
export function colorLevel(env: Env, detected: number = chalk.level): 0 | 1 | 2 | 3 {
  if (env.NO_COLOR !== undefined && env.NO_COLOR !== "") return 0;
  return Math.max(0, Math.min(3, detected)) as 0 | 1 | 2 | 3;
}

/** Glyphs need a UTF-8 terminal: KEEL_TUI_ASCII=1, TERM=dumb or a non-UTF-8 locale use ASCII. */
export function asciiOnly(env: Env): boolean {
  if (env.KEEL_TUI_ASCII === "1" || env.TERM === "dumb") return true;
  const loc = env.LC_ALL || env.LC_CTYPE || env.LANG || "";
  return !!loc && !/utf-?8/i.test(loc);
}

export function makeTheme(env: Env = process.env, detected?: number): Theme {
  const name = themeName(env);
  const level = colorLevel(env, detected);
  const palette = name === "light" ? LIGHT : DARK;
  return { name, palette, level, paint: makePaint(palette, level), ascii: asciiOnly(env) };
}

/** Make Ink (which colours with chalk's own instance) use the same level: none with NO_COLOR. */
export function applyLevel(t: Theme) {
  chalk.level = t.level;
}

// ------------------------------------------------------------------ contrast (WCAG), for the tests of both palettes

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
