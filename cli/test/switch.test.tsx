// keel 0.18.14 /project: one pick switches (the person picked twice before), and a switch prints a short project card,
// not keel's whole start box again.
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
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo/src" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={120} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  return { stub, core, probe, r, frame };
}

describe("/project", () => {
  it("one pick switches the project", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.r.stdin.write("/project");
    await tick(60);
    t.r.stdin.write("\r");
    await waitFor(() => t.probe.pick);
    await tick(80);
    t.r.stdin.write("\x1b[B");                     // demo (now) → alpha
    await tick(60);
    t.r.stdin.write("\r");
    await waitFor(() => t.core.snapshot.project?.id === "alpha", 3000);
    expect(t.probe.pick).toBe(false);
    t.r.unmount();
  });

  it("a switch prints a short card, not the start box again", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.r.stdin.write("/project alpha");
    await tick(60);
    t.r.stdin.write("\r");
    await waitFor(() => t.frame().includes("now on project"), 3000);
    await tick(80);
    expect(t.frame().split("keel TUI").length - 1).toBe(1);   // the start box once: at the start
    expect(t.frame()).toMatch(/waiting {2}/);
    t.r.unmount();
  });

  it("a focus that still names the old project does not pull the window back", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    expect(t.core.snapshot.project?.id).toBe("demo");
    expect(await t.core.useProject("alpha")).toBe(true);
    // the dashboard shared a chat before keel had this pick: its focus still says demo
    t.core.onMessage({ event: "ui.focus", data: JSON.stringify({ project: "demo", chats: {}, by: "web", client: "web-1" }) });
    await tick(100);
    expect(t.core.snapshot.project?.id).toBe("alpha");
    t.r.unmount();
  });
});
