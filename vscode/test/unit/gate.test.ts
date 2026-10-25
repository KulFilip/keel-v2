import { describe, expect, it } from "vitest";
import { answerProblem, answersOf, buildAnswer, defaultButton, gateButtons, quickApprove, reasonLabel } from "../../src/logic/gate";
import type { InboxItem, Waiting } from "../../src/api/models";

describe("gate options → buttons", () => {
  it("uses keel's named choices exactly, with their reasons", () => {
    const w: Waiting = {
      id: "q-7",
      options: ["approve", "reject"],
      choices: ["approve", "change", "split"],
      choice_info: [
        { name: "approve", label: "Approve the spec", description: "go on", why: "none", default: true },
        { name: "change", label: "Change it", why: "required" },
      ],
    };
    const b = gateButtons(w);
    expect(b.map((x) => [x.name, x.label, x.why, x.plain])).toEqual([
      ["approve", "Approve the spec", "none", false],
      ["change", "Change it", "required", false],
    ]);
    expect(defaultButton(b)?.name).toBe("approve");
  });

  it("raw choice names become buttons; reject needs a reason", () => {
    const b = gateButtons({ choices: ["approve", "reject"] });
    expect(b.map((x) => [x.label, x.why])).toEqual([
      ["Approve", "none"],
      ["Reject", "required"],
    ]);
  });

  it("without named choices: only the approve / send back the question offers", () => {
    expect(gateButtons({ options: ["approve", "reject"], labels: { approve: "Ship it" } }).map((x) => x.label)).toEqual(["Ship it", "Send back"]);
    expect(gateButtons({ options: ["approve"] }).map((x) => x.name)).toEqual(["approve"]);
    expect(gateButtons({ options: [] })).toEqual([]);
    expect(gateButtons({ options: ["retry"] })).toEqual([]);
  });

  it("send back asks what to change and needs it", () => {
    const b = gateButtons({ options: ["approve", "reject"] });
    expect(reasonLabel(b[1])).toBe("What should keel change?");
    expect(reasonLabel(b[0])).toBeUndefined();
    expect(answerProblem(b, "reject", " ")).toContain("needs a reason");
    expect(answerProblem(b, "reject", "add a test for refunds")).toBe("");
    expect(answerProblem(b, undefined, "")).toBe("Choose one first.");
  });

  it("builds the answer bound to the question id", () => {
    const plain: Waiting = { id: "q-1", options: ["approve", "reject"] };
    expect(buildAnswer(plain, { picked: "approve" })).toEqual({ decision: "approve", id: "q-1" });
    expect(buildAnswer(plain, { picked: "reject", why: " add a test " })).toEqual({ decision: "reject", id: "q-1", why: "add a test" });
    const named: Waiting = { id: "q-2", choices: ["approve", "change"] };
    expect(buildAnswer(named, { picked: "change", why: "split it" })).toEqual({ decision: "approve", id: "q-2", why: "split it", payload: { choice: "change" } });
  });

  it("clarify answers: typed wins, multiple sends ticks, untouched single is left out", () => {
    const qs = [
      { id: "q1", question: "Which currency?", options: [{ label: "EUR", recommended: true }, { label: "USD" }] },
      { id: "q2", question: "Which shops?", multiple: true, options: [{ label: "shop", recommended: true }, { label: "outlet" }] },
      { id: "q3", question: "Rounding?", options: [{ label: "Other", why: "required" }] },
      { id: "q4", question: "Untouched?", options: [{ label: "A" }] },
    ];
    const a = answersOf(qs, { q1: ["USD"], q3: ["Other"] }, { q2: "SHOPS-1234 too", q3: "half up" });
    expect(a).toEqual({ q1: "USD", q2: ["shop", "SHOPS-1234 too"], q3: "Other: half up" });
    const w: Waiting = { id: "q-c", kind: "clarify", questions: qs };
    expect(gateButtons(w)).toEqual([]);
    expect(answerProblem([], undefined, "", qs)).toBe("");
    expect(buildAnswer(w, { qPicked: { q1: ["EUR"] } }).payload).toEqual({ answers: { q1: "EUR", q2: ["shop"] } });
  });
});

describe("notification quick approve", () => {
  const base: InboxItem = { project_id: "shop", thread_id: "t1", kind: "gate", id: "q-7", options: ["approve", "reject"] };
  it("offers Approve when exactly one approve without a reason is offered", () => {
    expect(quickApprove(base)?.name).toBe("approve");
    expect(quickApprove({ ...base, options: undefined, choices: ["approve", "change"] })?.plain).toBe(false);
  });
  it("otherwise only Open", () => {
    expect(quickApprove({ ...base, options: ["reject"] })).toBeUndefined();
    expect(quickApprove({ ...base, choice_info: [{ name: "approve", why: "required" }] })).toBeUndefined();
    expect(quickApprove({ ...base, questions: [{ id: "q1", question: "?" }] })).toBeUndefined();
    expect(quickApprove({ ...base, kind: "permission" })).toBeUndefined();
  });
});
