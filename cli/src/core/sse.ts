// Server-sent events in Node, for keel's one stream (GET /api/events): the twin of the web's EventSource use in
// web/src/state.tsx. A small parser (the SSE wire format: event, data, id, comments) and a subscription over fetch
// that reconnects with a growing wait (1 s, 2 s, 4 s … 30 s), like the web.

export type SseMessage = { event: string; data: string; id?: string };
export type LiveState = "connecting" | "live" | "reconnecting" | "closed";

/** Turns the text of a stream, in chunks of any size, into messages. */
export class SseParser {
  private buf = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;

  push(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // a lone \r at the very end may be the first half of \r\n: wait for the next chunk
      if (m[0] === "\r" && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      if (line === "") {
        if (this.data.length) out.push({ event: this.event || "message", data: this.data.join("\n"), ...(this.id ? { id: this.id } : {}) });
        this.event = "";
        this.data = [];
        continue;
      }
      if (line.startsWith(":")) continue;                     // a comment: "connected", "ping"
      const i = line.indexOf(":");
      const field = i < 0 ? line : line.slice(0, i);
      let value = i < 0 ? "" : line.slice(i + 1);
      if (value.startsWith(" ")) value = value.slice(1);
      if (field === "event") this.event = value;
      else if (field === "data") this.data.push(value);
      else if (field === "id") this.id = value;
    }
    return out;
  }
}

export type Subscription = { close: () => void };

/** Follows `url` until close(): each message to `onMessage`, the connection's state to `onState`. */
export function subscribe(url: string, onMessage: (m: SseMessage) => void, opts: {
  onState?: (s: LiveState) => void; headers?: () => Record<string, string>; fetch?: typeof fetch; maxWait?: number;
} = {}): Subscription {
  const f = opts.fetch ?? fetch;
  let closed = false;
  let attempt = 0;
  let ctrl: AbortController | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const state = (s: LiveState) => opts.onState?.(s);

  const run = async () => {
    if (closed) return;
    ctrl = new AbortController();
    try {
      const res = await f(url, { headers: { accept: "text/event-stream", ...(opts.headers?.() ?? {}) }, signal: ctrl.signal });
      if (!res.ok || !res.body) throw new Error(`events: ${res.status}`);
      attempt = 0;
      state("live");
      const parser = new SseParser();
      const decoder = new TextDecoder();
      const reader = res.body.getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        for (const m of parser.push(decoder.decode(value, { stream: true }))) onMessage(m);
      }
    } catch {
      /* the stream broke or keel is away: try again below */
    }
    if (closed) return;
    state("reconnecting");
    const wait = Math.min(opts.maxWait ?? 30000, 1000 * 2 ** attempt++);
    timer = setTimeout(() => void run(), wait);
  };
  state("connecting");
  void run();
  return {
    close: () => {
      closed = true;
      if (timer) clearTimeout(timer);
      ctrl?.abort();
      state("closed");
    },
  };
}
