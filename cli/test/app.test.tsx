// keel TUI's Ink app (ink-testing-library): the start screen, autocomplete, a command's answer, a pick, KeelBot's
// streaming answer, the panels and the status line.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";
import { VERBS } from "../src/ui/thinking";

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, publicUrl: "http://localhost:8080" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={100} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const type = async (text: string) => {
    r.stdin.write(text);
    await tick(30);
  };
  const enter = async () => {
    r.stdin.write("\r");
    await tick(30);
    await waitFor(() => !probe.busy);
    await tick(30);
  };
  return { stub, core, probe, r, frame, type, enter };
}

describe("keel TUI", () => {
  it("opens with keel's logo, the version, which keel, the project, what waits and what is next", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(50);
    const f = t.frame();
    expect(f).toContain("|_|\\_\\___|\\___||_|");
    expect(f).toContain("keel v2 0.17.3");
    expect(f).toContain("keel     http://localhost:8080 · docker · fake model");
    expect(f).toContain("project  demo · branch keel/health");
    expect(f).toContain('flow     feature "Add a health endpoint" · ◆ waiting at spec_gate');
    expect(f).toContain("waiting  1 waiting for you · gate: spec approval");
    expect(f).toContain("next     waiting at spec_gate (spec approval): /approve");
    // a gate waits on this project: the prompt says how to answer it
    expect(f).toContain("A gate waits for you: /approve, /reject <why>, /next … or ask KeelBot");
    t.r.unmount();
  });

  it("autocompletes commands with Tab and runs them", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("/wor");
    expect(t.frame()).toContain("/workflows [workflow]");
    t.r.stdin.write("\t");
    await tick(30);
    expect(t.frame()).toContain("› /workflows");
    await t.type("feature");
    await t.enter();
    await waitFor(() => t.frame().includes("DIAGRAM workflow feature"));
    expect(t.frame()).toContain("› /workflows feature");
    t.r.unmount();
  });

  it("asks with a picker and an input when /flow has no arguments", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("/flow");
    await t.enter();
    await waitFor(() => t.probe.pick);
    expect(t.frame()).toContain("Which flow?");
    expect(t.frame()).toContain("❯ feature");
    t.r.stdin.write("\r");
    await waitFor(() => t.probe.ask);
    expect(t.frame()).toContain("What should the feature flow do?");
    await t.type("Add a health endpoint");
    await t.enter();
    await waitFor(() => t.frame().includes("recorded as started via keel TUI"));
    const call = t.stub.calls.find((c) => c.method === "POST" && c.path === "/api/projects/demo/flows")!;
    expect(call.headers["x-keel-tool"]).toBe("/flow");
    t.r.unmount();
  });

  it("streams KeelBot's answer, then shows it as markdown", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("where does the app start?");
    await t.enter();
    await waitFor(() => t.probe.chatBusy);
    t.core.onMessage({ event: "helper.step", data: JSON.stringify({ type: "helper.step", thread_id: "s1", project_id: "demo", at: "x", call_id: "call-9",
      data: { n: 1, kind: "tool", tool: "grep", text: "createApp" } }) });
    t.core.onMessage({ event: "helper.step", data: JSON.stringify({ type: "helper.step", thread_id: "s1", project_id: "demo", at: "x", call_id: "call-9",
      data: { n: 2, kind: "text", text: "It starts in **src/main.ts:3**" } }) });
    await tick(50);
    expect(t.frame()).toMatch(new RegExp(`(${VERBS.join("|")})… \\(\\d+s · ~\\d+ tokens · esc to interrupt\\)`));
    expect(t.frame()).toMatch(/  > grep createApp +✓/);                      // a tool step, settled at the right
    expect(t.frame()).toContain("It starts in src/main.ts:3");
    t.stub.answer("It starts in `src/main.ts:3`, where **createApp** runs.");
    t.core.onMessage({ event: "helper.finished", data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: { status: "done" } }) });
    await waitFor(() => t.probe.answers === 1);
    await tick(50);
    const f = t.frame();
    expect(f).toContain("It starts in src/main.ts:3, where createApp runs.");
    expect(f).toMatch(/✓ Finished in \d+\.\ds · KeelBot · fake\/fake · 1\.5k tokens/);
    expect(f).toMatch(/  > grep createApp +✓\n/);                        // what it did, kept above the answer
    expect(f).not.toContain("esc to interrupt");
    expect(t.stub.calls.find((c) => c.path === "/api/projects/demo/helper/sessions/s1/turn")?.body).toEqual({ text: "where does the app start?" });
    t.r.unmount();
  });

  it("shows keel's live events as notices", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.core.onMessage({ event: "gate.waiting", data: JSON.stringify({ type: "gate.waiting", thread_id: "t1", project_id: "demo", at: "x", step: "spec_gate",
      data: { title: "spec approval" } }) });
    await tick(50);
    expect(t.frame()).toContain("◆ waiting for you: spec approval");
    t.r.unmount();
  });

  it("toggles the flow rail, the agents and the inbox with the keyboard, and keeps the status line", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(30);
    expect(t.frame()).toContain("demo (keel/health) · feature waiting · phase spec · AC 0/2 · 1 waiting · 15.4k tokens");
    t.r.stdin.write("\x06");                      // Ctrl+F
    await tick(50);
    let f = t.frame();
    expect(f).toContain('Flow · feature "Add a health endpoint" · ◆ waiting');
    expect(f).toContain("✔ preflight  ◆ spec  · red  · green  · gate");
    expect(f).toContain("◆ waiting for you: spec approval · /approve or /reject <why>");
    t.r.stdin.write("\x01");                      // Ctrl+A
    await waitFor(() => t.frame().includes("Agents · 1 at work"));
    expect(t.frame()).toMatch(new RegExp(`explorer · (${VERBS.join("|")})… \\(\\d+s · ~1\\.0k tokens · spec\\)`));
    t.r.stdin.write("\x02");                      // Ctrl+B
    await tick(50);
    f = t.frame();
    expect(f).toContain("Inbox · 1 waiting");
    expect(f).toContain("1. demo · gate: spec approval · /approve 1");
    t.r.stdin.write("\x02");
    await tick(50);
    expect(t.frame()).not.toContain("Inbox · 1 waiting");
    t.r.unmount();
  });

  it("approves from the prompt and says so", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("/approve");
    await t.enter();
    await waitFor(() => t.frame().includes("✓ approved spec approval"));
    expect(t.frame()).toContain("The flow is running at red (phase red)");
    t.r.unmount();
  });
});

describe("a terminal that says 0 columns at first (docker exec -it)", () => {
  it("still draws the start screen at full width", async () => {
    const { render: inkRender } = await import("ink");
    const { FakeStdin, FakeStdout } = await import("../src/script");
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const out = new FakeStdout(0);
    const app = inkRender(<App core={core} probe={probe} />, { stdin: new FakeStdin() as never, stdout: out as never, debug: true, patchConsole: false });
    await waitFor(() => probe.started);
    await tick(50);
    expect(stripAnsi(out.last)).toContain("│ keel v2 0.17.3 · keel TUI 0.17.3");
    app.unmount();
  });
});
