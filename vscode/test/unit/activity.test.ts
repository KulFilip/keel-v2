import { describe, expect, it } from "vitest";
import { activityOf, activityOfStep, diffStat, filterMatches, FlowLive, testCounts } from "../../src/logic/activity";
import type { EngineEvent } from "../../src/api/models";

const ev = (type: string, data: Record<string, unknown> = {}, extra: Partial<EngineEvent> = {}): EngineEvent => ({
  type,
  thread_id: "t1",
  project_id: "shop",
  at: "2026-10-25T10:00:00Z",
  call_id: "c1",
  data,
  ...extra,
});

describe("event → activity line", () => {
  it("an edit step shows +/− and keeps the diff folded, with the path to open", () => {
    const l = activityOf(ev("agent.step", { n: 3, kind: "edit", path: "src/cart.ts", diff: "--- a\n+++ b\n@@ -1 +1,2 @@\n-a\n+b\n+c\n", agent: "coder" }))!;
    expect(l).toMatchObject({ kind: "edit", title: "Edit src/cart.ts", path: "src/cart.ts", added: 2, removed: 1, agent: "coder", key: "c1#3" });
    expect(l.detail).toContain("+b");
  });

  it("a read step opens its file", () => {
    expect(activityOf(ev("agent.step", { n: 1, kind: "read", path: "src/orders.ts" }))).toMatchObject({ kind: "read", title: "Read src/orders.ts", path: "src/orders.ts" });
  });

  it("a command keeps its exit code and folded output", () => {
    const l = activityOf(ev("tool.ran", { cmd: "npm run lint", code: 1, output: "2 problems" }))!;
    expect(l).toMatchObject({ kind: "command", title: "$ npm run lint", exit: 1, ok: false, detail: "2 problems" });
  });

  it("a test run is a test line with counts", () => {
    const l = activityOf(ev("tool.ran", { cmd: "npx vitest run", code: 0, output: "Tests  12 passed (12)\n" }))!;
    expect(l).toMatchObject({ kind: "test", passed: 12, failed: 0, ok: true, exit: 0 });
    expect(l.title).toBe("Tests: 12 passed, 0 failed (npx vitest run)");
    const bad = activityOfStep({ n: 2, kind: "tool", tool: "bash", text: "./gradlew test", output: "Tests run: 10, Failures: 2, Errors: 1" }, "coder", "c2")!;
    expect(bad).toMatchObject({ kind: "test", passed: 7, failed: 3, ok: false });
  });

  it("a guard refusal is a red line", () => {
    expect(activityOf(ev("guard.refused", { reason: "rm -rf outside the worktree", path: "/etc" }))).toMatchObject({ kind: "guard", title: "Refused: rm -rf outside the worktree", ok: false });
  });

  it("gate events say what was asked and answered", () => {
    expect(activityOf(ev("gate.waiting", { title: "Approve the spec?" }, { call_id: null }))!.title).toBe("Gate opened: Approve the spec?");
    expect(activityOf(ev("gate.decided", { gate: "spec-gate", choice: "approve", by: "ana" }))!.title).toBe("Gate answered: spec-gate → approve by ana");
  });

  it("an agent's answer is markdown, folded", () => {
    const l = activityOfStep({ n: 9, kind: "answer", text: "## Plan\n- add `refund()`\n- test it" }, "planner", "c3")!;
    expect(l).toMatchObject({ kind: "text", title: "## Plan", markdown: true });
    expect(l.detail).toContain("- test it");
  });

  it("usage events and deltas are hidden", () => {
    expect(activityOf(ev("agent.usage", { tokens_in: 10 }))).toBeUndefined();
    expect(activityOf(ev("agent.delta", { text: "Hel" }))).toBeUndefined();
    expect(activityOf(ev("agent.step", { kind: "thinking", text: "hmm" }))).toBeUndefined();
  });

  it("agent finished shows tokens and cost", () => {
    expect(activityOf(ev("agent.finished", { agent: "coder", tokens_in: 1200, tokens_out: 300, cost_usd: 0.123, status: "done" }))!.title).toBe("Done · 2k tokens · $0.12");
  });

  it("filters pick their kinds", () => {
    expect(filterMatches("edits", { kind: "edit" })).toBe(true);
    expect(filterMatches("edits", { kind: "read" })).toBe(false);
    expect(filterMatches("commands", { kind: "test" })).toBe(true);
    expect(filterMatches("tests", { kind: "command" })).toBe(false);
    expect(filterMatches("all", { kind: "gate" })).toBe(true);
  });

  it("diff stats and test counts", () => {
    expect(diffStat("+++ b\n--- a\n+x\n-y\n-z")).toEqual([1, 2]);
    expect(testCounts("test result: ok. 5 passed; 0 failed")).toEqual([5, 0]);
    expect(testCounts("ok  \tshop/cart\t0.1s\nFAIL\tshop/pay\n")).toEqual([1, 1]);
    expect(testCounts("nothing here")).toBeUndefined();
    // a linter's summary is not a test run
    expect(testCounts("✖ 1 problem (1 error, 0 warnings)")).toBeUndefined();
    expect(testCounts("== 3 passed, 1 error in 0.2s ==")).toEqual([3, 1]);
    expect(testCounts("== 1 failed, 4 passed in 0.3s ==")).toEqual([4, 1]);
  });
});

describe("FlowLive", () => {
  it("tracks who runs, their usage, and the step", () => {
    const live = new FlowLive();
    live.apply(ev("step.started", { name: "Write the tests" }));
    live.apply(ev("agent.started", { agent: "test-author", model: "sonnet", effort: "high" }));
    live.apply(ev("agent.usage", { tokens_in: 900, tokens_out: 100, cost_usd: 0.05 }));
    expect(live.step).toBe("Write the tests");
    const a = live.running.get("c1")!;
    expect(a).toMatchObject({ agent: "test-author", model: "sonnet", tokens: 1000, costUsd: 0.05 });
    expect(a.since).toBe(Date.parse("2026-10-25T10:00:00Z"));
    expect(live.agentOf("c1")).toBe("test-author");
    live.apply(ev("agent.finished", {}));
    expect(live.running.size).toBe(0);
    expect(live.agentOf("c1")).toBe("test-author");
  });

  it("starts from the jobs list of a flow opened mid-run", () => {
    const live = new FlowLive();
    live.start({ id: "c7", agent: "coder", model: "opus", status: "running", started_at: "2026-10-25T09:59:00Z", tokens_in: 10, tokens_out: 5, step: "green" });
    live.start({ id: "c6", agent: "planner", status: "done" });
    expect([...live.running.keys()]).toEqual(["c7"]);
    expect(live.step).toBe("green");
    expect(live.agentOf("c6")).toBe("planner");
  });
});
