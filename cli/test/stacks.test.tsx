// keel TUI's stacks (0.18.9): /stacks (the list and the marketplace's), /stack <name> with its YAML, /stack remove (a
// yes first; keel's own say why not), /stack off and on, /stack install from the marketplace (every command first, one
// yes), /create stack as keel's guided questions or written by KeelBot (keel checks it, one yes saves it), and
// KeelBot's keel-stack button.

import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { splitButtons } from "../src/core/buttons";
import { TABLE } from "../src/core/commands";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo/src" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={140} theme={none} />);
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

describe("keel TUI's stacks (0.18.9)", () => {
  it("the command table has /stacks and /stack, and /create says stack", () => {
    const names = TABLE.commands.map((c) => c.name);
    expect(names).toEqual(expect.arrayContaining(["stacks", "stack"]));
    expect(TABLE.commands.find((c) => c.name === "stack")!.writes).toBe(true);
    expect(TABLE.commands.find((c) => c.name === "create")!.args).toContain("stack");
  });

  it("/stacks lists them; /stack <name> shows one with its YAML", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/stacks");
    expect(t.frame()).toContain("2 stacks for demo, 2 used");
    expect(t.frame()).toMatch(/go\s+api · keel · used/);
    expect(t.frame()).toMatch(/zig-api\s+api · project · used/);
    await t.run("/stack zig-api");
    expect(t.frame()).toContain("it can be removed: /stack remove zig-api");
    expect(t.frame()).toContain("lane: api");
    t.r.unmount();
  });

  it("/stack remove asks first; keel's own cannot be removed and turns off instead", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/stack remove go");
    expect(t.frame()).toContain("go cannot be removed: It ships with keel");
    expect(t.frame()).toContain("Turn it off for this project: /stack off go");
    expect(t.probe.pick).toBe(false);
    await t.run("/stack off go");
    expect(t.stub.calls.find((c) => c.path === "/api/projects/demo/stacks/go/off")!.body).toEqual({ off: true });
    expect(t.frame()).toContain("✓ go is turned off for demo; turned off there: go.");
    await t.run("/stack remove zig-api");
    expect(t.frame()).toContain("Remove the stack zig-api from demo?");
    expect(t.frame()).toContain("keel deletes .keel/stacks/zig-api.yml");
    expect(t.stub.calls.some((c) => c.method === "DELETE")).toBe(false);
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.method === "DELETE" && c.path === "/api/projects/demo/stacks/zig-api"));
    expect(t.frame()).toContain("✓ removed zig-api (.keel/stacks/zig-api.yml).");
    t.r.unmount();
  });

  it("/stacks market and /stack install: every command first, one yes installs it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/stacks market zig");
    expect(t.stub.calls.find((c) => c.path === "/api/marketplace/stacks")!.query).toBe("?q=zig&project=demo");
    expect(t.frame()).toContain("zig  Zig · api · keel · version 1.1.0");
    expect(t.frame()).toContain("keel's own (keel) · api · used here");
    await t.run("/stack install zig");
    expect(t.frame()).toContain("Install zig 1.1.0?");
    expect(t.frame()).toContain("api_test_module: zig build test");
    expect(t.frame()).toContain("tool zig-fmt (on edit)");
    await t.enter();
    expect(t.stub.calls.find((c) => c.path === "/api/projects/demo/stacks/market/install")!.body).toEqual({ name: "zig" });
    expect(t.frame()).toContain("✓ installed zig 1.1.0 from the catalog keel as .keel/stacks/zig.yml.");
    t.r.unmount();
  });

  it("/create stack with no words: keel's guided questions, its check, one yes saves it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/create stack");
    expect(t.frame()).toContain("keel read build.zig");
    expect(t.frame()).toContain("Which lane does the stack build and test?");
    await t.enter();
    await waitFor(() => t.probe.ask);
    expect(t.frame()).toContain("api_test_module: zig build test  (build.zig)");
    await t.run("zig-api2");
    await waitFor(() => t.probe.pick);
    const sent = t.stub.calls.find((c) => c.path === "/api/projects/demo/stacks/check")!.body as { form: Record<string, unknown> };
    expect(sent.form).toMatchObject({ name: "zig-api2", lane: "api", commands: { api_test_module: "zig build test" } });
    expect(t.frame()).toContain("warning: there is no api_test_ac");
    expect(t.frame()).toContain("Save the stack zig-api2 as .keel/stacks/zig-api2.yml?");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/projects/demo/stacks/save"));
    expect(t.frame()).toContain("✓ saved zig-api2 as .keel/stacks/zig-api2.yml");
    t.r.unmount();
  });

  it("/create stack <words>: KeelBot writes it, keel checks it, one yes saves it", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/create stack it builds with zig");
    const sent = t.stub.calls.find((c) => c.path.endsWith("/s1/turn"))!.body as { text: string };
    expect(sent.text).toContain("Write a new keel stack for this project: it builds with zig");
    expect(sent.text).toContain("keel-stack block");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer("Here.\n\n```keel-stack\nname: zig-api3\nlane: api\n```");
    finished(t.core);
    await waitFor(() => t.probe.pick);
    await tick(80);                                                     // the picker's keys are live after its render
    expect(t.frame()).toContain("KeelBot wrote a stack: save zig-api3?");
    expect(t.frame()).toContain("api · layers unit · 1 commands");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/projects/demo/stacks/save"));
    expect(t.frame()).toContain("✓ saved the stack zig-api3 as .keel/stacks/zig-api3.yml");
    t.r.unmount();
  });

  it("KeelBot's keel-stack block is a button; one keel refuses is never offered", async () => {
    expect(splitButtons("a\n```keel-stack\nname: x\nlane: api\n```").buttons).toEqual([{ kind: "stack", yaml: "name: x\nlane: api" }]);
    const t = setup();
    await waitFor(() => t.probe.started);
    const { mkdtempSync, writeFileSync } = await import("node:fs");
    const { join } = await import("node:path");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "keel-stack-"));
    writeFileSync(join(dir, "bad.yml"), "name: nolane\n");
    await t.run(`/create stack --file ${join(dir, "bad.yml")}`);
    expect(t.frame()).toContain("The stack cannot be saved yet");
    expect(t.frame()).toContain("its lane is None");
    expect(t.probe.pick).toBe(false);
    t.r.unmount();
  });
});
