// keel TUI round 3: @mentions and paste, Fix mode (live diffs, Keep / Undo, KeelBot's questions), plugins' commands
// and panels (contributes.tui), and --profile.
import React from "react";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { fuzzy, isPaste, Mentions, Pastes, rank, typingMention } from "../src/core/mentions";
import { fill, pathOf, pluginCommands, render as renderShow, type TuiPluginView } from "../src/core/plugins";
import { Profiler, route, stats } from "../src/core/profile";
import { makeTheme, PLAIN } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const none = makeTheme({ NO_COLOR: "1" }, 0);

function setup(prep?: (s: ReturnType<typeof stubKeel>) => void, profiler?: Profiler) {
  const stub = stubKeel();
  prep?.(stub);
  const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true, profiler });
  const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
  const r = render(<App core={core} probe={probe} width={100} theme={none} profiler={profiler} />);
  const frame = () => stripAnsi(r.lastFrame() ?? "");
  const type = async (s: string) => {
    r.stdin.write(s);
    await tick(40);
  };
  const enter = async () => {
    r.stdin.write("\r");
    await tick(40);
    await waitFor(() => !probe.busy);
    await tick(30);
  };
  return { stub, core, probe, r, frame, type, enter };
}

const step = (n: number, kind: string, extra: Record<string, unknown> = {}) => ({ event: "helper.step", data: JSON.stringify({ type: "helper.step",
  thread_id: "s1", project_id: "demo", at: new Date().toISOString(), call_id: "call-9", data: { n, kind, text: "", ...extra } }) });

const GIT: TuiPluginView = {
  name: "git", title: "Git", version: "1.0.0",
  commands: [{ name: "git", args: "<status|log|diff [path]>", summary: "the branch, its commits, its diff", sub: {
    status: { summary: "status", call: { method: "GET", path: "/projects/{pid}/git/status" },
      show: { title: "{branch} · base {base} · ahead {ahead}", items: "changes", line: "{status}  {path}", empty: "clean" } },
    log: { summary: "log", call: { method: "GET", path: "/projects/{pid}/git/log" }, show: { items: ".", line: "{sha}  {subject}" } },
    diff: { summary: "diff", call: { method: "GET", path: "/projects/{pid}/git/diff?path={arg}" }, show: { diff: "diff", empty: "no change" } },
    push: { summary: "push", call: { method: "POST", path: "/projects/{pid}/git/push" }, show: { title: "pushed: {pushed}" }, confirm: "Push the branch?" },
  } }],
  panel: { title: "Branch", key: "g", every: 10, call: { method: "GET", path: "/projects/{pid}/git/status" },
    show: { title: "{branch} ↑{ahead}", items: "changes", line: "{status} {path}" } },
};

describe("@mentions", () => {
  it("rank files fuzzily: the file's name first, letters next to each other", () => {
    expect(fuzzy("scr", "src/score.ts")).not.toBeNull();
    expect(fuzzy("xyz", "src/score.ts")).toBeNull();
    const files = ["web/src/App.tsx", "src/app.ts", "src/score.ts", "docs/apple.md"].map((f) => ({ kind: "file" as const, value: f, label: "@" + f }));
    expect(rank("app", files).map((x) => x.value)[0]).toBe("src/app.ts");
    expect(rank("app", files).map((x) => x.value).sort()).toEqual(["docs/apple.md", "src/app.ts", "web/src/App.tsx"]);
    expect(typingMention("look at @sr")).toEqual({ query: "sr", start: 8 });
    expect(typingMention("mail a@b")).toBeNull();
  });

  it("come from the project's files, the code graph and the flow's criteria, and go with the turn", async () => {
    const stub = stubKeel();
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    await core.start();
    const m = new Mentions(() => "demo", () => [{ id: "AC-1", title: "GET /health" }]);
    expect((await m.complete("sco")).map((x) => x.value)).toContain("src/score.ts");
    expect((await m.complete("Sco")).map((x) => `${x.kind}:${x.value}`)).toContain("symbol:ScoreService");
    expect((await m.complete("AC")).map((x) => x.value)[0]).toBe("AC-1");
    expect(m.mentionsIn("fix @src/score.ts for @AC-1, see @ScoreService and @nothing")).toEqual([
      { kind: "file", value: "src/score.ts" }, { kind: "ac", value: "AC-1" }, { kind: "symbol", value: "ScoreService", file: "src/score.ts", line: 3 }]);
  });

  it("in the prompt: @ opens the picker, Tab takes one, the turn sends it as a mention", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("why is @score");
    await waitFor(() => t.frame().includes("@src/score.ts"));
    t.r.stdin.write("\t");
    await tick(40);
    expect(t.frame()).toContain("› why is @src/score.ts");
    await t.type("slow?");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path.endsWith("/turn")));
    const turn = t.stub.calls.find((c) => c.path.endsWith("/turn"))!;
    expect(turn.body).toEqual({ text: "why is @src/score.ts slow?", mentions: [{ kind: "file", value: "src/score.ts" }] });
    expect(t.frame()).toContain("with @src/score.ts");
    t.r.unmount();
  });
});

describe("paste", () => {
  it("many lines behind a placeholder, an image path as an image, short text as it is", () => {
    const p = new Pastes();
    expect(p.add("one line").insert).toBe("one line");
    const big = Array.from({ length: 120 }, (_, i) => `line ${i}`).join("\n");
    expect(p.add(big).insert).toBe("[pasted 120 lines #1]");
    expect(p.add("/Users/me/shot one.png".replace(" ", "\\ ")).insert).toBe("[image shot one.png #2]");
    const { text, images } = p.expand("look [pasted 120 lines #1] and [image shot one.png #2]");
    expect(text.startsWith("look \nline 0\nline 1")).toBe(true);
    expect(text).toContain("line 119\n and (an image at /Users/me/shot one.png)");
    expect(images.map((i) => i.name)).toEqual(["shot one.png"]);
    expect(isPaste("a\nb")).toBe(true);
    expect(isPaste("ab")).toBe(false);
    expect(isPaste("please see foo.png")).toBe(false);                         // words, not a dropped file
    expect(new Pastes().add("please see foo.png").insert).toBe("please see foo.png");
    expect(isPaste("x".repeat(500))).toBe(true);
  });

  it("in the prompt: the placeholder shows, KeelBot gets the whole text, an image goes as an image", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await t.type("explain ");
    await t.type("def a():\n    return 1\n\ndef b():\n    return 2\n");
    expect(t.frame()).toContain("› explain [pasted 5 lines #1]");
    await t.type(" and ");
    await t.type("/tmp/err.png");
    expect(t.frame()).toContain("[image err.png #2]");
    await t.enter();
    await waitFor(() => t.stub.calls.some((c) => c.path.endsWith("/turn")));
    const body = t.stub.calls.find((c) => c.path.endsWith("/turn"))!.body as { text: string; images?: string[] };
    expect(body.text).toBe("explain \ndef a():\n    return 1\n\ndef b():\n    return 2\n\n and (an image at /tmp/err.png)");
    // 0.18.18 the pasted image goes with the turn as an image; the engine says whether the model can see it
    expect(body.images).toEqual(["/tmp/err.png"]);
    t.r.unmount();
  });
});

describe("Fix mode", () => {
  const DIFF = "--- a/src/app.ts\n+++ b/src/app.ts\n@@ -3,2 +3,2 @@\n-const limit = 10;\n+const limit = 100;\n export { limit };\n";

  it("shows each change as KeelBot makes it, then the files to keep or undo, and /keep and /undo call keel", async () => {
    const t = setup((s) => {
      s.state.changes = [{ path: "src/app.ts", status: "modified", added: 1, removed: 1, diff: DIFF },
        { path: "notes.md", status: "added", added: 2, removed: 0, diff: "--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,2 @@\n+# notes\n+one\n" }];
    });
    await waitFor(() => t.probe.started);
    await t.type("/mode fix");
    await t.enter();
    await t.type("raise the limit");
    await t.enter();
    await waitFor(() => t.probe.chatBusy);
    t.core.onMessage(step(1, "edit", { path: "src/app.ts", text: "Edit src/app.ts", diff: DIFF, ok: true }));
    await tick(50);
    let f = t.frame();
    expect(f).toMatch(/\* edit src\/app\.ts +✓/);
    expect(f).toContain("   3 -const limit = 10;");
    expect(f).toContain("   3 +const limit = 100;");
    t.stub.state.turnChanges = { 1: t.stub.state.changes };     // 0.18.20 this answer's own files
    t.stub.answer("Raised the limit to 100.", { turn: 1, files: ["src/app.ts", "notes.md"] });
    t.core.onMessage({ event: "helper.finished", data: JSON.stringify({ type: "helper.finished", thread_id: "s1", project_id: "demo", at: "x", data: {} }) });
    await waitFor(() => t.frame().includes("2 file(s) changed"));
    f = t.frame();
    expect(f).toContain("M src/app.ts  +1 -1");
    expect(f).toContain("A notes.md  +2 -0");
    expect(f).toContain("/keep [path|all] runs the checks and commits · /undo [path|all] · /changes");
    await t.type("/keep src/a");
    t.r.stdin.write("\t");
    await tick(40);
    expect(t.frame()).toContain("› /keep src/app.ts");
    await t.enter();
    expect(t.stub.calls.find((c) => c.path.endsWith("/done"))!.body).toEqual({ paths: ["src/app.ts"] });
    expect(t.frame()).toContain("✓ kept 1 file(s): feat(AC-1): the helper (abc1234) · checks: pytest -q");
    await t.type("/undo all");
    await t.enter();
    expect(t.stub.calls.find((c) => c.path.endsWith("/undo"))!.body).toEqual({});
    expect(t.frame()).toContain("✓ put back every file KeelBot changed");
    expect((t.stub.calls.find((c) => c.path.endsWith("/helper/sessions") && c.method === "POST")!.body as { mode: string }).mode).toBe("fix");
    t.r.unmount();
  });

  it("asks KeelBot's questions as an amber yes/no and answers through keel's approvals", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    t.core.onMessage({ event: "helper.permission", data: JSON.stringify({ type: "helper.permission", thread_id: "s1", project_id: "demo", at: "x",
      step: "helper", data: { id: "q9", command: "npm install left-pad", title: "KeelBot asks to run a command" } }) });
    await waitFor(() => t.probe.pick);
    expect(t.frame()).toContain("? KeelBot asks to run: npm install left-pad?");
    expect(t.frame()).toContain("❯ Allow once");
    t.r.stdin.write("\x1b[B");
    await tick(30);
    t.r.stdin.write("\x1b[B");
    await tick(30);
    t.r.stdin.write("\r");
    await waitFor(() => t.stub.calls.some((c) => c.path === "/api/approvals/q9/decide"));
    expect(t.stub.calls.find((c) => c.path === "/api/approvals/q9/decide")!.body).toEqual({ decision: "deny", why: "" });
    await waitFor(() => t.frame().includes("refused: npm install left-pad"));
    t.r.unmount();
  });
});

describe("plugins in keel TUI", () => {
  it("fill templates and call only what the manifest says", () => {
    expect(fill("{branch} · {a.b} · {missing}", { branch: "main", a: { b: 3 } })).toBe("main · 3 · ");
    expect(pathOf({ method: "GET", path: "/projects/{pid}/git/diff?path={arg}" }, "my app", "src/a b.ts")).toBe("/projects/my%20app/git/diff?path=src%2Fa%20b.ts");
    expect(renderShow({ branch: "x", changes: [] }, { title: "{branch}", items: "changes", line: "{path}", empty: "clean" }, PLAIN)).toBe("x\nclean");
    const cmds = pluginCommands([GIT], new Set(["git-x", "status"]));
    expect(cmds.map((c) => c.name)).toEqual(["git"]);
    expect(pluginCommands([GIT], new Set(["git"]))).toEqual([]);                  // keel's own name wins
  });

  it("/git status | log | diff and its push (asks first), in /help, with Tab, and the branch panel on Ctrl+G", async () => {
    const t = setup((s) => { s.state.plugins = { plugins: [GIT], problems: [] }; });
    await waitFor(() => t.probe.started);
    await tick(50);
    await t.type("/git st");
    t.r.stdin.write("\t");
    await tick(40);
    expect(t.frame()).toContain("› /git status");
    await t.enter();
    await waitFor(() => t.frame().includes("keel/health · base main · ahead 2"));
    expect(t.frame()).toContain("M  src/app.ts");
    expect(t.frame()).toContain("??  notes.md");
    await t.type("/git diff src/app.ts");
    await t.enter();
    await waitFor(() => t.frame().includes("+const a = 2;"));
    expect(t.stub.calls.some((c) => c.path === "/api/projects/demo/git/diff" && c.query === "?path=src%2Fapp.ts")).toBe(true);
    expect(t.frame()).toContain("   1 +const a = 2;");
    await t.type("/git push");
    await t.enter();
    await waitFor(() => t.probe.pick);
    expect(t.frame()).toContain("? Push the branch?");
    expect(t.stub.calls.some((c) => c.path.endsWith("/git/push"))).toBe(false);          // nothing before the yes
    t.r.stdin.write("\r");
    await waitFor(() => t.stub.calls.some((c) => c.path.endsWith("/git/push") && c.method === "POST"));
    await t.type("/help");
    await t.enter();
    expect(t.frame()).toMatch(/Plugins\n {2}\/git <status\|log\|diff \[path\]> +the branch, its commits, its diff/);
    t.r.stdin.write("\x07");                                                               // Ctrl+G
    await waitFor(() => t.frame().includes("Branch · Git") && t.frame().includes("keel/health ↑2"));
    expect(t.frame()).toContain("M src/app.ts");
    t.r.unmount();
  });
});

describe("--profile", () => {
  it("routes, percentiles, the calls, the live events' lag, the frames, the startup, a file and a summary", async () => {
    expect(route("GET", "http://k/api/projects/demo/flows/abc123?x=1")).toBe("GET /api/projects/{id}/flows/{id}");
    expect(stats([5, 1, 3, 2, 4])).toMatchObject({ n: 5, p50: 3, p95: 5, max: 5, mean: 3 });
    const p = new Profiler(Date.now() - 400);
    const t = setup(undefined, p);
    await waitFor(() => t.probe.started);
    t.core.onMessage({ event: "gate.waiting", data: JSON.stringify({ type: "gate.waiting", thread_id: "t1", project_id: "demo", at: new Date(Date.now() - 120).toISOString(), data: { title: "x" } }) });
    await tick(50);
    t.r.unmount();
    const r = p.report();
    expect(r.startup_ms).toBeGreaterThanOrEqual(400);
    expect(r.api.n).toBeGreaterThan(3);
    expect(r.api.routes.map((x) => x.route)).toContain("GET /api/projects/{id}/flow");
    expect(r.sse_lag_ms.n).toBe(1);
    expect(r.sse_lag_ms.p50).toBeGreaterThanOrEqual(100);
    expect(r.frame_ms.n).toBeGreaterThan(2);
    expect(r.memory_mb.rss_max).toBeGreaterThan(10);
    const dir = mkdtempSync(join(tmpdir(), "keel-tui-profile-"));
    const file = p.save({ KEEL_TUI_PROFILE_DIR: dir });
    expect(JSON.parse(readFileSync(file, "utf8")).api.n).toBe(r.api.n);
    const sum = p.summary(file);
    expect(sum).toMatch(/startup {5}\d+ ms to the start screen/);
    expect(sum).toContain(`saved       ${file} (on this computer only)`);
  });
});
