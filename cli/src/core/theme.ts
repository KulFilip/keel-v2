// keel's colours in the terminal: one place for every colour keel TUI draws with. Each piece of text has a ROLE (the
// person's message, KeelBot's answer, a gate that waits, a question, a hint, meta text ...) and each palette says how
// that role looks. The palettes use the terminal's own named ANSI colours wherever they read well, so a terminal theme
// (Solarized, Dracula, macOS Basic ...) decides the exact shade; a fixed shade only where the named colour is known to
// be too pale (green and yellow on a light background, the quiet grey of meta text on a known background).
//
//   KEEL_TUI_THEME=keel|dark|light|auto   which palette. Unset (the default) or "terminal": keel's own palette, or light
//                                    when COLORFGBG / the background the terminal reports (OSC 11, termbg.ts) is light.
//                                    auto: follow the background (dark, light; a palette that reads on both if unknown)
//   /theme keel|dark|light|auto      the same while keel TUI runs
//   KEEL_TUI_COLORS="ok=#3cc463,gate=ansi:yellow"   per-role overrides on top of whichever palette is active (see
//                                    parseColors); the same as a `colors` object in keel TUI's settings file (the env wins)
//   NO_COLOR=1                       no colour at all (https://no-color.org); FORCE_COLOR=0|1|2|3 forces a level
//
// Colour is never the only sign: the person's lines start with a bold "›", gates and notices with "◆", suggestions
// with "✦", questions with "?" or their number, bullets "•"; hints and details have their own indentation.
//
// No UI here: a Paint turns text into styled text for any terminal front end; keel TUI's Ink parts read the palette.

import chalk, { Chalk } from "chalk";

/** The semantic roles (what the text IS) and the code roles (highlighted code). `dim` and `faint` are kept for the
 *  older call sites: both are the quiet meta look now, never grey on grey. */
export type Role =
  // the conversation
  | "person" | "keelbot" | "heading" | "accent"
  // waiting for the person
  | "gate" | "question" | "option" | "recommended" | "chosen" | "suggest"
  // secondary and quiet text
  | "hint" | "detail" | "meta" | "dim" | "faint" | "border"
  // outcomes
  | "ok" | "warn" | "bad"
  // code, paths and links, diffs
  | "code" | "path" | "link" | "run" | "add" | "del"
  // highlighted code (highlight.ts)
  | "fg" | "kw" | "str" | "num" | "com" | "fn" | "attr" | "type";

/** A role's look: "ansi:<name>" (the terminal's named colour), "#rrggbb" (a fixed shade), "term:" (the terminal's
 *  own text colour), "dim:" (the terminal's text colour, dimmed: quiet on any background). */
export type Palette = Record<Role, string>;

const META_DARK = "#a8a8a8";   // ≥ 4.5:1 on black and on the usual dark backgrounds (#1e1e1e, Dracula, Nord, Solarized)
const META_LIGHT = "#5c5c5c";  // ≥ 4.5:1 on white and on Solarized light
const GREEN_LIGHT = "#1a7f37"; // the named greens of many light themes are under 3:1 on white
const AMBER_LIGHT = "#8a5a00"; // the named yellows of many light themes are under 2:1 on white
const TEAL_LIGHT = "#0b6e6e";  // so is cyan

const shared = { fg: "term:", keelbot: "term:", question: "term:", option: "term:", detail: "term:", bad: "ansi:red", del: "ansi:red" };

const KEEL_GREEN = "#2fa84f";  // ok, recommended, success, diff add: ≥ 4.5:1 on dark, 3:1 on white
const KEEL_AMBER = "#f2b84b";  // gate, warn
const KEEL_META = "#9a958c";   // meta, dim, faint, comments: warm grey, ≥ 6:1 on near-black, 2.9:1 on white
const KEEL_ACCENT = "#a48bff"; // keel's accent (the old pink), fixed so it does not depend on the terminal's magenta
const KEEL_TEAL = "#2f9e9e";   // hints and attributes: readable on dark (5:1) and on white (3.3:1)
const KEEL_NUM = "#c98a1a";    // numbers in code: readable on dark (7:1) and on white (3:1)

/** A dark background: the terminal's normal colours (its theme makes them readable on its own background), bright blue
 *  for blue (normal blue is too dark on most dark themes). */
export const DARK: Palette = {
  ...shared,
  person: "ansi:blueBright", heading: "ansi:magentaBright", accent: "ansi:magentaBright",
  gate: "ansi:yellow", recommended: "ansi:green", chosen: "ansi:green", suggest: "ansi:magentaBright",
  hint: "ansi:cyan", meta: META_DARK, dim: META_DARK, faint: META_DARK, border: META_DARK,
  ok: "ansi:green", warn: "ansi:yellow",
  code: "ansi:magentaBright", path: "ansi:blueBright", link: "ansi:blueBright", run: "ansi:blueBright", add: "ansi:green",
  kw: "ansi:magentaBright", str: "ansi:green", num: "ansi:yellow", com: META_DARK, fn: "ansi:blueBright", attr: "ansi:cyan", type: "ansi:cyan",
};

/** A light background: named red, blue and magenta; fixed dark shades of green, amber, teal and grey. */
export const LIGHT: Palette = {
  ...shared,
  person: "ansi:blue", heading: "ansi:magenta", accent: "ansi:magenta",
  gate: AMBER_LIGHT, recommended: GREEN_LIGHT, chosen: GREEN_LIGHT, suggest: "ansi:magenta",
  hint: TEAL_LIGHT, meta: META_LIGHT, dim: META_LIGHT, faint: META_LIGHT, border: META_LIGHT,
  ok: GREEN_LIGHT, warn: AMBER_LIGHT,
  code: "ansi:magenta", path: "ansi:blue", link: "ansi:blue", run: "ansi:blue", add: GREEN_LIGHT,
  kw: "ansi:magenta", str: GREEN_LIGHT, num: AMBER_LIGHT, com: META_LIGHT, fn: "ansi:blue", attr: TEAL_LIGHT, type: "ansi:magenta",
};

/** keel's own look (the default): the light palette's choices (person blue bar, the named blue for paths and links, red
 *  for errors) with fixed shades that read on a dark, warm background and are still acceptable on a light one. */
export const KEEL: Palette = {
  ...shared,
  person: "ansi:blue", heading: KEEL_ACCENT, accent: KEEL_ACCENT,
  gate: KEEL_AMBER, recommended: KEEL_GREEN, chosen: KEEL_GREEN, suggest: KEEL_ACCENT,
  hint: KEEL_TEAL, meta: KEEL_META, dim: KEEL_META, faint: KEEL_META, border: KEEL_META,
  ok: KEEL_GREEN, warn: KEEL_AMBER,
  code: KEEL_ACCENT, path: "ansi:blue", link: "ansi:blue", run: "ansi:blue", add: KEEL_GREEN,
  kw: KEEL_ACCENT, str: KEEL_GREEN, num: KEEL_NUM, com: KEEL_META, fn: "ansi:blue", attr: KEEL_TEAL, type: KEEL_ACCENT,
};

/** The background is not known: only what reads on dark and on light. Meta text is the terminal's own text colour,
 *  dimmed (no grey that can vanish on a grey background); hints are the text colour (their bold and their place say
 *  what they are); blue as bright blue (readable on both). */
export const AUTO: Palette = {
  ...shared,
  person: "ansi:blueBright", heading: "ansi:magenta", accent: "ansi:magenta",
  gate: "ansi:yellow", recommended: "ansi:green", chosen: "ansi:green", suggest: "ansi:magenta",
  hint: "term:", meta: "dim:", dim: "dim:", faint: "dim:", border: "dim:",
  ok: "ansi:green", warn: "ansi:yellow",
  code: "ansi:magenta", path: "ansi:blueBright", link: "ansi:blueBright", run: "ansi:blueBright", add: "ansi:green",
  kw: "ansi:magenta", str: "ansi:green", num: "ansi:yellow", com: "dim:", fn: "ansi:blueBright", attr: "ansi:yellow", type: "ansi:magenta",
};

/** Roles that are always bold with `strong` (headings, the person's words, what waits, a question, a chosen answer,
 *  KeelBot's suggestion). */
export const BOLD: ReadonlySet<Role> = new Set<Role>(["person", "heading", "gate", "question", "chosen", "suggest"]);
/** Roles drawn underlined with `strong` (paths and links: a sign beside the colour). */
export const UNDERLINE: ReadonlySet<Role> = new Set<Role>(["path", "link"]);

/** Bold that comes with a palette (the person's `+bold` / `+nobold` come on top). */
export const PALETTE_STYLES: Record<ThemeName, Styles> = {
  keel: { ok: { bold: true }, gate: { bold: true }, recommended: { bold: true }, warn: { bold: true } },
  dark: {}, light: {}, auto: {},
};

type AnsiName = "red" | "green" | "yellow" | "blue" | "magenta" | "cyan" | "redBright" | "greenBright" | "yellowBright" | "blueBright"
  | "magentaBright" | "cyanBright";

/** A palette value as Ink's color prop: "#hex", an ANSI colour name, or undefined (the terminal's own text colour). */
export function inkColor(v: string): string | undefined {
  if (v.startsWith("ansi:")) return v.slice(5);
  return v.startsWith("#") ? v : undefined;
}

type Fn = (s: string) => string;
/** One function per role (its colour), `strong` (the colour with the role's bold or underline), and the plain styles. */
export type Paint = Record<Role, Fn> & { strong: (r: Role, s: string) => string; bold: Fn; italic: Fn; underline: Fn; inverse: Fn;
  colored: boolean };

const id: Fn = (s) => s;
export const ROLES = Object.keys(DARK) as Role[];

/** No colour, no style: what -c prints into a pipe, and what NO_COLOR asks for. */
export const PLAIN: Paint = { ...(Object.fromEntries(ROLES.map((r) => [r, id])) as Record<Role, Fn>), strong: (_r, s) => s, bold: id, italic: id,
  underline: id, inverse: id, colored: false };

export function makePaint(p: Palette, level: 0 | 1 | 2 | 3, styles: Styles = {}): Paint {
  if (level === 0) return PLAIN;
  const c = new Chalk({ level });
  const fn = (v: string): Fn => {
    if (v.startsWith("ansi:")) return (s) => c[v.slice(5) as AnsiName](s);
    if (v === "dim:") return (s) => c.dim(s);
    return v.startsWith("#") ? (s) => c.hex(v)(s) : id;
  };
  // the role's own flags (+italic, +dim, +underline, +bold) on top of its colour; bold in `strong` too
  const roles = Object.fromEntries(ROLES.map((r) => {
    const f = fn(p[r]), st = styles[r];
    if (!st) return [r, f];
    return [r, (s: string) => {
      let out = f(s);
      if (st.italic) out = c.italic(out);
      if (st.dim) out = c.dim(out);
      if (st.underline) out = c.underline(out);
      return st.bold ? c.bold(out) : out;
    }];
  })) as Record<Role, Fn>;
  const strong = (r: Role, s: string) => {
    let out = roles[r](s);
    if (UNDERLINE.has(r)) out = c.underline(out);
    return BOLD.has(r) && styles[r]?.bold !== false && !styles[r]?.bold ? c.bold(out) : out;
  };
  return { ...roles, strong, bold: (s) => c.bold(s), italic: (s) => c.italic(s), underline: (s) => c.underline(s), inverse: (s) => c.inverse(s),
    colored: true };
}

/** A role's own style flags (KEEL_TUI_COLORS `role=#3cc463+bold`): `bold: false` is `+nobold` (no bold even where the role has it). */
export type Style = { bold?: boolean; underline?: boolean; italic?: boolean; dim?: boolean };
export type Styles = Partial<Record<Role, Style>>;

export type ThemeName = "keel" | "dark" | "light" | "auto";
/** `overrides`: the person's per-role colours (KEEL_TUI_COLORS, the settings file); `warnings`: what was ignored. */
export type Theme = { name: ThemeName; palette: Palette; level: 0 | 1 | 2 | 3; paint: Paint; ascii: boolean; overrides: Partial<Palette>; styles: Styles;
  /** only the person's flags (`styles` is the palette's flags with these on top) */
  userStyles: Styles; warnings: string[] };

type Env = Record<string, string | undefined>;

/** "keel", "dark", "light" or "auto" from a word ("terminal", keel TUI 0.18's name for the terminal's own colours, is keel). */
export function parseThemeName(word: string | undefined): ThemeName | null {
  const w = (word ?? "").trim().toLowerCase();
  return w === "keel" || w === "dark" || w === "light" || w === "auto" ? w : w === "terminal" ? "keel" : null;
}

/** dark or light from COLORFGBG ("15;0" is light text on a dark background; the last number is the background). */
export function bgFromColorFgBg(v: string | undefined): "dark" | "light" | null {
  if (!v) return null;
  const bg = Number(v.split(";").pop());
  if (!Number.isInteger(bg)) return null;
  return bg === 7 || bg === 15 ? "light" : "dark";
}

/** The palette: KEEL_TUI_THEME keel, dark or light as asked. Unset, "terminal" (the old name) or an unknown word: keel,
 *  or light when COLORFGBG, else the background the terminal reported (`probed`), says light. auto follows the
 *  background (dark, light) and is the palette that reads on both when it is not known. */
export function themeName(env: Env, probed?: "dark" | "light" | null): ThemeName {
  const raw = (env.KEEL_TUI_THEME ?? "").trim().toLowerCase();
  const want = parseThemeName(raw);
  if (raw === "keel") return "keel";
  if (want === "dark" || want === "light") return want;
  const bg = bgFromColorFgBg(env.COLORFGBG) ?? probed ?? null;
  if (want === "auto") return bg ?? "auto";
  return bg === "light" ? "light" : "keel";
}

/** Whether keel TUI should ask the terminal for its background (OSC 11): the person did not pick dark, light or keel,
 *  and COLORFGBG does not say. */
export function needsProbe(env: Env): boolean {
  const raw = (env.KEEL_TUI_THEME ?? "").trim().toLowerCase();
  return raw !== "keel" && raw !== "dark" && raw !== "light" && bgFromColorFgBg(env.COLORFGBG) === null;
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

// ------------------------------------------------------------------ per-role overrides (KEEL_TUI_COLORS)

/** Other words for a role (the older palette keys and plain English). */
export const ROLE_ALIASES: Record<string, Role> = { success: "ok", warning: "warn", waiting: "gate", error: "bad" };

const ANSI_NAMES = ["black", "red", "green", "yellow", "blue", "magenta", "cyan", "white", "gray", "grey"].flatMap((n) =>
  n === "gray" || n === "grey" ? [n] : [n, n + "Bright"]);
const ansiByLower = new Map(ANSI_NAMES.map((n) => [n.toLowerCase(), n]));

/** A colour value as a palette value: "#rgb" and "#rrggbb" become "#rrggbb", an ANSI colour name (or "ansi:<name>",
 *  "bright-red", "redBright") becomes "ansi:<name>"; anything else is null. */
export function parseColorValue(v: string): string | null {
  const w = v.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(w);
  if (hex) {
    const h = hex[1].toLowerCase();
    return "#" + (h.length === 3 ? [...h].map((c) => c + c).join("") : h);
  }
  const name = (w.toLowerCase().startsWith("ansi:") ? w.slice(5) : w).toLowerCase().replace(/^bright[-_ ]?(.+)$/, "$1bright").replace(/[-_ ]/g, "");
  const found = ansiByLower.get(name);
  return found ? "ansi:" + found : null;
}

/** The role a word names (a Role or an alias), else null. */
export function parseRole(word: string): Role | null {
  const w = word.trim().toLowerCase();
  const r = ROLE_ALIASES[w] ?? ROLES.find((x) => x.toLowerCase() === w);
  return r ?? null;
}

const FLAGS: Record<string, Style> = { bold: { bold: true }, nobold: { bold: false }, underline: { underline: true }, italic: { italic: true }, dim: { dim: true } };

/** Overrides from `role=colour+flag,role=+flag` (KEEL_TUI_COLORS; flags: bold, nobold, underline, italic, dim) and/or an
 *  object (the settings file's `colors`: "#3cc463+bold" or { color, bold, ... }). The object is read first, the string
 *  after it, so the env wins. A bad entry is ignored; all of them make ONE warning. */
export function parseColors(spec: string | undefined, fromFile?: unknown): { overrides: Partial<Palette>; styles: Styles; warnings: string[] } {
  const overrides: Partial<Palette> = {};
  const styles: Styles = {};
  const bad: string[] = [];
  const show = (v: unknown) => (typeof v === "string" ? v : JSON.stringify(v));
  const take = (k: string, v: unknown) => {
    const role = parseRole(k);
    let color: string | undefined;
    const st: Style = {};
    let ok = !!role;
    if (typeof v === "string") {
      const [c, ...flags] = v.split("+").map((x) => x.trim());
      if (c) { color = parseColorValue(c) ?? undefined; if (!color) ok = false; }
      for (const f of flags) { const fl = FLAGS[f.toLowerCase()]; if (fl) Object.assign(st, fl); else ok = false; }
      if (!c && !flags.length) ok = false;
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const o = v as Record<string, unknown>;
      if (o.color !== undefined) { color = typeof o.color === "string" ? parseColorValue(o.color) ?? undefined : undefined; if (!color) ok = false; }
      for (const f of ["bold", "underline", "italic", "dim"] as const) {
        if (o[f] === undefined) continue;
        if (typeof o[f] === "boolean") st[f] = o[f] as boolean; else ok = false;
      }
      if (Object.keys(o).some((x) => !["color", "bold", "underline", "italic", "dim"].includes(x))) ok = false;
    } else ok = false;
    if (ok && role) {
      if (color) overrides[role] = color;
      if (Object.keys(st).length) styles[role] = { ...styles[role], ...st };
    } else bad.push(`${k}=${show(v)}`);
  };
  if (fromFile && typeof fromFile === "object" && !Array.isArray(fromFile)) {
    for (const [k, v] of Object.entries(fromFile)) take(k, v);
  } else if (fromFile !== undefined && fromFile !== null) bad.push("colors (settings file) is not an object");
  for (const part of (spec ?? "").split(",")) {
    if (!part.trim()) continue;
    const i = part.indexOf("=");
    if (i < 0) bad.push(part.trim());
    else take(part.slice(0, i).trim(), part.slice(i + 1).trim());
  }
  return { overrides, styles, warnings: bad.length ? [`keel TUI: ignored colour entries (${bad.join(", ")}); use role=#rrggbb, role=ansi:name, role=#rrggbb+bold or role=+bold`] : [] };
}

/** The overrides as `role=colour+flag` words (/theme). */
export const describeOverrides = (o: Partial<Palette>, st: Styles = {}): string[] => ROLES.filter((r) => o[r] || st[r]).map((r) => {
  const s = st[r] ?? {};
  const flags = [s.bold === true && "bold", s.bold === false && "nobold", s.underline && "underline", s.italic && "italic", s.dim && "dim"].filter(Boolean);
  return `${r}=${o[r] ?? ""}${flags.map((f) => "+" + f).join("")}`;
});

export const paletteOf = (name: ThemeName): Palette => (name === "light" ? LIGHT : name === "dark" ? DARK : name === "keel" ? KEEL : AUTO);

/** The palette's own flags with the person's on top (per role, the person's flag wins). */
const mergeStyles = (name: ThemeName, user: Styles): Styles => {
  const out: Styles = { ...PALETTE_STYLES[name] };
  for (const r of Object.keys(user) as Role[]) out[r] = { ...out[r], ...user[r] };
  return out;
};

/** The palette with the person's overrides on top. */
const withOverrides = (name: ThemeName, o: Partial<Palette>): Palette => ({ ...paletteOf(name), ...o });

/** `fileColors`: the settings file's `colors` object; KEEL_TUI_COLORS in `env` wins over it. */
export function makeTheme(env: Env = process.env, detected?: number, probed?: "dark" | "light" | null, fileColors?: unknown): Theme {
  const level = colorLevel(env, detected);
  const name = themeName(env, probed);
  const { overrides, styles, warnings } = parseColors(env.KEEL_TUI_COLORS, fileColors);
  const palette = withOverrides(name, overrides);
  const all = mergeStyles(name, styles);
  return { name, palette, level, paint: makePaint(palette, level, all), ascii: asciiOnly(env), overrides, styles: all, userStyles: styles, warnings };
}

/** The same theme with another palette (/theme): the colour level and the glyphs stay. */
export function withPalette(t: Theme, name: ThemeName): Theme {
  const palette = withOverrides(name, t.overrides);
  const styles = mergeStyles(name, t.userStyles);
  return { ...t, name, palette, styles, paint: makePaint(palette, t.level, styles) };
}

/** Make Ink (which colours with chalk's own instance) use the same level: none with NO_COLOR. */
export function applyLevel(t: Theme) {
  chalk.level = t.level;
}

// ------------------------------------------------------------------ contrast (WCAG), for the tests of the fixed shades

const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((v) => (v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

export function contrast(a: string, b: string): number {
  const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
  return (x + 0.05) / (y + 0.05);
}
