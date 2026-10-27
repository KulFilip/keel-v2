// keel TUI's full screen: keel's name stays at the top, the prompt and the status line at the bottom, and the
// transcript between them scrolls (PgUp / PgDn, Shift+↑↓, the wheel, Home and End); /clear keeps the start.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { blockLines, isMouse, paintFrame, SYNC, view, wheel, wrap } from "../src/core/lines";
import { parseArgs } from "../src/main.args";
import { makeTheme, PLAIN } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);
const ROWS = 24;

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={80} rows={ROWS} mouse theme={none} />);
  // the agent at work's line turns (its compass and seconds): left out where frames are compared
  const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n").map((l) => (/ · \S.*…/.test(l) && /explorer/.test(l) ? "(agent)" : l));
  const key = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
  };
  const run = async (s: string) => {
    await key(s);
    await key("\r");
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  return { stub, core, probe, r, lines, key, run };
}

describe("lines", () => {
  it("fold text to the width, and a person's message gets air above it", () => {
    expect(wrap("a".repeat(25), 10)).toEqual(["a".repeat(10), "a".repeat(10), "a".repeat(5)]);
    // a folded line goes on under its own text: the second column (/help), else its first word
    expect(wrap("  /keep [path]   keep the change and commit it", 34)).toEqual(["  /keep [path]   keep the change", "                 and commit it"]);
    expect(wrap("    one two three four", 14)).toEqual(["    one two", "    three four"]);
    const u = blockLines({ kind: "user", text: "hello" }, 40, PLAIN);
    expect(u).toEqual(["", "│", "│  hello", "│"]);
    expect(blockLines({ kind: "error", text: "x" }, 40, PLAIN)).toEqual(["✗ x"]);
  });

  it("show the newest lines, and scroll up to the oldest and no further", () => {
    const all = Array.from({ length: 10 }, (_, i) => `l${i}`);
    expect(view(all, 3, 0)).toEqual({ shown: ["l7", "l8", "l9"], offset: 0, above: 7, below: 0 });
    expect(view(all, 3, 2).shown).toEqual(["l5", "l6", "l7"]);
    expect(view(all, 3, 99)).toMatchObject({ shown: ["l0", "l1", "l2"], offset: 7, above: 0 });
    expect(view(all.slice(0, 2), 5, 3)).toMatchObject({ shown: ["l0", "l1"], offset: 0 });
  });

  it("read the wheel, and never take the mouse's reports as typing", () => {
    expect(wheel("\x1b[<64;10;5M")).toBe(1);
    expect(wheel("\x1b[<65;10;5M\x1b[<65;10;5M")).toBe(-2);
    expect(wheel("\x1b[<0;10;5M")).toBe(0);
    expect(isMouse("\x1b[<0;3;4m")).toBe(true);
    expect(isMouse("[<64;10;5M")).toBe(true);
    expect(isMouse("hello")).toBe(false);
  });

  it("the command line: full screen and the wheel by default, --inline and --no-mouse turn them off", () => {
    expect(parseArgs([], {})).toMatchObject({ inline: false, mouse: true });
    expect(parseArgs(["--inline", "--no-mouse"], {})).toMatchObject({ inline: true, mouse: false });
    expect(parseArgs([], { KEEL_TUI_INLINE: "1", KEEL_TUI_MOUSE: "0" })).toMatchObject({ inline: true, mouse: false });
    expect(parseArgs(["--rows", "30"], {})).toMatchObject({ rows: 30 });
  });
});

describe("the full screen", () => {
  it("keeps keel's name on top and the prompt and status at the bottom, in exactly the screen's height", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(60);
    const ls = t.lines();
    expect(ls.length).toBe(ROWS - 1);
    expect(ls[0]).toMatch(/^\[ keel \] v2 /);
    // keel itself on top (0.18.8): its logins and what it spent; the project and its branch are the bottom line's
    // only the logins that work (0.18.61): codex is not set up, so it is not there
    expect(ls[0]).toContain("claude ✓ · today");
    expect(ls[0]).not.toContain("codex");
    expect(ls[0]).toContain("today 15.4k $0.42 · month 99.0k $3.10");
    expect(ls[0]).not.toContain("demo");
    expect(ls.at(-1)).toMatch(/^ \[\?\] ask · demo/);          // KeelBot's mode first, then the project and its branch
    expect(ls.at(-3)).toMatch(/^│ › .*KeelBot/);
    expect(ls.join("\n")).toContain("keel v2");
  });

  it("scrolls the transcript with PgUp / PgDn, the wheel, Home and End, and the name and prompt stay", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    const bottom = t.lines().join("\n");
    await t.key("\x1b[5~"); // PgUp
    let ls = t.lines();
    expect(ls.join("\n")).not.toBe(bottom);
    expect(ls[0]).toMatch(/^\[ keel \]/);
    expect(ls.some((l) => /↓ \d+ newer lines · PgDn, End or the wheel/.test(l))).toBe(true);
    expect(ls.at(-3)).toMatch(/^│ › .*KeelBot/);
    await t.key("\x1b[H"); // Home: the oldest, the start screen with keel's logo
    expect(t.lines()[2]).toMatch(/^╭─+╮$/);
    expect(t.lines().join("\n")).toContain("project  demo");
    await t.key("\x1b[F"); // End: the newest again
    expect(t.lines().join("\n")).toBe(bottom);
    await t.key("\x1b[<64;10;5M"); // the wheel up
    expect(t.lines().some((l) => /newer lines/.test(l))).toBe(true);
    await t.key("\x1b[<65;10;5M"); // and down
    expect(t.lines().join("\n")).toBe(bottom);
    // the mouse's reports never reach the prompt
    expect(t.lines().at(-3)).toMatch(/^│ ›  A gate/);
  });

  it("/clear empties the transcript but keeps keel's start; /mouse switches the wheel", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    await t.run("/clear");
    const s = t.lines().join("\n");
    expect(s).toContain("Ask KeelBot anything");
    expect(s).not.toContain("Type a question for KeelBot");
    await t.run("/mouse off");
    expect(t.lines().join("\n")).toContain("the mouse is the terminal's again");
    expect(t.r.stdout.frames.join("")).toContain("\x1b[?1000l");
  });
});

describe("painting a frame (no flashing)", () => {
  const erase = (n: number) => "\x1b[2K\x1b[1A".repeat(n - 1) + "\x1b[2K\x1b[G";
  it("paints over the last frame from the top-left corner: no erase, each line cleared after its text, the rest below", () => {
    expect(paintFrame(erase(3) + "a\nbb\n")).toBe(SYNC.on + "\x1b[H" + "a\x1b[K\r\nbb\x1b[K" + "\x1b[J" + SYNC.off);
    expect(paintFrame("first\n")).toBe(SYNC.on + "\x1b[Hfirst\x1b[K\x1b[J" + SYNC.off);
    // Ink's "clear the screen" (a frame as tall as the screen) is painted over too, never cleared
    expect(paintFrame("\x1b[2J\x1b[3J\x1b[Hx\n")).toBe(SYNC.on + "\x1b[Hx\x1b[K\x1b[J" + SYNC.off);
    expect(paintFrame(erase(2))).toBe("");
  });

  it("lets everything else through as it is (the cursor's hide and show)", () => {
    expect(paintFrame("\x1b[?25l")).toBe("\x1b[?25l");
  });
});

