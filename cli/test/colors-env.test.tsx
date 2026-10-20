// keel TUI 0.18.26: KEEL_TUI_COLORS and the settings file's `colors` change single roles on top of the active palette.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { StatusLine } from "../src/ui/parts";
import { ThemeProvider } from "../src/ui/theme";
import { KeelCore } from "../src/core/keel";
import { run } from "../src/core/commands";
import { applyLevel, describeOverrides, makeTheme, parseColors, withPalette, DARK, LIGHT } from "../src/core/theme";
import type { Snapshot } from "../src/core/keel";
import { stripAnsi } from "../src/script";
import { stubKeel, waitFor } from "./stub";

const hex = (h: string) => `\x1b[38;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m`;
const ENV = "ok=#3cc463,gate=#e0a13a,recommended=#3cc463";

describe("KEEL_TUI_COLORS", () => {
  it("changes the role's colour in the dark and the light palette, and leaves the others", () => {
    for (const [name, base] of [["dark", DARK], ["light", LIGHT]] as const) {
      const t = makeTheme({ KEEL_TUI_THEME: name, KEEL_TUI_COLORS: "ok=#3cc463,gate=ansi:cyan" }, 3);
      expect(t.palette.ok).toBe("#3cc463");
      expect(t.palette.gate).toBe("ansi:cyan");
      expect(t.palette.warn).toBe(base.warn);
      expect(t.paint.ok("x")).toBe(hex("#3cc463") + "x\x1b[39m");
      expect(t.paint.gate("x")).toBe("\x1b[36mx\x1b[39m");
      expect(t.warnings).toEqual([]);
    }
  });

  it("takes the aliases and the short and the named forms", () => {
    const { overrides, warnings } = parseColors("success=#0f0, warning=ansi:magenta,waiting=Red,error=#ABC,meta=#111111,heading=bright-cyan");
    expect(overrides).toMatchObject({ ok: "#00ff00", warn: "ansi:magenta", gate: "ansi:red", bad: "#aabbcc", meta: "#111111", heading: "ansi:cyanBright" });
    expect(warnings).toEqual([]);
    for (const r of ["person", "accent", "recommended", "chosen", "suggest", "hint", "code", "path", "link", "add", "del", "run"])
      expect(parseColors(`${r}=#123456`).overrides[r as "add"]).toBe("#123456");
  });

  it("ignores bad entries with ONE warning", () => {
    const t = makeTheme({ KEEL_TUI_THEME: "dark", KEEL_TUI_COLORS: "ok=#3cc463,nope=#fff,gate=purple-ish,hint,warn=#12" }, 3);
    expect(t.overrides).toEqual({ ok: "#3cc463" });
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("nope=#fff");
    expect(t.warnings[0]).toContain("gate=purple-ish");
    expect(t.palette.gate).toBe(DARK.gate);
  });

  it("the settings file's `colors` is read first, the env wins", () => {
    const t = makeTheme({ KEEL_TUI_COLORS: "ok=#111111" }, 3, undefined, { ok: "#222222", gate: "ansi:blue", bad: 5 });
    expect(t.palette.ok).toBe("#111111");
    expect(t.palette.gate).toBe("ansi:blue");
    expect(t.warnings).toHaveLength(1);
    expect(makeTheme({}, 3, undefined, "oops").warnings).toHaveLength(1);
  });

  it("NO_COLOR still gives plain text", () => {
    const t = makeTheme({ NO_COLOR: "1", KEEL_TUI_COLORS: ENV }, 3);
    expect(t.level).toBe(0);
    expect(t.paint.ok("x")).toBe("x");
    expect(t.paint.colored).toBe(false);
    const r = render(<ThemeProvider theme={t}><StatusLine s={snap()} /></ThemeProvider>);
    expect(r.lastFrame()).not.toContain("\x1b[");
    r.unmount();
  });

  it("withPalette (the /theme switch) keeps the overrides", () => {
    const t = withPalette(makeTheme({ KEEL_TUI_THEME: "dark", KEEL_TUI_COLORS: "ok=#3cc463" }, 3), "light");
    expect(t.name).toBe("light");
    expect(t.palette.ok).toBe("#3cc463");
    expect(t.palette.warn).toBe(LIGHT.warn);
  });
});

const thread = (status: string, acs: number) => ({ thread_id: "t", title: "x", workflow_id: "feature", status, run_mode: "manual", current: "s", phase: "build",
  ac: null, acs: Array.from({ length: acs }, (_, i) => ({ id: `AC-${i}`, status: "done" })), error: null, blockers: [],
  usage: { tokens_in: 1, tokens_out: 1, cap_tokens: 1000, cost_usd: 0 }, waiting: null });
const snap = (opts: { status?: string; inbox?: number; live?: string } = {}) => ({ chat: { mode: "ask", session: null }, project: { id: "demo", name: "demo", branch: null },
  flow: { thread: thread(opts.status ?? "done", 3) }, inbox: Array.from({ length: opts.inbox ?? 0 }, () => ({ project_id: "demo" })), live: opts.live ?? "live" }) as unknown as Snapshot;

describe("the status line with overrides", () => {
  const t = makeTheme({ KEEL_TUI_THEME: "dark", KEEL_TUI_COLORS: "ok=#3cc463,gate=#e0a13a" }, 3);
  const frame = (s: Snapshot) => {
    applyLevel(t);
    const r = render(<ThemeProvider theme={t}><StatusLine s={s} /></ThemeProvider>);
    const f = r.lastFrame() ?? "";
    r.unmount();
    return f;
  };

  it("done, AC 3/3 and live use the ok colour", () => {
    const f = frame(snap());
    for (const w of ["feature done", "AC 3/3", "● live"]) expect(f).toContain(hex("#3cc463") + w);
  });

  it("a waiting flow and waiting gates use the gate colour", () => {
    const f = frame(snap({ status: "waiting", inbox: 2 }));
    expect(f).toContain(hex("#e0a13a") + "feature waiting");
    expect(f).toContain("\x1b[1m" + hex("#e0a13a") + "◆ 2 waiting here");
  });
});

describe("/theme lists the overrides", () => {
  it("says the palette and the active overrides, and keeps them after a switch", async () => {
    const core = new KeelCore({ url: "http://keel.test", fetch: stubKeel().fetch, noLive: true });
    expect((await run({ core, width: 80 }, "/theme")).themeInfo).toBe(true);
    const t = makeTheme({ KEEL_TUI_THEME: "dark", KEEL_TUI_COLORS: ENV }, 3);
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} theme={t} />);
    await waitFor(() => probe.started);
    r.stdin.write("/theme");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("› /theme"));
    r.stdin.write("\r");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("active colour overrides"));
    expect(stripAnsi(r.lastFrame() ?? "")).toContain("KEEL_TUI_COLORS");
    r.stdin.write("/theme light");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("› /theme light"));
    r.stdin.write("\r");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("theme light: colours for a light background; your colours stay"));
    r.unmount();
  });
});


describe("style flags: role=#3cc463+bold", () => {
  const BOLD = "\x1b[1m";
  const frameOf = (colors: unknown, env: Record<string, string> = {}, s = snap()) => {
    const t = makeTheme({ KEEL_TUI_THEME: "dark", ...env }, env.NO_COLOR ? 0 : 3, undefined, colors);
    applyLevel(t);
    const r = render(<ThemeProvider theme={t}><StatusLine s={s} /></ThemeProvider>);
    const f = r.lastFrame() ?? "";
    r.unmount();
    return { t, f };
  };

  it("applies bold (and underline, italic, dim) with the colour, in paint and in the status line", () => {
    const { t, f } = frameOf(undefined, { KEEL_TUI_COLORS: "ok=#3cc463+bold+underline" });
    expect(t.overrides.ok).toBe("#3cc463");
    expect(t.styles.ok).toEqual({ bold: true, underline: true });
    expect(t.paint.ok("x")).toContain(BOLD);
    expect(t.paint.ok("x")).toContain("\x1b[4m");
    expect(f).toContain(BOLD + hex("#3cc463") + "feature done");
    expect(frameOf(undefined, { KEEL_TUI_COLORS: "ok=ansi:red+italic+dim" }).t.paint.ok("x")).toMatch(/\x1b\[3m.*\x1b\[2m|\x1b\[2m.*\x1b\[3m/);
  });

  it("a flag alone keeps the palette colour", () => {
    const { t, f } = frameOf(undefined, { KEEL_TUI_COLORS: "ok=+bold" });
    expect(t.palette.ok).toBe(DARK.ok);
    expect(t.overrides.ok).toBeUndefined();
    expect(f).toContain(BOLD + "\x1b[32mfeature done");
  });

  it("+nobold removes the bold a role has by default", () => {
    const strongOf = (colors?: string) => makeTheme({ KEEL_TUI_THEME: "dark", KEEL_TUI_COLORS: colors }, 3).paint.strong("gate", "x");
    expect(strongOf()).toContain(BOLD);
    expect(strongOf("gate=+nobold")).not.toContain(BOLD);
    const { f } = frameOf(undefined, { KEEL_TUI_COLORS: "gate=+nobold" }, snap({ status: "waiting", inbox: 1 }));
    expect(f).toContain("\x1b[33m" + "◆ 1 waiting here");
    expect(f).not.toContain(BOLD + "\x1b[33m◆");
  });

  it("the settings file takes the string form and the object form", () => {
    const t = makeTheme({ KEEL_TUI_THEME: "dark" }, 3, undefined, { ok: { color: "#3cc463", bold: true }, gate: "#e0a13a+bold", warn: "+nobold" });
    expect(t.warnings).toEqual([]);
    expect(t.overrides).toMatchObject({ ok: "#3cc463", gate: "#e0a13a" });
    expect(t.styles).toEqual({ ok: { bold: true }, gate: { bold: true }, warn: { bold: false } });
  });

  it("bad flags give the one warning and the entry is ignored", () => {
    const t = makeTheme({ KEEL_TUI_COLORS: "ok=#3cc463+shiny,gate=+bold+blink,warn=#e0a13a+bold,hint=" }, 3, undefined, { bad: { bold: "yes" } });
    expect(t.warnings).toHaveLength(1);
    expect(t.warnings[0]).toContain("ok=#3cc463+shiny");
    expect(t.warnings[0]).toContain("gate=+bold+blink");
    expect(t.overrides).toEqual({ warn: "#e0a13a" });
    expect(t.styles).toEqual({ warn: { bold: true } });
  });

  it("NO_COLOR stays plain text, bold flags included", () => {
    const { t, f } = frameOf(undefined, { NO_COLOR: "1", KEEL_TUI_COLORS: "ok=#3cc463+bold+underline" });
    expect(t.paint.ok("x")).toBe("x");
    expect(t.paint.strong("ok", "x")).toBe("x");
    expect(f).not.toContain("\x1b[");
  });

  it("/theme lists the flags", () => {
    const t = makeTheme({ KEEL_TUI_COLORS: "ok=#3cc463+bold,gate=+nobold" }, 3);
    expect(describeOverrides(t.overrides, t.styles)).toEqual(["gate=+nobold", "ok=#3cc463+bold"]);
  });
});
