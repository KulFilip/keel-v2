// keel TUI 0.18.4: KeelBot's buttons as yes / no (start, decide a gate, stop flows, a run mode), /run, /stop all and
// /stop <n>, a /status that reads in a glance, and /agent: the agents at work and the ones the person starts.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { question, splitButtons } from "../src/core/buttons";
import * as fmt from "../src/core/format";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={120} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const type = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
  };
  const enter = async () => {
    r.stdin.write("\r");
    await tick(40);
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  const run = async (s: string) => {
    await type(s);
    await enter();
  };
  return { stub, core, probe, r, frame, type, enter, run };
}

const finished = (core: KeelCore) => core.onMessage({ event: "helper.finished",
  data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });

describe("KeelBot's buttons", () => {
  it("come out of the answer, and a block inside a code block or one that cannot be read stays text", () => {
    const a = splitButtons([
      "Two flows wait. Stop them?",
      "```keel-flow", '{"do": "stop", "flows": ["t1", "t2", "t1"]}', "```",
      "```keel-flow", '{"do": "mode", "flow": "t1", "mode": "auto"}', "```",
      "```keel-flow", '{"do": "mode", "flow": "t1", "mode": "fast"}', "```",
      "````md", "```keel-flow", '{"do": "approve", "flow": "t1"}', "```", "````",
    ].join("\n"));
    expect(a.buttons).toEqual([{ kind: "stop", flows: ["t1", "t2"] }, { kind: "mode", flow: "t1", mode: "auto" }]);
    expect(a.text).toContain("Two flows wait. Stop them?");
    expect(a.text).toContain('"mode": "fast"');                       // not a run mode: left as KeelBot wrote it
    expect(a.text).toContain('{"do": "approve", "flow": "t1"}');      // an example inside a code block
    const name = (t: string) => `"${t}"`;
    expect(question(a.buttons[0], name)).toBe('KeelBot suggests: stop 2 flows ("t1", "t2")?');
    expect(question({ kind: "decide", decision: "reject", flow: "t1", why: "too big" }, name)).toBe('KeelBot suggests: reject the gate of "t1" (too big)?');
    expect(question({ kind: "workflow", yaml: "id: x" }, name)).toBeNull();
  });

  it("in the terminal: the answer without the block, then a yes / no that stops the flow", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("close all flows");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer('One flow runs. I can stop it for you:\n\n```keel-flow\n{"do": "stop", "flows": ["t1"]}\n```');
    finished(t.core);
    await waitFor(() => t.probe.pick);
    const f = t.frame();
    expect(f).toContain("One flow runs. I can stop it for you:");
    expect(f).not.toContain('"do": "stop"');
    expect(f).toContain('? KeelBot suggests: stop "Add a health endpoint"?');
    await t.enter();                                                    // Yes
    expect(t.stub.calls.some((c) => c.method === "POST" && c.path === "/api/threads/t1/stop")).toBe(true);
    expect(t.frame()).toContain('✓ stopped "Add a health endpoint". Finished steps stay saved.');
    t.r.unmount();
  });

  it("No does nothing", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("make it auto");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer('```keel-flow\n{"do": "mode", "flow": "t1", "mode": "auto"}\n```');
    finished(t.core);
    await waitFor(() => t.probe.pick);
    expect(t.frame()).toContain('KeelBot suggests: run "Add a health endpoint" in auto mode');
    await t.type("\x1b[B");                                             // No
    await t.enter();
    expect(t.stub.calls.some((c) => c.path === "/api/threads/t1/mode")).toBe(false);
    expect(t.frame()).toContain("not done");
    t.r.unmount();
  });
});

describe("/run, /stop and /flows", () => {
  it("/run auto sets the run mode; /run alone shows the modes with the current one", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/run auto");
    expect(t.stub.calls.find((c) => c.path === "/api/threads/t1/mode")!.body).toEqual({ mode: "auto" });
    expect(t.frame()).toContain('✓ "Add a health endpoint" runs in auto mode from its next gate on');
    await t.run("/run");
    expect(t.frame()).toContain("Run mode of");
    expect(t.frame()).toContain("readonly");
    t.r.unmount();
  });

  it("/stop all asks once and stops every running or waiting flow; /flows numbers them", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/flows");
    expect(t.frame()).toMatch(/ 1\. ◆ waiting at spec_gate {2}"Add a health endpoint" {2}feature · criteria 0\/2 · \$0\.42 {2}t1/);
    await t.run("/stop all");
    expect(t.frame()).toContain('Stop "Add a health endpoint"?');
    await t.enter();
    expect(t.stub.calls.some((c) => c.path === "/api/threads/t1/stop")).toBe(true);
    t.r.unmount();
  });

  it("/status: what waits for you first, one line per criterion", () => {
    const s = stubKeel();
    const out = fmt.status({ id: "demo", branch: "keel/health" } as never, { thread: s.state.thread as never, workflow: s.workflow as never }, undefined, 80);
    const lines = out.split("\n");
    expect(lines[0]).toBe('"Add a health endpoint" · feature (keel) · ◆ waiting · run mode manual');
    expect(out).toContain("◆ Waiting for you: spec approval");
    expect(out).toMatch(/ {2}\/approve {26}Approve the spec/);
    expect(out).toContain("Criteria: 0/2 done  □□");
    expect(out).toContain("  □ AC-1 API  GET /health");
    expect(out).toContain("Tokens: 15.4k of 500.0k (3 %) · $0.42");
    expect(lines.every((l) => l.length <= 80)).toBe(true);
  });
});

describe("/agent", () => {
  it("lists the flow's agents and opens one to follow it live", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/agent");
    expect(t.frame()).toContain("Go to which agent?");
    expect(t.frame()).toContain("▶ explorer (flow)");
    await t.enter();
    await waitFor(() => t.frame().includes("read_file"));
    expect(t.frame()).toContain("Agent · explorer · spec");
    expect(t.frame()).toContain("Esc stops following");
    await t.type("\x1b");
    await tick(60);
    expect(t.frame()).not.toContain("Esc stops following");
    t.r.unmount();
  });

  it("/agent new starts one in its own worktree, says when it is finished, and /agent opens it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/agent new write the docs for /health");
    const create = t.stub.calls.find((c) => c.method === "POST" && c.path === "/api/projects/demo/helper/sessions")!;
    expect(create.body).toMatchObject({ mode: "side", title: "write the docs for /health" });
    expect(t.stub.calls.find((c) => c.path.endsWith("/s1/turn"))!.body).toMatchObject({ text: "write the docs for /health" });
    expect(t.frame()).toContain('agent "write the docs for /health" started (its own worktree and branch');
    expect(t.core.snapshot.chat.session).toBeNull();                     // the person's own chat stays theirs
    await waitFor(() => t.frame().includes('agent "write the docs for /health" is finished · /agent opens it'), 8000);
    t.stub.answer("Wrote docs/health.md.");
    await t.run("/agent 2");
    expect(t.frame()).toContain('agent "write the docs for /health" · side');
    expect(t.frame()).toContain("Wrote docs/health.md.");
    t.r.unmount();
  }, 15000);
});
