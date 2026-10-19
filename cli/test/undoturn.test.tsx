// 0.18.19 /undo with no argument undoes KeelBot's last answer (its files back, the question in the prompt, the turn
// dim on screen) and /redo puts it back, as opencode's /undo and /redo (from opencode (MIT),
// tui/src/routes/session/index.tsx); /undo <path> and /undo all still put files back one by one.
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { run } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { blockLines } from "../src/core/lines";
import { makeTheme, PLAIN } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";

const AT = "2026-10-16T10:00:00Z";
const none = makeTheme({ NO_COLOR: "1" }, 0);

const session = (mode = "edit") => ({
  id: "s1",
  project: "demo",
  root: "/work/demo",
  mode,
  title: "b",
  model: { provider: "fake", mode: "api", model: "fake" },
  status: "idle",
  tokens_in: 0,
  tokens_out: 0,
  tokens_cached: 0,
  cost_usd: 0,
  turns: 1,
  created_at: AT,
  updated_at: AT,
});

async function opened(messages: Record<string, unknown>[] = []) {
  const stub = stubKeel();
  const core = new KeelCore({
    url: "http://keel.test",
    fetch: stub.fetch,
    noLive: true,
  });
  await core.start();
  stub.state.session = session();
  stub.state.messages = messages;
  await core.openChat("s1");
  return { stub, core };
}

const turn = [
  { n: 1, role: "user", text: "add b", data: {}, at: AT },
  {
    n: 2,
    role: "helper",
    text: "Added b.",
    call_id: "call-9",
    data: {},
    at: AT,
  },
];

describe("/undo and /redo of a whole answer", () => {
  it("/undo with no argument calls undo-turn and gives the question back for the prompt", async () => {
    const { stub, core } = await opened(structuredClone(turn));
    const r = await run({ core, width: 100 }, "/undo");
    expect(
      stub.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/api/projects/demo/helper/sessions/s1/undo-turn",
      ),
    ).toBe(true);
    expect(r.blocks.map((b) => b.text).join("\n")).toContain(
      "undid the last answer: 3 files restored",
    );
    expect(r.prompt).toBe("add b");
    expect(r.revert).toEqual({ undo: true, text: "add b" });
    const again = await run({ core, width: 100 }, "/undo");
    expect(again.blocks[0].kind).toBe("error");
    expect(again.blocks[0].text).toContain("Nothing to undo");
  });

  it("/redo calls redo-turn and says what came back", async () => {
    const { stub, core } = await opened(structuredClone(turn));
    await run({ core, width: 100 }, "/undo");
    stub.state.turnFiles = ["src/b.ts"];
    const r = await run({ core, width: 100 }, "/redo");
    expect(
      stub.calls.some(
        (c) =>
          c.method === "POST" &&
          c.path === "/api/projects/demo/helper/sessions/s1/redo-turn",
      ),
    ).toBe(true);
    expect(r.blocks.map((b) => b.text).join("\n")).toContain(
      "redid the answer: 1 file restored",
    );
    expect(r.revert).toEqual({ undo: false, text: "add b" });
    expect(r.prompt).toBeUndefined();
  });

  it("/undo <path> and /undo all still put files back one by one", async () => {
    const { stub, core } = await opened(structuredClone(turn));
    stub.state.changes = [
      {
        path: "src/app.ts",
        status: "modified",
        added: 1,
        removed: 1,
        diff: "",
      },
    ];
    await run({ core, width: 100 }, "/undo src/app.ts");
    expect(stub.calls.find((c) => c.path.endsWith("/s1/undo"))!.body).toEqual({
      path: "src/app.ts",
    });
    await run({ core, width: 100 }, "/undo all");
    expect(
      stub.calls.filter((c) => c.path.endsWith("/s1/undo")).map((c) => c.body),
    ).toEqual([{ path: "src/app.ts" }, {}]);
    expect(stub.calls.some((c) => c.path.endsWith("/undo-turn"))).toBe(false);
  });

  it("with no chat there is nothing to undo or redo", async () => {
    const stub = stubKeel();
    const core = new KeelCore({
      url: "http://keel.test",
      fetch: stub.fetch,
      noLive: true,
    });
    await core.start();
    expect((await run({ core, width: 100 }, "/undo")).blocks[0].text).toContain(
      "nothing to undo",
    );
    expect((await run({ core, width: 100 }, "/redo")).blocks[0].text).toContain(
      "nothing to redo",
    );
  });

  it("a reverted block is drawn dim, and the person's message says it is undone", () => {
    expect(
      blockLines({ kind: "user", text: "add b", reverted: true }, 40, PLAIN),
    ).toEqual(["", " ↶ add b  (undone)"]);
    expect(
      blockLines(
        { kind: "markdown", text: "Added **b**.", reverted: true },
        40,
        PLAIN,
      ),
    ).toEqual(["  Added **b**."]);
  });

  it("an opened chat shows its undone turn dim", async () => {
    const msgs = structuredClone(turn).map((m) => ({
      ...m,
      data: { reverted: true },
    }));
    const { core } = await opened(msgs);
    const pick = (await run({ core, width: 100 }, "/chats")).pick!;
    const r = await pick.then("s1");
    expect(r.blocks.filter((b) => b.reverted).map((b) => b.text)).toEqual([
      "add b",
      "Added b.",
    ]);
  });
});

describe("/undo on keel TUI's screen", () => {
  it("puts the question back in the prompt and marks the turn undone, /redo takes the mark away", async () => {
    const stub = stubKeel();
    const core = new KeelCore({
      url: "http://keel.test",
      fetch: stub.fetch,
      noLive: true,
    });
    const probe: Probe = {
      started: false,
      busy: false,
      pick: false,
      ask: false,
      chatBusy: false,
      answers: 0,
    };
    const r = render(
      <App core={core} probe={probe} width={80} rows={40} theme={none} />,
    );
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    const type = async (s: string) => {
      r.stdin.write(s);
      await tick(40);
    };
    const enter = async () => {
      r.stdin.write("\r");
      await tick(40);
      await waitFor(() => !probe.busy);
      await tick(40);
    };
    await waitFor(() => probe.started);
    await type("/mode edit");
    await enter();
    await type("add b");
    await enter();
    await waitFor(() => probe.chatBusy);
    stub.answer("Added b.");
    core.onMessage({
      event: "helper.finished",
      data: JSON.stringify({
        type: "helper.finished",
        thread_id: "s1",
        project_id: "demo",
        at: "x",
        data: {},
      }),
    });
    await waitFor(() => frame().includes("Added b."));
    await type("/undo");
    await enter();
    await waitFor(() =>
      frame().includes("undid the last answer: 3 files restored"),
    );
    const f = frame();
    expect(f).toContain("↶ add b  (undone)");
    expect(f).toMatch(/│ › add b +│/); // the question is back in the prompt, not sent
    expect(stub.state.messages.filter((m) => m.role === "user")).toHaveLength(1);
    await type("\x15"); // Ctrl+U: the prompt is empty again
    await type("/redo");
    await enter();
    await waitFor(() => frame().includes("redid the answer"));
    expect(frame()).not.toContain("(undone)");
    r.unmount();
  });
});
