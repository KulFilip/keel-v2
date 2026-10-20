// keel TUI's colour roles: the example screen of a KeelBot chat about a waiting gate (colors-demo.tsx) in the dark and
// the light palette, every role where it belongs, the person and KeelBot told apart, nothing readable left dim, and
// NO_COLOR as plain text.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { run } from "../src/core/commands";
import { blockLines, noteText, textBlock } from "../src/core/lines";
import { labelLine } from "../src/core/format";
import { AUTO, DARK, LIGHT, makeTheme, PLAIN, ROLES, type Palette, type Role } from "../src/core/theme";
import { parseOsc11 } from "../src/core/termbg";
import { stripAnsi } from "../src/script";
import { demoScreen } from "./colors-demo";
import { stubKeel, waitFor } from "./stub";

const CODE: Record<string, number> = { red: 31, green: 32, yellow: 33, blue: 34, magenta: 35, cyan: 36, redBright: 91, greenBright: 92,
  yellowBright: 93, blueBright: 94, magentaBright: 95, cyanBright: 96 };
const hex = (h: string) => `\x1b[38;2;${parseInt(h.slice(1, 3), 16)};${parseInt(h.slice(3, 5), 16)};${parseInt(h.slice(5, 7), 16)}m`;
/** The escape a role's colour opens with in a palette ("" for the terminal's own text colour). */
const open = (p: Palette, r: Role) => (p[r].startsWith("ansi:") ? `\x1b[${CODE[p[r].slice(5)]}m` : p[r] === "dim:" ? "\x1b[2m"
  : p[r].startsWith("#") ? hex(p[r]) : "");
const BOLD = "\x1b[1m";

const dark = makeTheme({ KEEL_TUI_THEME: "dark" }, 3);
const light = makeTheme({ KEEL_TUI_THEME: "light" }, 3);
const none = makeTheme({ NO_COLOR: "1" }, 3);
const line = (screen: string, has: string) => screen.split("\n").find((l) => stripAnsi(l).includes(has)) ?? "";

describe("the example screen: a chat with KeelBot about a waiting gate", () => {
  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    it(`uses each role where it belongs (${name})`, () => {
      const p = t.palette;
      const s = demoScreen(t);
      // the waiting banner: bold, the gate's colour, its ◆
      expect(line(s, "◆ Waiting for you")).toContain(BOLD + open(p, "gate") + "◆ Waiting for you: frame the question");
      // the ways to answer: the command a bold hint, what it does in the text colour (not dim)
      expect(line(s, "/answer")).toContain(BOLD + open(p, "hint") + "/answer");
      expect(line(s, "/answer")).toMatch(/\x1b\[22m {2,}2 question\(s\), one after the other$/);
      // "why it matters": the label a bold hint, the reason readable
      expect(line(s, "why it matters: the order")).toContain(BOLD + open(p, "hint") + "why it matters:" + "\x1b[39m\x1b[22m the order decides");
      // meta: quieter, never the text colour dimmed on a known background
      expect(line(s, "Tokens:")).toContain(open(p, "meta") + "Tokens: 5.5k of 1.1M (1 %) · $0.04");
      expect(line(s, "flow id")).toContain(open(p, "meta") + "flow id ");
      // the person: a bar in the person's colour down the left, bold words; KeelBot: the text colour, indented, no bar
      expect(line(s, "what do you mean")).toContain(open(p, "person") + "│");
      expect(line(s, "what do you mean")).toContain(BOLD + "what do you mean");
      expect(line(s, "I mean the gate")).not.toContain("│");
      expect(line(s, "I mean the gate")).toMatch(/^ {2}I mean the gate \x1b\[1mframe the question/);
      expect(line(s, "keep the earlier one")).toContain(open(p, "accent") + "•");
      expect(line(s, "src/webhooks/order.ts:42")).toContain(open(p, "path") + "src/webhooks/order.ts:42");
      // KeelBot's thinking, folded, and who answered: quiet meta text, readable (not dimmed)
      expect(line(s, "⋮ Thought for 4s")).toContain(open(p, "meta") + "⋮ Thought for 4s");
      expect(line(s, "■ Ask · Claude Sonnet 5.5")).toContain(open(p, "meta") + "■ Ask");
      // KeelBot's suggestion: the question's words, the answer it would give as chosen; not sent as a warning
      expect(line(s, "keep it? → No")).toContain(BOLD + open(p, "chosen") + "No");
      expect(line(s, "Suggestion not sent")).toContain(open(p, "warn") + "  Suggestion not sent: you chose No.");
      // the question card: its number in the gate's colour, the question bold, its why readable
      expect(line(s, "1/1 What should I do next?")).toContain(BOLD + open(p, "gate") + "1/1");
      // the suggestion box: ✦ and the suggestion's colour; the question box: "?" and the gate's colour
      expect(line(s, "✦ KeelBot suggests")).toContain(open(p, "suggest") + "✦ KeelBot suggests ");
      expect(line(s, "? What should I do next?")).toContain(open(p, "gate") + "? ");
      // an option: bold, "(recommended)" in its own colour, its description readable (no dim, no grey)
      const opt = line(s, "Ask KeelBot more");
      expect(opt).toContain(BOLD + "  Ask KeelBot more");
      expect(opt).not.toContain(open(p, "meta") + "  it explains");
      expect(line(s, "(recommended)")).toContain(open(p, "recommended") + " (recommended)");
      // nothing on this screen is dimmed (SGR 2) in a palette with a known background
      expect(s).not.toContain("\x1b[2m");
    });
  }

  for (const [name, t] of [["dark", dark], ["light", light]] as const) {
    it(`draws the tool calls, the footer's time and the sidebar in their roles (${name})`, () => {
      const p = t.palette;
      const s = demoScreen(t, 100, true);
      // a tool call: quiet (meta), its name readable; a failed one in the error colour, its fold too
      expect(line(s, "⚙ keel_status")).toContain(open(p, "meta") + "⚙ ");
      expect(line(s, "$ git log --oneline")).toContain(open(p, "meta") + "$ ");
      expect(line(s, "└ 20 lines")).toContain(open(p, "meta") + "    └ 20 lines");
      expect(line(s, "└ the code graph is not indexed")).toContain(open(p, "bad") + "    └ the code graph is not indexed yet");
      expect(line(s, "⚙ keel_search")).toContain(open(p, "bad") + "⚙ ");
      // the footer: who answered and how long it took, quiet
      expect(line(s, "■ Ask · Claude Sonnet 5.5 · 7.6s")).toContain(open(p, "meta") + "■ Ask · Claude Sonnet 5.5 · 7.6s");
      // the sidebar: bold headings, the failed server in the error colour, the meta words quiet
      expect(line(s, "Context")).toContain(BOLD + open(p, "heading") + "Context");
      expect(line(s, "Files changed")).toContain(BOLD + open(p, "heading") + "Files changed");
      expect(line(s, "41% used")).toContain(open(p, "meta") + "41% used");
      expect(stripAnsi(line(s, "Context")).slice(101)).toBe("│ Context");
      expect(line(s, "✗ Jira")).toContain(open(p, "bad") + "✗ ");
      expect(line(s, "● keel")).toContain(open(p, "ok") + "● ");
      expect(line(s, "◆ waits: frame the question")).toContain(open(p, "gate") + "◆ waits");
      expect(s).not.toContain("\x1b[2m");
    });
  }

  it("draws the sidebar with NO_COLOR as plain text", () => {
    const plain = demoScreen(none, 100, true);
    expect(plain).not.toMatch(/\x1b\[/);
    expect(plain).toBe(stripAnsi(demoScreen(dark, 100, true)));
    expect(plain).toMatch(/Context\n?/);
    expect(plain).toMatch(/✗ Jira +failed/);
    expect(plain).toMatch(/M src\/webhooks\/order\.ts +\+12 -3/);
  });

  it("is the same text with NO_COLOR, with no escape at all", () => {
    const plain = demoScreen(none);
    expect(plain).not.toMatch(/\x1b\[/);
    expect(plain).toBe(stripAnsi(demoScreen(dark)));
    expect(plain).toContain("│  what do you mean");
    expect(plain).toContain('✦ KeelBot suggests this answer for "frame the question". Send it?');
    expect(plain).toContain("◆ Waiting for you: frame the question has 2 questions");
  });
});

describe("the palettes", () => {
  it("have every role, and different looks for the person, KeelBot, a gate, a hint and meta text", () => {
    for (const p of [DARK, LIGHT, AUTO]) {
      expect(ROLES.every((r) => typeof p[r] === "string" && p[r].length > 0)).toBe(true);
      expect(new Set([p.person, p.keelbot, p.gate, p.meta]).size).toBe(4);
      expect(p.recommended).toBe(p.chosen);
    }
    expect(DARK.hint).not.toBe(DARK.person);
    expect(LIGHT.hint).not.toBe(LIGHT.person);
  });

  it("draw the full screen's blocks in the same roles", () => {
    const p = dark.paint;
    expect(blockLines({ kind: "user", text: "hi" }, 40, p)[2]).toBe(`\x1b[94m│\x1b[39m  ${BOLD}hi\x1b[22m`);
    expect(blockLines({ kind: "dim", text: "  q? → Yes" }, 40, p)[0]).toContain(`${BOLD}\x1b[32mYes`);
    // KeelBot's thinking shown with Ctrl+T: its own words in meta, never read as "q → answer" or "not done"
    const thought = blockLines({ kind: "dim", text: "⋮ Thinking (3s)\n  a → b\n  not done yet" }, 40, p);
    expect(thought.every((l) => l.startsWith(open(dark.palette, "meta")))).toBe(true);
    expect(blockLines({ kind: "user", text: "hi" }, 40, PLAIN)).toEqual(["", "│", "│  hi", "│"]);
    expect(noteText("  q? → Yes", PLAIN)).toBe("  q? → Yes");
    expect(textBlock("1/2 Which one?\n   why it matters: x", PLAIN)).toBe("1/2 Which one?\n   why it matters: x");
    expect(stripAnsi(textBlock("Your answers:\n  1. Which one?\n     → B", p))).toBe("Your answers:\n  1. Which one?\n     → B");
    expect(labelLine("why it matters: x", p)).toBe(`${BOLD}\x1b[36mwhy it matters:\x1b[39m\x1b[22m x`);
  });

  it("read the terminal's background from its OSC 11 answer", () => {
    expect(parseOsc11("\x1b]11;rgb:ffff/ffff/ffff\x1b\\")).toBe("light");
    expect(parseOsc11("\x1b]11;rgb:1e1e/1e1e/1e1e\x07")).toBe("dark");
    expect(parseOsc11("\x1b]11;rgb:fd/f6/e3\x07")).toBe("light");
    expect(parseOsc11("\x1b[?62;c")).toBeNull();
  });
});

describe("/theme", () => {
  it("switches the palette while keel TUI runs", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    expect((await run({ core, width: 80 }, "/theme light")).theme).toBe("light");
    expect((await run({ core, width: 80 }, "/theme terminal")).theme).toBe("auto");
    expect((await run({ core, width: 80 }, "/theme pink")).blocks[0].kind).toBe("error");
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={80} theme={dark} />);
    await waitFor(() => probe.started);
    r.stdin.write("/theme light");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("› /theme light"));
    r.stdin.write("\r");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("theme light: colours for a light background"));
    // what comes next is in the light palette; the prompt's "›": the person's blue on light
    await waitFor(() => (r.lastFrame() ?? "").includes(hex(LIGHT.ok)) && (r.lastFrame() ?? "").includes("\x1b[34m› "));
    expect(r.lastFrame()).toContain(hex(LIGHT.ok));
    expect(r.lastFrame()).toContain("\x1b[34m› ");
    r.unmount();
  });
});
