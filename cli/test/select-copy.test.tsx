// keel TUI 0.18.38 copying text: a drag in the transcript copies through the terminal (OSC 52) and this computer's own
// clipboard command (macOS Terminal ignores OSC 52), says how many lines, scrolls when it is held past the top or the
// bottom (and with the wheel), and keel TUI says how to select with the terminal itself or give it the mouse.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { copiedText, copyText, localCopier } from "../src/core/clipboard";
import { MOUSE } from "../src/core/lines";
import { stubKeel, tick, waitFor } from "./stub";

describe("copyText", () => {
  const fake = () => {
    const calls: { cmd: string; args: string[]; text?: string }[] = [];
    const spawn = (cmd: string, args: string[]) => {
      const c: { cmd: string; args: string[]; text?: string } = { cmd, args };
      calls.push(c);
      return { stdin: { end: (s: string) => void (c.text = s) }, on: () => undefined };
    };
    return { calls, spawn };
  };
  const out = () => {
    const w: string[] = [];
    return { w, write: (s: string) => void w.push(s) };
  };

  it("on a Mac: OSC 52 and pbcopy both get the text", () => {
    const f = fake();
    const o = out();
    const c = copyText("one\ntwo", o, { TERM_PROGRAM: "Apple_Terminal" }, "darwin", f.spawn);
    expect(o.w[0].startsWith("\x1b]52;c;")).toBe(true);
    expect(f.calls).toEqual([{ cmd: "pbcopy", args: [], text: "one\ntwo" }]);
    expect(c).toEqual({ lines: 2, chars: 7, via: "pbcopy", note: null });
    expect(copiedText(c)).toBe("copied 2 lines (7 characters)");
  });

  it("over ssh, in keel's container or in the tests only the terminal can; macOS Terminal gets a way that works", () => {
    expect(localCopier({ SSH_CONNECTION: "1 2 3 4" }, "darwin")).toBeNull();
    expect(localCopier({ KEEL_TUI_CLIPBOARD: "terminal" }, "darwin")).toBeNull();
    expect(localCopier({}, "linux")).toBeNull();                         // keel's container: no display
    expect(localCopier({ WAYLAND_DISPLAY: "wayland-0" }, "linux")).toEqual(["wl-copy"]);
    expect(localCopier({ DISPLAY: ":0" }, "linux")).toEqual(["xclip", "-selection", "clipboard"]);
    const f = fake();
    const c = copyText("x", out(), { TERM_PROGRAM: "Apple_Terminal" }, "linux", f.spawn);
    expect(f.calls).toEqual([]);
    expect(copiedText(c)).toBe("copied 1 character · macOS Terminal ignores copy requests: Option-drag selects with the terminal, or /mouse off");
    expect(copyText("x", out(), { TERM_PROGRAM: "iTerm.app" }, "linux", f.spawn).note).toBeNull();
  });
});

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={80} rows={24} mouse theme={makeTheme({ NO_COLOR: "1" }, 0)} />);
  const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n");
  const send = async (s: string, ms = 40) => {
    r.stdin.write(s);
    await tick(ms);
  };
  const clip = () => r.stdout.frames.filter((f) => f.startsWith("\x1b]52;c;")).map((f) => Buffer.from(f.slice(7, -1), "base64").toString("utf8"));
  const run = async (s: string) => {
    await send(s);
    await send("\r");
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  const below = () => Number(/↓ (\d+) newer line/.exec(lines().join("\n"))?.[1] ?? 0);
  /** the screen rows (0-based) of the transcript's lines: below the header's two rows, above the live area */
  const rowOf = (re: RegExp) => lines().findIndex((l, i) => i > 1 && re.test(l));
  return { probe, r, lines, send, clip, run, below, rowOf };
}

describe("selecting in the transcript", () => {
  it("a drag over several lines copies them and says how many", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    const top = t.rowOf(/\/\w/);
    const want = t.lines().slice(top, top + 3).map((l) => l.replace(/\s+$/, "")).join("\n");
    await t.send(`\x1b[<0;1;${top + 1}M`);
    await t.send(`\x1b[<32;40;${top + 2}M`);
    expect(t.lines().join("\n")).toContain("selecting · release copies");
    await t.send(`\x1b[<32;80;${top + 3}M`);
    await t.send(`\x1b[<0;80;${top + 3}m`);
    expect(t.clip().at(-1)).toBe(want);
    expect(t.lines().join("\n")).toMatch(/copied 3 lines \(\d+ characters\) · Option-drag \(Shift-drag\)/);
    t.r.unmount();
  });

  it("held past the top, it scrolls to older lines and the selection grows with it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    expect(t.below()).toBe(0);
    const last = t.rowOf(/KeelBot's own commands/);
    expect(last).toBeGreaterThan(2);
    await t.send(`\x1b[<0;80;${last + 1}M`);               // the end of the help's last line
    await t.send(`\x1b[<32;5;1M`, 400);                 // keel's name, above the transcript: held there
    expect(t.below()).toBeGreaterThan(6);
    await t.send(`\x1b[<0;5;1m`, 120);
    const held = t.below();
    await tick(200);
    expect(t.below()).toBe(held);                         // the release stops it
    const text = t.clip().at(-1) ?? "";
    expect(text.split("\n").length).toBeGreaterThan(18);  // more than the screen had rows for
    expect(text.trimEnd().endsWith("KeelBot's own commands (/gate, /where …) go to KeelBot as they are.")).toBe(true);
    t.r.unmount();
  });

  it("held below the transcript, it scrolls back to the newest lines", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    await t.send("\x1b[5~");                              // PgUp
    const up = t.below();
    expect(up).toBeGreaterThan(0);
    await t.send(`\x1b[<0;1;4M`);
    await t.send(`\x1b[<32;5;24M`, 600);                // the status line, below the transcript
    expect(t.below()).toBeLessThan(up);
    await t.send(`\x1b[<0;5;24m`);
    expect(t.clip().at(-1)?.split("\n").length).toBeGreaterThan(5);
    t.r.unmount();
  });

  it("the wheel while dragging moves the view and the selection's end with it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    const last = t.rowOf(/KeelBot's own commands/);
    await t.send(`\x1b[<0;1;${last + 1}M`);
    await t.send(`\x1b[<32;3;${last + 1}M`);
    await t.send("\x1b[<64;3;" + (last + 1) + "M", 80);  // the wheel up, the button still held
    expect(t.below()).toBe(3);
    await t.send(`\x1b[<0;3;${last + 1}m`);
    const text = t.clip().at(-1) ?? "";
    expect(text.split("\n").length).toBe(4);              // from 3 lines up down to where the drag began
    expect(text.trimEnd().endsWith("KeelBot's own commands (/gate, /where …) go to KeelBot as they are.")).toBe(false);
    t.r.unmount();
  });
});

describe("the terminal's own selection", () => {
  it("/help and the status line say how; /mouse off gives the mouse to the terminal and /mouse on takes it back", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    const help = t.lines().join(" ").replace(/\s+/g, " ");
    expect(help).toContain("Option-drag (Shift-drag) for the terminal's own selection; /mouse off gives the mouse to the terminal; /copy copies");
    const wide = render(<App core={new KeelCore({ url: "http://keel.test", fetch: stubKeel().fetch, noLive: true })} width={200} rows={24} mouse
      theme={makeTheme({ NO_COLOR: "1" }, 0)} />);
    await tick(200);
    expect(stripAnsi(wide.lastFrame() ?? "")).toContain("Option/Shift-drag: terminal selection");
    wide.unmount();
    await t.run("/mouse off");
    expect(t.r.stdout.frames.join("")).toContain(MOUSE.off);
    expect(t.lines().join("\n")).toContain("the mouse is the terminal's again");
    expect(t.lines().join("\n")).not.toContain("Option/Shift-drag: terminal selection");
    await t.run("/mouse on");
    expect(t.r.stdout.frames.join("").lastIndexOf(MOUSE.on)).toBeGreaterThan(t.r.stdout.frames.join("").lastIndexOf(MOUSE.off));
    expect(t.lines().join("\n")).toContain("drag over text and it is copied");
    t.r.unmount();
  });
});
