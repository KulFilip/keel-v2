// keel TUI 0.18.6: the same project and KeelBot chat as the dashboard (the shared focus, api ui/UiFocus.kt): it opens
// the chat the dashboard has open, follows the dashboard to another project or chat, shows a question asked there and
// KeelBot's answer, and tells the dashboard what it opens itself.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);
const AT = "2026-10-16T10:00:00Z";

function setup(prep?: (s: ReturnType<typeof stubKeel>) => void) {
  const stub = stubKeel();
  prep?.(stub);
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, cwd: "/nowhere" });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={100} theme={none} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const event = (name: string, data: unknown) => core.onMessage({ event: name, data: JSON.stringify(data) });
  return { stub, core, probe, r, frame, event };
}

const withChat = (s: ReturnType<typeof stubKeel>) => {
  s.state.session = { id: "s1", project: "demo", root: "/work/demo", mode: "ask", title: "close all flows", model: { provider: "fake", mode: "api", model: "fake" },
    status: "idle", tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0, turns: 1, created_at: AT, updated_at: AT };
  s.state.messages.push({ n: 1, role: "user", text: "close all flows", data: {}, at: AT }, { n: 2, role: "helper", text: "Two flows wait.", data: {}, at: AT });
};

describe("the same project and chat as the dashboard", () => {
  it("starts on the dashboard's project and opens the chat it has open", async () => {
    const t = setup((s) => {
      withChat(s);
      s.state.focus = { project: "zeta", chats: { demo: "s1" }, by: "web", client: "tab-1" };
    });
    await waitFor(() => t.probe.started);
    expect(t.core.snapshot.project?.id).toBe("zeta");                 // not inside a project folder: the dashboard's
    await t.core.useProject("demo");
    await waitFor(() => t.frame().includes('KeelBot chat "close all flows"'));
    expect(t.frame()).toContain("Two flows wait.");
    expect(t.core.snapshot.chat.session?.id).toBe("s1");
    // and it told keel which project it is on now
    expect(t.stub.state.focus.project).toBe("demo");
    expect(t.stub.state.focus.client).toBe(t.core.client);
    t.r.unmount();
  });

  it("follows the dashboard to another project, and never its own change", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.event("ui.focus", { project: "alpha", chats: {}, by: "web", client: "tab-1" });
    await waitFor(() => t.frame().includes("following the dashboard: project alpha"));
    expect(t.core.snapshot.project?.id).toBe("alpha");
    t.event("ui.focus", { project: "zeta", chats: {}, by: "tui", client: t.core.client });
    await tick(60);
    expect(t.core.snapshot.project?.id).toBe("alpha");
    t.r.unmount();
  });

  it("a question asked in the dashboard's chat: the words, then KeelBot's answer, here too", async () => {
    const t = setup(withChat);
    t.stub.state.focus = { project: "demo", chats: { demo: "s1" }, by: "web", client: "tab-1" };
    await waitFor(() => t.probe.started);
    await waitFor(() => t.core.snapshot.chat.session?.id === "s1");
    t.stub.state.messages.push({ n: 3, role: "user", text: "and the logger flow?", data: {}, at: AT });
    t.event("helper.started", { type: "helper.started", thread_id: "s1", project_id: "demo", at: AT, call_id: "call-dash", data: {} });
    await waitFor(() => t.frame().includes("and the logger flow?"));
    expect(t.frame()).toContain("asked in the dashboard");
    expect(t.core.snapshot.chat.busy).toBe(true);
    t.stub.answer("The logger flow is done.");
    t.event("helper.finished", { type: "helper.finished", thread_id: "s1", project_id: "demo", at: AT, data: {} });
    await waitFor(() => t.frame().includes("The logger flow is done."));
    t.r.unmount();
  });

  it("its own new chat becomes the dashboard's chat too", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.r.stdin.write("hi");
    await tick(40);
    t.r.stdin.write("\r");
    await waitFor(() => t.stub.state.focus.chats.demo === "s1");
    expect(t.stub.state.focus.by).toBe("tui");
    t.r.unmount();
  });
});
