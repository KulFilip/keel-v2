import { describe, expect, it } from "vitest";
import { LiveStream, SseParser, toEngineEvent } from "../../src/api/sse";
import type { EngineEvent } from "../../src/api/models";
import { fakeFetch, json, streamOf } from "./fakeFetch";

describe("SseParser", () => {
  it("reads events split anywhere across chunks", () => {
    const p = new SseParser();
    const text = 'event: engine\ndata: {"type":"step.started","thread_id":"t1"}\n\n: ping\n\ndata: {"type":"gate.waiting"}\n\n';
    const got = [];
    // every split point, one character at a time
    for (const ch of text) got.push(...p.feed(ch));
    expect(got).toHaveLength(2);
    expect(got[0]).toEqual({ event: "engine", data: '{"type":"step.started","thread_id":"t1"}', id: undefined });
    expect(got[1].event).toBe("message");
  });

  it("joins data lines and handles CRLF split between chunks", () => {
    const p = new SseParser();
    const a = p.feed("id: 7\r\ndata: one\r");
    const b = p.feed("\ndata: two\r\n\r");
    const c = p.feed("\n");
    expect(a).toEqual([]);
    expect(b).toEqual([]);
    expect(c).toEqual([{ event: "message", data: "one\ntwo", id: "7" }]);
    expect(p.lastId).toBe("7");
  });

  it("keeps a half line until it is complete and ignores comments", () => {
    const p = new SseParser();
    expect(p.feed('data: {"type":"tool.r')).toEqual([]);
    expect(p.feed('an"}')).toEqual([]);
    expect(p.feed("\n:comment\n\n")).toEqual([{ event: "message", data: '{"type":"tool.ran"}', id: undefined }]);
  });

  it("turns a message into an engine event", () => {
    expect(toEngineEvent({ event: "helper.delta", data: '{"call_id":"c1","data":{"text":"Hi"}}' })).toEqual({ type: "helper.delta", call_id: "c1", data: { text: "Hi" } });
    expect(toEngineEvent({ event: "engine", data: "not json" })).toEqual({ type: "engine" });
  });
});

describe("LiveStream", () => {
  it("reconnects after the stream ends, resubscribes with Last-Event-ID, and says connected each time", async () => {
    const f = fakeFetch([
      streamOf(['id: 1\ndata: {"type":"step.started"}\n', "\nid: 2\ndata: {\"type\":\"gate.waiting\"}\n\n"]),
      new TypeError("network down"),
      () => streamOf(['data: {"type":"thread.done"}\n\n'], true),
    ]);
    const events: string[] = [];
    const states: boolean[] = [];
    const sleeps: number[] = [];
    let done!: () => void;
    const finished = new Promise<void>((r) => (done = r));
    const s = new LiveStream({
      fetch: f.fetch,
      url: () => "http://192.168.1.20:8088/api/events?project=shop&notify=all",
      headers: () => ({ Authorization: "Bearer t" }),
      onEvent: (e: EngineEvent) => {
        events.push(e.type);
        if (e.type === "thread.done") done();
      },
      onState: (c) => states.push(c),
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
    s.start();
    await finished;
    expect(events).toEqual(["step.started", "gate.waiting", "thread.done"]);
    expect(states).toEqual([true, false, true]);
    expect(sleeps).toEqual([2000, 4000]);
    expect(f.seen).toHaveLength(3);
    expect(f.seen[0].headers["Last-Event-ID"]).toBeUndefined();
    expect(f.seen[2].headers["Last-Event-ID"]).toBe("2");
    expect(f.seen[2].headers.Authorization).toBe("Bearer t");
    s.stop();
    expect(states).toEqual([true, false, true, false]);
    expect(s.isRunning).toBe(false);
  });

  it("stops on a refused sign-in instead of retrying", async () => {
    const f = fakeFetch([json(401, { error: "Sign in" })]);
    let refused = 0;
    await new Promise<void>((resolve) => {
      const s = new LiveStream({
        fetch: f.fetch,
        url: () => "http://x/api/events",
        headers: () => ({}),
        onEvent: () => undefined,
        onState: () => undefined,
        onRefused: (st) => {
          refused = st;
          resolve();
        },
        sleep: async () => undefined,
      });
      s.start();
    });
    expect(refused).toBe(401);
    expect(f.seen).toHaveLength(1);
  });
});
