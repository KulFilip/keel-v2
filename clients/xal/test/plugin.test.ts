// The contract with xal's plugin loader (apps/cli/src/plugins/load.ts and discover.ts at 0.1.0-beta.256): a default
// export with a name and a synchronous register; what it registers.
import assert from "node:assert/strict";
import { test } from "node:test";
import plugin, { PREFIX } from "../plugin.ts";
import { SPECS } from "../src/commands.ts";
import type { Cli, Command, Hook, PluginContext, PromptSection } from "../src/xal.ts";

function fakeCtx(config: Record<string, unknown> = {}) {
  const got = { commands: [] as Command[], clis: [] as Cli[], hooks: [] as Hook[], prompts: [] as PromptSection[] };
  const ctx: PluginContext = {
    config,
    runtime: { app: { name: "xal", version: "0.1.0-beta.256" } },
    signal: new AbortController().signal,
    registerCommand: (c) => void got.commands.push(c),
    registerCli: (c) => void got.clis.push(c),
    registerHook: (h) => void got.hooks.push(h),
    registerPrompt: (p) => void got.prompts.push(p),
  };
  return { ctx, got };
}

test("xal's loader: default export with a name, a synchronous register, async bootstrap and shutdown", async () => {
  assert.equal(plugin.name, "keel");
  assert.equal(typeof plugin.register, "function");
  const { ctx } = fakeCtx();
  const result: unknown = plugin.register(ctx);
  assert.equal(result, undefined, "register must not return a promise");
  assert.equal(typeof plugin.bootstrap, "function");
  assert.equal(typeof plugin.shutdown, "function");
  await plugin.shutdown!(ctx);
});

test("registers /keel, /keel:<command> for each command (aliases too), xal keel, and the brief section", async () => {
  const { ctx, got } = fakeCtx({ url: "http://127.0.0.1:1" });
  plugin.register(ctx);
  const names = got.commands.flatMap((c) => [c.name, ...(c.aliases ?? [])]);
  assert.deepEqual(names.slice(0, 1), ["keel"]);
  for (const s of SPECS) assert.ok(names.includes(PREFIX + s.name), s.name);
  assert.ok(names.includes("keel:jobs"));
  assert.equal(new Set(names).size, names.length, "xal refuses a name registered twice");
  assert.ok(names.every((n) => !/\s/.test(n)), "the palette matches names without spaces");
  assert.ok(got.commands.every((c) => c.describe.startsWith("keel")));
  assert.deepEqual(got.clis.map((c) => c.name), ["keel"]);
  assert.deepEqual(got.prompts.map((p) => p.id), ["keel_brief"]);
  assert.equal(got.prompts[0]!.text({ kind: "primary", cwd: "/" }), "", "no brief before bootstrap read it");
  assert.equal(got.prompts[0]!.text({ kind: "subagent", cwd: "/" }), "");
  assert.deepEqual(got.hooks, [], "keel's guard is opt-in");
  await plugin.shutdown!(ctx);
});

test("guard: true adds the beforeTool hook; a bad pluginConfig.keel fails registration", async () => {
  const { ctx, got } = fakeCtx({ guard: true, guardCommand: ["sh", "-c", "cat >/dev/null; exit 0"] });
  plugin.register(ctx);
  assert.deepEqual(got.hooks.map((h) => h.name), ["keel-guard"]);
  const verdict = await got.hooks[0]!.beforeTool!({ callId: "1", tool: "write", args: { file_path: "a" } }, {
    session: { id: "s", kind: "primary", cwd: "/w", mode: "normal" },
    signal: new AbortController().signal,
  });
  assert.equal(verdict, undefined);
  await plugin.shutdown!(ctx);
  assert.throws(() => plugin.register(fakeCtx({ port: 8088 }).ctx), /unknown field port/);
});

test("/keel <command> dispatches; an unknown one prints the help", async () => {
  const { ctx, got } = fakeCtx({ url: "http://127.0.0.1:1" });
  plugin.register(ctx);
  const keel = got.commands[0]!;
  const lines: string[] = [];
  const c = { print: (t: string) => void lines.push(t), busy: () => {}, select: async () => undefined, ask: async () => undefined };
  await keel.run(["nope"], c);
  assert.match(lines[0]!, /^keel: no command "nope"\.\nkeel in xal\./);
  await keel.run([], c);
  assert.match(lines[1]!, /^keel in xal\./);
  await plugin.shutdown!(ctx);
});
