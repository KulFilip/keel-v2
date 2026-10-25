// keel 0.18.54 the Flow page's Events read well: usage events are hidden unless asked for (All / Agents / Gates / Phases /
// Usage), an agent's answer is Markdown folded to a few lines, a gate's decision is a coloured badge with its answers as a
// numbered question → answer list, and a step that starts or ends is a small divider with a readable name.

import { act, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { EngineEvent } from "../api";
import { decisionOf, eventRow, humanize, inFilter, parseAnswers, whoOf } from "../components/eventRows";
import { FakeEventSource } from "./setup";
import { ANSWERS, openShopFlow, shopEvent, shopWorkflow } from "./shopFlow";

const nameOf = (id: string) => shopWorkflow.steps.find((s) => s.id === id)?.name;
// the api sends a type the web lists on its own channel, any other (agent.usage, supervisor.*) on "engine"
const push = (e: EngineEvent) => act(() => FakeEventSource.emit(["agent.usage", "provider.usage"].includes(e.type) || e.type.startsWith("supervisor.") ? "engine" : e.type, e));

describe("event → row", () => {
  it("hides usage events under All and shows them under Usage", () => {
    const usage = eventRow(shopEvent("agent.usage", "spec", { agent: "explorer", tokens_in: 1200, tokens_out: 300 }));
    expect(usage).toMatchObject({ kind: "usage", group: "usage", text: "explorer used 1,500 tokens so far" });
    expect(inFilter(usage, "all")).toBe(false);
    expect(inFilter(usage, "usage")).toBe(true);
    expect(inFilter(eventRow(shopEvent("provider.usage", undefined, { provider: "claude" })), "all")).toBe(false);
    const agent = eventRow(shopEvent("agent.finished", "spec", { agent: "explorer", status: "done", result: "## Lenses\n\n**Goal** ok" }));
    expect(inFilter(agent, "all")).toBe(true);
    expect(inFilter(agent, "agents")).toBe(true);
    expect(inFilter(agent, "gates")).toBe(false);
  });

  it("an agent's answer is kept as Markdown, not one line", () => {
    const row = eventRow(shopEvent("agent.finished", "interview", { agent: "explorer", status: "done", result: "## Lenses — cart\n\n**Goal/users** `docs/cart.md:12`" }));
    expect(row).toMatchObject({ kind: "agent", label: "agent", text: "explorer finished · done", md: "## Lenses — cart\n\n**Goal/users** `docs/cart.md:12`" });
  });

  it("a gate's decision is a badge, its answers a question → answer list", () => {
    expect(decisionOf("approve")).toEqual({ tone: "ok", label: "approved" });
    expect(decisionOf("reject")).toEqual({ tone: "warn", label: "sent back" });
    expect(decisionOf("deny")).toEqual({ tone: "bad", label: "refused" });
    expect(decisionOf("approve", { choice: "skip_web" })).toEqual({ tone: "ok", label: "approved · skip web" });

    const row = eventRow(shopEvent("gate.decided", "interview_gate", { gate: "your answers", decision: "approve", clarify: true, why: ANSWERS }), nameOf);
    expect(row.kind).toBe("gate");
    expect(row.decision).toEqual({ tone: "ok", label: "answered" });
    expect(row.answers).toEqual([
      { n: 1, q: "Which carts keep the discount?", a: "Only open carts" },
      { n: 2, q: "Who may change a discount?", a: "ana and bo (the shop owners)" },
    ]);
    // the person's own note stays; keel's line for the agent does not
    expect(row.note).toBe("alex reviews the copy.");

    const back = eventRow(shopEvent("gate.decided", "spec_gate", { gate: "spec approval", decision: "reject", why: "AC-2 misses the empty cart" }));
    expect(back).toMatchObject({ decision: { tone: "warn", label: "sent back" }, by: "you", note: "AC-2 misses the empty cart" });
  });

  it("reads the one-line answers too, and tells who answered", () => {
    expect(parseAnswers("Answers to your questions: 1. Which carts? → Only open · 2. Who? → ana")?.answers)
      .toEqual([{ n: 1, q: "Which carts?", a: "Only open" }, { n: 2, q: "Who?", a: "ana" }]);
    expect(parseAnswers("approved, fine")).toBeNull();
    expect(whoOf({ by: "supervisor" })).toBe("supervisor");
    expect(whoOf({ why: "auto-approved (mode auto)" })).toBe("auto");
    expect(whoOf({ by: "engine" })).toBe("keel");
    expect(whoOf({ why: "looks right" })).toBe("you");
  });

  it("a step that starts or finishes is a divider with a readable name", () => {
    expect(humanize("interview_gate")).toBe("interview gate");
    expect(humanize("review__fix")).toBe("review fix");
    expect(eventRow(shopEvent("step.started", "interview_gate", {}), nameOf))
      .toMatchObject({ kind: "phase", group: "phases", divider: "start", text: "interview gate (your answers) started" });
    expect(eventRow(shopEvent("step.finished", "interview", { status: "done" }), nameOf))
      .toMatchObject({ divider: "end", text: "interview finished" });
    expect(eventRow(shopEvent("step.finished", "spec", { status: "failed" }), nameOf).text).toBe("spec finished · failed");
  });
});

describe("Events panel", () => {
  it("shows readable rows, newest first, and hides usage until asked", async () => {
    const user = userEvent.setup();
    openShopFlow();
    render(<App />);
    const panel = await screen.findByRole("region", { name: "Events" });
    push(shopEvent("step.started", "interview", {}));
    push(shopEvent("agent.usage", "interview", { agent: "explorer", tokens_in: 900, tokens_out: 100 }));
    push(shopEvent("agent.finished", "interview", { agent: "explorer", status: "done",
      result: "## Lenses — cart totals\n\n**Goal/users:** shop owners ana and bo.\n\n- one\n- two\n- three\n- four" }));
    push(shopEvent("step.finished", "interview", { status: "done" }));
    push(shopEvent("gate.decided", "interview_gate", { gate: "your answers", decision: "approve", clarify: true, why: ANSWERS }));
    push(shopEvent("agent.usage", "spec", { agent: "explorer", tokens_in: 50, tokens_out: 5 }));

    expect(within(panel).getByTestId("events-order")).toHaveTextContent("Newest first · 2 usage hidden");
    const list = within(panel).getByLabelText("What happened, newest first");
    const kinds = [...list.children].map((c) => (c as HTMLElement).dataset.kind);
    expect(kinds).toEqual(["gate", "phase", "agent", "phase"]);
    expect(within(list).queryByText(/tokens so far/)).toBeNull();

    // the gate: a green badge and the answers as a numbered list
    const gate = list.children[0] as HTMLElement;
    expect(within(gate).getByTestId("decision-badge")).toHaveClass("p-ok");
    expect(within(gate).getByTestId("decision-badge")).toHaveTextContent("answered");
    const qa = within(gate).getByRole("list", { name: "Your answers" });
    expect(within(qa).getAllByRole("listitem").map((li) => li.textContent)).toEqual([
      "Which carts keep the discount?→ Only open carts", "Who may change a discount?→ ana and bo (the shop owners)"]);

    // the step dividers say which step, in words
    expect(within(list).getByRole("separator", { name: "interview finished" })).toBeInTheDocument();

    // the agent's answer: Markdown (a heading, a list), folded, with Show more
    const agent = list.children[2] as HTMLElement;
    expect(within(agent).getByRole("heading", { name: "Lenses — cart totals" })).toBeInTheDocument();
    expect(agent.querySelector(".ev-md")).toHaveClass("is-folded");
    await user.click(within(agent).getByRole("button", { name: "Show more" }));
    expect(agent.querySelector(".ev-md")).not.toHaveClass("is-folded");

    // Usage shows only the usage rows; Gates only the gate
    await user.click(within(panel).getByRole("button", { name: "Usage" }));
    expect([...list.children].map((c) => (c as HTMLElement).dataset.kind)).toEqual(["usage", "usage"]);
    expect(localStorage.getItem("keel2.events.filter")).toBe("usage");
    await user.click(within(panel).getByRole("button", { name: "Gates" }));
    expect([...list.children].map((c) => (c as HTMLElement).dataset.kind)).toEqual(["gate"]);
    await user.click(within(panel).getByRole("button", { name: "All" }));
    expect(localStorage.getItem("keel2.events.filter")).toBeNull();
  });
});
