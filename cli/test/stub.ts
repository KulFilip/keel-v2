// A stub keel for keel TUI's tests: the api routes the TUI calls, with one project ("demo") whose feature flow waits
// at its spec gate, an inbox, a running agent, KeelBot and the diagrams route. As a fetch (UI tests) or an http server
// (the contract test); every call is recorded with its method, path, body and headers.
import { createServer, type Server } from "node:http";

export type Call = { method: string; path: string; query: string; body: unknown; headers: Record<string, string> };

const AT = "2026-10-16T10:00:00Z";

export function stubKeel() {
  const calls: Call[] = [];
  const workflow = {
    id: "feature", name: "feature (keel)", keel_rules: true, version: 1, yaml: "", source: "keel",
    steps: [
      { id: "preflight", kind: "code", name: "preflight", phase: "preflight", action: "preflight" },
      { id: "spec", kind: "agent", name: "spec", phase: "spec", agent: "explorer" },
      { id: "spec_gate", kind: "gate", name: "spec approval", phase: "spec" },
      { id: "red", kind: "agent", name: "red", phase: "red", agent: "test-author", per_ac: true },
      { id: "green", kind: "agent", name: "green", phase: "green", agent: "implementer", per_ac: true },
      { id: "ac_gate", kind: "gate", name: "criterion review", phase: "gate", per_ac: true },
    ],
  };
  const waiting = { step: "spec_gate", kind: "gate", title: "spec approval", detail: "Read the spec.", options: ["approve", "reject"], id: "q1",
    labels: { approve: "Approve the spec" } };
  const state = {
    thread: {
      thread_id: "t1", project_id: "demo", workflow_id: "feature", title: "Add a health endpoint", status: "waiting", current: "spec_gate",
      phase: "spec", ac: null, acs: [{ id: "AC-1", layer: "API", title: "GET /health", status: "todo" }, { id: "AC-2", layer: "WEB", title: "shows it", status: "todo" }],
      waiting, usage: { tokens_in: 12000, tokens_out: 3400, cost_usd: 0.42, premium_requests: 0, cap_tokens: 500000 }, checkpoints: 2, updated_at: AT,
    } as Record<string, unknown>,
    session: null as null | Record<string, unknown>,
    changes: [] as { path: string; status: string; added: number; removed: number; diff: string }[],
    plugins: { plugins: [] as unknown[], problems: [] as unknown[] },
    messages: [] as Record<string, unknown>[],
    // 0.18.6 skills: the agents each is on, and the reviewer's own skill list (an override wins over the skill's list)
    skillAgents: { debugging: ["reproducer"], "changelog-entries": [] } as Record<string, string[]>,
    reviewerSkills: ["review"],
    installed: null as null | { version: string; agents: string[] },
  };
  const project = { id: "demo", name: "demo", root: "/work/demo", branch: "keel/health", flow: "feature", phase: "spec", acs: [0, 2], waiting: 1, running: 1 };
  const job = { id: "j1", project_id: "demo", thread_id: "t1", agent: "explorer", provider: "fake", model: "fake", step: "spec", phase: "spec", ac: null,
    status: "running", started_at: AT, ended_at: null, tokens_in: 900, tokens_out: 100, cost_usd: 0, premium_requests: 0, steps_count: 3, mcp_calls: 0 };
  const inboxItem = { project_id: "demo", project_name: "demo", thread_id: "t1", flow: "Add a health endpoint", workflow_id: "feature", step: "spec_gate",
    kind: "gate", title: "spec approval", detail: "Read the spec.", more: false, options: ["approve", "reject"], id: "q1" };

  const route = (method: string, path: string, query: URLSearchParams, body: any): [number, unknown] => {
    const key = `${method} ${path}`;
    switch (key) {
      case "GET /api/health": return [200, { ok: true, engine: true, version: "0.17.3", fake: true, native: false }];
      case "GET /api/projects": return [200, [project, ...["alpha", "zeta"].map((id) => ({ ...project, id, name: id, root: `/work/${id}`, branch: "main",
        flow: null, phase: null, waiting: 0, running: 0 }))]];
      case "GET /api/projects/demo/flow": return [200, { thread: state.thread, workflow }];
      case "GET /api/threads/t1/history": return [200, [{ id: "c1", n: 1, step: "preflight", at: AT, note: "" }, { id: "c2", n: 2, step: "spec", at: AT, note: "" }]];
      case "GET /api/inbox": return [200, { items: state.thread.status === "waiting" ? [inboxItem] : [], count: 1, kinds: ["gate"], projects: [] }];
      case "GET /api/jobs": return [200, query.get("status") === "running" ? [job] : [job]];
      case "GET /api/jobs/j1/steps": return [200, { steps: [{ n: 3, at: AT, kind: "tool", tool: "read_file", text: "src/app.ts" }], running: true }];
      case "GET /api/projects/demo/workflows": return [200, [workflow]];
      case "GET /api/projects/demo/runs": return [200, [{ thread_id: "t1", title: "Add a health endpoint", workflow_id: "feature", status: "waiting", phase: "spec",
        current: "spec_gate", waiting: "spec approval", acs_done: 0, acs_total: 2, tokens: 15400, where: "folder", branch: "keel/health", error: null,
        created_at: AT, updated_at: AT, cost_usd: 0.42, latest: true }]];
      case "GET /api/projects/demo/budget/now": return [200, { today: { tokens: 15400, cost_usd: 0.42 }, month: { tokens: 99000, cost_usd: 3.1 }, flows: [], caps: [] }];
      case "POST /api/diagrams/ascii": return [200, { kind: body.kind, text: `DIAGRAM ${body.kind} ${body.data?.workflow?.id ?? ""} w=${body.width}\n`, lines: 1 }];
      case "POST /api/projects/demo/flows":
        state.thread = { ...state.thread, thread_id: "t2", title: body.title, status: "running", current: "preflight", phase: "preflight", waiting: undefined };
        return [200, state.thread];
      case "POST /api/inbox/t1/act":
        if (body.decision === "reject" && !body.why) return [400, { error: "why is missing" }];
        state.thread = { ...state.thread, status: "running", current: "red", phase: "red", waiting: undefined };
        return [200, state.thread];
      case "GET /api/projects/demo/helper/commands": return [200, [{ name: "gate", description: "explain the gate", plugin: "keelbot", source: "keel" }]];
      case "POST /api/projects/demo/helper/sessions":
        state.session = { id: "s1", project: "demo", root: "/work/demo", mode: body.mode ?? "ask", title: body.title ?? "", model: body.model ?? { provider: "fake", mode: "api", model: "fake" },
          status: "idle", tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0, turns: 0, created_at: AT, updated_at: AT };
        return [200, state.session];
      case "POST /api/projects/demo/helper/sessions/s1/turn":
        state.messages.push({ n: state.messages.length + 1, role: "user", text: body.text, data: {}, at: AT });
        return [200, { session: "s1", call_id: "call-9", n: state.messages.length }];
      case "GET /api/projects/demo/helper/sessions/s1": return [200, { ...state.session, messages: state.messages, busy: false }];
      case "GET /api/projects/demo/helper/sessions": return [200, state.session ? [state.session] : []];
      // 0.18.5 a new workflow, rule pack or agent
      case "POST /api/projects/demo/workflows/check": {
        const bad = String(body.yaml).includes("kind: oops");
        return [200, { name: "docs check", steps: 2, gates: 1, agents: [], commands: ["npm test"], edits_files: false, valid: !bad,
          errors: bad ? ["steps[1].kind: one of agent, code, gate, branch"] : [], warnings: [], lines: bad ? [{ line: 7, message: "steps[1].kind: one of agent, code, gate, branch" }] : [] }];
      }
      case "POST /api/projects/demo/workflows/import": return [200, { workflow: { id: "docs-check", steps: [{}, {}] }, review: {} }];
      case "POST /api/projects/demo/rules/check": return [200, { ok: true, errors: [], dry_run: { checked: 9, blocked: [{ kind: "edit", target: "db/V1__init.sql", agent: "implementer" }] } }];
      case "POST /api/projects/demo/rules/packs": return [200, { pack: { id: "no-sql-edits" } }];
      case "POST /api/projects/demo/agents": return [200, { id: "doc-writer", tools: body.tools }];
      // 0.18.6 skills
      case "GET /api/projects/demo/skills": return [200, [
        { id: "debugging", kind: "debugging", source: "keel", stack: "any", version: "v2", tokens: 2300, agents: state.skillAgents.debugging, when: "bug-repro", enabled: true },
        { id: "mine", kind: "knowledge", source: "yours", stack: "any", version: "v1", tokens: 40, agents: [], when: "on demand", enabled: false }]];
      case "GET /api/projects/demo/agents": return [200, [
        { id: "reproducer", label: "reproducer", overridden: [], skills: [], phases: ["bug-repro"] },
        { id: "investigator", label: "investigator", overridden: [], skills: [], phases: ["bug-investigate"] },
        { id: "reviewer", label: "reviewer", overridden: ["skills"], skills: state.reviewerSkills, phases: ["ship"] }]];
      case "PUT /api/projects/demo/agents/reviewer": state.reviewerSkills = body.skills; return [200, { id: "reviewer" }];
      case "POST /api/projects/demo/skills/import": return [200, { id: "changelog-entries", tokens: 30, agents: [] }];
      case "GET /api/marketplace/skills": return [200, { catalog_error: null,
        skills: [{ name: "flaky-tests", title: "Flaky tests", publisher: "keel", publisher_title: "keel", version: "1.0.0", summary: "Find why a test fails sometimes.",
          review: { tokens: 1200, sections: ["Steps"], description: "Flaky tests." }, installed: state.installed && { ...state.installed, sid: "flaky-tests" }, update: null }],
        builtin: [{ name: "debugging", summary: "Find the cause.", source: "keel", tokens: 2300, agents: state.skillAgents.debugging }] }];
      case "GET /api/marketplace/skills/flaky-tests": return [200, { name: "flaky-tests", title: "Flaky tests", publisher: "keel", publisher_title: "keel",
        version: "1.0.0", summary: "Find why a test fails sometimes.", review: { tokens: 1200, sections: ["Steps"], description: "Flaky tests." },
        installed: null, update: null, builtin: false, text: "---\nname: flaky-tests\n---\nx", fetch_error: null, refused: null }];
      case "GET /api/marketplace/skills/debugging": return [200, { name: "debugging", builtin: true, installed: null, update: null }];
      case "POST /api/projects/demo/skills/market/install":
        state.installed = { version: "1.0.0", agents: body.agents ?? [] };
        return [200, { skill: { id: body.name, agents: body.agents ?? [], tokens: 1200 }, market: { version: "1.0.0", catalog: "keel" } }];
      case "POST /api/threads/t1/mode": state.thread = { ...state.thread, run_mode: body.mode }; return [200, state.thread];
      case "POST /api/threads/t1/stop": state.thread = { ...state.thread, status: "stopped", waiting: undefined }; return [200, state.thread];
      // round 3: @mentions, Fix mode's changes, Keep and Undo, questions, plugins
      case "GET /api/projects/demo/repo/files": return [200, { files: ["src/app.ts", "src/score.ts", "README.md", "web/src/App.tsx"], truncated: false }];
      case "GET /api/projects/demo/graph/search": return [200, { available: true, results: query.get("q") === "Sco"
        ? [{ id: "class:ScoreService", name: "ScoreService", kind: "class", file: "src/score.ts", line: 3, unit: "score", group: "" }] : [] }];
      case "GET /api/projects/demo/helper/sessions/s1/changes": return [200, state.changes];
      case "POST /api/projects/demo/helper/sessions/s1/undo":
        state.changes = body?.path ? state.changes.filter((c) => c.path !== body.path) : [];
        return [200, state.changes];
      case "POST /api/projects/demo/helper/sessions/s1/done": {
        const files = (body?.paths as string[] | undefined) ?? state.changes.map((c) => c.path);
        state.changes = state.changes.filter((c) => !files.includes(c.path));
        return [200, { ok: true, sha: "abc1234def", message: "feat(AC-1): the helper", files, checks: "pytest -q" }];
      }
      case "POST /api/approvals/q9/decide": return [200, { id: "q9", decision: body.decision }];
      case "GET /api/tui/plugins": return [200, state.plugins];
      case "GET /api/projects/demo/git/status": return [200, { branch: "keel/health", base: "main", ahead: 2, behind: 0,
        changes: [{ path: "src/app.ts", status: "M" }, { path: "notes.md", status: "??" }] }];
      case "GET /api/projects/demo/git/log": return [200, [{ sha: "abc1234", author: "Ada", date: "2026-10-16", subject: "feat: health" }]];
      case "GET /api/projects/demo/git/diff": return [200, { diff: `--- a/src/app.ts\n+++ b/src/app.ts\n@@ -1,2 +1,2 @@\n-const a = 1;\n+const a = 2;\n keep();\n${query.get("path") ? "" : ""}` }];
      case "POST /api/projects/demo/git/push": return [200, { pushed: true }];
      default:
        if (method === "GET" && path.startsWith("/api/skills/")) {
          const sid = path.slice("/api/skills/".length);
          return [200, { id: sid, kind: "debugging", stack: "any", source: "keel", version: "v2", tokens: 2300, agents: state.skillAgents[sid] ?? [],
            when: "bug-repro", enabled: true, body: "# Debugging\n\nFind the **cause** first.", refs: [{ path: "references/bisect.md", tokens: 900 }] }];
        }
        if (method === "PUT" && path.startsWith("/api/projects/demo/skills/")) {
          const sid = path.slice("/api/projects/demo/skills/".length);
          state.skillAgents[sid] = body.agents;
          return [200, { id: sid, agents: body.agents }];
        }
        return [404, { error: `stub: no ${key}` }];
    }
  };

  /** KeelBot's answer arrives (the stub's engine stored it). */
  const answer = (text: string) => state.messages.push({ n: state.messages.length + 1, role: "helper", text, call_id: "call-9",
    data: { provider: "fake", model: "fake", tokens_in: 1200, tokens_out: 300 }, at: AT });

  const handle = (method: string, url: string, body: unknown, headers: Record<string, string>) => {
    const u = new URL(url, "http://stub");
    calls.push({ method, path: u.pathname, query: u.search, body, headers });
    return route(method, u.pathname, u.searchParams, body);
  };

  const fetch: typeof globalThis.fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const h = Object.fromEntries(Object.entries((init?.headers ?? {}) as Record<string, string>).map(([k, v]) => [k.toLowerCase(), v]));
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    const [status, data] = handle(init?.method ?? "GET", url, body, h);
    return new Response(JSON.stringify(data), { status, headers: { "content-type": "application/json" } });
  };

  return { calls, state, fetch, handle, answer, workflow };
}

/** The same stub as an http server (the contract test): SSE on /api/events sends what `sse` is given. */
export async function stubServer(): Promise<{ url: string; stub: ReturnType<typeof stubKeel>; sse: (event: string, data: unknown) => void; close: () => Promise<void> }> {
  const stub = stubKeel();
  const streams: import("node:http").ServerResponse[] = [];
  const server: Server = createServer((req, res) => {
    let raw = "";
    req.on("data", (c) => (raw += c));
    req.on("end", () => {
      const headers = Object.fromEntries(Object.entries(req.headers).map(([k, v]) => [k, String(v)]));
      if (req.url?.startsWith("/api/events")) {
        stub.calls.push({ method: "GET", path: "/api/events", query: req.url.slice("/api/events".length), body: undefined, headers });
        res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache" });
        res.write(":connected\n\n");
        streams.push(res);
        return;
      }
      const [status, data] = stub.handle(req.method ?? "GET", req.url ?? "/", raw ? JSON.parse(raw) : undefined, headers);
      res.writeHead(status, { "content-type": "application/json" });
      res.end(JSON.stringify(data));
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as { port: number }).port;
  return {
    url: `http://127.0.0.1:${port}`, stub,
    sse: (event, data) => streams.forEach((s) => s.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`)),
    close: () => new Promise((r) => { streams.forEach((s) => s.end()); server.closeAllConnections?.(); server.close(() => r()); }),
  };
}

export const tick = (ms = 20) => new Promise((r) => setTimeout(r, ms));

export async function waitFor(cond: () => boolean, ms = 4000): Promise<void> {
  const end = Date.now() + ms;
  while (!cond()) {
    if (Date.now() > end) throw new Error("waitFor timed out");
    await tick(20);
  }
}
