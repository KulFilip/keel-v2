// keel TUI (P1-1): the status line's context meter — "ctx N%" for the open chat's session, how full its model's
// context window is, coloured yellow from 70% and red from 85%; nothing when no chat is open.
import { describe, expect, it } from "vitest";
import { KeelCore } from "../src/core/keel";
import { statusParts, statusSegments } from "../src/ui/parts";
import { stubKeel } from "./stub";

const makeCore = () => {
  const stub = stubKeel();
  return new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
};

/** sets the open chat's session to carry the given context-window fill (ctx_tokens/ctx_window). */
const openChatWith = (core: KeelCore, ctx: { ctx_tokens: number; ctx_window: number }) => {
  core.snapshot = { ...core.snapshot, chat: { ...core.snapshot.chat,
    session: { id: "h1", project: "demo", root: "/work/demo", mode: "ask", title: "chat", model: { provider: "claude", mode: "api", model: "claude-opus" },
      status: "idle", tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0, turns: 1, created_at: "x", updated_at: "x",
      ...ctx } } };
};

describe("AC-3 the status line's context meter", () => {
  it("AC-3 shows ctx 41% for the open chat's session ratio", () => {
    const core = makeCore();
    openChatWith(core, { ctx_tokens: 82_000, ctx_window: 200_000 });
    expect(statusParts(core.snapshot)).toContain("ctx 41%");
  });

  it("AC-3 omits the ctx segment when no chat is open", () => {
    const core = makeCore();
    expect(core.snapshot.chat.session).toBeNull();
    const parts = statusParts(core.snapshot);
    expect(parts.some((p) => p.startsWith("ctx "))).toBe(false);
  });

  it("AC-3 colours the ctx segment yellow from 70% full", () => {
    const core = makeCore();
    openChatWith(core, { ctx_tokens: 140_000, ctx_window: 200_000 });
    const seg = statusSegments(core.snapshot).find((s) => s.text === "ctx 70%");
    expect(seg).toBeTruthy();
    expect(seg?.role).toBe("warn");
  });

  it("AC-3 colours the ctx segment red from 85% full", () => {
    const core = makeCore();
    openChatWith(core, { ctx_tokens: 170_000, ctx_window: 200_000 });
    const seg = statusSegments(core.snapshot).find((s) => s.text === "ctx 85%");
    expect(seg).toBeTruthy();
    expect(seg?.role).toBe("bad");
  });
});
