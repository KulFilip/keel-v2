// keel TUI's look: the dashboard's palette (dark and light, readable on both), NO_COLOR, highlighted code, coloured
// diagrams and lists, KeelBot's answer as it streams, and the "working" indicator.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/theme";
import { FRAMES, FRAMES_ASCII, pickVerb, Thinking, VERBS } from "../src/ui/thinking";
import { KeelCore } from "../src/core/keel";
import { contrast, DARK, inkColor, LIGHT, makeTheme, PLAIN, TERMINAL, themeName, userTint } from "../src/core/theme";
import { classifyDiff } from "../src/core/diff";
import { highlight, language } from "../src/core/highlight";
import { renderMarkdown } from "../src/core/markdown";
import { colorDiagram } from "../src/core/colorize";
import { helpText, run } from "../src/core/commands";
import * as fmt from "../src/core/format";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const RGB = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const color = makeTheme({ KEEL_TUI_THEME: "dark" }, 3);
const light = makeTheme({ KEEL_TUI_THEME: "light" }, 3);
const none = makeTheme({ NO_COLOR: "1" }, 3);

describe("the palette", () => {
  it("is the dashboard's: accent purple, amber gates, green ok, red bad", () => {
    expect(DARK.accent).toBe("#a48bff");
    expect(DARK.warn).toBe("#e0a13a");
    expect(DARK.ok).toBe("#4ec07c");
    expect(DARK.bad).toBe("#f0685a");
    expect(LIGHT.accent).toBe("#6a4ee6");
  });

  it("is readable on its own background, dark and light", () => {
    for (const p of [DARK, LIGHT]) {
      for (const r of ["fg", "dim", "accent", "run", "ok", "bad", "kw", "str", "fn"] as const) expect(contrast(p[r], p.bg), `${r} on ${p.bg}`).toBeGreaterThanOrEqual(4.5);
      for (const r of ["warn", "gate", "num", "attr", "type"] as const) expect(contrast(p[r], p.bg), `${r} on ${p.bg}`).toBeGreaterThanOrEqual(3.5);
      for (const r of ["faint", "com"] as const) expect(contrast(p[r], p.bg), `${r} on ${p.bg}`).toBeGreaterThanOrEqual(3);
    }
  });

  it("follows NO_COLOR, KEEL_TUI_THEME and the terminal's background", () => {
    expect(none.level).toBe(0);
    expect(none.paint.accent("x")).toBe("x");
    expect(makeTheme({ NO_COLOR: "" }, 3).level).toBe(3);                 // set but empty: no-color.org says colour
    expect(color.paint.accent("x")).toBe(`${RGB(DARK.accent)}x\x1b[39m`);
    expect(makeTheme({}, 2).paint.accent("x")).toMatch(/^\x1b\[38;5;\d+mx/);   // a 256-colour terminal: the nearest colour
    expect(themeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(themeName({ COLORFGBG: "15;0" })).toBe("dark");
    expect(themeName({ KEEL_TUI_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(makeTheme({ LANG: "C" }).ascii).toBe(true);
    expect(makeTheme({ LANG: "en_US.UTF-8" }).ascii).toBe(false);
  });
});

describe("code", () => {
  it("is highlighted by language with the web's highlighter, in the palette's code colours", () => {
    const lines = highlight('def run(players):\n    # rank them\n    return {"ok": True, "n": 3}', "python", color.paint);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`${RGB(DARK.kw)}def`);
    expect(lines[0]).toContain(`${RGB(DARK.fn)}run`);
    expect(lines[1]).toContain(`${RGB(DARK.com)}# rank them`);
    expect(lines[2]).toContain(`${RGB(DARK.str)}"ok"`);
    expect(lines[2]).toContain(`${RGB(DARK.num)}3`);
    expect(stripAnsi(lines.join("\n"))).toBe('def run(players):\n    # rank them\n    return {"ok": True, "n": 3}');
    expect(language("ts")).toBe("typescript");
    expect(language("klingon")).toBeNull();
  });

  it("colours a diff green and red, and nothing without colour", () => {
    const d = highlight("@@ -1,2 +1,2 @@\n-old\n+new\n context", "diff", color.paint);
    // each line with its number (xal's diff gutter): the old file's for a removed line, the new file's otherwise
    expect(d[0]).toBe(`${RGB(DARK.faint)}     \x1b[39m${RGB(DARK.warn)}@@ -1,2 +1,2 @@\x1b[39m`);
    expect(d[1]).toBe(`${RGB(DARK.faint)}   1 \x1b[39m${RGB(DARK.del)}-old\x1b[39m`);
    expect(d[2]).toBe(`${RGB(DARK.faint)}   1 \x1b[39m${RGB(DARK.add)}+new\x1b[39m`);
    expect(stripAnsi(d[3])).toBe("   2  context");
    expect(highlight("-old\n+new", "diff", PLAIN)).toEqual(["-old", "+new"]);
  });

  it("in KeelBot's markdown: fenced code highlighted, inline code tinted, file:line as a link, headings in the accent", () => {
    const md = "## Where\n\nSee `run()` in src/app.ts:3.\n\n```ts\nconst x: number = 1;\n```";
    const out = renderMarkdown(md, color.paint);
    expect(out).toContain(`${RGB(DARK.accent)}Where`);
    expect(out).toContain(`${RGB(DARK.kw)}run()`);
    expect(out).toContain(`${RGB(DARK.run)}src/app.ts:3`);
    expect(out).toContain(`${RGB(DARK.kw)}const`);
    expect(stripAnsi(out)).toBe("Where\n\nSee run() in src/app.ts:3.\n\n  ts\n  │ const x: number = 1;");
    // an answer still being written: the open code block is code already
    expect(stripAnsi(renderMarkdown("Look:\n```py\ndef f():", PLAIN))).toBe("Look:\n  py\n  │ def f():");
  });
});

describe("diagrams and lists", () => {
  const flow = [
    "flow feature \"Health\" - waiting at spec_gate - phase spec",
    "== Spec: write and approve what to build ==  id=spec",
    "  [x] spec  (agent explorer)",
    "  [?] spec approval  (gate, you decide)   <-- waiting for you",
    "  [>] red  (agent test-author)   <-- now",
    "  [!] green  (agent implementer)   <-- failed here",
  ].join("\n");

  it("colour the step states and keep the text the same", () => {
    const out = colorDiagram(flow, color.paint);
    expect(stripAnsi(out)).toBe(flow);
    expect(out).toContain(`${RGB(DARK.ok)}[x]`);
    expect(out).toContain(`${RGB(DARK.gate)}[?]`);
    expect(out).toContain(`${RGB(DARK.accent)}[>]`);
    expect(out).toContain(`${RGB(DARK.bad)}[!]`);
    expect(out).toContain(`${RGB(DARK.gate)}<-- waiting for you`);
    expect(colorDiagram(flow, PLAIN)).toBe(flow);
    const er = "+- users ------+\n| PK id bigint |\n| FK org_id -> orgs.id |\n+--------------+";
    expect(stripAnsi(colorDiagram(er, color.paint))).toBe(er);
    expect(colorDiagram(er, color.paint)).toContain(`${RGB(DARK.gate)}PK`);
  });

  it("show statuses as coloured badges, ids dim, complete criteria green", () => {
    const rows = [{ thread_id: "t1", title: "Health", workflow_id: "feature", status: "done", phase: null, current: null, waiting: null,
      acs_done: 2, acs_total: 2, tokens: 1000, where: "folder", branch: null, error: null, created_at: "", updated_at: "", cost_usd: 0, latest: true }];
    const out = fmt.flows(rows as never, color.paint);
    expect(out).toContain(`${RGB(DARK.ok)}✔ done`);
    expect(out).toContain(`${RGB(DARK.faint)}t1`);
    expect(out).toContain(`${RGB(DARK.ok)}2/2`);
    expect(stripAnsi(out)).toBe(' 1. ✔ done  "Health"  feature · criteria 2/2 · $0.00  t1\n/stop <n> stops one, /stop all stops every running or waiting one.');
    expect(fmt.badge("waiting", color.paint)).toContain(RGB(DARK.gate));
    expect(fmt.badge("running", PLAIN)).toBe("▶ running");
  });

  it("/help groups the commands: names in the accent, arguments in a second colour, keys highlighted", async () => {
    const plain = helpText(PLAIN);
    for (const g of ["Flows", "Gates", "Look", "KeelBot", "Screen", "Keys"]) expect(plain).toMatch(new RegExp(`^${g}$`, "m"));
    expect(plain.indexOf("/approve")).toBeGreaterThan(plain.indexOf("Gates"));
    const c = helpText(color.paint);
    expect(c).toContain(`${RGB(DARK.accent)}/reject`);
    expect(c).toContain(`${RGB(DARK.attr)}[n] <why>`);
    expect(c).toContain(`${RGB(DARK.accent)}Ctrl+F`);
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    expect((await run({ core, width: 100, paint: color.paint }, "/help")).blocks[0].text).toBe(c);
  });
});

describe("the working indicator", () => {
  it("a keel verb per turn, a turning spinner, seconds, tokens and how to stop it", async () => {
    const r = render(<ThemeProvider theme={color}><Thinking verb="Sounding the depths" since={Date.now() - 3200} tokens={1234} hint="esc to interrupt" interval={10} /></ThemeProvider>);
    const seen = new Set<string>();
    for (let i = 0; i < 8; i++) {
      seen.add(stripAnsi(r.lastFrame() ?? "").slice(0, 1));
      await tick(15);
    }
    expect(stripAnsi(r.lastFrame() ?? "")).toMatch(/^. Sounding the depths… \(3s · ~1\.2k tokens · esc to interrupt\)$/);
    expect([...seen].filter((f) => FRAMES.includes(f)).length).toBeGreaterThan(1);       // it turns
    r.unmount();
    const a = render(<ThemeProvider theme={makeTheme({ KEEL_TUI_ASCII: "1" }, 0)}><Thinking verb="Tacking" since={null} /></ThemeProvider>);
    expect(FRAMES_ASCII).toContain((a.lastFrame() ?? "").slice(0, 1));
    a.unmount();
    expect(VERBS).toContain(pickVerb());
    expect(pickVerb("call-1")).toBe(pickVerb("call-1"));
  });
});

describe("KeelBot streams", () => {
  it("shows the answer while it is written, before the turn ends, then the whole answer", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} theme={none} />);
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    await waitFor(() => probe.started);
    r.stdin.write("where does it start?");
    await tick(30);
    r.stdin.write("\r");
    await waitFor(() => probe.chatBusy);
    const delta = (n: number, text: string) => core.onMessage({ event: "helper.delta", data: JSON.stringify({ type: "helper.delta",
      thread_id: "s1", project_id: "demo", at: "x", call_id: "call-9", step: "helper", data: { n, block: 0, text } }) });
    delta(1, "It starts");
    await tick(30);
    expect(frame()).toContain("It starts");
    expect(frame()).toContain("esc to interrupt");
    delta(2, "It starts in **main.py**, where");
    await tick(30);
    expect(frame()).toContain("It starts in main.py, where");
    expect(probe.answers).toBe(0);                                                         // the turn has not ended
    expect(frame()).toMatch(/~\d+ tokens/);
    stub.answer("It starts in **main.py**, where `run()` is.");
    core.onMessage({ event: "helper.finished", data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });
    await waitFor(() => probe.answers === 1);
    await tick(30);
    expect(frame()).toContain("It starts in main.py, where run() is.");
    expect(frame()).not.toContain("esc to interrupt");
    expect(r.lastFrame()).not.toMatch(/\x1b\[3[0-9;]*m/);                                   // NO_COLOR: no colour at all
    r.unmount();
  });

  it("Esc stops the turn through keel's api", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} theme={none} />);
    await waitFor(() => probe.started);
    r.stdin.write("why?");
    await tick(30);
    r.stdin.write("\r");
    await waitFor(() => probe.chatBusy);
    r.stdin.write("\x1b");
    await waitFor(() => stub.calls.some((c) => c.method === "POST" && c.path === "/api/projects/demo/helper/sessions/s1/stop"));
    r.unmount();
  });

  it("draws in keel's colours with a colour theme: the accent border, the logo, the status line", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} theme={color} />);
    await waitFor(() => probe.started);
    await tick(40);
    const raw = r.lastFrame() ?? "";
    expect(raw).toContain(RGB(DARK.accent));            // the logo and the start screen's border
    expect(raw).toContain(RGB(DARK.gate));              // a gate waits: the prompt's border and the waiting line
    r.unmount();
  });
});

describe("markdown and paths", () => {
  it("keeps a file:line with underscores whole, in the link colour (no bold inside __init__.py)", () => {
    const md = "- **entry**: `run()` in src/scores/__init__.py:1 and __bold__ here";
    const out = renderMarkdown(md, color.paint);
    expect(stripAnsi(out)).toBe("  • entry: run() in src/scores/__init__.py:1 and bold here");
    expect(out).toContain(`${RGB(DARK.run)}src/scores/__init__.py:1`);
    expect(out).not.toMatch(/[^\x1b]\[\d+m/);                      // every colour code is whole
  });
});

describe("what we took from xal", () => {
  it("the terminal's own colours: a 16-colour terminal or KEEL_TUI_THEME=terminal", () => {
    const t = makeTheme({}, 1);
    expect(t.name).toBe("terminal");
    expect(t.paint.accent("x")).toBe("\x1b[95mx\x1b[39m");                  // magenta (13), whatever shade the terminal has
    expect(t.paint.bad("x")).toBe("\x1b[91mx\x1b[39m");
    expect(t.paint.fg("x")).toBe("x");                                         // the terminal's own text colour
    expect(makeTheme({ KEEL_TUI_THEME: "terminal" }, 3).palette).toBe(TERMINAL);
    expect(inkColor("ansi:magentaBright")).toBe("magentaBright");
    expect(inkColor("#a48bff")).toBe("#a48bff");
  });

  it("a person's message on a tinted background: 8 % toward the text colour", () => {
    expect(userTint(DARK)).toBe("#262627");
    expect(userTint(LIGHT)).toBe("#e3e2e0");
    expect(userTint(TERMINAL)).toBeUndefined();
  });

  it("diffs keep their line numbers", () => {
    expect(classifyDiff(["--- a/x", "+++ b/x", "@@ -10,2 +10,3 @@", " same", "-gone", "+new", "+more"]).map((l) => `${l.kind}:${l.number}`))
      .toEqual(["faint:", "faint:", "hunk:", "plain:10", "removed:11", "added:11", "added:12"]);
  });

  it("tables in a box with the header in the accent, bullets by depth, links with their address faint", () => {
    const md = "| step | state |\n|---|---|\n| spec | done |\n| red | waiting |\n\n- one\n  - two\n    - three\n\nSee [the docs](https://x.io).";
    const out = renderMarkdown(md, color.paint, 60);
    expect(stripAnsi(out)).toBe([
      "  ┌──────┬─────────┐", "  │ step │ state   │", "  ├──────┼─────────┤", "  │ spec │ done    │", "  │ red  │ waiting │", "  └──────┴─────────┘",
      "", "  • one", "    ◦ two", "      ▪ three", "", "See the docs (https://x.io)."].join("\n"));
    expect(out).toContain(`${RGB(DARK.accent)}step`);
    expect(out).toContain(`${RGB(DARK.faint)}(https://x.io)`);
  });
});

describe("xal's layout ideas in keel TUI", () => {
  it("a question is amber with a '?', a list is in the accent; the person's message sits on a tinted line", async () => {
    const { Picker } = await import("../src/ui/parts");
    const q = render(<ThemeProvider theme={color}><Picker title="Run with the fake model anyway?" choices={[{ label: "Yes", value: "y" }, { label: "No", value: "n" }]} index={0} filter="" /></ThemeProvider>);
    expect(stripAnsi(q.lastFrame() ?? "")).toContain("? Run with the fake model anyway?");
    expect(q.lastFrame()).toContain(RGB(DARK.gate));
    expect(stripAnsi(q.lastFrame() ?? "")).toContain("↑↓ · Enter · type to filter · Esc");
    q.unmount();
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={80} theme={color} />);
    await waitFor(() => probe.started);
    r.stdin.write("/status");
    await tick(30);
    r.stdin.write("\r");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("Criteria: 0/2 done"));
    expect(r.lastFrame()).toContain("\x1b[48;2;38;38;39m");                  // userTint(DARK) behind " › /status"
    expect(stripAnsi(r.lastFrame() ?? "")).toMatch(/\n › \/status {60,}\n/);
    r.unmount();
  });
});
