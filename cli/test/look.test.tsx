// keel TUI's look: the dashboard's palette (dark and light, readable on both), NO_COLOR, highlighted code, coloured
// diagrams and lists, KeelBot's answer as it streams, and the "working" indicator.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { ThemeProvider } from "../src/ui/theme";
import { FRAMES, FRAMES_ASCII, pickVerb, Thinking, VERBS } from "../src/ui/thinking";
import { KeelCore } from "../src/core/keel";
import { AUTO, contrast, DARK, inkColor, LIGHT, makeTheme, PLAIN, ROLES, themeName, withPalette } from "../src/core/theme";
import { classifyDiff } from "../src/core/diff";
import { highlight, language } from "../src/core/highlight";
import { renderMarkdown } from "../src/core/markdown";
import { colorDiagram } from "../src/core/colorize";
import { helpText, run } from "../src/core/commands";
import * as fmt from "../src/core/format";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const RGB = (hex: string) => `\x1b[38;2;${parseInt(hex.slice(1, 3), 16)};${parseInt(hex.slice(3, 5), 16)};${parseInt(hex.slice(5, 7), 16)}m`;
const CODE: Record<string, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, redBright: 91, greenBright: 92,
  yellowBright: 93, blueBright: 94, magentaBright: 95, cyanBright: 96 };
/** The escape a palette value opens with: a named colour, a fixed shade (truecolor) or the dimmed text colour. */
const SGR = (v: string) => (v.startsWith("ansi:") ? `\x1b[${CODE[v.slice(5)]}m` : v === "dim:" ? "\x1b[2m" : RGB(v));
const color = makeTheme({ KEEL_TUI_THEME: "dark" }, 3);
const light = makeTheme({ KEEL_TUI_THEME: "light" }, 3);
const none = makeTheme({ NO_COLOR: "1" }, 3);

describe("the palette", () => {
  it("names the terminal's own colours where they read well: magenta accent, amber gates, green ok, red bad", () => {
    expect(DARK.accent).toBe("ansi:magentaBright");
    expect(DARK.gate).toBe("ansi:yellow");
    expect(DARK.ok).toBe("ansi:green");
    expect(DARK.bad).toBe("ansi:red");
    expect(LIGHT.accent).toBe("ansi:magenta");
    expect(LIGHT.person).toBe("ansi:blue");
    // no grey on grey: the quiet roles are a known-good shade, or the text colour dimmed when the background is unknown
    expect(AUTO.meta).toBe("dim:");
    for (const p of [DARK, LIGHT, AUTO]) for (const r of ["keelbot", "question", "option", "detail", "fg"] as const) expect(p[r]).toBe("term:");
  });

  it("its fixed shades are readable on the backgrounds they are for", () => {
    const fixed = (p: typeof DARK) => ROLES.filter((r) => p[r].startsWith("#"));
    for (const bg of ["#000000", "#1e1e1e", "#282a36", "#2e3440", "#002b36"]) for (const r of fixed(DARK)) expect(contrast(DARK[r], bg), `${r} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    for (const bg of ["#ffffff", "#fdf6e3", "#f7f6f3"]) for (const r of fixed(LIGHT)) expect(contrast(LIGHT[r], bg), `${r} on ${bg}`).toBeGreaterThanOrEqual(4.5);
    expect(fixed(AUTO)).toEqual([]);                                       // nothing fixed when the background is unknown
  });

  it("follows NO_COLOR, KEEL_TUI_THEME, COLORFGBG and the background the terminal reports", () => {
    expect(none.level).toBe(0);
    expect(none.paint.accent("x")).toBe("x");
    expect(makeTheme({ NO_COLOR: "" }, 3).level).toBe(3);                 // set but empty: no-color.org says colour
    expect(color.paint.accent("x")).toBe("\x1b[95mx\x1b[39m");
    expect(light.paint.ok("x")).toBe(`${RGB("#1a7f37")}x\x1b[39m`);
    expect(makeTheme({ KEEL_TUI_THEME: "light" }, 2).paint.ok("x")).toMatch(/^\x1b\[38;5;\d+mx/);   // 256 colours: the nearest
    expect(makeTheme({}, 3).name).toBe("auto");
    expect(makeTheme({}, 3).paint.meta("x")).toBe("\x1b[2mx\x1b[22m");
    expect(themeName({ COLORFGBG: "0;15" })).toBe("light");
    expect(themeName({ COLORFGBG: "15;0" })).toBe("dark");
    expect(themeName({ KEEL_TUI_THEME: "light", COLORFGBG: "15;0" })).toBe("light");
    expect(themeName({ KEEL_TUI_THEME: "auto", COLORFGBG: "0;15" })).toBe("light");
    expect(themeName({}, "light")).toBe("light");                          // OSC 11 said so
    expect(themeName({ KEEL_TUI_THEME: "terminal" })).toBe("auto");        // keel TUI 0.18's word
    expect(withPalette(color, "light").paint.person("x")).toBe("\x1b[34mx\x1b[39m");
    expect(makeTheme({ LANG: "C" }).ascii).toBe(true);
    expect(makeTheme({ LANG: "en_US.UTF-8" }).ascii).toBe(false);
  });
});

describe("code", () => {
  it("is highlighted by language with the web's highlighter, in the palette's code colours", () => {
    const lines = highlight('def run(players):\n    # rank them\n    return {"ok": True, "n": 3}', "python", color.paint);
    expect(lines).toHaveLength(3);
    expect(lines[0]).toContain(`${SGR(DARK.kw)}def`);
    expect(lines[0]).toContain(`${SGR(DARK.fn)}run`);
    expect(lines[1]).toContain(`${SGR(DARK.com)}# rank them`);
    expect(lines[2]).toContain(`${SGR(DARK.str)}"ok"`);
    expect(lines[2]).toContain(`${SGR(DARK.num)}3`);
    expect(stripAnsi(lines.join("\n"))).toBe('def run(players):\n    # rank them\n    return {"ok": True, "n": 3}');
    expect(language("ts")).toBe("typescript");
    expect(language("klingon")).toBeNull();
  });

  it("colours a diff green and red, and nothing without colour", () => {
    const d = highlight("@@ -1,2 +1,2 @@\n-old\n+new\n context", "diff", color.paint);
    // each line with its number (xal's diff gutter): the old file's for a removed line, the new file's otherwise
    expect(d[0]).toBe(`${SGR(DARK.faint)}     \x1b[39m${SGR(DARK.warn)}@@ -1,2 +1,2 @@\x1b[39m`);
    expect(d[1]).toBe(`${SGR(DARK.faint)}   1 \x1b[39m${SGR(DARK.del)}-old\x1b[39m`);
    expect(d[2]).toBe(`${SGR(DARK.faint)}   1 \x1b[39m${SGR(DARK.add)}+new\x1b[39m`);
    expect(stripAnsi(d[3])).toBe("   2  context");
    expect(highlight("-old\n+new", "diff", PLAIN)).toEqual(["-old", "+new"]);
  });

  it("in KeelBot's markdown: fenced code highlighted, inline code tinted, file:line as a link, headings in the accent", () => {
    const md = "## Where\n\nSee `run()` in src/app.ts:3.\n\n```ts\nconst x: number = 1;\n```";
    const out = renderMarkdown(md, color.paint);
    expect(out).toContain(`${SGR(DARK.accent)}Where`);
    expect(out).toContain(`${SGR(DARK.kw)}run()`);
    expect(out).toContain(`${SGR(DARK.run)}src/app.ts:3`);
    expect(out).toContain(`${SGR(DARK.kw)}const`);
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
    expect(out).toContain(`${SGR(DARK.ok)}[x]`);
    expect(out).toContain(`${SGR(DARK.gate)}[?]`);
    expect(out).toContain(`${SGR(DARK.accent)}[>]`);
    expect(out).toContain(`${SGR(DARK.bad)}[!]`);
    expect(out).toContain(`${SGR(DARK.gate)}<-- waiting for you`);
    expect(colorDiagram(flow, PLAIN)).toBe(flow);
    const er = "+- users ------+\n| PK id bigint |\n| FK org_id -> orgs.id |\n+--------------+";
    expect(stripAnsi(colorDiagram(er, color.paint))).toBe(er);
    expect(colorDiagram(er, color.paint)).toContain(`${SGR(DARK.gate)}PK`);
  });

  it("show statuses as coloured badges, ids dim, complete criteria green", () => {
    const rows = [{ thread_id: "t1", title: "Health", workflow_id: "feature", status: "done", phase: null, current: null, waiting: null,
      acs_done: 2, acs_total: 2, tokens: 1000, where: "folder", branch: null, error: null, created_at: "", updated_at: "", cost_usd: 0, latest: true }];
    const out = fmt.flows(rows as never, color.paint);
    expect(out).toContain(`${SGR(DARK.ok)}✔ done`);
    expect(out).toContain(`${SGR(DARK.faint)}t1`);
    expect(out).toContain(`${SGR(DARK.ok)}2/2`);
    expect(stripAnsi(out)).toBe(' 1. ✔ done  "Health"  feature · criteria 2/2 · $0.00  t1\n/stop <n> stops one, /stop all stops every running or waiting one.');
    expect(fmt.badge("waiting", color.paint)).toContain(SGR(DARK.gate));
    expect(fmt.badge("running", PLAIN)).toBe("▶ running");
  });

  it("/help groups the commands: names in the accent, arguments in a second colour, keys highlighted", async () => {
    const plain = helpText(PLAIN);
    for (const g of ["Flows", "Gates", "Look", "KeelBot", "Screen", "Keys"]) expect(plain).toMatch(new RegExp(`^${g}$`, "m"));
    expect(plain.indexOf("/approve")).toBeGreaterThan(plain.indexOf("Gates"));
    const c = helpText(color.paint);
    expect(c).toContain(`${SGR(DARK.accent)}/reject`);
    expect(c).toContain(`${SGR(DARK.attr)}[n] <why>`);
    expect(c).toContain(`${SGR(DARK.accent)}Ctrl+F`);
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

  it("0.18.23 shows KeelBot's thinking while it thinks, folds it when the answer starts, Ctrl+T opens it", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} theme={none} />);
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    await waitFor(() => probe.started);
    r.stdin.write("where does it start?");
    await waitFor(() => frame().includes("where does it start?"));
    r.stdin.write("\r");
    await waitFor(() => probe.chatBusy);
    const ev = (type: string, n: number, text: string) => core.onMessage({ event: "engine", data: JSON.stringify({ type,
      thread_id: "s1", project_id: "demo", at: "x", call_id: "call-9", step: "helper", data: { n, block: 0, text } }) });
    ev("helper.thinking.delta", 1, "The person asks where");
    ev("helper.thinking.delta", 2, "The person asks where it starts. I look at main.py first.");
    await waitFor(() => frame().includes("I look at main.py first."));
    expect(frame()).toContain("⋮ Thinking");
    expect(frame()).toContain("The person asks where it starts. I look at main.py first.");
    ev("helper.delta", 1, "It starts in main.py");
    await waitFor(() => frame().includes("It starts in main.py"));
    expect(frame()).toMatch(/⋮ Thought for \d+s \(Ctrl\+T to show\)/);
    expect(frame()).not.toContain("I look at main.py first.");
    r.stdin.write("\x14");                                                                  // Ctrl+T opens it again
    await waitFor(() => frame().includes("I look at main.py first."));
    r.stdin.write("\x14");
    await waitFor(() => !frame().includes("I look at main.py first."));
    stub.answer("It starts in main.py.", { mode: "ask", provider: "claude", model: "sonnet",
      thinking: "The person asks where it starts. I look at main.py first.", thinking_ms: 12000 });
    core.onMessage({ event: "helper.finished", data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });
    await waitFor(() => probe.answers === 1);
    await waitFor(() => frame().includes("⋮ Thought for 12s (Ctrl+T to show)") && /■ Ask · \S+/.test(frame()));
    const f = frame();
    expect(f).toContain("⋮ Thought for 12s (Ctrl+T to show)");
    expect(f).toContain("It starts in main.py.");
    expect(f).toMatch(/■ Ask · \S+/);
    expect(f.indexOf("⋮ Thought for 12s")).toBeLessThan(f.indexOf("It starts in main.py."));
    expect(f.indexOf("It starts in main.py.")).toBeLessThan(f.indexOf("■ Ask"));
    expect(f).not.toContain("I look at main.py first.");                                     // folded, not in the answer
    r.stdin.write("\x14");                                                                  // after the turn: shown once
    await waitFor(() => frame().includes("⋮ Thinking (12s)"));
    expect(frame()).toContain("I look at main.py first.");
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
    expect(raw).toContain(SGR(DARK.accent));            // the logo and the start screen's border
    expect(raw).toContain(SGR(DARK.gate));              // a gate waits: the prompt's border and the waiting line
    r.unmount();
  });
});

describe("markdown and paths", () => {
  it("keeps a file:line with underscores whole, in the link colour (no bold inside __init__.py)", () => {
    const md = "- **entry**: `run()` in src/scores/__init__.py:1 and __bold__ here";
    const out = renderMarkdown(md, color.paint);
    expect(stripAnsi(out)).toBe("  • entry: run() in src/scores/__init__.py:1 and bold here");
    expect(out).toContain(`${SGR(DARK.run)}src/scores/__init__.py:1`);
    expect(out).not.toMatch(/[^\x1b]\[\d+m/);                      // every colour code is whole
  });
});

describe("what we took from xal", () => {
  it("the terminal's own colours, also in a 16-colour terminal", () => {
    const t = makeTheme({ KEEL_TUI_THEME: "dark" }, 1);
    expect(t.paint.accent("x")).toBe("\x1b[95mx\x1b[39m");                  // magenta, whatever shade the terminal has
    expect(t.paint.bad("x")).toBe("\x1b[31mx\x1b[39m");
    expect(t.paint.fg("x")).toBe("x");                                         // the terminal's own text colour
    expect(inkColor("ansi:magentaBright")).toBe("magentaBright");
    expect(inkColor("#a48bff")).toBe("#a48bff");
    expect(inkColor("dim:")).toBeUndefined();
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
    expect(out).toContain(`${SGR(DARK.accent)}step`);
    expect(out).toContain(`${SGR(DARK.faint)}(https://x.io)`);
  });
});

describe("xal's layout ideas in keel TUI", () => {
  it("a question is amber with a '?', a list is in the accent; the person's message has a bar in its colour", async () => {
    const { Picker } = await import("../src/ui/parts");
    const q = render(<ThemeProvider theme={color}><Picker title="Run with the fake model anyway?" choices={[{ label: "Yes", value: "y" }, { label: "No", value: "n" }]} index={0} filter="" /></ThemeProvider>);
    expect(stripAnsi(q.lastFrame() ?? "")).toContain("? Run with the fake model anyway?");
    expect(q.lastFrame()).toContain(SGR(DARK.gate));
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
    // the person's message: the bar in the person's colour down its left side (its lines of air too), the words bold
    expect(r.lastFrame()).toContain("\x1b[94m│\x1b[39m  \x1b[1m/status\x1b[22m");
    expect(stripAnsi(r.lastFrame() ?? "")).toMatch(/\n│\s*\n│  \/status\s*\n│\s*\n/);
    r.unmount();
  });
});
