// keel 0.18.20 after a KeelBot answer in Edit, Fix or Side: only the files THIS answer changed (the answer's data says
// which, GET …/changes?turn=n gives their diffs), never the folder's other uncommitted files, and no block at all when
// the answer changed nothing.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);
const finished = {
  event: "helper.finished",
  data: JSON.stringify({
    type: "helper.finished",
    thread_id: "s1",
    project_id: "demo",
    at: "x",
    data: {},
  }),
};
// what keel init left uncommitted in the folder: the chat-wide list would have them, the answer's own list never
const INIT = [
  {
    path: ".codegraph/.gitignore",
    status: "added",
    added: 1,
    removed: 0,
    diff: "--- /dev/null\n+++ b/.codegraph/.gitignore\n@@ -0,0 +1 @@\n+*.db\n",
  },
  {
    path: "docs/RUNNING.md",
    status: "added",
    added: 1,
    removed: 0,
    diff: "--- /dev/null\n+++ b/docs/RUNNING.md\n@@ -0,0 +1 @@\n+# Running\n",
  },
];
const APP = {
  path: "src/app.ts",
  status: "modified",
  added: 1,
  removed: 1,
  diff: "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,2 +3,2 @@\n-const limit = 10;\n+const limit = 100;\n export { limit };\n",
};

async function editChat() {
  const stub = stubKeel();
  stub.state.changes = [...INIT];
  const core = new KeelCore({
    url: "http://keel.test",
    fetch: stub.fetch,
    noLive: true,
  });
  const probe: Probe = {
    started: false,
    busy: false,
    pick: false,
    ask: false,
    chatBusy: false,
    answers: 0,
  };
  const r = render(<App core={core} probe={probe} width={100} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const send = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
    r.stdin.write("\r");
    await tick(40);
    await waitFor(() => !probe.busy);
    await tick(30);
  };
  await waitFor(() => probe.started);
  await send("/mode edit");
  return { stub, core, probe, r, frame, send };
}

describe("after a KeelBot answer: only the files it changed", () => {
  it("shows no block when the answer changed no file, although the folder has uncommitted files", async () => {
    const t = await editChat();
    await t.send("what does this project do?");
    await waitFor(() => t.probe.chatBusy);
    const before = t.probe.answers;
    t.stub.answer("I changed no files.", { turn: 1, files: [] });
    t.core.onMessage(finished);
    await waitFor(() => t.probe.answers > before);
    await tick(80);
    const f = t.frame();
    expect(f).toContain("I changed no files.");
    expect(f).not.toContain("file(s) changed");
    expect(f).not.toContain("docs/RUNNING.md");
    expect(f).not.toContain(".codegraph/.gitignore");
    // nothing to ask for: the answer said it changed no file
    expect(
      t.stub.calls.some(
        (c) => c.path.endsWith("/changes") && c.query.includes("turn="),
      ),
    ).toBe(false);
    t.r.unmount();
  });

  it("lists the one file the answer changed, with its diff, and never the folder's other uncommitted files", async () => {
    const t = await editChat();
    t.stub.state.turnChanges = { 1: [APP] };
    t.stub.state.changes = [...INIT, APP];
    await t.send("raise the limit");
    await waitFor(() => t.probe.chatBusy);
    t.stub.answer("Raised the limit to 100.", {
      turn: 1,
      files: ["src/app.ts"],
    });
    t.core.onMessage(finished);
    await waitFor(() => t.frame().includes("1 file(s) changed"));
    const f = t.frame();
    expect(f).toContain("M src/app.ts  +1 -1");
    expect(f).toContain("+const limit = 100;");
    expect(f).not.toContain("docs/RUNNING.md");
    expect(f).not.toContain(".codegraph/.gitignore");
    expect(
      t.stub.calls.find(
        (c) => c.path.endsWith("/changes") && c.query.includes("turn="),
      )!.query,
    ).toBe("?turn=1");
    t.r.unmount();
  });

  it("shows no block for an answer from an engine that does not say which files it changed", async () => {
    const t = await editChat();
    await t.send("hello");
    await waitFor(() => t.probe.chatBusy);
    const before = t.probe.answers;
    t.stub.answer("Hi.");
    t.core.onMessage(finished);
    await waitFor(() => t.probe.answers > before);
    await tick(80);
    expect(t.frame()).not.toContain("file(s) changed");
    t.r.unmount();
  });
});
