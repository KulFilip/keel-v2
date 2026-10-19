// keel 0.18.15 /copy: the person could not copy from keel TUI (the wheel is captured), so /copy puts a block on the
// clipboard through the terminal (OSC 52), also through docker exec and ssh. Since then: select with the mouse and it
// is copied (the full screen with the mouse on: a drag, or a double-click on a word).
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { osc52, pickCopy } from "../src/core/clipboard";
import { stubKeel, tick, waitFor } from "./stub";

describe("osc52", () => {
  it("asks the terminal to put the text on the clipboard, base64 encoded", () => {
    const seq = osc52("héllo\nworld", {});
    expect(seq.startsWith("\x1b]52;c;") && seq.endsWith("\x07")).toBe(true);
    expect(Buffer.from(seq.slice(7, -1), "base64").toString("utf8")).toBe(
      "héllo\nworld",
    );
  });
  it("is wrapped for tmux, which passes it on to the terminal", () => {
    const seq = osc52("x", { TMUX: "/tmp/tmux-1/default,1,0" });
    expect(seq.startsWith("\x1bPtmux;\x1b\x1b]52;c;")).toBe(true);
  });
});

describe("pickCopy", () => {
  const blocks = [
    { kind: "user", text: "what now?" },
    { kind: "markdown", text: "first" },
    { kind: "dim", text: "  note" },
    { kind: "text", text: "second" },
  ];
  it("takes what keel said, newest first, never the person's own line or a dim note", () => {
    expect(pickCopy(blocks, 1)?.text).toBe("second");
    expect(pickCopy(blocks, 2)?.text).toBe("first");
    expect(pickCopy(blocks, 3)).toBeNull();
  });
});

describe("/copy", () => {
  it("copies the last answer and says so", async () => {
    const stub = stubKeel();
    const core = new KeelCore({
      url: "http://keel.test",
      fetch: stub.fetch,
      noLive: true,
      cwd: "/work/demo/src",
    });
    const probe: Probe = {
      started: false,
      busy: false,
      pick: false,
      ask: false,
      chatBusy: false,
      answers: 0,
    };
    const r = render(
      <App
        core={core}
        probe={probe}
        width={120}
        theme={makeTheme({ NO_COLOR: "1" }, 0)}
      />,
    );
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    await waitFor(() => probe.started);
    r.stdin.write("/help");
    await tick(60);
    r.stdin.write("\r");
    await waitFor(() => frame().includes("/copy"), 3000);
    r.stdin.write("/copy");
    await tick(60);
    r.stdin.write("\r");
    await waitFor(() => frame().includes("to your clipboard"), 3000);
    expect(frame()).toMatch(/copied \d+ lines? to your clipboard/);
    r.unmount();
  });
});

describe("selecting in the full screen", () => {
  function setup() {
    const stub = stubKeel();
    const core = new KeelCore({
      url: "http://keel.test",
      fetch: stub.fetch,
      noLive: true,
    });
    const probe: Probe = {
      started: false,
      busy: false,
      pick: false,
      ask: false,
      chatBusy: false,
      answers: 0,
    };
    const r = render(
      <App
        core={core}
        probe={probe}
        width={80}
        rows={24}
        mouse
        theme={makeTheme({ NO_COLOR: "1" }, 0)}
      />,
    );
    const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n");
    const send = async (s: string) => {
      r.stdin.write(s);
      await tick(40);
    };
    const clip = () =>
      r.stdout.frames
        .filter((f) => f.startsWith("\x1b]52;c;"))
        .map((f) => Buffer.from(f.slice(7, -1), "base64").toString("utf8"));
    const run = async (s: string) => {
      await send(s);
      await send("\r");
      await waitFor(() => !probe.busy);
      await tick(40);
    };
    return { probe, r, lines, send, clip, run };
  }

  it("a drag over the transcript copies what it covers and says so; a plain click copies nothing", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(60);
    // the brief's own reports: press at column 5 of row 3 (keel's logo), drag to column 20, release
    await t.send("\x1b[<0;5;3M\x1b[<32;20;3M");
    await t.send("\x1b[<0;20;3m");
    await waitFor(() => t.lines().join("\n").includes("copied"));
    expect(t.clip()).toHaveLength(1);
    await t.send("\x1b[2~"); // a key (Insert) ends it
    expect(t.lines().join("\n")).not.toContain("copied");
    await t.run("/help");
    // a line of the transcript with words from column 5 to 20 (SGR is 1-based)
    const row = t.lines().findIndex((l, i) => i > 1 && /[a-z]{3}/.test(l.slice(4, 20)));
    expect(row).toBeGreaterThan(1);
    const want = t.lines()[row].slice(4, 20).replace(/\s+$/, "");
    const before = t.lines();
    await t.send(`\x1b[<0;9;${row + 1}M`); // a plain click (elsewhere: twice on one cell is a double-click)
    await t.send(`\x1b[<0;9;${row + 1}m`);
    expect(t.clip()).toHaveLength(1);
    expect(t.lines().join("\n")).not.toContain("copied");
    await t.send(`\x1b[<0;5;${row + 1}M`);
    await t.send(`\x1b[<32;20;${row + 1}M`);
    expect(t.r.lastFrame()).toContain("\x1b[7m"); // the selected cells, inverse
    await t.send(`\x1b[<0;20;${row + 1}m`);
    await waitFor(() => t.lines().join("\n").includes("copied"));
    expect(t.clip().at(-1)).toBe(want);
    expect(t.lines().slice(0, row + 1)).toEqual(before.slice(0, row + 1)); // the notice moves nothing
    expect(t.lines().join("\n")).toContain(
      `copied ${[...want].length} characters`,
    );
    expect(t.lines().join("\n")).not.toContain("[<"); // the reports are never typed into the prompt
    // a key ends the selection and the notice
    await t.send("x");
    expect(t.lines().join("\n")).not.toContain("copied");
    expect(t.r.lastFrame()).not.toContain("\x1b[7m" + want.slice(0, 3));
    t.r.unmount();
  });

  it("a double-click copies the word under it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(60);
    const row = t.lines().findIndex((l) => /project {2}demo/.test(l));
    expect(row).toBeGreaterThan(1);
    const col = t.lines()[row].indexOf("demo") + 2; // SGR's 1-based column of the "e" in "demo"
    for (const end of ["M", "m", "M", "m"]) await t.send(`\x1b[<0;${col};${row + 1}${end}`);
    await waitFor(() => t.lines().join("\n").includes("copied"));
    expect(t.clip()).toEqual(["demo"]);
    t.r.unmount();
  });
});
