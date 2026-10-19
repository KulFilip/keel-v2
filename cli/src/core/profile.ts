// keel-tui --profile: how fast keel TUI is on this computer. It records the time to the start screen, each api call's
// latency (by route), how late keel's live events arrive (the time they reach the TUI minus the event's own `at`), how
// long each frame takes to render (React's commit time) and the memory, once a second. On exit: a short summary, and
// the whole record as JSON in a file on this computer. Nothing is sent anywhere.

import { mkdirSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export type Stats = { n: number; p50: number; p95: number; max: number; mean: number };

export function stats(values: number[]): Stats {
  if (!values.length) return { n: 0, p50: 0, p95: 0, max: 0, mean: 0 };
  const v = [...values].sort((a, b) => a - b);
  const at = (q: number) => v[Math.min(v.length - 1, Math.max(0, Math.ceil(q * v.length) - 1))];
  const r = (x: number) => Math.round(x * 10) / 10;
  return { n: v.length, p50: r(at(0.5)), p95: r(at(0.95)), max: r(v[v.length - 1]), mean: r(v.reduce((a, b) => a + b, 0) / v.length) };
}

/** /api/projects/demo/flows/abc123 → /api/projects/{id}/flows/{id}: one route for the latency table. */
export function route(method: string, url: string): string {
  const path = url.replace(/^https?:\/\/[^/]+/, "").split("?")[0];
  const known = new Set(["api", "projects", "threads", "jobs", "helper", "sessions", "inbox", "events", "workflows", "flows", "flow",
    "history", "repo", "files", "graph", "search", "diagrams", "ascii", "health", "tui", "plugins", "approvals", "decide", "runs",
    "budget", "now", "rules", "steps", "turn", "changes", "undo", "undo-turn", "redo-turn", "done", "stop", "act", "resume", "rewind", "git", "status", "log", "diff"]);
  return `${method} ` + path.split("/").map((s) => (!s || known.has(s) ? s : "{id}")).join("/");
}

export class Profiler {
  readonly started = Date.now();
  private t0: number;
  startupMs: number | null = null;
  readonly calls = new Map<string, number[]>();
  readonly lag: number[] = [];
  readonly frames: number[] = [];
  readonly memory: { at: number; rss: number; heap: number }[] = [];
  private timer: ReturnType<typeof setInterval> | null = null;

  /** `t0` is when the process started (ms, from performance.timeOrigin), so the startup counts node's own start too. */
  constructor(t0: number = performance.timeOrigin, private clock: () => number = Date.now) {
    this.t0 = t0;
    this.sample();
    this.timer = setInterval(() => this.sample(), 1000);
    this.timer.unref?.();
  }

  sample() {
    const m = process.memoryUsage();
    this.memory.push({ at: this.clock() - this.started, rss: m.rss, heap: m.heapUsed });
  }

  /** The start screen is on: the time since the process started. */
  ready() {
    if (this.startupMs === null) this.startupMs = Math.round(this.clock() - this.t0);
  }

  /** A fetch that times every call by its route (the SSE stream is not a call: it is counted as live events). */
  wrap(f: typeof fetch): typeof fetch {
    return (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
      const t = performance.now();
      const res = await f(input, init);
      if (!url.includes("/api/events")) {
        const key = route(init?.method ?? "GET", url);
        (this.calls.get(key) ?? this.calls.set(key, []).get(key)!).push(performance.now() - t);
      }
      return res;
    }) as typeof fetch;
  }

  /** A live event arrived: how long after keel made it. */
  event(at: string | undefined) {
    const made = at ? Date.parse(at) : NaN;
    if (!Number.isNaN(made)) this.lag.push(Math.max(0, this.clock() - made));
  }

  /** React finished a frame in `ms` (its Profiler's actualDuration). */
  frame(ms: number) {
    this.frames.push(ms);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.sample();
  }

  report() {
    const routes = [...this.calls.entries()].map(([k, v]) => ({ route: k, ...stats(v) })).sort((a, b) => b.n * b.mean - a.n * a.mean);
    const all = [...this.calls.values()].flat();
    const mb = (b: number) => Math.round((b / 1048576) * 10) / 10;
    return {
      at: new Date(this.started).toISOString(),
      seconds: Math.round((this.clock() - this.started) / 100) / 10,
      startup_ms: this.startupMs,
      api: { ...stats(all), routes },
      sse_lag_ms: stats(this.lag),
      frame_ms: stats(this.frames),
      memory_mb: { rss_max: mb(Math.max(0, ...this.memory.map((m) => m.rss))), heap_max: mb(Math.max(0, ...this.memory.map((m) => m.heap))),
        samples: this.memory.map((m) => ({ s: Math.round(m.at / 100) / 10, rss: mb(m.rss), heap: mb(m.heap) })) },
    };
  }

  /** The summary for the terminal. */
  summary(file: string): string {
    const r = this.report();
    const s = (x: Stats) => (x.n ? `p50 ${x.p50} ms · p95 ${x.p95} ms · max ${x.max} ms (${x.n})` : "none");
    return [
      "keel TUI profile",
      `  startup     ${r.startup_ms ?? "-"} ms to the start screen`,
      `  api calls   ${s(r.api)}`,
      ...r.api.routes.slice(0, 5).map((x) => `    ${x.route.padEnd(48)} ${s(x)}`),
      `  live events ${s(r.sse_lag_ms)} late`,
      `  frames      ${s(r.frame_ms)}`,
      `  memory      rss up to ${r.memory_mb.rss_max} MB · heap up to ${r.memory_mb.heap_max} MB`,
      `  saved       ${file} (on this computer only)`,
    ].join("\n");
  }

  /** Write the record: KEEL_TUI_PROFILE_DIR, else $XDG_STATE_HOME/keel2/tui-profiles, else ~/.local/state/keel2/tui-profiles. */
  save(env: Record<string, string | undefined> = process.env): string {
    this.stop();
    const dir = env.KEEL_TUI_PROFILE_DIR || join(env.XDG_STATE_HOME || join(homedir(), ".local", "state"), "keel2", "tui-profiles");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `profile-${new Date(this.started).toISOString().replace(/[:.]/g, "-")}.json`);
    writeFileSync(file, JSON.stringify(this.report(), null, 1) + "\n");
    return file;
  }
}
