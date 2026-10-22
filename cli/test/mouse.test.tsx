// keel TUI 0.18.38 the mouse in the full screen: the wheel moves the transcript one step per notch (never doubled by a
// listener set up again on a render, never moved by a sideways swipe), and the transcript keeps every line (also its
// empty ones) where the mouse finds it.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { wheel } from "../src/core/lines";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";
import { renderAt } from "./wide";

const UP = "\x1b[<64;10;5M";
const DOWN = "\x1b[<65;10;5M";

function setup(width = 80) {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={width} rows={24} mouse theme={makeTheme({ NO_COLOR: "1" }, 0)} />);
  const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n");
  const send = async (s: string, ms = 60) => {
    r.stdin.write(s);
    await tick(ms);
  };
  const run = async (s: string) => {
    await send(s);
    await send("\r");
    await waitFor(() => !probe.busy);
    await tick(60);
  };
  /** how many lines the view is above the newest ("↓ N newer lines"), 0 at the bottom */
  const below = () => Number(/↓ (\d+) newer line/.exec(lines().join("\n"))?.[1] ?? 0);
  return { stub, core, probe, r, lines, send, run, below };
}

describe("the wheel", () => {
  it("reads up and down with any modifier, and leaves the sideways wheel and the buttons out", () => {
    expect(wheel(UP)).toBe(1);
    expect(wheel(DOWN)).toBe(-1);
    expect(wheel("\x1b[<68;1;1M")).toBe(1);                         // Shift+up
    expect(wheel("\x1b[<81;1;1M")).toBe(-1);                        // Ctrl+down
    expect(wheel("\x1b[<72;1;1M")).toBe(1);                         // Meta+up
    expect(wheel("\x1b[<96;1;1M")).toBe(1);                         // up with the motion bit
    expect(wheel("\x1b[<66;1;1M\x1b[<67;1;1M\x1b[<66;1;1M")).toBe(0); // a trackpad's sideways swipe
    expect(wheel("\x1b[<0;1;1M\x1b[<32;2;1M\x1b[<0;2;1m")).toBe(0);  // a press, a drag, a release
  });

  it("one notch is one step of 3 lines, up shows older lines, down newer, and never past the newest", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    expect(t.below()).toBe(0);
    await t.send(UP);
    expect(t.below()).toBe(3);
    await t.send(UP);
    expect(t.below()).toBe(6);
    await t.send(DOWN);
    expect(t.below()).toBe(3);
    await t.send(DOWN);
    await t.send(DOWN);
    expect(t.below()).toBe(0);
    // sideways: nothing moves, nothing is typed
    await t.send("\x1b[<66;10;5M");
    expect(t.below()).toBe(0);
    expect(t.lines().join("\n")).not.toContain("[<");
    t.r.unmount();
  });

  it("is not doubled after many renders (the listener is set up once)", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    // renders: typing, new lines in the transcript, a resize of the view
    for (const c of "hello") await t.send(c, 20);
    await t.run("/status");
    for (let i = 0; i < 5; i++) await t.send("x", 20);
    await t.send(UP);
    expect(t.below()).toBe(3);
    await t.send(UP);
    expect(t.below()).toBe(6);
    t.r.unmount();
  });

  it("a burst of notches (a trackpad) moves the view by all of them, in few frames", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/help");
    const frames = t.r.frames.length;
    await t.send(UP.repeat(4), 100);
    expect(t.below()).toBe(12);
    expect(t.r.frames.length - frames).toBeLessThanOrEqual(3);
    t.r.unmount();
  });
});

describe("the transcript's lines", () => {
  it("keeps its empty lines when the live area takes rows from it", async () => {
    // a real terminal 100 columns wide (no fixed width): the answer's empty line was squeezed to no row by Yoga
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = renderAt(<App core={core} probe={probe} rows={40} mouse theme={makeTheme({ KEEL_TUI_THEME: "dark" }, 3)} />, 100);
    await waitFor(() => probe.started);
    r.stdin.write("hi");
    await tick(30);
    r.stdin.write("\r");
    await waitFor(() => probe.chatBusy);
    stub.answer("I read the four review comments on the pull request. Here is what each one asks and whether it is right.\n\n"
      + "**Comment 1: keep `eta_updated_at`?** Valid, the column is read by the tracking page and the nightly export.\n"
      + "**Comment 2: why raw SQL?** The query builder cannot express the lateral join here.\n"
      + "**Comment 4: use a factory in ParcelPerformEtaAbsentKeepsStoredTest.php:50.** Valid but optional. I changed nothing in that test file "
      + "because it passes and the factory would only shorten it by a few lines.\n\nThat is all four.");
    core.onMessage({ event: "helper.finished", data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: { status: "done" } }) });
    await waitFor(() => probe.answers === 1);
    await tick(80);
    const ls = stripAnsi(r.lastFrame() ?? "").split("\n");
    const at = ls.findIndex((l) => l.includes("I read the four"));
    expect(ls.slice(at, at + 3).map((l) => l.trim())).toEqual(["I read the four review comments on the pull request. Here is what each one asks and whether it",
      "is right.", ""]);
    expect(ls[at + 3]).toContain("Comment 1: keep eta_updated_at?");
    expect(ls[at - 1].trim()).toBe("");                                // the air above the answer
    r.unmount();
  });
});
