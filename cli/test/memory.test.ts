// keel TUI 0.18.19: KeelBot's memory stays in keel's backend. /mode (and Shift+Tab) changes the open chat's mode in
// place where the chat can go on in it (the engine then tells KeelBot of the change); into or out of a side session's
// own worktree it starts a new chat, as before.
import { describe, expect, it } from "vitest";
import { run } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { stubKeel } from "./stub";

const AT = "2026-10-19T12:00:00Z";

const session = (extra: Record<string, unknown> = {}) => ({
  id: "s1", project: "demo", root: "/work/demo", mode: "ask", title: "Where does it start?",
  model: { provider: "fake", mode: "api", model: "fake" }, status: "idle", tokens_in: 0, tokens_out: 0, tokens_cached: 0,
  cost_usd: 0, turns: 1, created_at: AT, updated_at: AT, ...extra,
});

async function open(extra: Record<string, unknown> = {}) {
  const stub = stubKeel();
  const c = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  await c.start();
  stub.state.session = session(extra);
  await c.openChat("s1");
  const say = async (line: string) => (await run({ core: c, width: 100 }, line)).blocks.map((b) => b.text).join("\n");
  const patches = () => stub.calls.filter((x) => x.method === "PATCH" && x.path === "/api/projects/demo/helper/sessions/s1").map((x) => x.body);
  return { stub, c, say, patches };
}

describe("/mode in an open chat", () => {
  it("Ask to Edit and back: the same chat goes on in the new mode", async () => {
    const t = await open();
    expect(await t.say("/mode edit")).toContain("KeelBot: edit mode");
    expect(t.patches()).toEqual([{ mode: "edit" }]);
    expect(t.c.snapshot.chat.session?.id).toBe("s1");
    expect(t.c.snapshot.chat.mode).toBe("edit");
    expect(t.c.snapshot.chat.session?.mode).toBe("edit");
    expect(await t.say("/mode ask")).toContain("This chat goes on in ask mode");
    expect(t.patches()).toEqual([{ mode: "edit" }, { mode: "ask" }]);
  });

  it("into a side session is a new chat (its own worktree); a side chat moves to Ask in place, not to Edit", async () => {
    const t = await open();
    expect(await t.say("/mode side")).toContain("A new chat starts with the next message");
    expect(t.patches()).toEqual([]);
    expect(t.c.snapshot.chat.session).toBeNull();

    const side = await open({ mode: "side", worktree: "/work/demo/.keel/wt/x", branch: "keel/helper/x" });
    expect(await side.say("/mode ask")).toContain("This chat goes on in ask mode");
    expect(side.patches()).toEqual([{ mode: "ask" }]);
    expect(await side.say("/mode edit")).toContain("A new chat starts with the next message");
    expect(side.patches()).toEqual([{ mode: "ask" }]);
    expect(side.c.snapshot.chat.session).toBeNull();
  });
});
