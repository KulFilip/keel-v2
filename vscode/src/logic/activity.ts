// A flow's live activity: engine events and agent steps as one line each, and who runs now. A port of the JetBrains
// plugin's Activity.kt (pure: the unit tests read it without VS Code).

import type { EngineEvent, JobRow, JobStep } from "../api/models";
import { firstLine, ktokens, parseTime, usd } from "./format";

export type ActKind =
  | "read"
  | "edit"
  | "command"
  | "test"
  | "guard"
  | "gate"
  | "step"
  | "agent"
  | "text"
  | "error";

/** The feed filter. */
export type ActFilter = "all" | "edits" | "commands" | "tests";

export const ACT_FILTERS: { id: ActFilter; label: string }[] = [
  { id: "all", label: "All" },
  { id: "edits", label: "Edits" },
  { id: "commands", label: "Commands" },
  { id: "tests", label: "Tests" },
];

export function filterMatches(f: ActFilter, l: { kind: ActKind }): boolean {
  switch (f) {
    case "all":
      return true;
    case "edits":
      return l.kind === "edit";
    case "commands":
      return l.kind === "command" || l.kind === "test";
    case "tests":
      return l.kind === "test";
  }
}

/**
 * One line of the feed. `key` keeps a step seen twice (the backlog of /api/jobs/{call}/steps and the live agent.step)
 * once. `detail` is the folded part: a command's output, an edit's diff, a refusal's reason, an agent's answer
 * (`markdown`: rendered as markdown).
 */
export interface ActivityLine {
  key: string;
  at: string;
  agent?: string;
  kind: ActKind;
  title: string;
  path?: string;
  added?: number;
  removed?: number;
  detail?: string;
  markdown?: boolean;
  ok?: boolean;
  exit?: number;
  passed?: number;
  failed?: number;
}

/** +added −removed of a unified diff (file headers left out). */
export function diffStat(diff: string | null | undefined): [number, number] {
  if (!diff) return [0, 0];
  let a = 0;
  let r = 0;
  for (const l of diff.split("\n")) {
    if (l.startsWith("+++") || l.startsWith("---")) continue;
    if (l.startsWith("+")) a++;
    else if (l.startsWith("-")) r++;
  }
  return [a, r];
}

function lastMatch(re: RegExp, t: string): RegExpMatchArray | undefined {
  let last: RegExpMatchArray | undefined;
  for (const m of t.matchAll(re)) last = m;
  return last;
}

/** Passed / failed counts in a test run's output (pytest, jest, vitest, Gradle, Maven/JUnit, go test, cargo); undefined: none. */
export function testCounts(
  output: string | null | undefined,
): [number, number] | undefined {
  if (!output || !output.trim()) return undefined;
  const t = output;
  let m = lastMatch(
    /Tests run:\s*(\d+),\s*Failures:\s*(\d+)(?:,\s*Errors:\s*(\d+))?/g,
    t,
  );
  if (m) {
    const run = Number(m[1]);
    const bad = Number(m[2]) + (m[3] ? Number(m[3]) : 0);
    return [Math.max(0, run - bad), bad];
  }
  m = lastMatch(/(\d+) tests? completed(?:, (\d+) failed)?/g, t);
  if (m) {
    const run = Number(m[1]);
    const bad = m[2] ? Number(m[2]) : 0;
    return [Math.max(0, run - bad), bad];
  }
  m = lastMatch(/test result: \w+\. (\d+) passed; (\d+) failed/g, t);
  if (m) return [Number(m[1]), Number(m[2])];
  const p = lastMatch(/(\d+) (?:passed|passing)\b/g, t);
  const f = lastMatch(/(\d+) (?:failed|failing|errors?)\b/g, t);
  if (!p && !f) {
    const ok = [...t.matchAll(/^(ok|PASS)\s+\S+/gm)].length;
    const bad = [...t.matchAll(/^(FAIL|--- FAIL)\b/gm)].length;
    return ok + bad > 0 && /^(ok|FAIL)\s/m.test(t) ? [ok, bad] : undefined;
  }
  return [p ? Number(p[1]) : 0, f ? Number(f[1]) : 0];
}

const COMMAND_TOOLS = new Set([
  "bash",
  "run_command",
  "shell",
  "exec_command",
  "command",
  "terminal",
]);
const READ_TOOLS = new Set([
  "read",
  "read_file",
  "view",
  "cat",
  "grep",
  "glob",
  "search",
  "ls",
  "list_files",
  "find",
]);

function testTitle(c: [number, number], cmd: string): string {
  const what = firstLine(cmd, 80);
  return `Tests: ${c[0]} passed, ${c[1]} failed` + (what ? ` (${what})` : "");
}

/** A line without its undefined fields (so equal lines compare equal and the webview gets less). */
function clean(o: ActivityLine): ActivityLine {
  for (const k of Object.keys(o) as (keyof ActivityLine)[]) if (o[k] === undefined || o[k] === null) delete o[k];
  return o;
}

/** One agent step (a live agent.step's data, or a step of /api/jobs/{call}/steps) as a feed line; undefined: not shown. */
export function activityOfStep(
  s: JobStep,
  agent: string | undefined,
  callId: string | undefined,
  at = s.at ?? "",
): ActivityLine | undefined {
  const key = `${callId ?? "?"}#${s.n ?? 0}`;
  const tool = s.tool ?? "";
  const text = s.text ?? "";
  const path = s.path ?? undefined;
  switch (s.kind) {
    case "read":
      return clean({
        key,
        at,
        agent,
        kind: "read",
        title: `Read ${path ?? firstLine(text)}`,
        path,
      });
    case "write":
    case "edit": {
      const [a, r] = diffStat(s.diff);
      const failed = s.ok === false;
      const verb = s.kind === "write" ? "Write" : "Edit";
      return clean({
        key,
        at,
        agent,
        kind: "edit",
        title: `${verb} ${path ?? ""}${failed ? " failed" : ""}`.trim(),
        path,
        added: a,
        removed: r,
        detail: s.diff ?? s.output ?? undefined,
        ok: s.ok ?? undefined,
      });
    }
    case "tool": {
      const lt = tool.toLowerCase();
      const counts = testCounts(s.output);
      if (counts) {
        return clean({
          key,
          at,
          agent,
          kind: "test",
          title: testTitle(counts, text),
          detail: s.output ?? undefined,
          ok: counts[1] === 0,
          passed: counts[0],
          failed: counts[1],
        });
      }
      if (COMMAND_TOOLS.has(lt)) {
        return clean({
          key,
          at,
          agent,
          kind: "command",
          title: `$ ${firstLine(text, 120)}`,
          detail: s.output ?? undefined,
          ok: s.ok ?? undefined,
        });
      }
      if (READ_TOOLS.has(lt) || (path && lt.includes("read"))) {
        const verb =
          lt === "grep" || lt === "glob" || lt === "search" ? "Search" : "Read";
        return clean({
          key,
          at,
          agent,
          kind: "read",
          title: `${verb} ${path ?? firstLine(text, 100)}`,
          path,
        });
      }
      return clean({
        key,
        at,
        agent,
        kind: "command",
        title:
          `${s.server ? s.server + ":" : ""}${tool} ${firstLine(text, 100)}`.trim(),
        detail: s.output ?? undefined,
        ok: s.ok ?? undefined,
      });
    }
    case "guard":
      return clean({
        key,
        at,
        agent,
        kind: "guard",
        title: `Refused: ${firstLine(text, 120)}`,
        path,
        detail: text,
        ok: false,
      });
    case "error":
      return clean({
        key,
        at,
        agent,
        kind: "error",
        title: `Error: ${firstLine(text, 120)}`,
        detail: text,
        ok: false,
      });
    case "answer":
    case "result":
      if (!text.trim()) return undefined;
      return clean({
        key,
        at,
        agent,
        kind: "text",
        title: firstLine(text, 120),
        detail: text,
        markdown: true,
      });
    default:
      return undefined; // text, thinking: the agent's prose, not an action
  }
}

const str = (d: Record<string, unknown>, k: string): string | undefined => {
  const v = d[k];
  if (typeof v === "string") return v.trim() ? v : undefined;
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  return undefined;
};
const num = (d: Record<string, unknown>, k: string): number | undefined => {
  const v = d[k];
  if (typeof v === "number") return v;
  if (typeof v === "string" && v.trim() && !Number.isNaN(Number(v)))
    return Number(v);
  return undefined;
};
const bool = (d: Record<string, unknown>, k: string): boolean | undefined =>
  typeof d[k] === "boolean" ? (d[k] as boolean) : undefined;

/** Events that never become a line nor a reload (live text, usage, thinking). */
export function isQuiet(type: string): boolean {
  return (
    type === "agent.usage" || type.endsWith(".delta") || type === "helper.usage"
  );
}

/** An engine event as a feed line; `agentOf` names the agent of a call id; undefined: not a line (deltas, usage). */
export function activityOf(
  ev: EngineEvent,
  agentOf: (callId?: string | null) => string | undefined = () => undefined,
): ActivityLine | undefined {
  const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<
    string,
    unknown
  >;
  const at = ev.at ?? "";
  const agent = str(d, "agent") ?? agentOf(ev.call_id);
  const key = `${ev.type}|${ev.call_id ?? ev.step ?? ""}|${at}|${str(d, "n") ?? ""}`;
  const step = ev.step ?? undefined;
  switch (ev.type) {
    case "agent.step":
      return activityOfStep(
        {
          n: num(d, "n") ?? 0,
          at,
          kind: str(d, "kind") ?? "text",
          text: str(d, "text") ?? "",
          tool: str(d, "tool"),
          path: str(d, "path"),
          ok: bool(d, "ok"),
          diff: str(d, "diff"),
          output: str(d, "output"),
          server: str(d, "server"),
        },
        agent,
        ev.call_id ?? undefined,
        at,
      );
    case "tool.ran": {
      const out = str(d, "output");
      const counts = testCounts(out);
      const cmd = str(d, "cmd") ?? str(d, "tool") ?? "";
      const code = num(d, "code");
      const who = agent ?? str(d, "tool");
      if (counts)
        return clean({
          key,
          at,
          agent: who,
          kind: "test",
          title: testTitle(counts, cmd),
          detail: out,
          ok: counts[1] === 0,
          exit: code,
          passed: counts[0],
          failed: counts[1],
        });
      return clean({
        key,
        at,
        agent: who,
        kind: "command",
        title: `$ ${firstLine(cmd, 120)}`,
        detail: out,
        ok: bool(d, "ok") ?? (code === undefined ? undefined : code === 0),
        exit: code,
      });
    }
    case "guard.refused": {
      const why =
        str(d, "reason") ??
        str(d, "why") ??
        str(d, "message") ??
        str(d, "text") ??
        str(d, "tool") ??
        "a guard";
      return clean({
        key,
        at,
        agent,
        kind: "guard",
        title: `Refused: ${firstLine(why, 120)}`,
        path: str(d, "path"),
        detail: why.length > 120 ? why : undefined,
        ok: false,
      });
    }
    case "gate.waiting":
      return {
        key,
        at,
        kind: "gate",
        title: `Gate opened: ${str(d, "title") ?? str(d, "name") ?? step ?? "a question"}`,
      };
    case "gate.decided": {
      const what = [
        str(d, "choice") ?? str(d, "decision"),
        str(d, "by") ? `by ${str(d, "by")}` : undefined,
      ]
        .filter(Boolean)
        .join(" ");
      return clean({
        key,
        at,
        kind: "gate",
        title:
          `Gate answered: ${str(d, "gate") ?? step ?? ""} → ${what}`.trim(),
        detail: str(d, "why"),
      });
    }
    case "step.started":
      return {
        key,
        at,
        kind: "step",
        title: `Step started: ${str(d, "name") ?? step ?? ""}${str(d, "ac") ? ` (${str(d, "ac")})` : ""}`,
      };
    case "step.finished": {
      const st = str(d, "status");
      return {
        key,
        at,
        kind: "step",
        title: `Step done: ${str(d, "name") ?? step ?? ""}${st && st !== "done" ? ` · ${st}` : ""}`,
      };
    }
    case "agent.started": {
      const m = [str(d, "model"), str(d, "effort")].filter(Boolean).join(" · ");
      return clean({
        key,
        at,
        agent,
        kind: "agent",
        title: "Started" + (m ? ` (${m})` : ""),
      });
    }
    case "agent.finished": {
      const tokens = (num(d, "tokens_in") ?? 0) + (num(d, "tokens_out") ?? 0);
      const status = str(d, "status") ?? "done";
      const failed = status === "failed";
      const result = str(d, "result");
      return clean({
        key,
        at,
        agent,
        kind: failed ? "error" : "agent",
        title: `${status.charAt(0).toUpperCase() + status.slice(1)} · ${ktokens(tokens)} tokens · ${usd(num(d, "cost_usd") ?? 0)}`,
        detail: result,
        markdown: result && !failed ? true : undefined,
        ok: !failed,
      });
    }
    case "thread.done":
      return { key, at, kind: "step", title: "The flow is done" };
    case "thread.failed":
      return {
        key,
        at,
        kind: "error",
        title: `The flow failed: ${firstLine(str(d, "error") ?? str(d, "message") ?? "", 120)}`,
        ok: false,
      };
    default:
      return undefined; // agent.usage, *.delta and the rest: not a line
  }
}

/** An agent running now: who, which model, since when (epoch ms), and its usage so far. */
export interface RunningAgent {
  callId: string;
  agent: string;
  model?: string;
  effort?: string;
  since?: number;
  tokens: number;
  costUsd: number;
}

/** The flow's "now": its current step and running agents, kept up to date from the events. */
export class FlowLive {
  step: string | undefined;
  readonly running = new Map<string, RunningAgent>();
  private readonly seen = new Map<string, string>();

  agentOf = (callId?: string | null): string | undefined =>
    callId
      ? (this.running.get(callId)?.agent ?? this.seen.get(callId))
      : undefined;

  /** A call from the jobs list (a flow opened mid-run). */
  start(job: JobRow): void {
    if (!job.agent) return;
    this.seen.set(job.id, job.agent);
    if (job.status === "running") {
      this.running.set(job.id, {
        callId: job.id,
        agent: job.agent,
        model: job.model ?? undefined,
        effort: job.effort ?? undefined,
        since: parseTime(job.started_at),
        tokens: (job.tokens_in ?? 0) + (job.tokens_out ?? 0),
        costUsd: job.cost_usd ?? 0,
      });
      if (job.step && !this.step) this.step = job.step;
    }
  }

  apply(ev: EngineEvent, now = Date.now()): void {
    const d = (ev.data && typeof ev.data === "object" ? ev.data : {}) as Record<
      string,
      unknown
    >;
    const call = ev.call_id ?? undefined;
    switch (ev.type) {
      case "step.started":
        this.step = str(d, "name") ?? ev.step ?? undefined;
        break;
      case "step.finished":
        if (this.step === (str(d, "name") ?? ev.step ?? undefined))
          this.step = undefined;
        break;
      case "agent.started":
        if (call) {
          const agent = str(d, "agent") ?? "agent";
          this.seen.set(call, agent);
          this.running.set(call, {
            callId: call,
            agent,
            model: str(d, "model"),
            effort: str(d, "effort"),
            since: parseTime(ev.at) ?? now,
            tokens: 0,
            costUsd: 0,
          });
        }
        break;
      case "agent.usage":
        if (call) {
          const r = this.running.get(call);
          if (r)
            this.running.set(call, {
              ...r,
              tokens: (num(d, "tokens_in") ?? 0) + (num(d, "tokens_out") ?? 0),
              costUsd: num(d, "cost_usd") ?? r.costUsd,
            });
        }
        break;
      case "agent.finished":
        if (call) this.running.delete(call);
        break;
      case "thread.done":
      case "thread.failed":
      case "thread.stopped":
        this.running.clear();
        this.step = undefined;
        break;
    }
  }
}
