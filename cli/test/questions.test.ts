// keel 0.18.13 one way to ask, in keel TUI: a gate's named choices with the engine's words (choice_info), a reason only
// where the picked choice needs one, `/answer id=a,b` for a question that takes several, and KeelBot's answer button.
import { describe, expect, it } from "vitest";
import { run, type Reply } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import * as fmt from "../src/core/format";
import {
  parseQuestions,
  prepare,
  pressButton,
  question,
  toButton,
} from "../src/core/buttons";
import { stubKeel } from "./stub";

const STUCK = {
  step: "verify_green",
  kind: "fix",
  title: "AC-002 is stuck at verify_green",
  detail: "failed 3 times",
  options: ["approve", "reject"],
  id: "q-stuck",
  choices: ["retry", "skip", "stop"],
  choice_info: [
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
  ],
};

async function waitingOn(waiting: object) {
  const stub = stubKeel();
  stub.state.thread = { ...stub.state.thread, waiting } as never;
  const core = new KeelCore({
    url: "http://keel.test",
    fetch: stub.fetch,
    noLive: true,
  });
  await core.start();
  return {
    stub,
    ctx: { core, width: 100 },
    acts: () =>
      stub.calls.filter(
        (c) => c.method === "POST" && c.path === "/api/inbox/t1/act",
      ),
  };
}

describe("a gate's named choices (choice_info)", () => {
  it("the waiting lines, /status and /next name each choice: its label, what it does, the default, the reason it needs", () => {
    const w = STUCK as never;
    expect(fmt.choiceLines(w)).toEqual([
      "1. Try again (retry) · default · reason optional — one more round, with your note",
      "2. Skip it for now (skip) · needs a reason — move AC-002 to the end of the list",
      "3. Stop the flow (stop) — the commits so far stay",
    ]);
    expect(fmt.waitingLines(w).join("\n")).toContain(
      "2. Skip it for now (skip) · needs a reason",
    );
    const s = stubKeel();
    const view = {
      thread: { ...s.state.thread, waiting: STUCK } as never,
      workflow: s.workflow as never,
    };
    const status = fmt.status({ id: "demo", branch: "x" } as never, view);
    expect(status).toMatch(
      /\/answer skip <why> +Skip it for now — move AC-002/,
    );
    expect(status).toMatch(/\/answer retry \[why\] +Try again \(default\)/);
    expect(status).not.toContain("/approve ");
    // a stuck criterion (kind fix) is answered with its choices, not "approve to try again"
    expect(fmt.next({ id: "demo", branch: "x" } as never, view)).toContain(
      "/answer <retry | skip | stop>",
    );
    // an older engine without choice_info: the raw names, as before
    expect(
      fmt.choiceLines({ ...STUCK, choice_info: undefined } as never),
    ).toEqual([]);
  });

  it("/answer <choice> refuses a choice that needs a reason without one, and sends it with one", async () => {
    const { ctx, acts } = await waitingOn(STUCK);
    expect((await run(ctx, "/answer skip")).blocks[0]).toEqual({
      kind: "error",
      text: "Skip it for now needs a reason: /answer skip <why>.",
    });
    expect(acts()).toHaveLength(0);
    expect((await run(ctx, "/answer nope")).blocks[0].text).toBe(
      "Choose one of: retry, skip, stop",
    );
    expect(
      (await run(ctx, "/answer skip it needs the queue first")).blocks[0].kind,
    ).toBe("ok");
    expect(acts()[0].body).toEqual({
      decision: "approve",
      why: "it needs the queue first",
      payload: { choice: "skip" },
      id: "q-stuck",
    });
  });

  it("/answer alone: a pick with the labels and descriptions, on the default; a reason asked only where it is needed", async () => {
    const { ctx, acts } = await waitingOn(STUCK);
    const r = await run(ctx, "/answer");
    expect(r.pick?.choices).toEqual([
      {
        label: "Try again (default)",
        value: "retry",
        hint: "one more round, with your note",
      },
      {
        label: "Skip it for now · needs a reason",
        value: "skip",
        hint: "move AC-002 to the end of the list",
      },
      {
        label: "Stop the flow",
        value: "stop",
        hint: "the commits so far stay",
      },
    ]);
    expect(r.pick?.index).toBe(0);
    // needs a reason: asked, and asked again while empty
    const ask = (await r.pick!.then("skip")) as Reply;
    expect(ask.ask?.prompt).toBe("Why Skip it for now? (needed)");
    const again = (await ask.ask!.then("  ")) as Reply;
    expect(again.blocks[0]).toEqual({
      kind: "error",
      text: "Skip it for now needs a reason.",
    });
    expect(acts()).toHaveLength(0);
    expect(
      ((await again.ask!.then("blocked by AC-003")) as Reply).blocks[0].kind,
    ).toBe("ok");
    expect(acts()[0].body).toMatchObject({
      decision: "approve",
      why: "blocked by AC-003",
      payload: { choice: "skip" },
    });
  });

  it("a choice that needs no reason is sent at once; an optional reason may be left empty", async () => {
    const a = await waitingOn(STUCK);
    const r = await run(a.ctx, "/answer");
    expect(((await r.pick!.then("stop")) as Reply).blocks[0].kind).toBe("ok");
    expect(a.acts()[0].body).toEqual({
      decision: "approve",
      payload: { choice: "stop" },
      id: "q-stuck",
    });
    const b = await waitingOn(STUCK);
    const r2 = await run(b.ctx, "/answer");
    const ask = (await r2.pick!.then("retry")) as Reply;
    expect(ask.ask?.prompt).toBe(
      "Why Try again? (optional: Enter sends without)",
    );
    expect(((await ask.ask!.then("")) as Reply).blocks[0].kind).toBe("ok");
    expect(b.acts()[0].body).toEqual({
      decision: "approve",
      payload: { choice: "retry" },
      id: "q-stuck",
    });
  });

  it("an older engine (no choice_info): the raw names, and a reject still needs its reason", async () => {
    const { ctx, acts } = await waitingOn({
      ...STUCK,
      choices: ["fix", "reject"],
      choice_info: undefined,
      kind: "gate",
    });
    const r = await run(ctx, "/answer");
    expect(r.pick?.choices.map((c) => c.label)).toEqual([
      "fix (default)",
      "reject · needs a reason",
    ]);
    expect((await run(ctx, "/answer reject")).blocks[0].kind).toBe("error");
    expect((await run(ctx, "/answer fix")).blocks[0].kind).toBe("ok");
    expect(acts()[0].body).toMatchObject({ payload: { choice: "fix" } });
  });
});

describe("/answer for questions", () => {
  it("id=a,b sends a list for a question that takes several; one that takes one keeps its words", async () => {
    const { ctx, acts } = await waitingOn({
      step: "questions",
      kind: "clarify",
      title: "Three questions",
      detail: "",
      options: ["approve"],
      id: "q-init",
      questions: [
        {
          id: "run",
          question: "How does it run?",
          options: [
            { label: "docker compose", recommended: true },
            { label: "locally" },
          ],
        },
        {
          id: "knowledge",
          question: "Which pages?",
          multiple: true,
          options: [
            { label: "architecture", recommended: true },
            { label: "domain" },
            { label: "data" },
          ],
        },
      ],
    });
    expect(
      (
        await run(
          ctx,
          '/answer knowledge=architecture,data run="docker compose, with a seed"',
        )
      ).blocks[0].kind,
    ).toBe("ok");
    expect(acts()[0].body).toEqual({
      decision: "approve",
      payload: {
        answers: {
          knowledge: ["architecture", "data"],
          run: "docker compose, with a seed",
        },
      },
      id: "q-init",
    });
  });
});

describe("KeelBot's answer button (keel-flow answer)", () => {
  it("reads answers or a choice, asks yes / no in words, and sends the answer like the Flow page", async () => {
    const answers = toButton(
      "flow",
      '{"do": "answer", "flow": "t1", "answers": {"knowledge": ["architecture", "data"], "run": "docker compose"}}',
    );
    expect(answers).toEqual({
      kind: "answer",
      flow: "t1",
      answers: { knowledge: ["architecture", "data"], run: "docker compose" },
      why: undefined,
    });
    expect(question(answers!, () => '"Set up"')).toBe(
      'KeelBot suggests: answer "Set up" with knowledge → architecture, data; run → docker compose?',
    );
    expect(toButton("flow", '{"do": "answer", "flow": "t1"}')).toBeNull(); // nothing to answer: stays text
    const choice = toButton(
      "flow",
      '{"do": "answer", "flow": "t1", "choice": "skip", "why": "blocked by AC-003"}',
    )!;
    expect(question(choice, () => "it")).toBe(
      "KeelBot suggests: answer it with the choice skip (blocked by AC-003)?",
    );
    const { stub, acts } = await waitingOn(STUCK);
    expect(await pressButton(choice, "demo", () => "it")).toContain(
      "answered it (the choice skip)",
    );
    expect(acts()[0].body).toEqual({
      decision: "approve",
      why: "blocked by AC-003",
      payload: { choice: "skip" },
    });
    expect(stub.calls.some((c) => c.path === "/api/inbox/t1/act")).toBe(true);
  });

  it("a choice that needs a reason, given without one, is not offered; the questions' own words show", async () => {
    await waitingOn(STUCK);                                   // prepare reads the flow's question as it waits now
    const prep = await prepare(toButton("flow", '{"do": "answer", "flow": "t1", "choice": "skip"}')!, "demo", () => "it");
    expect(prep).toMatchObject({ error: expect.stringContaining("Skip it for now, which needs a reason") });
    const ok = await prepare(toButton("flow", '{"do": "answer", "flow": "t1", "choice": "stop"}')!, "demo", () => "it");
    expect(ok).toEqual({ title: "KeelBot suggests: answer it with the choice stop?",
      detail: "it waits at: AC-002 is stuck at verify_green\nStop the flow: the commits so far stay" });
  });

  it("parses KeelBot's questions with the dashboard's own parser", () => {
    expect(
      parseQuestions('[{"question": "Where?", "options": ["Web", "iOS"]}]'),
    ).toEqual([
      {
        id: "q1",
        question: "Where?",
        why: undefined,
        multiple: false,
        options: [
          { label: "Web", description: undefined, recommended: true },
          { label: "iOS", description: undefined, recommended: false },
        ],
      },
    ]);
  });
});
