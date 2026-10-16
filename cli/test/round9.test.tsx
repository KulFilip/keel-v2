// keel TUI 0.18.9: KeelBot's plugin buttons (git, CI, a query) as a yes / no, and a way out when something fails:
// stash and switch, KeelBot finds the fix, /fix.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { splitButtons, question } from "../src/core/buttons";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup() {
  const stub = stubKeel();
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/work/demo" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={140} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const key = async (s: string) => {
    r.stdin.write(s);
    await tick(60);
  };
  const run = async (s: string) => {
    await key(s);
    await key("\r");
    await waitFor(() => !probe.busy);
    await tick(40);
  };
  const finished = () => core.onMessage({ event: "helper.finished",
    data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });
  return { stub, core, probe, r, frame, key, run, finished };
}

describe("KeelBot's plugin buttons in keel TUI", () => {
  it("git, CI and query buttons are read, and each asks in words", () => {
    const b = splitButtons('```keel-git\n{"op": "switch", "branch": "main"}\n```\n```keel-ci\n{"op": "rerun", "run": 7}\n```\n'
      + '```keel-query\n{"sql": "SELECT count(*) FROM players"}\n```').buttons;
    expect(b.map((x) => x.kind)).toEqual(["git", "ci", "query"]);
    expect(b.map((x) => question(x, (t) => t))).toEqual(["KeelBot suggests: switch to main?", "KeelBot suggests: run the failed CI jobs of run #7 again?",
      "KeelBot suggests: run this on the local database: SELECT count(*) FROM players?"]);
  });

  it("a git switch the folder's changes block: stash and switch, in the terminal", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("switch to main");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer('Here:\n```keel-git\n{"op": "switch", "branch": "main"}\n```');
    t.finished();
    await waitFor(() => t.probe.pick);
    await tick(80);
    expect(t.frame()).toContain("KeelBot suggests: switch to main?");
    await t.key("\r");                                                  // Yes
    await waitFor(() => t.frame().includes("It did not work. Find a fix?"));
    expect(t.frame()).toContain("would be overwritten");
    expect(t.frame()).toContain("Stash my changes and switch");
    await tick(80);
    await t.key("\r");                                                  // stash and switch
    await waitFor(() => t.frame().includes("on main now. Your changes from keel/health are in git's stash"));
    expect(t.stub.calls.filter((c) => c.path === "/api/projects/demo/git/switch").map((c) => c.body)).toEqual([
      { branch: "main", create: false }, { branch: "main", create: false, stash: true }]);
    t.r.unmount();
  });

  it("or KeelBot finds the fix; and /fix hands the last error to it any time", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.run("/project nowhere");                                     // an error to fix
    await t.run("/fix");
    const sent = t.stub.calls.filter((c) => c.path.endsWith("/s1/turn")).at(-1)!.body as { text: string };
    expect(sent.text).toContain('This failed: the last thing keel TUI did.\nkeel said: No project "nowhere"');
    expect(sent.text).toContain("propose how to fix it, with the buttons that do it. Change nothing yourself.");
    t.r.unmount();
  });
});
