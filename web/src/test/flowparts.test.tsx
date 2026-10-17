// keel 0.18.11 the Flow page for long flows: phases fold to one line (a phase that is over or not started yet starts
// closed, the one at work open, the person's choice remembered), one row per criterion with its tries and why it was
// sent back, "Needs you" pinned on top of the steps, and the canvas follows the live step until the person scrolls.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { sendBacksOf } from "../components/stepFacts";
import { db, FakeEventSource } from "./setup";

const block = (id: string) => document.querySelector<HTMLElement>(`[data-block="${id}"]`);

describe("Flow page: long flows (0.18.11)", () => {
  it("phases fold: one that is over starts closed with its summary, the one at work is open, and a choice is remembered", async () => {
    const user = userEvent.setup();
    render(<App />);
    await screen.findByRole("region", { name: "Gate waits for you" });
    const spec = document.querySelector<HTMLElement>('section[data-phase="spec"]')!;
    const head = spec.querySelector<HTMLElement>(".sx-h-btn")!;
    expect(spec).toHaveClass("is-folded");
    expect(head).toHaveAttribute("aria-expanded", "false");
    expect(head).toHaveTextContent("1 of 1 done");
    expect(block("s1")).toBeNull();
    expect(block("s8")).not.toBeNull();                                   // the gate that waits: its phase is open

    await user.click(head);
    expect(head).toHaveAttribute("aria-expanded", "true");
    expect(block("s1")).not.toBeNull();
    expect(Object.values(JSON.parse(localStorage.getItem("keel2.flow.fold.th_7f3a")!))).toContain(true);
  });

  it("a criterion row says its state, tokens and why it was sent back", async () => {
    db.flows["ludus-engine"].thread!.gate_log = ["gate s2 approve", "ac AC-002 reject: the test checks nothing", "ac AC-002 reject", "ac AC-001 approve"];
    render(<App />);
    const rows = await screen.findByLabelText("Each criterion");
    const ac2 = rows.querySelector<HTMLElement>('[data-ac-row="AC-002"]')!;
    expect(ac2).toHaveClass("is-cur", "s-wait");
    expect(ac2).toHaveTextContent("Refuse a negative score with 400");
    const why = within(ac2).getByRole("list", { name: "Why AC-002 was sent back" });
    expect(why).toHaveTextContent("try 1 sent back: “the test checks nothing”");
    expect(why).toHaveTextContent("try 2 sent back: “no reason given”");
    await waitFor(() => expect(ac2.querySelector(".sc-ac-n")).toHaveTextContent("57k"));   // green 37k + the review at work 20k
    expect(rows.querySelector('[data-ac-row="AC-001"]')).toHaveClass("s-done");
    expect(rows.querySelector('[data-ac-row="AC-003"]')).toHaveTextContent("to do");
  });

  it("reads why a criterion was sent back from the gate log, oldest first", () => {
    expect(sendBacksOf([
      "ac AC-1 reject: too weak", "gate s2 reject: not this", "ac AC-1 already-met reject: no", "ac AC-2 reject (x) [fix]: later", "ac AC-1 reject",
    ])).toEqual({ "AC-1": ["too weak", "no reason given"], "AC-2": ["later"] });
    expect(sendBacksOf(undefined)).toEqual({});
  });

  it("the canvas follows the live step until the person scrolls; then Jump to live brings it back", async () => {
    const user = userEvent.setup();
    const f = db.flows["ludus-engine"];
    f.thread = { ...f.thread!, status: "running", waiting: undefined, current: "s3" };
    const seen: string[] = [];
    const had = Element.prototype.scrollIntoView;
    Element.prototype.scrollIntoView = function (this: Element) {
      const b = this.closest("[data-block]")?.getAttribute("data-block");
      if (b) seen.push(b);
    };
    try {
      render(<App />);
      await waitFor(() => expect(block("s3")).not.toBeNull());
      const step = (to: string) => {
        f.thread = { ...f.thread!, current: to };
        act(() => FakeEventSource.emit("step.started", { type: "step.started", thread_id: "th_7f3a", project_id: "ludus-engine", step: to, at: new Date().toISOString(), data: {} }));
      };
      step("s5");
      await waitFor(() => expect(seen).toContain("s5"));
      expect(screen.queryByRole("button", { name: "Jump to live" })).toBeNull();

      fireEvent.wheel(screen.getByRole("region", { name: /: the steps$/ }));
      const back = await screen.findByRole("button", { name: "Jump to live" });
      step("s7");
      await waitFor(() => expect(block("s7")).toHaveAttribute("data-state", "run"));
      expect(seen).not.toContain("s7");                                    // it does not pull the page away

      await user.click(back);
      await waitFor(() => expect(seen).toContain("s7"));
      expect(screen.queryByRole("button", { name: "Jump to live" })).toBeNull();
    } finally {
      Element.prototype.scrollIntoView = had;
    }
  });

  it("a failed step is pinned on top of the steps with Go to it", async () => {
    const user = userEvent.setup();
    const f = db.flows["ludus-engine"];
    f.thread = { ...f.thread!, status: "failed", waiting: undefined, current: "s5" };
    render(<App />);
    const pin = await waitFor(() => {
      const el = document.querySelector<HTMLElement>(".fl-needs");
      expect(el).not.toBeNull();
      return el!;
    });
    expect(pin).toHaveTextContent("green failed. See why and what to do.");
    expect(pin).toHaveClass("is-bad");
    await user.click(within(pin).getByRole("button", { name: "Go to it" }));
    await waitFor(() => expect(document.activeElement?.closest("[data-block]")?.getAttribute("data-block")).toBe("s5"));
  });
});
