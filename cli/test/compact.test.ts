// P1-2 AC-3: keel TUI's /compact calls the engine's compact route for the open chat and reports what it did.
import { describe, expect, it } from "vitest";
import { run } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { stubKeel } from "./stub";

const AT = "2026-10-16T10:00:00Z";

const core = () => {
  const stub = stubKeel();
  return { stub, core: new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true }) };
};

describe("/compact", () => {
  it("AC-3 prints what the route answers for the open chat", async () => {
    const { core: c, stub } = core();
    await c.start();
    stub.state.session = { id: "s1", project: "demo", root: "/work/demo", mode: "ask", title: "a long chat", model: { provider: "fake", mode: "api", model: "fake" },
      status: "idle", tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0, turns: 4, created_at: AT, updated_at: AT };
    await c.openChat("s1");
    const r = await run({ core: c, width: 100 }, "/compact");
    const call = stub.calls.find((x) => x.method === "POST" && x.path === "/api/projects/demo/helper/sessions/s1/compact");
    expect(call).toBeTruthy();
    expect(r.blocks.map((b) => b.text).join("\n")).toContain("compacted: 48k → 6k tokens, nothing lost");
  });

  it("AC-3 says there is nothing to compact with no open chat", async () => {
    const { core: c } = core();
    await c.start();
    const r = await run({ core: c, width: 100 }, "/compact");
    expect(r.blocks.map((b) => b.text).join("\n")).toContain("nothing to compact");
  });
});
