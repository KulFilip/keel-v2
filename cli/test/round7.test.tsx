// keel TUI 0.18.7: KeelBot's Edit and Side modes from /mode, /resume <n>, and each agent line names its flow.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={120} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const run = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
    r.stdin.write("\r");
    await tick(40);
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  return { stub, core, probe, r, frame, run };
}

describe("0.18.7", () => {
  it("/mode edit: KeelBot changes the project folder, no flow needed; the next chat is an Edit chat", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/mode");
    expect(t.frame().replace(/\s+/g, " ")).toContain("edit: it changes files and runs commands in the project folder");
    await t.run("/mode edit");
    expect(t.frame()).toContain("KeelBot: edit mode");
    await t.run("switch to main and fix the typo");
    expect((t.stub.calls.find((c) => c.method === "POST" && c.path === "/api/projects/demo/helper/sessions")!.body as { mode: string }).mode).toBe("edit");
    t.r.unmount();
  });

  it("Enter on a command typed whole runs it, even when a longer one starts the same (/mode, /model)", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/mode");
    // /mode ran (its list of the four modes), not /model's catalog pick (0.18.9 reads the catalog early anyway)
    expect(t.frame()).toContain("/mode ask | edit | fix | side");
    expect(t.probe.pick).toBe(false);
    t.r.unmount();
  });

  it("/mode side works in the terminal app too, and fix needs a waiting flow", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/mode side");
    expect(t.frame()).toContain("KeelBot: side mode: it works in its own copy of the project");
    t.r.unmount();
  });

  it("/resume <n> takes a flow from /flows by its number", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/resume 1");
    expect(t.frame()).toContain("The flow is waiting: nothing to resume.");
    await t.run("/resume 9");
    expect(t.frame()).toContain("No flow 9: /flows lists them, numbered.");
    t.r.unmount();
  });

  it("an agent line names the flow it works for", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await waitFor(() => t.frame().includes('explorer · '));
    await waitFor(() => /explorer · .*"Add a health endpoint" · spec/.test(t.frame()));
    t.r.unmount();
  });
});
