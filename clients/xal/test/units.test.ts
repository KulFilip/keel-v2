// config, project choice and brief, notices, guard
import assert from "node:assert/strict";
import { test } from "node:test";
import { briefText, pickProject, type Project } from "../src/brief.ts";
import { DEFAULTS, readConfig } from "../src/config.ts";
import { guardDecision, hookInput, runHook, type Run } from "../src/guard.ts";
import { noticeFor } from "../src/notices.ts";
import { PROJECTS } from "./helpers.ts";

test("config: defaults; KEEL_URL and KEEL_PROJECT; pluginConfig wins; /api and trailing / are dropped", () => {
  assert.deepEqual(readConfig({}), DEFAULTS);
  assert.equal(readConfig({}, { KEEL_URL: "http://localhost:8088/api/" }).url, "http://localhost:8088");
  assert.equal(readConfig({ url: "http://127.0.0.1:8098" }, { KEEL_URL: "http://x:1" }).url, "http://127.0.0.1:8098");
  assert.equal(readConfig({}, { KEEL_PROJECT: "shop" }).project, "shop");
  const c = readConfig({ mcp: ["keel2", "mcp", "--write"], brief: false, guard: true, timeoutMs: 5000 });
  assert.deepEqual([c.mcp, c.brief, c.guard, c.timeoutMs], [["keel2", "mcp", "--write"], false, true, 5000]);
});

test("config: wrong types and unknown fields fail, like xal's own sections", () => {
  assert.throws(() => readConfig({ urll: "x" }), /unknown field urll/);
  assert.throws(() => readConfig({ url: "localhost:8080" }), /http\(s\) URL/);
  assert.throws(() => readConfig({ mcp: "keel2 mcp" }), /non-empty array/);
  assert.throws(() => readConfig({ mcp: [] }), /non-empty array/);
  assert.throws(() => readConfig({ guard: "yes" }), /true or false/);
  assert.throws(() => readConfig({ timeoutMs: 10 }), /1000 to 600000/);
});

test("pickProject: configured id or name, then the folder that holds cwd (deepest), then the only one, then /workspace", () => {
  const ps = PROJECTS as Project[];
  assert.equal(pickProject(ps, "/anywhere", "api")?.id, "api");
  assert.throws(() => pickProject(ps, "/x", "nope"), /no project "nope" \(it has: shop, api\)/);
  assert.equal(pickProject(ps, "/Users/me/src/api/web/src")?.id, "api");
  assert.equal(pickProject(ps, "/Users/me/src/apiary")?.id, "shop", "a sibling folder with the same prefix is not inside");
  const nested = [...ps, { ...ps[1]!, id: "web", root: "/Users/me/src/api/web" }];
  assert.equal(pickProject(nested, "/Users/me/src/api/web/a")?.id, "web");
  assert.equal(pickProject([ps[1]!], "/elsewhere")?.id, "api");
  assert.equal(pickProject([ps[1]!, { ...ps[1]!, id: "b", root: "/b" }], "/elsewhere"), undefined);
});

test("brief: short session state in a tag, the flow line only with a flow", () => {
  const b = briefText(PROJECTS[0] as Project, "http://localhost:8088", 2);
  assert.match(b, /^<keel-brief>\n/);
  assert.match(b, /\n<\/keel-brief>$/);
  assert.match(b, /Now: flow "change" · phase red · AC 1\/3\./);
  assert.match(b, /1 waiting for the person, 2 agent call\(s\) running/);
  assert.match(b, /Inbox has 2 item/);
  assert.ok(b.split("\n").length <= 8);
  const idle = briefText(PROJECTS[1] as Project, "http://x", 0);
  assert.match(idle, /Now: no flow runs\./);
  assert.doesNotMatch(idle, /Inbox|waiting/);
});

const ev = (type: string, data: Record<string, unknown> = {}, extra: Record<string, unknown> = {}) =>
  JSON.stringify({ type, thread_id: "t1", project_id: "shop", at: "2026-10-16T12:00:00Z", data, ...extra });

test("notices: the web's event words (components/events.ts), only the events that matter, this project only", () => {
  assert.equal(noticeFor("gate.waiting", ev("gate.waiting", { title: "AC gate" }, { step: "ac_gate" })), "keel · gate · AC gate waits for you (ac_gate)");
  assert.equal(noticeFor("gate.decided", ev("gate.decided", { decision: "reject", why: "no" }, { step: "spec_gate" })), 'keel · gate · spec_gate sent back — "no"');
  assert.equal(noticeFor("thread.failed", ev("thread.failed", { error: "boom" })), "keel · flow · flow failed: boom");
  assert.equal(noticeFor("agent.started", ev("agent.started", { agent: "implementer", provider: "fake", model: "fake", ac: "AC-1" }, { step: "green" })), "keel · agent · implementer start · fake fake · AC-1 (green)");
  assert.equal(noticeFor("agent.step", ev("agent.step", { text: "reading" })), undefined, "steps stay on the Live page");
  assert.equal(noticeFor("engine", ev("budget.stop", { text: "cap reached" })), "keel · budget · cap reached");
  assert.equal(noticeFor("thread.done", ev("thread.done"), "other"), undefined, "another project's event");
  assert.equal(noticeFor("notification", JSON.stringify({ title: "Gate waits" })), undefined, "the bell repeats the events");
  assert.equal(noticeFor("gate.waiting", "not json"), undefined);
});

test("guard: xal's tools in Claude's names; tools keel does not judge are not sent", () => {
  assert.deepEqual(hookInput("edit", { file_path: "a.ts", old_string: "x", new_string: "y" }, "/w"), {
    tool_name: "Edit",
    tool_input: { file_path: "a.ts", old_string: "x", new_string: "y" },
    cwd: "/w",
  });
  assert.equal(hookInput("bash", { command: "ls" }, "/w")?.tool_name, "Bash");
  assert.equal(hookInput("mcp__db__query", {}, "/w")?.tool_name, "mcp__db__query");
  assert.equal(hookInput("task", {}, "/w"), undefined);
});

test("guard: exit 0 allows, exit 2 blocks with keel's reason, a broken guard refuses changes and lets reads pass", async () => {
  const sig = new AbortController().signal;
  const fixed = (r: Awaited<ReturnType<Run>>): Run => async () => r;
  assert.equal(await guardDecision(["g"], "write", {}, "/w", sig, fixed({ code: 0, stderr: "" })), undefined);
  assert.deepEqual(await guardDecision(["g"], "edit", {}, "/w", sig, fixed({ code: 2, stderr: "[keel guard] RED allows tests only\n" })), {
    type: "block",
    reason: "[keel guard] RED allows tests only",
  });
  const broken = fixed({ code: null, stderr: "", error: "spawn keel2 ENOENT" });
  const r = await guardDecision(["keel2"], "bash", { command: "rm x" }, "/w", sig, broken);
  assert.equal(r?.type, "block");
  assert.match((r as { reason: string }).reason, /could not ask keel \(spawn keel2 ENOENT\).*guard to false/);
  assert.equal(await guardDecision(["keel2"], "read", { file_path: "a" }, "/w", sig, broken), undefined);
  let called = false;
  await guardDecision(["g"], "task", {}, "/w", sig, async () => ((called = true), { code: 0, stderr: "" }));
  assert.equal(called, false);
});

test("guard: runHook hands the call as JSON on stdin and reads the exit code and stderr of a real process", async () => {
  const script = 'input=$(cat); case "$input" in *\\"tool_name\\":\\"Write\\"*) echo "[keel guard] no writes in review" >&2; exit 2;; esac; exit 0';
  const sig = new AbortController().signal;
  assert.deepEqual(await guardDecision(["sh", "-c", script], "write", { file_path: "a" }, "/w", sig, runHook), {
    type: "block",
    reason: "[keel guard] no writes in review",
  });
  assert.equal(await guardDecision(["sh", "-c", script], "read", { file_path: "a" }, "/w", sig, runHook), undefined);
});
