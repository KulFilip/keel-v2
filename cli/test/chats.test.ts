// P1-3 keel TUI's chats: /chats is a picker (newest first, with each chat's last message, age and size, and typing
// narrows it by title or last-message text), /rename names the open chat and /export writes it as Markdown.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { pickMatches, run, type Choice } from "../src/core/commands";
import { KeelCore } from "../src/core/keel";
import { stubKeel } from "./stub";

const NOW = "2026-10-16T12:00:00Z";

const chat = (
  id: string,
  title: string,
  updated_at: string,
  last_message: string,
  message_count: number,
) => ({
  id,
  project: "demo",
  root: "/work/demo",
  mode: "ask",
  title,
  model: { provider: "fake", mode: "api", model: "fake" },
  status: "idle",
  tokens_in: 0,
  tokens_out: 0,
  tokens_cached: 0,
  cost_usd: 0,
  turns: message_count / 2,
  created_at: updated_at,
  updated_at,
  last_message,
  message_count,
});

const core = () => {
  const stub = stubKeel();
  return {
    stub,
    core: new KeelCore({
      url: "http://keel.test",
      fetch: stub.fetch,
      noLive: true,
    }),
  };
};

const threeChats = () => [
  chat("a", "Old chat", "2026-10-14T12:00:00Z", "the tests live in tests/", 4),
  chat(
    "b",
    "Health endpoint",
    "2026-10-16T11:55:00Z",
    "GET /health answers ok",
    6,
  ),
  chat("c", "Ports", "2026-10-16T09:00:00Z", "port 8088 is the api", 2),
];

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(new Date(NOW));
});
afterEach(() => vi.useRealTimers());

describe("/chats", () => {
  it("AC-1 lists the chats newest first with title, last message, age and size", async () => {
    const { core: c, stub } = core();
    await c.start();
    stub.state.sessions = threeChats();
    const r = await run({ core: c, width: 100 }, "/chats");
    const choices = r.pick!.choices;
    expect(choices.map((x) => x.label)).toEqual([
      "Health endpoint",
      "Ports",
      "Old chat",
    ]);
    expect(choices.map((x) => x.value)).toEqual(["b", "c", "a"]);
    expect(choices[0].hint).toContain("GET /health answers ok");
    expect(choices[0].hint).toContain("5m ago");
    expect(choices[0].hint).toContain("6 msgs");
    expect(choices[1].hint).toContain("3h ago");
    expect(choices[2].hint).toContain("2d ago");
    expect(choices[2].hint).toContain("4 msgs");
  });

  it("AC-1 typing narrows the list by title or last-message text", async () => {
    const { core: c, stub } = core();
    await c.start();
    stub.state.sessions = threeChats();
    const choices = (await run({ core: c, width: 100 }, "/chats")).pick!
      .choices;
    const labels = (f: string) =>
      pickMatches(choices, f).map((x: Choice) => x.label);
    expect(labels("")).toEqual(["Health endpoint", "Ports", "Old chat"]);
    expect(labels("ports")).toEqual(["Ports"]); // the title
    expect(labels("tests/")).toEqual(["Old chat"]); // the last message only
    expect(labels("ANSWERS")).toEqual(["Health endpoint"]); // any case
    expect(labels("nothing like it")).toEqual([]);
  });
});
