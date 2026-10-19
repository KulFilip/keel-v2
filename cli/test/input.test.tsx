// 0.18.18 keel TUI phase 2, input comfort: the person's earlier prompts (↑ / ↓, from keel, so they survive a restart),
// a prompt of several lines (Alt+Enter, /editor), `!command` through keel's guard, and images with a turn.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const UP = "\x1b[A";
const DOWN = "\x1b[B";
const ESC = "\x1b";

async function app(setup?: (stub: ReturnType<typeof stubKeel>) => void) {
  const stub = stubKeel();
  setup?.(stub);
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo/src" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={120} theme={makeTheme({ NO_COLOR: "1" }, 0)} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  /** the prompt's own line(s): between the box's top and bottom border */
  const prompt = () => {
    const ls = frame().split("\n");
    const top = ls.map((l) => l.includes("╭")).lastIndexOf(true);
    const bottom = ls.findIndex((l, i) => i > top && l.includes("╰"));
    return ls.slice(top + 1, bottom).map((l) => l.replace(/^│\s?/, "").replace(/\s*│\s*$/, "")).join("\n");
  };
  const key = async (k: string, ms = 40) => {
    r.stdin.write(k);
    await tick(ms);
  };
  await waitFor(() => probe.started);
  await tick(60);
  return { stub, core, probe, r, frame, prompt, key };
}

describe("prompt history", () => {
  it("↑ walks the project's earlier prompts from keel, newest first; ↓ comes back, down to an empty prompt", async () => {
    const a = await app((s) => (s.state.prompts = ["the newest question", "an older question"]));
    await waitFor(() => a.stub.calls.some((c) => c.path === "/api/projects/demo/helper/prompts"));
    await a.key(UP);
    expect(a.prompt()).toContain("the newest question");
    await a.key(UP);
    expect(a.prompt()).toContain("an older question");
    await a.key(UP);                                       // the oldest stays
    expect(a.prompt()).toContain("an older question");
    await a.key(DOWN);
    expect(a.prompt()).toContain("the newest question");
    await a.key(DOWN);
    expect(a.prompt()).not.toContain("question");
    a.r.unmount();
  });

  it("↑ in a prompt the person typed leaves it alone; Esc or typing leaves the history", async () => {
    const a = await app((s) => (s.state.prompts = ["the newest question"]));
    await waitFor(() => a.stub.calls.some((c) => c.path === "/api/projects/demo/helper/prompts"));
    await a.key("my own");
    await a.key(UP);
    expect(a.prompt()).toContain("my own");
    expect(a.prompt()).not.toContain("newest");
    await a.key("\x15");                                   // Ctrl+U: an empty prompt again
    await a.key(UP);
    expect(a.prompt()).toContain("the newest question");
    await a.key(ESC);
    expect(a.prompt()).not.toContain("newest");
    await a.key(UP);
    await a.key("!");                                      // typing edits the prompt: ↑ no longer walks
    await a.key(UP);
    expect(a.prompt()).toContain("the newest question!");
    a.r.unmount();
  });

  it("what the person just sent comes first, before keel's older prompts", async () => {
    const a = await app((s) => (s.state.prompts = ["an older question"]));
    await waitFor(() => a.stub.calls.some((c) => c.path === "/api/projects/demo/helper/prompts"));
    await a.key("/help", 60);
    await a.key("\r");
    await waitFor(() => a.frame().includes("/copy"), 3000);
    await a.key(UP);
    expect(a.prompt()).toContain("/help");
    await a.key(UP);
    expect(a.prompt()).toContain("an older question");
    a.r.unmount();
  });
});
