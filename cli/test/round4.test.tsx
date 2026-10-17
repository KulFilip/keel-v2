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

function setup(cwd = "/work/demo/src") {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd });
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
    await tick(80);                                                     // the picker's keys are live after its render
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
    await tick(80);                                                     // the picker's keys are live after its render
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
    expect(t.frame()).toContain('Agent · explorer · "Add a health endpoint" · spec');
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

describe("/project", () => {
  it("the list starts on the project you are in: Enter keeps it, one ↑ is the one before; a switch shows the new start box", async () => {
    const t = setup("/work/zeta");
    await waitFor(() => t.probe.started);
    expect(t.core.snapshot.project?.id).toBe("zeta");
    await t.run("/project");
    expect(t.frame()).toMatch(/❯ zeta \(now\)/);
    await t.enter();
    expect(t.frame()).toContain("Still on zeta.");
    await t.run("/project");
    await t.type("\x1b[A");
    await t.enter();
    expect(t.core.snapshot.project?.id).toBe("alpha");
    const f = t.frame();
    expect(f).toContain("✓ now on project alpha");
    expect(f.slice(f.lastIndexOf("now on project alpha"))).toMatch(/project +alpha · branch main/);
    t.r.unmount();
  });
});

describe("clicks (the full screen with the mouse)", () => {
  function screenSetup() {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    // wide enough for the whole agent line (0.18.7: it names its flow too)
    const r = render(<App core={core} probe={probe} width={130} rows={40} mouse theme={none} />);
    const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n");
    /** a left click on the first line that has `text` (SGR: 1-based column and row) */
    const click = async (text: string) => {
      const row = lines().findIndex((l) => l.includes(text));
      if (row < 0) throw new Error(`no line with ${text}:\n${lines().join("\n")}`);
      const col = lines()[row].indexOf(text);
      r.stdin.write(`\x1b[<0;${col + 2};${row + 1}M`);
      await tick(20);
      r.stdin.write(`\x1b[<0;${col + 2};${row + 1}m`);
      await tick(60);
    };
    return { stub, core, probe, r, lines, click };
  }

  it("a click on an agent at work follows it: its steps, live; the line shows its last step and says so", async () => {
    const t = screenSetup();
    await waitFor(() => t.probe.started);
    await waitFor(() => t.lines().some((l) => l.includes("explorer ·")));
    expect(t.lines().find((l) => l.includes("explorer ·"))).toContain("click to follow");
    await t.click("explorer ·");
    await waitFor(() => t.lines().some((l) => l.includes(`Agent · explorer · "Add a health endpoint" · spec`)));
    await waitFor(() => t.lines().some((l) => l.includes("read_file")));
    expect(t.lines().join("\n")).not.toContain("[<0;");                 // a click is never typed into the prompt
    t.r.unmount();
  });

  it("Ctrl+F, then a click on what waits: a choice first, then the decision", async () => {
    const t = screenSetup();
    await waitFor(() => t.probe.started);
    t.r.stdin.write("\x06");                                            // Ctrl+F
    await tick(60);
    await t.click("waiting for you: spec approval");
    await waitFor(() => t.probe.pick);
    await tick(80);                                                     // the picker's keys are live after its render
    expect(t.lines().join("\n")).toContain("spec approval: what do you do?");
    expect(t.stub.calls.some((c) => c.path === "/api/inbox/t1/act")).toBe(false);
    t.r.stdin.write("\r");                                              // Approve
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/inbox/t1/act"));
    expect(t.stub.calls.find((c) => c.path === "/api/inbox/t1/act")!.body).toMatchObject({ decision: "approve" });
    t.r.unmount();
  });

  it("a click elsewhere in the flow panel shows /status", async () => {
    const t = screenSetup();
    await waitFor(() => t.probe.started);
    t.r.stdin.write("\x06");
    await tick(60);
    await t.click("Flow · feature");
    await waitFor(() => t.lines().join("\n").includes("Criteria: 0/2 done"));
    t.r.unmount();
  });
});

describe("the status line's waiting", () => {
  it("says what it counts, and a click on it asks what to do: approve, send back, answer, stop, read", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={100} rows={40} mouse theme={none} />);
    const lines = () => stripAnsi(r.lastFrame() ?? "").split("\n");
    await waitFor(() => probe.started);
    await tick(60);
    const row = lines().findIndex((l) => l.includes("◆ 1 waiting here"));
    expect(row).toBeGreaterThan(0);
    r.stdin.write(`\x1b[<0;20;${row + 1}M`);
    await waitFor(() => probe.pick);
    await tick(80);
    const f = lines().join("\n");
    expect(f).toContain("demo · Add a health endpoint · spec approval: what do you do?");
    for (const c of ["Approve", "Send back…", "Stop the flow", "Read it first"]) expect(f).toContain(c);
    r.stdin.write("\x1b[B");                                            // Send back…
    await tick(40);
    r.stdin.write("\x1b[B");                                            // Stop the flow
    await tick(40);
    r.stdin.write("\r");
    await waitFor(() => lines().join("\n").includes("Stop demo · Add a health endpoint?"));
    r.stdin.write("\r");                                                // Yes, stop it
    await waitFor(() => stub.calls.some((c) => c.method === "POST" && c.path === "/api/threads/t1/stop"));
    r.unmount();
  });
});

describe("/create (0.18.5)", () => {
  const WF = "id: docs-check\nname: docs check\nkeel_rules: false\nversion: 1\nsteps:\n  - { id: t, kind: code, name: tests, action: \"run: npm test\" }\n  - { id: look, kind: gate, name: look }";

  it("an agent from four questions, saved after one yes", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/create agent");
    expect(t.frame()).toContain("Its name (for example: doc writer)?");
    await t.run("doc writer");
    await t.run("Writes the user docs.");
    expect(t.frame()).toContain("What may it do?");
    await t.type("\x1b[B");
    await t.enter();                                                    // read and change files
    await t.run("Read the spec and write docs/<feature>.md.");
    expect(t.frame()).toContain('save "doc writer"?');
    await t.enter();
    expect(t.stub.calls.find((c) => c.path === "/api/projects/demo/agents")!.body).toEqual({ name: "doc writer", about: "Writes the user docs.",
      prompt: "Read the spec and write docs/<feature>.md.", tools: ["Read", "Grep", "Glob", "Edit", "Write"], phases: ["any"] });
    expect(t.frame()).toContain("✓ saved the agent doc-writer");
    t.r.unmount();
  });

  it("KeelBot writes a workflow: keel's check shows what it is, one yes saves it; one with errors is never offered", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/create workflow run the tests and let me look");
    const sent = t.stub.calls.find((c) => c.path.endsWith("/s1/turn"))!.body as { text: string };
    expect(sent.text).toContain("Write a new keel workflow for this project: run the tests and let me look");
    expect(sent.text).toContain("keel-workflow block");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer("Here it is.\n\n```keel-workflow\n" + WF + "\n```");
    finished(t.core);
    await waitFor(() => t.probe.pick);
    await tick(80);                                                     // the picker's keys are live after its render
    expect(t.frame()).toContain("docs check: 2 steps, 1 gates, runs npm test, changes no file");
    expect(t.frame()).toContain("KeelBot wrote a workflow: save docs check?");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/projects/demo/workflows/import"));
    expect(t.frame()).toContain("✓ saved the workflow docs-check (2 steps). Start it: /flow docs-check <idea>.");
    t.r.unmount();
  });

  it("a rule pack from a file: what it would have refused, then saved", async () => {
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keel-rule-"));
    writeFileSync(join(dir, "pack.yaml"), "schema: 1\nkind: rules\nname: no-sql-edits\nrules: []\n");
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run(`/create rule --file ${join(dir, "pack.yaml")}`);
    expect(t.frame()).toContain("would have refused 1 of 9");
    expect(t.frame()).toContain("edit: db/V1__init.sql (implementer)");
    await t.enter();
    expect(t.stub.calls.some((c) => c.path === "/api/projects/demo/rules/packs")).toBe(true);
    expect(t.frame()).toContain("✓ saved the rule pack no-sql-edits");
    t.r.unmount();
  });
});
