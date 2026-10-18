// keel 0.18.13 one way to ask: questions.ts (read, answer and write back questions the same way everywhere), the
// ChoiceForm for a gate's named choices, and the ClarifyForm's recommended-first order, default ticks and number keys.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { useState } from "react";
import { describe, expect, it, vi } from "vitest";
import type { ChoiceInfo, ClarifyQuestion } from "../api";
import { ChoiceForm } from "../components/ChoiceForm";
import { ClarifyForm } from "../components/ClarifyForm";
import {
  ANSWERS_PREFIX,
  answersMessage,
  answersOf,
  byRecommended,
  choiceProblem,
  choiceRows,
  defaultPick,
  parseQuestions,
  readAnswersMessage,
  type ClarifyAnswers,
} from "../questions";
import * as sdk from "../sdk";

const INIT: ClarifyQuestion[] = [
  {
    id: "run",
    question: "How does the project run?",
    options: [
      { label: "locally" },
      { label: "docker compose", recommended: true },
    ],
  },
  {
    id: "knowledge",
    question: "Which knowledge pages?",
    multiple: true,
    options: [
      { label: "architecture", recommended: true },
      { label: "domain", recommended: true },
      { label: "data" },
    ],
  },
];

describe("questions.ts", () => {
  it("parses KeelBot's questions: at most 4, 2–4 options, strings as labels, the first recommended when none is", () => {
    const qs = parseQuestions(
      '{"questions": [{"question": " Where? ", "options": ["Web", {"label": "iOS", "description": "the app"}, "", "a", "b"]},' +
        ' {"question": "", "options": ["x"]}, {"id": "n", "question": "How many?", "multiple": true, "options": [{"label": "10", "recommended": true}]}]}',
    );
    expect(qs).toEqual([
      {
        id: "q1",
        question: "Where?",
        why: undefined,
        multiple: false,
        options: [
          { label: "Web", description: undefined, recommended: true },
          { label: "iOS", description: "the app", recommended: false },
          { label: "a", description: undefined, recommended: false },
        ],
      },
      {
        id: "n",
        question: "How many?",
        why: undefined,
        multiple: true,
        options: [{ label: "10", description: undefined, recommended: true }],
      },
    ]);
    expect(parseQuestions("not json")).toEqual([]);
    expect(
      parseQuestions([{ question: "Q", options: ["a", "b"] }]),
    ).toHaveLength(1); // already parsed
  });

  it("answers: typed words win, a multiple question untouched sends its recommended options, an unanswered one is left out", () => {
    expect(defaultPick(INIT[1])).toEqual(["architecture", "domain"]);
    expect(defaultPick(INIT[0])).toEqual([]);
    expect(answersOf(INIT, {}, {})).toEqual({
      knowledge: ["architecture", "domain"],
    });
    expect(
      answersOf(
        INIT,
        { run: "locally", knowledge: ["data"] },
        { knowledge: "runbooks" },
      ),
    ).toEqual({ run: "locally", knowledge: ["data", "runbooks"] });
    expect(
      answersOf(INIT, { run: "locally", knowledge: [] }, { run: " podman " }),
    ).toEqual({ run: "podman" });
  });

  it("writes the answers as KeelBot's next message and reads them back", () => {
    const text = answersMessage(INIT, { knowledge: ["architecture", "data"] });
    expect(text).toBe(
      `${ANSWERS_PREFIX}\n1. How does the project run?\n   → (not answered: use the recommended one)\n2. Which knowledge pages?\n   → architecture; data`,
    );
    expect(readAnswersMessage(text)).toEqual([
      {
        question: "How does the project run?",
        answer: "(not answered: use the recommended one)",
      },
      { question: "Which knowledge pages?", answer: "architecture; data" },
    ]);
    expect(readAnswersMessage("Something else")).toBeNull();
  });

  it("sorts the recommended first, and reads choices from choice_info or (an older engine) the raw names", () => {
    expect(byRecommended(INIT[0].options).map((o) => o.label)).toEqual([
      "docker compose",
      "locally",
    ]);
    const old = choiceRows(["fix", "reject"]);
    expect(old).toEqual([
      {
        name: "fix",
        label: "fix",
        description: "",
        why: "none",
        default: true,
      },
      {
        name: "reject",
        label: "reject",
        description: "",
        why: "required",
        default: false,
      },
    ]);
    expect(choiceProblem(old[1], " ")).toBe(
      "Write why first: “reject” needs a reason.",
    );
    expect(choiceProblem(old[1], "because")).toBe("");
    expect(choiceProblem(undefined, "")).toBe("Choose one first.");
  });

  it("is in the SDK, for the plugins", () => {
    expect(sdk.parseQuestions).toBe(parseQuestions);
    expect(sdk.answersMessage).toBe(answersMessage);
    expect(sdk.answersOf).toBe(answersOf);
    expect(typeof sdk.ChoiceForm).toBe("function");
  });
});

const CHOICES: ChoiceInfo[] = [
  {
    name: "retry",
    label: "Try again",
    description: "one more round, with your note",
    why: "optional",
    default: true,
  },
  {
    name: "skip",
    label: "Skip it for now",
    description: "move AC-002 to the end of the list",
    why: "required",
    default: false,
  },
  {
    name: "stop",
    label: "Stop the flow",
    description: "the commits so far stay",
    why: "none",
    default: false,
  },
];

describe("ChoiceForm", () => {
  it("one card per choice with its description; the default is marked and picked first", () => {
    render(<ChoiceForm id="t" choices={CHOICES} onSend={() => undefined} />);
    const group = screen.getByRole("radiogroup", { name: "Choose one" });
    const cards = within(group).getAllByRole("radio");
    expect(cards.map((c) => c.textContent)).toEqual([
      "1Try againdefaultone more round, with your note",
      "2Skip it for nowneeds a reasonmove AC-002 to the end of the list",
      "3Stop the flowthe commits so far stay",
    ]);
    expect(cards[0]).toHaveAttribute("aria-checked", "true");
    expect(cards[0]).toHaveClass("default");
    expect(
      screen.getByRole("button", { name: "Send: Try again" }),
    ).toBeInTheDocument();
  });

  it("a choice that needs a reason: Send is refused with a line that says so until it has text", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChoiceForm id="t" choices={CHOICES} onSend={onSend} />);
    await user.click(screen.getByRole("radio", { name: /Skip it for now/ }));
    const why = screen.getByLabelText("Why (needed for “Skip it for now”)");
    await user.click(
      screen.getByRole("button", { name: "Send: Skip it for now" }),
    );
    expect(onSend).not.toHaveBeenCalled();
    expect(screen.getByRole("alert")).toHaveTextContent(
      "Write why first: “Skip it for now” needs a reason.",
    );
    expect(why).toHaveFocus();
    await user.type(why, "blocked by AC-003");
    expect(screen.queryByRole("alert")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Send: Skip it for now" }),
    );
    expect(onSend).toHaveBeenCalledWith("skip", "blocked by AC-003");
  });

  it("an optional reason shows the box as optional; a choice without one shows no box", async () => {
    const user = userEvent.setup();
    const onSend = vi.fn();
    render(<ChoiceForm id="t" choices={CHOICES} onSend={onSend} />);
    expect(screen.getByLabelText("Why (optional)")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Send: Try again" }));
    expect(onSend).toHaveBeenLastCalledWith("retry", "");
    await user.click(screen.getByRole("radio", { name: /Stop the flow/ }));
    expect(screen.queryByRole("textbox")).not.toBeInTheDocument();
    await user.click(
      screen.getByRole("button", { name: "Send: Stop the flow" }),
    );
    expect(onSend).toHaveBeenLastCalledWith("stop", "");
  });

  it("the number keys pick a choice while the form has the focus, not while typing", async () => {
    const user = userEvent.setup();
    render(<ChoiceForm id="t" choices={CHOICES} onSend={() => undefined} />);
    screen.getByRole("radio", { name: /Try again/ }).focus();
    await user.keyboard("3");
    expect(
      screen.getByRole("radio", { name: /Stop the flow/ }),
    ).toHaveAttribute("aria-checked", "true");
    await user.keyboard("1");
    await user.type(screen.getByLabelText("Why (optional)"), "2");
    expect(screen.getByRole("radio", { name: /Try again/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByLabelText("Why (optional)")).toHaveValue("2");
  });
});

function Form({ questions }: { questions: ClarifyQuestion[] }) {
  const [picked, setPicked] = useState<ClarifyAnswers>({});
  const [typed, setTyped] = useState<ClarifyAnswers>({});
  return (
    <>
      <ClarifyForm
        questions={questions}
        picked={picked}
        typed={typed}
        onPick={(id, v) => setPicked((p) => ({ ...p, [id]: v }))}
        onType={(id, t) => setTyped((p) => ({ ...p, [id]: t }))}
      />
      <pre data-testid="sent">
        {JSON.stringify(answersOf(questions, picked, typed))}
      </pre>
    </>
  );
}

describe("ClarifyForm", () => {
  it("shows the recommended option first; a multiple question starts with its recommended options ticked", () => {
    render(<Form questions={INIT} />);
    const run = screen.getByRole("radiogroup", {
      name: "How does the project run?",
    });
    expect(
      within(run)
        .getAllByRole("radio")
        .map((r) => r.textContent),
    ).toEqual(["docker composerecommended", "locally"]);
    const pages = screen.getByRole("group", { name: "Which knowledge pages?" });
    expect(
      within(pages)
        .getAllByRole("checkbox")
        .map((c) => c.getAttribute("aria-checked")),
    ).toEqual(["true", "true", "false"]);
    expect(screen.getByRole("status")).toHaveTextContent("1 of 2 answered");
    expect(screen.getByTestId("sent")).toHaveTextContent(
      '{"knowledge":["architecture","domain"]}',
    );
  });

  it("once touched, a multiple question keeps what the person ticked (even nothing)", async () => {
    const user = userEvent.setup();
    render(<Form questions={INIT} />);
    await user.click(screen.getByRole("checkbox", { name: /domain/ }));
    await user.click(screen.getByRole("checkbox", { name: /data/ }));
    expect(screen.getByTestId("sent")).toHaveTextContent(
      '{"knowledge":["architecture","data"]}',
    );
    await user.click(screen.getByRole("checkbox", { name: /architecture/ }));
    await user.click(screen.getByRole("checkbox", { name: /data/ }));
    expect(
      screen.getByRole("checkbox", { name: /architecture/ }),
    ).toHaveAttribute("aria-checked", "false");
    expect(screen.getByTestId("sent")).toHaveTextContent("{}");
  });

  it("the number keys pick in the focused question (the shown order), not while typing", async () => {
    const user = userEvent.setup();
    render(<Form questions={INIT} />);
    screen.getByRole("radio", { name: /docker compose/ }).focus();
    await user.keyboard("2");
    expect(screen.getByRole("radio", { name: /locally/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    screen.getByRole("checkbox", { name: /architecture/ }).focus();
    await user.keyboard("3");
    expect(screen.getByRole("checkbox", { name: /data/ })).toHaveAttribute(
      "aria-checked",
      "true",
    );
    expect(screen.getByRole("radio", { name: /locally/ })).toHaveAttribute(
      "aria-checked",
      "true",
    ); // the other question stays
    await user.type(
      screen.getByLabelText("Your own answer to: Which knowledge pages?"),
      "1",
    );
    expect(screen.getByTestId("sent")).toHaveTextContent(
      '{"run":"locally","knowledge":["architecture","domain","data","1"]}',
    );
    expect(screen.getByRole("status")).toHaveTextContent("2 of 2 answered");
  });
});
