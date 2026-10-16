import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { test } from "node:test";
import { McpClient, McpError, processTransport } from "../src/mcp.ts";
import { FakeServer, text } from "./helpers.ts";

const info = { name: "xal test (keel plugin)", version: "0.0.1" };

test("start: initialize with the protocol, elicitation and who we are, then notifications/initialized", async () => {
  const s = new FakeServer();
  const c = new McpClient(s.transport(), info);
  await c.start();
  const init = s.received[0]!;
  assert.equal(init.method, "initialize");
  const params = init.params as Record<string, unknown>;
  assert.equal(params.protocolVersion, "2025-06-18");
  assert.deepEqual(params.capabilities, { elicitation: {} });
  assert.deepEqual(params.clientInfo, info);
  await new Promise((r) => setTimeout(r, 0));
  assert.equal(s.initialized, true);
  assert.equal(c.serverName, "keel");
});

test("tools: reads every page and caches the names", async () => {
  const s = new FakeServer();
  s.pageSize = 2;
  for (const n of ["keel_status", "keel_next", "keel_inbox", "keel_live", "keel_flows"]) s.tools[n] = () => text(n);
  const c = new McpClient(s.transport(), info);
  await c.start();
  const names = await c.tools();
  assert.deepEqual([...names].sort(), ["keel_flows", "keel_inbox", "keel_live", "keel_next", "keel_status"]);
  const lists = s.received.filter((m) => m.method === "tools/list").length;
  await c.tools();
  assert.equal(s.received.filter((m) => m.method === "tools/list").length, lists, "second call is cached");
});

test("call: joins the text parts, drops empty arguments, a tool error throws with keel's words", async () => {
  const s = new FakeServer();
  s.tools.keel_status = (args) => ({ content: [{ type: "text", text: `a ${JSON.stringify(args)}` }, { type: "text", text: "b" }] });
  s.tools.keel_approve_gate = () => text("nothing waits on shop", true);
  const c = new McpClient(s.transport(), info);
  await c.start();
  assert.equal(await c.call("keel_status", { project: "shop", why: "", thread_id: undefined }), 'a {"project":"shop"}\nb');
  await assert.rejects(c.call("keel_approve_gate", {}), (e: Error) => e instanceof McpError && e.message === "nothing waits on shop");
  await assert.rejects(c.call("keel_nope", {}), /Unknown tool/);
});

test("elicitation: the server's question goes to onElicit and its answer back; ping is answered", async () => {
  const s = new FakeServer();
  const asked: string[] = [];
  s.tools.keel_stop_flow = async (_a, srv) => {
    const res = (await srv.ask("elicitation/create", { message: "keel: stop the flow?", requestedSchema: { type: "object", properties: { confirm: { type: "boolean" } } } })).result as Record<string, unknown>;
    return text(res.action === "accept" && (res.content as Record<string, unknown>).confirm === true ? "stopped" : "not done");
  };
  const c = new McpClient(s.transport(), info, 5000, async (message) => {
    asked.push(message);
    return { action: "accept", content: { confirm: true } };
  });
  await c.start();
  assert.equal(await c.call("keel_stop_flow"), "stopped");
  assert.deepEqual(asked, ["keel: stop the flow?"]);
  const pong = await s.ask("ping", {});
  assert.deepEqual(pong.result, {});
});

test("elicitation without a way to ask is declined; an unknown server request gets method-not-found", async () => {
  const s = new FakeServer();
  const c = new McpClient(s.transport(), info);
  await c.start();
  assert.deepEqual((await s.ask("elicitation/create", { message: "?" })).result, { action: "decline" });
  assert.equal(((await s.ask("sampling/createMessage", {})).error as Record<string, unknown>).code, -32601);
});

test("a server that stops fails the waiting request and every later one; a slow one times out", async () => {
  const s = new FakeServer();
  s.tools.keel_live = () => new Promise(() => {});
  const c = new McpClient(s.transport(), info, 200);
  await c.start();
  await assert.rejects(c.call("keel_live"), /did not answer tools\/call in 0 s/);
  const p = c.call("keel_live");
  s.die("exited (1): boom");
  await assert.rejects(p, /stopped: exited \(1\): boom/);
  await assert.rejects(c.call("keel_status"), /stopped/);
});

test("processTransport: a real child process speaking newline-delimited JSON (fixtures/fake-mcp.mjs)", async () => {
  const script = fileURLToPath(new URL("./fixtures/fake-mcp.mjs", import.meta.url));
  const c = new McpClient(processTransport([process.execPath, script]), info, 10_000);
  await c.start();
  assert.equal(c.serverName, "fake-keel");
  assert.ok((await c.tools()).has("keel_status"));
  assert.equal(await c.call("keel_status", { project: "shop" }), "status of shop");
  c.close();
});

test("processTransport: a command that does not exist fails start with its name", async () => {
  const c = new McpClient(processTransport(["/nonexistent/keel2", "mcp"]), info, 5000);
  await assert.rejects(c.start(), /\/nonexistent\/keel2 mcp/);
});
