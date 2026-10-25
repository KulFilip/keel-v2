import type { FetchLike } from "../../src/api/client";

export interface Seen {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

/** A fake fetch: answers queued in order, every request kept. */
export function fakeFetch(answers: (Response | Error | (() => Response))[]): { fetch: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  const fetch: FetchLike = async (url, init) => {
    seen.push({
      url,
      method: init?.method ?? "GET",
      headers: { ...((init?.headers as Record<string, string>) ?? {}) },
      body: typeof init?.body === "string" ? init.body : undefined,
    });
    const a = answers.shift();
    if (!a) throw new Error("no more answers");
    if (a instanceof Error) throw a;
    return typeof a === "function" ? a() : a;
  };
  return { fetch, seen };
}

export const json = (status: number, body: unknown, type = "application/json"): Response =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": type } });

/** A streamed body that sends these chunks, then ends (or stays open when `hang`). */
export function streamOf(chunks: string[], hang = false): Response {
  const enc = new TextEncoder();
  const body = new ReadableStream<Uint8Array>({
    start(c) {
      for (const ch of chunks) c.enqueue(enc.encode(ch));
      if (!hang) c.close();
    },
  });
  return new Response(body, { status: 200, headers: { "Content-Type": "text/event-stream" } });
}
