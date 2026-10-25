// "What this step does" › Task: the agent's facts are a definition list (a label never shares its cell with the value,
// so a long value wraps instead of being drawn over the label), and the step's instructions read as Markdown with
// their run-on "lead: A (…), B (…), C (…)." lists as bullets.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { StepExplanation } from "../api";
import { listify } from "../components/prose";
import { StepInfoBody } from "../components/StepInfo";

const agentStep = (instructions: string): StepExplanation =>
  ({
    id: "spec",
    name: "spec",
    kind: "agent",
    phase: "spec",
    phase_meaning: "the spec is written",
    thread: false,
    rules: { phase: "spec", buckets: [], shell_refused: [] },
    next: [],
    agent: {
      id: "explorer",
      custom: false,
      about: "Maps the code a criterion touches.",
      instructions,
      model: {
        step: "default",
        rule: "the step's model, else the agent's",
        now: {
          provider: "claude",
          model: "claude-sonnet-4-5-with-a-long-name",
          effort: "high",
        },
      },
      max_turns: 40,
      knowledge: {
        sections: [
          "architecture",
          "domain",
          "conventions",
          "data",
          "integrations",
        ],
        code_graph: true,
        memory: true,
      },
      markers: [],
      prompt: "the prompt",
      placeholders: false,
    },
  }) as unknown as StepExplanation;

describe("Step details", () => {
  it("shows the agent's facts as label / value pairs that never share a cell", () => {
    render(<StepInfoBody x={agentStep("Write the spec.")} />);
    const facts = screen.getByTestId("explain-facts");
    expect(facts.tagName).toBe("DL");
    expect(facts).toHaveClass("xkv");
    const labels = [...facts.querySelectorAll("dt")].map((d) => d.textContent);
    expect(labels).toEqual(["Agent", "Model", "Turns at most", "Knowledge"]);
    const values = [...facts.querySelectorAll("dd")].map((d) => d.textContent);
    expect(values[0]).toBe("explorer");
    expect(values[1]).toBe("claude claude-sonnet-4-5-with-a-long-name · high");
    expect(values[2]).toBe("40");
    expect(values[3]).toMatch(
      /^architecture, domain, conventions, data, integrations · code graph · memory$/,
    );
  });

  it("renders what the step asks as Markdown, its run-on list as bullets", () => {
    const text =
      "Interview first, criteria second: write them from what was asked. It starts with the four sections a reader scans " +
      "first: In plain words (5 to 10 short sentences, simple English), For engineers (8 to 15 precise lines: the change at each " +
      "layer), What will change (one line per file or area: new, changed or removed), Payload changes (JSON before and after; or " +
      '"none: <the reason>"). Then a Goal, User stories and `docs/spec.md:12` as a citation.';
    render(<StepInfoBody x={agentStep(text)} />);
    const asks = screen.getByTestId("explain-asks");
    const items = within(asks)
      .getAllByRole("listitem")
      .map((li) => li.textContent);
    expect(items).toEqual([
      "In plain words (5 to 10 short sentences, simple English)",
      "For engineers (8 to 15 precise lines: the change at each layer)",
      "What will change (one line per file or area: new, changed or removed)",
      'Payload changes (JSON before and after; or "none: <the reason>")',
    ]);
    expect(within(asks).getByText("In plain words").tagName).toBe("B");
    expect(asks).toHaveTextContent("Then a Goal, User stories and");
    expect(within(asks).getByText("docs/spec.md:12")).toHaveClass("cite");
  });
});

describe("listify", () => {
  it("leaves text without that exact shape as it was", () => {
    const plain =
      "Interview first, criteria second, code last: write the criteria from what was asked, not from the code.";
    expect(listify(plain)).toBe(plain);
    // two items are not a list; an item without its bracket is not either
    expect(listify("Pick one: Small (a), Large (b).")).toBe(
      "Pick one: Small (a), Large (b).",
    );
    expect(listify("Then: a Goal, User stories (x), Findings (y).")).toBe(
      "Then: a Goal, User stories (x), Findings (y).",
    );
    // fenced code and existing lists stay as they are
    const code =
      "```\nUse: A (1), B (2), C (3).\n```\n- Use: A (1), B (2), C (3).";
    expect(listify(code)).toBe(code);
  });

  it("splits a clear run-on list and keeps the sentence after it", () => {
    expect(
      listify(
        "It has: Alpha (one, two), Beta (three: four), and Gamma (five). After that, more.",
      ),
    ).toBe(
      "It has:\n\n- **Alpha** (one, two)\n- **Beta** (three: four)\n- **Gamma** (five)\n\nAfter that, more.",
    );
  });
});
