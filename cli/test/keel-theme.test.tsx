// The `keel` palette: the default look (the hand-tuned colours on the light palette's role choices), how it is picked,
// and that overrides, /theme and NO_COLOR work with it.
import { describe, expect, it } from "vitest";
import { KeelCore } from "../src/core/keel";
import { run } from "../src/core/commands";
import { contrast, KEEL, LIGHT, makeTheme, needsProbe, parseThemeName, ROLES, themeName, withPalette } from "../src/core/theme";
import { stubKeel } from "./stub";

const RGB = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const BOLD = "\x1b[1m";

describe("the keel palette", () => {
  it("has exactly the tuned colours", () => {
    const want: Record<string, string> = {
      ok: "#2fa84f", recommended: "#2fa84f", chosen: "#2fa84f", success: "#2fa84f", add: "#2fa84f", str: "#2fa84f",
      gate: "#f2b84b", warn: "#f2b84b",
      meta: "#9a958c", dim: "#9a958c", faint: "#9a958c", com: "#9a958c",
      accent: "#a48bff", heading: "#a48bff", suggest: "#a48bff", code: "#a48bff", kw: "#a48bff", type: "#a48bff",
    };
    for (const [r, v] of Object.entries(want)) if (r !== "success") expect(KEEL[r as keyof typeof KEEL], r).toBe(v);
    // the light palette's person blue, path/link blue and the red for errors and deletions stay
    for (const r of ["person", "path", "link", "run", "fn"] as const) expect(KEEL[r], r).toBe(LIGHT[r]);
    expect(KEEL.person).toBe("ansi:blue");
    expect(KEEL.bad).toBe("ansi:red");
    expect(KEEL.del).toBe("ansi:red");
  });

  it("is bold on ok, gate and recommended", () => {
    const t = makeTheme({ KEEL_TUI_THEME: "keel" }, 3);
    expect(t.paint.ok("x")).toBe(`\x1b[1m${RGB("#2fa84f")}x\x1b[39m\x1b[22m`);
    expect(t.paint.gate("x")).toBe(`\x1b[1m${RGB("#f2b84b")}x\x1b[39m\x1b[22m`);
    expect(t.paint.recommended("x")).toBe(`\x1b[1m${RGB("#2fa84f")}x\x1b[39m\x1b[22m`);
    expect(t.styles.ok?.bold).toBe(true);
    expect(t.styles.gate?.bold).toBe(true);
    expect(t.styles.recommended?.bold).toBe(true);
    expect(t.paint.strong("chosen", "x")).toContain(BOLD);                 // chosen was already bold
  });

  it("reads on a near-black warm background (and the fixed shades are the specified amber is the palest, 1.8:1 on white)", () => {
    for (const r of ROLES.filter((x) => KEEL[x].startsWith("#"))) {
      expect(contrast(KEEL[r], "#14120f"), `${r} on dark`).toBeGreaterThanOrEqual(4.5);
      expect(contrast(KEEL[r], "#ffffff"), `${r} on white`).toBeGreaterThanOrEqual(1.7);
    }
  });
});

describe("which palette is picked", () => {
  it("is keel with no env and an unknown background", () => {
    expect(themeName({})).toBe("keel");
    expect(makeTheme({}, 3).name).toBe("keel");
    expect(makeTheme({}, 3, null).palette).toEqual(KEEL);
    expect(themeName({}, "dark")).toBe("keel");
    expect(themeName({ COLORFGBG: "15;0" })).toBe("keel");
    expect(themeName({ KEEL_TUI_THEME: "terminal" })).toBe("keel");
  });

  it("is light on a light background (COLORFGBG or the OSC 11 probe)", () => {
    expect(themeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(themeName({}, "light")).toBe("light");
    expect(makeTheme({}, 3, "light").palette).toEqual(LIGHT);
    expect(themeName({ KEEL_TUI_THEME: "terminal" }, "light")).toBe("light");
  });

  it("KEEL_TUI_THEME=dark, light, keel and auto still pick their palette", () => {
    expect(themeName({ KEEL_TUI_THEME: "dark" })).toBe("dark");
    expect(themeName({ KEEL_TUI_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(themeName({ KEEL_TUI_THEME: "keel", COLORFGBG: "0;15" })).toBe("keel");
    expect(themeName({ KEEL_TUI_THEME: "auto" })).toBe("auto");            // unknown: reads on both
    expect(themeName({ KEEL_TUI_THEME: "auto", COLORFGBG: "15;0" })).toBe("dark");
    expect(themeName({ KEEL_TUI_THEME: "auto" }, "light")).toBe("light");
    expect(parseThemeName("keel")).toBe("keel");
  });

  it("asks the terminal for its background only when nothing else says", () => {
    expect(needsProbe({})).toBe(true);
    expect(needsProbe({ KEEL_TUI_THEME: "auto" })).toBe(true);
    expect(needsProbe({ KEEL_TUI_THEME: "keel" })).toBe(false);
    expect(needsProbe({ KEEL_TUI_THEME: "dark" })).toBe(false);
    expect(needsProbe({ COLORFGBG: "15;0" })).toBe(false);
  });

  it("/theme keel switches to it", async () => {
    const core = new KeelCore({ url: "http://keel.test", fetch: stubKeel().fetch, noLive: true });
    expect((await run({ core, width: 80 }, "/theme keel")).theme).toBe("keel");
    expect((await run({ core, width: 80 }, "/theme dark")).theme).toBe("dark");
    const t = withPalette(makeTheme({ KEEL_TUI_THEME: "dark" }, 3), "keel");
    expect(t.palette).toEqual(KEEL);
    expect(t.paint.ok("x")).toContain(BOLD);
    expect(withPalette(t, "light").paint.ok("x")).not.toContain(BOLD);     // the keel bold goes with the palette
  });
});

describe("overrides and NO_COLOR on keel", () => {
  it("KEEL_TUI_COLORS still wins (colour and flags)", () => {
    const t = makeTheme({ KEEL_TUI_COLORS: "ok=#3cc463,gate=+nobold,hint=ansi:cyan" }, 3);
    expect(t.palette.ok).toBe("#3cc463");
    expect(t.palette.hint).toBe("ansi:cyan");
    expect(t.paint.ok("x")).toBe(`\x1b[1m${RGB("#3cc463")}x\x1b[39m\x1b[22m`);   // the keel bold stays
    expect(t.paint.gate("x")).toBe(`${RGB("#f2b84b")}x\x1b[39m`);                  // +nobold removes it
    expect(withPalette(t, "dark").palette.ok).toBe("#3cc463");
  });

  it("the person's own old setup gives the same colours", () => {
    const t = makeTheme({ KEEL_TUI_THEME: "light", KEEL_TUI_COLORS: "ok=#2fa84f+bold,gate=#f2b84b+bold,recommended=#2fa84f+bold,meta=#9a958c,dim=#9a958c,faint=#9a958c" }, 3);
    for (const r of ["ok", "gate", "recommended", "meta", "dim", "faint"] as const) expect(t.palette[r]).toBe(KEEL[r]);
  });

  it("NO_COLOR is plain", () => {
    const t = makeTheme({ NO_COLOR: "1" }, 3);
    expect(t.level).toBe(0);
    expect(t.paint.ok("x")).toBe("x");
    expect(t.paint.strong("gate", "x")).toBe("x");
  });
});
