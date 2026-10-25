// keel 0.18.55 a project keel does not know yet (no .keel/config.yml): the start box and /flow offer /flow init, and
// another flow asks once (Run init first / Start anyway). A project keel knows, or a keel that does not say, is as before.
import { describe, expect, it } from "vitest";
import { run } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { startLines } from "../src/core/lines";
import { PLAIN } from "../src/core/theme";
import { stubKeel } from "./stub";

async function core(configured?: boolean, flow = true) {
  const stub = stubKeel();
  stub.state.configured = configured;
  if (!flow)
    stub.state.thread = {
      ...stub.state.thread,
      status: "done",
      waiting: undefined,
    };
  const c = new KeelCore({
    url: "http://keel.test",
    fetch: stub.fetch,
    noLive: true,
  });
  await c.start();
  return { stub, ctx: { core: c, width: 100 } };
}

const starts = (stub: ReturnType<typeof stubKeel>) =>
  stub.calls.filter(
    (x) => x.method === "POST" && x.path === "/api/projects/demo/flows",
  );

describe("init for a project keel does not know yet", () => {
  it("the start box says /flow init", async () => {
    const { ctx } = await core(false);
    const box = startLines(ctx.core.snapshot, 100, PLAIN).join("\n");
    expect(box).toContain(
      "setup    keel does not know this project yet: /flow init sets it up",
    );
    const known = await core(true);
    expect(
      startLines(known.ctx.core.snapshot, 100, PLAIN).join("\n"),
    ).not.toContain("/flow init");
    const older = await core(undefined);
    expect(
      startLines(older.ctx.core.snapshot, 100, PLAIN).join("\n"),
    ).not.toContain("/flow init");
  });

  it("/flow puts init first, recommended, and /flow init starts it without asking for an idea", async () => {
    const { ctx, stub } = await core(false);
    const r = await run(ctx, "/flow");
    expect(r.pick?.title).toContain("keel does not know this project yet");
    expect(r.pick?.choices.map((x) => x.label)).toEqual([
      "init (recommended)",
      "feature",
    ]);
    const started = await r.pick!.then("init");
    expect(started.blocks[0].kind).toBe("ok");
    expect(starts(stub)[0].body).toMatchObject({
      workflow_id: "init",
      title: "Set up keel for demo",
    });
  });

  it("another flow asks once: Start anyway starts it, Run init first starts init instead", async () => {
    const { ctx, stub } = await core(false);
    const r = await run(ctx, "/flow feature Add a /health endpoint");
    expect(r.pick?.title).toBe("keel does not know this project yet");
    expect(r.pick?.choices.map((x) => x.label)).toEqual([
      "Run init first (recommended)",
      "Start anyway",
    ]);
    expect(starts(stub)).toHaveLength(0);
    await r.pick!.then("anyway");
    expect(starts(stub)[0].body).toMatchObject({
      workflow_id: "feature",
      title: "Add a /health endpoint",
    });

    const r2 = await run(ctx, "/flow feature Add a logger");
    await r2.pick!.then("init");
    expect(starts(stub)[1].body).toMatchObject({ workflow_id: "init" });
  });

  it("a project keel knows starts as before", async () => {
    const { ctx, stub } = await core(true);
    const r = await run(ctx, "/flow feature Add a /health endpoint");
    expect(r.pick).toBeUndefined();
    expect(starts(stub)[0].body).toMatchObject({ workflow_id: "feature" });
  });

  it("/next with no flow on such a project names /flow init", async () => {
    const { ctx } = await core(false, false);
    ctx.core.snapshot.flow = { thread: null, workflow: null } as never;
    const box = startLines(ctx.core.snapshot, 100, PLAIN).join("\n");
    expect(box).toContain("start with /flow init (recommended)");
  });
});
