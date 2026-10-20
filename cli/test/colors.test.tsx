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
import { stubKeel, tick, waitFor } from "./stub";

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
      // the person: a bold › in the person's colour, bold words; KeelBot: the text colour, indented, with its bullets
      expect(line(s, "› what do you mean")).toContain(BOLD + open(p, "person") + " › ");
      expect(line(s, "I mean the gate")).toMatch(/^ {2}I mean the gate \x1b\[1mframe the question/);
      expect(line(s, "keep the earlier one")).toContain(open(p, "accent") + "•");
      expect(line(s, "src/webhooks/order.ts:42")).toContain(open(p, "path") + "src/webhooks/order.ts:42");
      // KeelBot's suggestion: where it waits as a gate, the answer it would give as chosen
      expect(line(s, "it waits at:")).toContain(BOLD + open(p, "gate") + "it waits at:");
      expect(line(s, "keep it? → No")).toContain(BOLD + open(p, "chosen") + "No");
      expect(line(s, "not done")).toContain(open(p, "warn") + "  not done");
      // the question card: its number in the gate's colour, the question bold, its why readable
      expect(line(s, "1/1 What should I do next?")).toContain(BOLD + open(p, "gate") + "1/1");
      // the suggestion box: ✦ and the suggestion's colour; the question box: "?" and the gate's colour
      expect(line(s, "✦ KeelBot suggests:")).toContain(open(p, "suggest") + "✦ KeelBot suggests: ");
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

  it("is the same text with NO_COLOR, with no escape at all", () => {
    const plain = demoScreen(none);
    expect(plain).not.toMatch(/\x1b\[/);
    expect(plain).toBe(stripAnsi(demoScreen(dark)));
    expect(plain).toContain(" › what do you mean");
    expect(plain).toContain("✦ KeelBot suggests: answer");
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
    expect(blockLines({ kind: "user", text: "hi" }, 40, p)[1]).toBe(`${BOLD}\x1b[94m › \x1b[39m\x1b[22m${BOLD}hi\x1b[22m`);
    expect(blockLines({ kind: "dim", text: "  q? → Yes" }, 40, p)[0]).toContain(`${BOLD}\x1b[32mYes`);
    expect(blockLines({ kind: "user", text: "hi" }, 40, PLAIN)).toEqual(["", " › hi"]);
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
    await tick(30);
    r.stdin.write("\r");
    await waitFor(() => stripAnsi(r.lastFrame() ?? "").includes("theme light: colours for a light background"));
    await tick(30);
    expect(r.lastFrame()).toContain(hex(LIGHT.ok));                              // what comes next is in the light palette
    expect(r.lastFrame()).toContain("\x1b[34m› ");                               // the prompt's "›": the person's blue on light
    r.unmount();
  });
});
