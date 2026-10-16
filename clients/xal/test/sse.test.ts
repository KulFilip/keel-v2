import assert from "node:assert/strict";
import { test } from "node:test";
import { follow, SseParser, type SseMessage } from "../src/sse.ts";

const parse = (chunks: string[]) => {
  const got: SseMessage[] = [];
  const p = new SseParser((m) => got.push(m));
  for (const c of chunks) p.push(c);
  return got;
};

test("named events, comments and multi-line data; chunks split anywhere", () => {
  const stream = ':connected\n\nevent: gate.waiting\ndata: {"a":\ndata: 1}\n\n: ping\n\ndata: plain\n\n';
  const whole = parse([stream]);
  assert.deepEqual(whole, [
    { event: "gate.waiting", data: '{"a":\n1}' },
    { event: "message", data: "plain" },
  ]);
  const bytes = parse(stream.split(""));
  assert.deepEqual(bytes, whole);
});

test("CRLF and CR line ends, a CR split from its LF across chunks, id and no-space values", () => {
  assert.deepEqual(parse(["event:x\r", "\ndata:1\r\nid: 7\r\n\r\n", "event: y\rdata: 2\r\r\n"]), [
    { event: "x", data: "1", id: "7" },
    { event: "y", data: "2", id: "7" },
  ]);
});

const body = (text: string) =>
  new Response(new ReadableStream({ start(c) { c.enqueue(new TextEncoder().encode(text)); c.close(); } }));

test("follow: reads, reconnects with backoff when the stream ends or fails, stops on abort", async () => {
  const stop = new AbortController();
  const got: string[] = [];
  const states: string[] = [];
  const sleeps: number[] = [];
  let opens = 0;
  await follow(
    async () => {
      opens++;
      if (opens === 2) throw new Error("connection refused");
      if (opens === 4) stop.abort();
      return body(`event: e${opens}\ndata: {}\n\n`);
    },
    (m) => got.push(m.event),
    stop.signal,
    (s, why) => states.push(why ? `${s}: ${why}` : s),
    async (ms) => void sleeps.push(ms),
  );
  assert.deepEqual(got, ["e1", "e3", "e4"]);
  assert.deepEqual(states, ["live", "reconnecting: the stream ended", "reconnecting: connection refused", "live", "reconnecting: the stream ended", "live"]);
  assert.deepEqual(sleeps, [1000, 2000, 1000], "doubles after each failure, back to 1 s after a good connection");
});
