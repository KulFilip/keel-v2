import { describe, expect, it } from "vitest";
import { flowVm, lineVm, sortRuns } from "../../src/logic/flowVm";
import { statusText } from "../../src/logic/status";

describe("flow view model", () => {
  it("a waiting flow shows its gate with exactly the offered buttons and the step bar", () => {
    const vm = flowVm(
      {
        thread: {
          thread_id: "t-cart",
          title: "Cart totals in cents",
          workflow_id: "feature",
          status: "waiting",
          phase: "spec",
          current: "spec-gate",
          acs: [
            { id: "AC1", layer: "API", title: "total() returns cents", status: "green" },
            { id: "AC2", layer: "API", title: "tax rounds half up", status: "red" },
          ],
          waiting: { id: "q-7", title: "Approve the spec?", detail: "**4** criteria", options: ["approve", "reject"] },
          usage: { tokens_in: 1000, tokens_out: 500, cost_usd: 0.2 },
        },
        workflow: { id: "feature", steps: [{ id: "spec-gate", name: "Approve the spec" }] },
      },
      { where: "worktree" },
    )!;
    expect(vm.waits).toBe(true);
    expect(vm.gate?.buttons.map((b) => [b.name, b.label, b.reasonLabel])).toEqual([
      ["approve", "Approve", undefined],
      ["reject", "Send back", "What should keel change?"],
    ]);
    expect(vm.gate?.picked).toBe("approve");
    expect(vm.gate?.detailHtml).toContain("<strong>4</strong>");
    expect(vm.steps.map((s) => s.state)).toEqual(["current", "todo", "todo", "todo"]);
    expect(vm.current).toBe("Approve the spec");
    expect(vm.acs.map((a) => a.state)).toEqual(["green", "red"]);
    expect(vm.meta).toBe("feature · worktree · 2k tokens · $0.20");
    expect(vm.canStop).toBe(true);
  });

  it("a done flow has no gate, all steps done, and can neither stop nor resume", () => {
    const vm = flowVm({ thread: { thread_id: "t", status: "done", waiting: { options: ["approve"] } } }, {})!;
    expect(vm.gate).toBeUndefined();
    expect(vm.steps.every((s) => s.state === "done")).toBe(true);
    expect(vm.canStop).toBe(false);
    expect(vm.canResume).toBe(false);
  });

  it("activity lines render an answer as markdown and keep output as text", () => {
    expect(lineVm({ key: "a", at: "", kind: "text", title: "Plan", detail: "## Plan\n- one", markdown: true }).detailHtml).toBe("<h4>Plan</h4>\n<ul><li>one</li></ul>");
    const out = lineVm({ key: "b", at: "", kind: "command", title: "$ ls", detail: "<b>x</b>" });
    expect(out.detail).toBe("<b>x</b>");
    expect(out.detailHtml).toBeUndefined();
    expect(out.clock).toBe("--:--");
  });

  it("puts waiting and running flows on top", () => {
    const rows = sortRuns([
      { thread_id: "done", status: "done", updated_at: "2026-10-25T12:00:00Z" },
      { thread_id: "run", status: "running", updated_at: "2026-10-25T09:00:00Z" },
      { thread_id: "wait", status: "waiting", waiting: "Approve the spec?", updated_at: "2026-10-25T08:00:00Z" },
    ]);
    expect(rows.map((r) => r.thread_id)).toEqual(["wait", "run", "done"]);
  });
});

describe("status bar", () => {
  it("questions first, then the running phase", () => {
    expect(statusText({ connected: true, hasError: false, questions: 1 })).toBe("◆ keel: 1 question");
    expect(statusText({ connected: true, hasError: false, questions: 3, runningPhase: "green" })).toBe("◆ keel: 3 questions");
    expect(statusText({ connected: true, hasError: false, questions: 0, runningPhase: "green" })).toBe("◆ keel: green");
    expect(statusText({ connected: false, hasError: true, questions: 0 })).toBe("◆ keel: offline");
  });
});
