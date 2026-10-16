// The commands with keel's MCP server and REST api faked: which tool, which arguments, what is printed.
import assert from "node:assert/strict";
import { test } from "node:test";
import { diagramOverRest, helpText, runSpec, SPECS, specFor } from "../src/commands.ts";
import { readConfig } from "../src/config.ts";
import { Keel } from "../src/keel.ts";
import { FakeServer, fakeFetch, PROJECTS, recorder, text } from "./helpers.ts";

function setup(routes: Parameters<typeof fakeFetch>[0] = {}, cfg: Record<string, unknown> = {}, cwd = "/Users/me/elsewhere") {
  const server = new FakeServer();
  const calls: { name: string; args: Record<string, unknown> }[] = [];
  const reply = (name: string) => (args: Record<string, unknown>) => {
    calls.push({ name, args });
    return text(`${name} ok`);
  };
  for (const n of ["keel_status", "keel_next", "keel_inbox", "keel_live", "keel_flows", "keel_timeline", "keel_rules", "keel_budget",
    "keel_dashboard", "keel_plugins_installed", "keel_start_flow", "keel_approve_gate", "keel_answer", "keel_resume", "keel_stop_flow", "keel_workflows"]) {
    server.tools[n] = reply(n);
  }
  const http = fakeFetch({ "GET /api/projects": { json: PROJECTS }, "GET /api/inbox/count": { json: { count: 3 } }, ...routes });
  let started = 0;
  const keel = new Keel(readConfig({ url: "http://keel.test:8088", ...cfg }), {
    cwd,
    version: "0.1.0-beta.256",
    transport: (command) => {
      started++;
      assert.deepEqual(command, readConfig(cfg).mcp);
      return server.transport();
    },
    fetch: http.fetch,
    key: () => "test-web-key",            // never the real keel2 auth key in a test
  });
  return { server, calls, http, keel, started: () => started };
}

test("the keel TUI's command names are all here, each once (docs/plans/keel-tui.md)", () => {
  const names = SPECS.flatMap((s) => [s.name, ...(s.aliases ?? [])]);
  assert.equal(new Set(names).size, names.length);
  for (const n of ["status", "next", "inbox", "live", "jobs", "flows", "timeline", "steps", "workflows", "rules", "budget", "dashboard",
    "plugins", "flow", "approve", "reject", "answer", "resume", "stop", "diagram"]) {
    assert.ok(specFor(n), `/keel:${n}`);
  }
  assert.ok(names.every((n) => /^[a-z][a-z-]*$/.test(n)));
  assert.match(helpText(), /^keel in xal\./);
});

test("each command calls its MCP tool with the project of xal's folder and the words as arguments", async () => {
  const { calls, keel, started } = setup();
  const out = recorder();
  const run = (line: string) => {
    const [name, ...args] = line.split(" ");
    return runSpec(specFor(name!)!, args, keel, out);
  };
  assert.equal(await run("status"), true);
  await run("timeline failed 5");
  await run("timeline 7");
  await run("steps");
  await run("flow change Prices in euros");
  await run("approve looks right");
  await run("reject the test checks nothing");
  await run("answer reject not yet");
  await run("resume");
  await run("dashboard er");
  await run("workflows feature");
  assert.deepEqual(calls, [
    { name: "keel_status", args: { project: "shop" } },
    { name: "keel_timeline", args: { filter: "failed", limit: 5, project: "shop" } },
    { name: "keel_timeline", args: { limit: 7, project: "shop" } },
    { name: "keel_timeline", args: { filter: "steps", project: "shop" } },
    { name: "keel_start_flow", args: { type: "change", idea: "Prices in euros", project: "shop" } },
    { name: "keel_approve_gate", args: { decision: "approve", why: "looks right", project: "shop" } },
    { name: "keel_approve_gate", args: { decision: "reject", why: "the test checks nothing", project: "shop" } },
    { name: "keel_answer", args: { decision: "reject", why: "not yet", project: "shop" } },
    { name: "keel_resume", args: { decision: "approve", project: "shop" } },
    { name: "keel_dashboard", args: { view: "er", project: "shop" } },
    { name: "keel_workflows", args: { workflow: "feature", project: "shop" } },
  ]);
  assert.equal(out.lines[0], "keel_status ok");
  assert.equal(started(), 1, "one MCP server for the whole session");
  assert.deepEqual(out.labels.slice(0, 2), ["keel: status…", undefined], "the status bar says what runs");
});

test("usage errors and keel's errors print plainly and return false", async () => {
  const { keel, server } = setup();
  server.tools.keel_approve_gate = () => text("nothing waits on shop", true);
  const out = recorder();
  assert.equal(await runSpec(specFor("reject")!, [], keel, out), false);
  assert.equal(await runSpec(specFor("flow")!, ["change"], keel, out), false);
  assert.equal(await runSpec(specFor("approve")!, [], keel, out), false);
  assert.deepEqual(out.lines, [
    "keel: usage: /keel:reject <why…>   keel's agents read the why",
    "keel: usage: /keel:flow <workflow> <idea…>   for example: /keel:flow change Prices in euros",
    "nothing waits on shop",
  ].map((l, i) => (i === 2 ? `keel: ${l}` : l)));
});

test("a tool above the server's level says how to raise it", async () => {
  const { keel, server } = setup({}, { mcp: ["keel2", "mcp", "--write"] });
  delete server.tools.keel_workflows;
  const out = recorder();
  await runSpec(specFor("workflows")!, [], keel, out);
  assert.match(out.lines[0]!, /does not offer keel_workflows .* keel2 mcp --write; set pluginConfig.keel.mcp to \["keel2", "mcp", "--admin"\]/);
});

test("stop: keel's question is asked in xal; yes accepts, anything else declines", async () => {
  const { keel, server } = setup();
  server.tools.keel_stop_flow = async (_a, srv) => {
    const r = (await srv.ask("elicitation/create", { message: "keel: stop the flow?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } } })).result as Record<string, unknown>;
    return text(r.action === "accept" ? `stopped ${JSON.stringify(r.content)}` : `not done (${String(r.action)})`);
  };
  const yes = recorder(["yes"]);
  await runSpec(specFor("stop")!, [], keel, yes);
  assert.deepEqual(yes.asked, ["keel: stop the flow? (yes/no)"]);
  assert.equal(yes.lines[0], 'stopped {"confirm":true}');
  const no = recorder(["n"]);
  await runSpec(specFor("stop")!, [], keel, no);
  assert.equal(no.lines[0], "not done (decline)");
});

test("project: the folder's project; the configured one; keel down means keel chooses", async () => {
  const inApi = setup({}, {}, "/Users/me/src/api/web");
  await runSpec(specFor("next")!, [], inApi.keel, recorder());
  assert.equal(inApi.calls[0]!.args.project, "api");
  const conf = setup({}, { project: "api" });
  await runSpec(specFor("next")!, [], conf.keel, recorder());
  assert.equal(conf.calls[0]!.args.project, "api");
  const down = setup({ "GET /api/projects": { status: 503, json: { error: "down" } } });
  await runSpec(specFor("next")!, [], down.keel, recorder());
  assert.deepEqual(down.calls[0]!.args, {});
});

test("diagram flow over REST: the flow view's {workflow, thread} to /api/diagrams/ascii; an older keel says so", async () => {
  const view = { thread: { thread_id: "t1", current: "red" }, workflow: { id: "change", steps: [] } };
  const ok = setup({
    "GET /api/projects/shop/flow": { json: view },
    "POST /api/diagrams/ascii": (init) => ({ json: { kind: "flow", text: `drawn ${String(init?.body)}`, lines: 1 } }),
  });
  const out = recorder();
  await runSpec(specFor("diagram")!, ["flow"], ok.keel, out);
  const post = ok.http.calls.find((c) => c.url.endsWith("/api/diagrams/ascii"))!;
  assert.deepEqual(post.body, { kind: "flow", data: view, width: 100, max_lines: 60 });
  assert.equal(post.headers["X-Keel-Via"], "xal");
  assert.equal(post.headers["X-Keel-Client"], "xal 0.1.0-beta.256 (keel plugin)");
  assert.match(out.lines[0]!, /^drawn /);
  const old = setup({ "GET /api/projects/shop/flow": { json: view } });
  assert.match(await diagramOverRest("flow", undefined, old.keel), /no shared diagram renderer yet .* keel 0\.18/);
  const none = setup({ "GET /api/projects/shop/flow": { json: { thread: null, workflow: null } } });
  assert.match(await diagramOverRest("flow", undefined, none.keel), /no flow on this project yet/);
  await assert.rejects(diagramOverRest("map-er", undefined, none.keel), /keel_diagram tool \(keel 0\.18\)/);
});

test("diagram prefers keel's keel_diagram MCP tool when the server has it (keel 0.18)", async () => {
  const { keel, server } = setup();
  server.tools.keel_diagram = (args) => text(`picture ${JSON.stringify(args)}`);
  const out = recorder();
  await runSpec(specFor("diagram")!, ["workflow", "feature"], keel, out);
  assert.equal(out.lines[0], 'picture {"kind":"workflow","id":"feature","project":"shop"}');
});

test("ask: a KeelBot chat in ask mode, kept for the next question; --new starts another", async () => {
  let polls = 0;
  const { keel, http } = setup({
    "POST /api/projects/shop/helper/sessions": { json: { id: "h1", status: "idle" } },
    "POST /api/projects/shop/helper/sessions/h1/turn": { json: { session: "h1", call_id: "c", n: 1 } },
    "GET /api/projects/shop/helper/sessions/h1": () => ({
      json: ++polls < 2
        ? { id: "h1", status: "running", busy: true, messages: [] }
        : { id: "h1", status: "idle", busy: false, messages: [{ n: 1, role: "user", text: "q" }, { n: 2, role: "helper", text: "It adds tax." }] },
    }),
  });
  const out = recorder();
  await runSpec(specFor("ask")!, ["what", "does", "price", "do"], keel, out);
  assert.equal(out.lines.at(-1), "KeelBot:\nIt adds tax.");
  const created = http.calls.find((c) => c.method === "POST" && c.url.endsWith("/helper/sessions"))!;
  assert.deepEqual(created.body, { mode: "ask", title: "xal: what does price do" });
  assert.equal(keel.chat, "h1");
  await runSpec(specFor("ask")!, ["--new"], keel, out);
  assert.equal(keel.chat, undefined);
});

test("watch: keel's events become transcript lines until off", async () => {
  const sse = 'event: gate.waiting\ndata: {"type":"gate.waiting","thread_id":"t","project_id":"shop","step":"spec_gate","at":"x","data":{"title":"spec check"}}\n\n';
  const { keel, http } = setup({ "GET /api/events?project=shop": { body: sse, type: "text/event-stream" } });
  const out = recorder();
  await runSpec(specFor("watch")!, [], keel, out);
  await new Promise((r) => setTimeout(r, 50));
  assert.ok(keel.live);
  assert.ok(out.lines.includes("keel · gate · spec check waits for you (spec_gate)"), out.lines.join("\n"));
  assert.ok(out.lines.some((l) => l.startsWith("keel · live · following shop")));
  assert.equal(http.calls.find((c) => c.url.includes("/api/events"))!.headers.accept, "text/event-stream");
  await runSpec(specFor("watch")!, ["off"], keel, out);
  assert.equal(keel.live, false);
  assert.equal(out.lines.at(-1), "keel · notices off");
});

test("brief: read once from /api/projects and the inbox count; keel down gives no brief and no error", async () => {
  const { keel } = setup({}, {}, "/Users/me/src/api");
  await keel.loadBrief();
  assert.match(keel.brief, /project api \(api\), branch dev/);
  assert.match(keel.brief, /Inbox has 3 item/);
  const down = setup({ "GET /api/projects": { status: 500, json: {} } });
  await down.keel.loadBrief();
  assert.equal(down.keel.brief, "");
  const off = setup({}, { brief: false });
  await off.keel.loadBrief();
  assert.equal(off.keel.brief, "");
});

test("panel: status, flow rail, inbox and live agents in one print; a failing part says why", async () => {
  const { keel } = setup({ "GET /api/projects/shop/flow": { json: { thread: null, workflow: null } } });
  const out = recorder();
  await runSpec(specFor("panel")!, [], keel, out);
  const p = out.lines[0]!;
  for (const part of ["-- keel · status", "keel_status ok", "-- flow", "no flow on this project yet", "-- inbox", "keel_inbox ok", "-- live agents", "keel_live ok"]) {
    assert.ok(p.includes(part), part);
  }
  assert.ok([...p].every((ch) => ch.charCodeAt(0) < 128 || "·…".includes(ch)), "ASCII rules");
});

test("keel's MCP server does not start: one plain message with the command and what to check; the next command tries again", async () => {
  let tries = 0;
  const keel = new Keel(readConfig({ url: "http://keel.test:8088" }), {
    cwd: "/w",
    version: "0.1.0-beta.256",
    transport: () => {
      tries++;
      const server = new FakeServer();
      const t = server.transport();
      return { ...t, send: () => queueMicrotask(() => server.die("keel2 mcp exited (1): keel is not running.")) };
    },
    fetch: fakeFetch({}).fetch,
    key: () => undefined,
  });
  const out = recorder();
  assert.equal(await runSpec(specFor("status")!, [], keel, out), false);
  assert.match(out.lines[0]!, /^keel: could not start keel's MCP server \(keel2 mcp --admin\): keel2 mcp exited \(1\): keel is not running\.\n  Is keel running/);
  await runSpec(specFor("status")!, [], keel, out);
  assert.equal(tries, 2);
});

test("stop from a shell without a terminal: says why and declines", async () => {
  const { keel, server } = setup();
  server.tools.keel_stop_flow = async (_a, srv) => {
    const r = (await srv.ask("elicitation/create", { message: "keel: stop the flow?", requestedSchema: {} })).result as Record<string, unknown>;
    return text(`not done (${String(r.action)})`);
  };
  const out = recorder();
  out.ask = async () => {
    throw new Error("a terminal is required to enter a value");
  };
  await runSpec(specFor("stop")!, [], keel, out);
  assert.deepEqual(out.lines, ['keel: "keel: stop the flow?" needs your yes, and this shell cannot ask (no terminal). Run it in a terminal or in xal\'s TUI.', "not done (decline)"]);
});
