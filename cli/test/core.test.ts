// keel TUI's core without a UI: command parsing and autocomplete, the SSE parser, markdown, notices, the via headers.
import { describe, expect, it } from "vitest";
import { complete, COMMANDS, helpText, parse, run } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { fileLines, plain, renderMarkdown } from "../src/core/markdown";
import { notice } from "../src/core/notices";
import { SseParser } from "../src/core/sse";
import { normalizeUrl, setCommand, viaHeaders } from "../src/core/transport";
import * as fmt from "../src/core/format";
import { stubKeel } from "./stub";

const core = () => {
  const stub = stubKeel();
  return { stub, core: new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true }) };
};

describe("commands", () => {
  it("has every command the plan names", () => {
    const names = COMMANDS.map((c) => c.name);
    for (const n of ["help", "project", "flow", "flows", "resume", "stop", "status", "next", "inbox", "approve", "reject", "answer", "jobs", "live",
      "steps", "timeline", "workflows", "diagram", "rules", "plugins", "budget", "dashboard", "quit", "model", "chats", "panel"]) expect(names).toContain(n);
    expect(helpText()).toContain("/reject [n] <why>");
  });

  it("parses commands, chat text and escaped slashes", () => {
    expect(parse("  ")).toEqual({ kind: "empty" });
    expect(parse("why is the build red?")).toEqual({ kind: "chat", text: "why is the build red?" });
    expect(parse("//etc/hosts is a path")).toEqual({ kind: "chat", text: "/etc/hosts is a path" });
    const p = parse("/reject the spec misses the error case");
    expect(p.kind === "command" && p.name === "reject" && p.args).toBe("the spec misses the error case");
    const q = parse("/exit");
    expect(q.kind === "command" && q.command?.name).toBe("quit");
    const u = parse("/nope x");
    expect(u.kind === "command" && u.command).toBeNull();
  });

  it("completes names, KeelBot's own commands and arguments", async () => {
    const { core: c } = core();
    await c.start();
    const ctx = { core: c, width: 100 };
    expect(complete(ctx, "/fl").map((x) => x.value)).toEqual(["/flow ", "/flows"]);
    expect(complete(ctx, "/ga", [{ name: "gate", description: "explain the gate" }])).toEqual([{ value: "/gate ", label: "/gate", hint: "KeelBot · explain the gate" }]);
    expect(complete(ctx, "/diagram m").map((x) => x.value)).toEqual(["/diagram map-er", "/diagram map-system", "/diagram map-modules"]);
    expect(complete(ctx, "/panel a").map((x) => x.value)).toEqual(["/panel agents"]);
    expect(complete(ctx, "/project d").map((x) => x.value)).toEqual(["/project demo"]);
    expect(complete(ctx, "hello")).toEqual([]);
  });

  it("sends plain text and KeelBot's commands to KeelBot, refuses unknown ones", async () => {
    const { core: c } = core();
    const ctx = { core: c, width: 100 };
    expect((await run(ctx, "explain the spec")).chat).toBe("explain the spec");
    expect((await run(ctx, "/gate", [{ name: "gate" }])).chat).toBe("/gate");
    expect((await run(ctx, "/nope")).blocks[0]).toEqual({ kind: "error", text: "No command /nope. /help lists them." });
  });

  it("starts a flow from /flow <workflow> <idea>, recorded as started via keel TUI", async () => {
    const { core: c, stub } = core();
    await c.start();
    const r = await run({ core: c, width: 100 }, "/flow feature Add a /health endpoint");
    expect(r.blocks[0].kind).toBe("ok");
    const call = stub.calls.find((x) => x.method === "POST" && x.path === "/api/projects/demo/flows")!;
    expect(call.body).toMatchObject({ workflow_id: "feature", title: "Add a /health endpoint", request: "Add a /health endpoint", options: { started_via: "tui" } });
    expect(call.headers["x-keel-via"]).toBe("tui");
    expect(call.headers["x-keel-tool"]).toBe("/flow");
  });

  it("asks for the workflow, then the idea, when /flow has none", async () => {
    const { core: c } = core();
    await c.start();
    const ctx = { core: c, width: 100 };
    const r = await run(ctx, "/flow");
    expect(r.pick?.choices.map((x) => x.value)).toEqual(["feature"]);
    const r2 = await r.pick!.then("feature");
    expect(r2.ask?.prompt).toContain("What should the feature flow do?");
    const r3 = await r2.ask!.then("Add a logger");
    expect(r3.blocks[0].text).toContain('started feature "Add a logger"');
  });

  it("approves and rejects what waits; a rejection needs a reason", async () => {
    const { core: c, stub } = core();
    await c.start();
    const ctx = { core: c, width: 100 };
    expect((await run(ctx, "/reject")).blocks[0].text).toContain("Say why");
    const r = await run(ctx, "/approve");
    expect(r.blocks[0]).toMatchObject({ kind: "ok" });
    expect(r.blocks[0].text).toContain("approved spec approval");
    expect(stub.calls.find((x) => x.path === "/api/inbox/t1/act")?.body).toEqual({ decision: "approve", id: "q1" });
    expect((await run(ctx, "/approve")).blocks[0].text).toContain("Nothing waits");
  });

  it("draws workflows with keel's renderer", async () => {
    const { core: c, stub } = core();
    await c.start();
    const r = await run({ core: c, width: 90 }, "/workflows feature");
    expect(r.blocks[0]).toEqual({ kind: "diagram", text: "DIAGRAM workflow feature w=88" });
    expect(stub.calls.find((x) => x.path === "/api/diagrams/ascii")?.body).toMatchObject({ kind: "workflow", max_lines: 60 });
  });
});

describe("transport", () => {
  it("says who acts on every request", () => {
    setCommand("/approve");
    expect(viaHeaders()).toEqual({ "X-Keel-Via": "tui", "X-Keel-Client": "keel TUI 0.17.3", "X-Keel-Tool": "/approve" });
    setCommand("");
    expect(viaHeaders()["X-Keel-Tool"]).toBeUndefined();
    expect(normalizeUrl("localhost:8080/api/")).toBe("http://localhost:8080");
  });
});

describe("SSE parser", () => {
  it("reads named events in chunks of any size, skips comments", () => {
    const p = new SseParser();
    const text = ":connected\n\nevent: gate.waiting\ndata: {\"a\":1}\n\nevent: engine\r\ndata: line1\r\ndata: line2\r\n\r\n";
    const out = [];
    for (const ch of text) out.push(...p.push(ch));
    expect(out).toEqual([{ event: "gate.waiting", data: "{\"a\":1}" }, { event: "engine", data: "line1\nline2" }]);
  });
});

describe("markdown", () => {
  it("renders headings, lists, code and file:line references", () => {
    const md = "# Where it starts\n\nThe entry is `src/main.ts:12` and **App** in web/src/App.tsx:40.\n\n- one\n1. two\n```ts\nconst x = 1;\n```\n> note";
    expect(renderMarkdown(md, plain)).toBe("Where it starts\n\nThe entry is src/main.ts:12 and App in web/src/App.tsx:40.\n\n  • one\n  1. two\n  ts\n  │ const x = 1;\n  ┃ note");
    expect(fileLines(md)).toEqual([{ path: "src/main.ts", line: 12 }, { path: "web/src/App.tsx", line: 40 }]);
  });
});

describe("notices", () => {
  const ev = (type: string, data: Record<string, unknown> = {}, step?: string) => ({ type, thread_id: "t", project_id: "p", at: "x", step, data });
  it("turns keel's events into lines, and skips the noisy ones", () => {
    expect(notice(ev("gate.waiting", { title: "spec approval" }))).toBe("waiting for you: spec approval · /approve or /reject <why> (/next says more)");
    expect(notice(ev("thread.started", { workflow: "fix", title: "Crash", via: "mcp" }))).toBe('flow started via MCP: fix "Crash"');
    expect(notice(ev("agent.started", { agent: "explorer", provider: "fake", model: "fake" }, "spec"))).toBe("agent explorer started · spec · fake/fake");
    expect(notice(ev("agent.finished", { status: "done" }))).toBeNull();
    expect(notice(ev("step.started"))).toBeNull();
    expect(notice(ev("thread.done"))).toBe("flow done · /next");
  });
});

describe("format", () => {
  it("says what is next in TUI words", () => {
    const s = stubKeel();
    const view = { thread: s.state.thread as never, workflow: s.workflow as never };
    expect(fmt.next({ id: "demo", branch: "x" } as never, view)).toBe('waiting at spec_gate (spec approval): /approve ("Approve the spec") or /reject <why>.');
    expect(fmt.status({ id: "demo", branch: "keel/health" } as never, view)).toContain("criteria  0/2 done");
    expect(fmt.short(1234)).toBe("1.2k");
  });
});
