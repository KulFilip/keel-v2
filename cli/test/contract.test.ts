// The api contract keel TUI relies on, over real http (a stub keel server, Node's own fetch and SSE): the paths,
// methods and bodies of its calls, the via headers on every one, and the live stream it follows.
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { KeelCore } from "../src/core/keel";
import { run } from "../src/core/commands";
import { stubServer, waitFor } from "./stub";

let srv: Awaited<ReturnType<typeof stubServer>>;
let core: KeelCore;

beforeEach(async () => {
  srv = await stubServer();
  core = new KeelCore({ url: srv.url, cwd: "/work/demo/src" });
});
afterEach(async () => {
  core.stop();
  await srv.close();
});

describe("api contract", () => {
  it("loads keel, picks the project the folder is in, and follows its events", async () => {
    const s = await core.start();
    expect(s.health?.version).toBe("0.17.3");
    expect(s.project?.id).toBe("demo");
    expect(s.visited).toEqual(["preflight", "spec"]);
    await waitFor(() => srv.stub.calls.some((c) => c.path === "/api/events"));
    const ev = srv.stub.calls.find((c) => c.path === "/api/events")!;
    expect(ev.query).toBe("?project=demo&notify=all");
    expect(ev.headers["accept"]).toBe("text/event-stream");
    expect(ev.headers["x-keel-via"]).toBe("tui");
    await waitFor(() => core.snapshot.live === "live");
    const notes: string[] = [];
    core.on("notice", (t) => notes.push(t));
    srv.sse("gate.waiting", { type: "gate.waiting", thread_id: "t1", project_id: "demo", at: "x", step: "spec_gate", data: { title: "spec approval" } });
    srv.sse("engine", { type: "mcp.call", thread_id: "t1", project_id: "demo", at: "x", data: { client: "Claude Code", tool: "keel_status", ok: true } });
    srv.sse("engine", { type: "tui.call", thread_id: "t1", project_id: "demo", at: "x", data: { tool: "/approve" } });
    srv.sse("gate.waiting", { type: "gate.waiting", thread_id: "t9", project_id: "other", at: "x", data: { title: "not ours" } });
    await waitFor(() => notes.length >= 2);
    await new Promise((r) => setTimeout(r, 100));
    expect(notes).toEqual(["waiting for you: spec approval · /approve or /reject <why> (/next says more)", "via MCP · Claude Code: keel_status"]);
  });

  it("every call says it comes from keel TUI and which command sent it", async () => {
    await core.start();
    const ctx = { core, width: 100 };
    await run(ctx, "/status");
    await run(ctx, "/flow feature Add a health endpoint");
    await run(ctx, "/reject");                                    // refused before any call: no reason
    const before = srv.stub.calls.length;
    srv.stub.state.thread = { ...srv.stub.state.thread, thread_id: "t1", status: "waiting", current: "spec_gate",
      waiting: { step: "spec_gate", kind: "gate", title: "spec approval", options: ["approve", "reject"], id: "q1" } };
    await core.refresh();
    await run(ctx, "/reject the error case is missing");
    const calls = srv.stub.calls;
    expect(calls.every((c) => c.headers["x-keel-via"] === "tui" && c.headers["x-keel-client"] === "keel TUI 0.17.3")).toBe(true);
    const start = calls.find((c) => c.method === "POST" && c.path === "/api/projects/demo/flows")!;
    expect(start.headers["x-keel-tool"]).toBe("/flow");
    expect(start.headers["content-type"]).toBe("application/json");
    expect(start.body).toEqual({ workflow_id: "feature", title: "Add a health endpoint", request: "Add a health endpoint", options: { started_via: "tui" } });
    const act = calls.slice(before).find((c) => c.path === "/api/inbox/t1/act")!;
    expect(act.method).toBe("POST");
    expect(act.headers["x-keel-tool"]).toBe("/reject");
    expect(act.body).toEqual({ decision: "reject", why: "the error case is missing", id: "q1" });
    expect(calls.filter((c) => c.method !== "GET").map((c) => `${c.method} ${c.path}`)).toEqual(["POST /api/projects/demo/flows", "POST /api/inbox/t1/act"]);
  });

  it("a KeelBot turn: a session, the turn, the streamed steps and the stored answer", async () => {
    await core.start();
    const answers: string[] = [];
    core.on("answer", (a) => answers.push(a.text));
    await waitFor(() => core.snapshot.live === "live");
    await core.send("where does it start?");
    expect(core.snapshot.chat.busy).toBe(true);
    const create = srv.stub.calls.find((c) => c.method === "POST" && c.path === "/api/projects/demo/helper/sessions")!;
    expect(create.body).toEqual({ mode: "ask", title: "where does it start?" });
    srv.sse("helper.step", { type: "helper.step", thread_id: "s1", project_id: "demo", at: "x", call_id: "call-9", data: { n: 1, kind: "text", text: "Looking…" } });
    await waitFor(() => core.snapshot.chat.steps.length === 1);
    srv.stub.answer("In src/main.ts:3.");
    srv.sse("helper.finished", { type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: { status: "done" } });
    await waitFor(() => answers.length === 1);
    expect(answers).toEqual(["In src/main.ts:3."]);
    expect(core.snapshot.chat.busy).toBe(false);
  });

  it("draws through POST /api/diagrams/ascii with the terminal's width", async () => {
    await core.start();
    await run({ core, width: 120 }, "/diagram flow");
    const d = srv.stub.calls.find((c) => c.path === "/api/diagrams/ascii")!;
    expect(d.method).toBe("POST");
    expect(d.body).toMatchObject({ kind: "flow", width: 118, max_lines: 400, data: { visited: ["preflight", "spec"] } });
    expect((d.body as { data: { thread: { thread_id: string } } }).data.thread.thread_id).toBe("t1");
  });
});
