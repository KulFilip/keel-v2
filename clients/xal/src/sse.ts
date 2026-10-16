// Server-sent events over fetch (xal runs on Bun, which has no EventSource for this): named events, comments
// (keel's "ping"), reconnect with backoff. The twin of the web's EventSource use in web/src/state.tsx.
// TODO(feat/keel-tui): the keel TUI plans cli/src/sse.ts for the same job; keep one reader once it lands.

export type SseMessage = { event: string; data: string; id?: string };

/** Feeds text chunks, calls `emit` for each complete message. Lines may end in \n, \r\n or \r. */
export class SseParser {
  private buffer = "";
  private event = "";
  private data: string[] = [];
  private id: string | undefined;
  private readonly emit: (m: SseMessage) => void;

  constructor(emit: (m: SseMessage) => void) {
    this.emit = emit;
  }

  push(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buffer);
      if (!m) return;
      // a lone \r at the very end may be the first half of \r\n: wait for the next chunk
      if (m[0] === "\r" && m.index === this.buffer.length - 1) return;
      const line = this.buffer.slice(0, m.index);
      this.buffer = this.buffer.slice(m.index + m[0].length);
      this.line(line);
    }
  }

  private line(line: string): void {
    if (line === "") {
      if (this.data.length) this.emit({ event: this.event || "message", data: this.data.join("\n"), ...(this.id ? { id: this.id } : {}) });
      this.event = "";
      this.data = [];
      return;
    }
    if (line.startsWith(":")) return;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    if (field === "event") this.event = value;
    else if (field === "data") this.data.push(value);
    else if (field === "id") this.id = value;
  }
}

export type Open = (signal: AbortSignal) => Promise<Response>;

/** Reads the stream until `signal` aborts; reconnects after 1, 2, 4 … 30 s. `onState` says live / reconnecting. */
export async function follow(
  open: Open,
  onMessage: (m: SseMessage) => void,
  signal: AbortSignal,
  onState: (state: "live" | "reconnecting", why?: string) => void = () => {},
  sleep: (ms: number, signal: AbortSignal) => Promise<void> = wait,
): Promise<void> {
  let attempt = 0;
  while (!signal.aborted) {
    try {
      const res = await open(signal);
      attempt = 0;
      onState("live");
      const parser = new SseParser(onMessage);
      const reader = res.body!.pipeThrough(new TextDecoderStream()).getReader();
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        parser.push(value);
      }
      if (signal.aborted) return;
      onState("reconnecting", "the stream ended");
    } catch (err) {
      if (signal.aborted) return;
      onState("reconnecting", err instanceof Error ? err.message : String(err));
    }
    await sleep(Math.min(30_000, 1000 * 2 ** attempt++), signal);
  }
}

function wait(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(t);
      resolve();
    }, { once: true });
  });
}
