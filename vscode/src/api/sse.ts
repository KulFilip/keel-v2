import type { FetchLike } from "./client";
import type { EngineEvent } from "./models";

/** One server-sent event: its name (`event:`, "message" when none), its data lines joined by "\n", and its id. */
export interface SseMessage {
  event: string;
  data: string;
  id?: string;
}

/**
 * The text/event-stream format, fed chunk by chunk: a chunk may end anywhere, even between "\r" and "\n" or in the
 * middle of a field. Comments (": ping") are skipped; a blank line ends an event.
 */
export class SseParser {
  private buf = "";
  private data: string[] = [];
  private event = "";
  private id: string | undefined;
  /** The last id seen (sent back as Last-Event-ID on a reconnect). */
  lastId: string | undefined;

  feed(chunk: string): SseMessage[] {
    this.buf += chunk;
    const out: SseMessage[] = [];
    let start = 0;
    for (;;) {
      let i = start;
      while (
        i < this.buf.length &&
        this.buf[i] !== "\n" &&
        this.buf[i] !== "\r"
      )
        i++;
      if (i >= this.buf.length) break; // no full line yet
      // "\r" as the last char: it may be the first half of "\r\n", so wait for the next chunk
      if (this.buf[i] === "\r" && i === this.buf.length - 1) break;
      const line = this.buf.slice(start, i);
      start = this.buf[i] === "\r" && this.buf[i + 1] === "\n" ? i + 2 : i + 1;
      const m = this.line(line);
      if (m) out.push(m);
    }
    this.buf = this.buf.slice(start);
    return out;
  }

  /** Clears a half-read event (a new connection starts clean). */
  reset(): void {
    this.buf = "";
    this.data = [];
    this.event = "";
    this.id = undefined;
  }

  private line(line: string): SseMessage | undefined {
    if (line === "") {
      if (this.data.length === 0) {
        this.event = "";
        return undefined;
      }
      const m: SseMessage = {
        event: this.event || "message",
        data: this.data.join("\n"),
        id: this.id,
      };
      if (this.id !== undefined) this.lastId = this.id;
      this.data = [];
      this.event = "";
      return m;
    }
    if (line.startsWith(":")) return undefined;
    const colon = line.indexOf(":");
    const field = colon < 0 ? line : line.slice(0, colon);
    let value = colon < 0 ? "" : line.slice(colon + 1);
    if (value.startsWith(" ")) value = value.slice(1);
    switch (field) {
      case "data":
        this.data.push(value);
        break;
      case "event":
        this.event = value;
        break;
      case "id":
        if (!value.includes("\0")) this.id = value;
        break;
      default:
        break; // retry and unknown fields: not used
    }
    return undefined;
  }
}

/** An SSE message as an engine event: its JSON data, the type from the data or else the event name. */
export function toEngineEvent(m: SseMessage): EngineEvent {
  try {
    const v = JSON.parse(m.data) as EngineEvent;
    if (v && typeof v === "object" && !Array.isArray(v))
      return v.type ? v : { ...v, type: m.event };
  } catch {
    // not JSON: only its name is known
  }
  return { type: m.event };
}

export interface LiveStreamOptions {
  fetch?: FetchLike;
  url: () => string;
  headers: () => Record<string, string>;
  onEvent: (ev: EngineEvent) => void;
  /** true once a connection is open (each reconnect too: reload then), false when it drops. */
  onState: (connected: boolean) => void;
  /** keel refused the sign-in (401 / 403): the stream stops until it is started again. */
  onRefused?: (status: number) => void;
  /** Milliseconds to wait before the attempt-th reconnect. */
  backoff?: (attempt: number) => number;
  sleep?: (ms: number, signal: AbortSignal) => Promise<void>;
  /** No byte for this long (keel pings every 20 s): the connection is dead, open a new one. */
  idleMs?: number;
}

export const defaultBackoff = (attempt: number): number =>
  Math.min(30_000, 1000 * 2 ** Math.min(attempt, 5));

const abortableSleep = (ms: number, signal: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const t = setTimeout(done, ms);
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done);
  });

/**
 * keel's live stream (GET /api/events): one fetch with a streamed body, parsed as it comes. When it ends or fails it
 * reconnects with a growing pause and subscribes again (with Last-Event-ID when keel sent ids); each new connection
 * says `onState(true)` so the screens reload what they may have missed.
 */
export class LiveStream {
  private ctrl: AbortController | undefined;
  private running = false;
  private connected = false;
  readonly parser = new SseParser();

  constructor(private readonly o: LiveStreamOptions) {}

  get isConnected(): boolean {
    return this.connected;
  }

  get isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) return;
    this.running = true;
    const ctrl = new AbortController();
    this.ctrl = ctrl;
    void this.loop(ctrl.signal);
  }

  stop(): void {
    this.running = false;
    this.ctrl?.abort();
    this.ctrl = undefined;
    this.setConnected(false);
  }

  private setConnected(v: boolean): void {
    if (this.connected === v) return;
    this.connected = v;
    this.o.onState(v);
  }

  private async loop(signal: AbortSignal): Promise<void> {
    const fetchFn =
      this.o.fetch ?? ((u: string, i?: RequestInit) => fetch(u, i));
    const sleep = this.o.sleep ?? abortableSleep;
    const backoff = this.o.backoff ?? defaultBackoff;
    let attempt = 0;
    while (!signal.aborted) {
      let refused = 0;
      // one connection: aborted by stop() or by the idle watchdog
      const conn = new AbortController();
      const onAbort = () => conn.abort();
      signal.addEventListener("abort", onAbort);
      const idleMs = this.o.idleMs ?? 60_000;
      let idle: ReturnType<typeof setTimeout> | undefined;
      const kick = () => {
        if (idle) clearTimeout(idle);
        idle = setTimeout(() => conn.abort(), idleMs);
      };
      try {
        const headers = { ...this.o.headers() };
        if (this.parser.lastId) headers["Last-Event-ID"] = this.parser.lastId;
        kick();
        const res = await fetchFn(this.o.url(), { headers, signal: conn.signal });
        if (res.status === 401 || res.status === 403) {
          refused = res.status;
        } else if (!res.ok || !res.body) {
          throw new Error(`stream answered ${res.status}`);
        } else {
          this.parser.reset();
          attempt = 0;
          this.setConnected(true);
          const reader = res.body.getReader();
          const decoder = new TextDecoder();
          for (;;) {
            const { value, done } = await reader.read();
            if (done) break;
            kick();
            for (const m of this.parser.feed(
              decoder.decode(value, { stream: true }),
            )) {
              try {
                this.o.onEvent(toEngineEvent(m));
              } catch {
                // a listener's error must not end the stream
              }
            }
          }
        }
      } catch {
        // dropped or never opened: try again below
      } finally {
        if (idle) clearTimeout(idle);
        signal.removeEventListener("abort", onAbort);
        conn.abort();
      }
      if (signal.aborted) break;
      this.setConnected(false);
      if (refused) {
        this.running = false;
        this.o.onRefused?.(refused);
        return;
      }
      attempt++;
      await sleep(backoff(attempt), signal);
    }
  }
}
