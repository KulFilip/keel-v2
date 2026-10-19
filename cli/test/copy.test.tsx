// keel 0.18.15 /copy: the person could not copy from keel TUI (the wheel is captured), so /copy puts a block on the
// clipboard through the terminal (OSC 52), also through docker exec and ssh.
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
