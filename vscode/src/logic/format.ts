// Pure helpers the views share (no `vscode` import here, so the unit tests run on plain Node). Ports of the JetBrains
// plugin's Logic.kt / IdeLogic.kt, themselves ports of the web's own.

import type { CheckRun, ReviewThread } from "../api/models";

/** The four steps the step bar shows. */
export const STEP_NAMES = ["Spec", "Test", "Code", "Review"];

const SPEC_PHASES = new Set([
  "setup",
  "preflight",
  "workspace",
  "triage",
  "spec",
  "spec-ok",
  "contract",
  "bug-report",
  "small-change",
  "trivial",
]);
const CODE_PHASES = new Set([
  "green",
  "ac",
  "refactor",
  "integration",
  "lint-fix",
  "coverage-fix",
  "bug-investigate",
  "bug-fix",
]);

/** Which of the four steps a phase belongs to; 4 = all done. */
export function stepOf(
  phase: string | null | undefined,
  status?: string | null,
): number {
  if (status === "done") return 4;
  const p = (phase ?? "").toLowerCase();
  if (!p || p === "none") return 0;
  if (SPEC_PHASES.has(p) || p.startsWith("spec") || p.startsWith("triage"))
    return 0;
  if (p === "red" || p === "bug-repro" || p.startsWith("red")) return 1;
  if (CODE_PHASES.has(p) || p.startsWith("green") || p.endsWith("-fix"))
    return 2;
  return 3; // gate, ac-gate, review, e2e, smoke, ship, pr...
}

/** The first non-blank line, cut to `max` characters with an ellipsis. */
export function firstLine(text: string | null | undefined, max = 60): string {
  const l =
    (text ?? "")
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s.length > 0) ?? "";
  return l.length > max ? l.slice(0, max - 1).trimEnd() + "…" : l;
}

export function parseTime(iso: string | null | undefined): number | undefined {
  if (!iso) return undefined;
  let t = Date.parse(iso);
  if (Number.isNaN(t) && /^\d{4}-\d{2}-\d{2}T[\d:.]+$/.test(iso))
    t = Date.parse(iso + "Z");
  return Number.isNaN(t) ? undefined : t;
}

/** "now", "12 min", "2 h", "1 d" since an ISO time; "" when it cannot be read. */
export function ago(iso: string | null | undefined, now = Date.now()): string {
  const t = parseTime(iso);
  if (t === undefined) return "";
  const s = Math.max(0, Math.floor((now - t) / 1000));
  if (s < 60) return "now";
  if (s < 3600) return `${Math.floor(s / 60)} min`;
  if (s < 86_400) return `${Math.floor(s / 3600)} h`;
  return `${Math.floor(s / 86_400)} d`;
}

/** "HH:mm" of an ISO time in the local zone; "" when it cannot be read. */
export function clock(iso: string | null | undefined): string {
  const t = parseTime(iso);
  if (t === undefined) return "";
  const d = new Date(t);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/** "m:ss", or "h:mm:ss" from an hour on. */
export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${mm}:${ss}`
    : `${Math.floor(s / 60)}:${ss}`;
}

export function usd(v: number | null | undefined): string {
  return "$" + (v ?? 0).toFixed(2);
}

export function ktokens(n: number | null | undefined): string {
  const v = n ?? 0;
  if (v >= 1_000_000) return (v / 1_000_000).toFixed(1) + "M";
  if (v >= 1_000) return `${Math.floor((v + 500) / 1000)}k`;
  return String(v);
}

/** A review thread's place: waiting for you (someone else spoke last), open (you spoke last), resolved. */
export type ThreadPlace = "waiting" | "open" | "resolved";

export function threadStateOf(
  t: ReviewThread,
  me: string | null | undefined,
): ThreadPlace {
  if (t.resolved) return "resolved";
  const last = t.comments?.[t.comments.length - 1]?.author;
  if (me && last && last.toLowerCase() === me.toLowerCase()) return "open";
  return "waiting";
}

/** The CI line of a PR: "CI 2/2 ✓", "CI 1/2 ✗", "" when there are no checks. */
export function ciSummary(checks: CheckRun[] | null | undefined): string {
  const cs = checks ?? [];
  if (!cs.length) return "";
  const ok = cs.filter((c) =>
    ["success", "passed", "neutral", "skipped"].includes(
      (c.state ?? "").toLowerCase(),
    ),
  ).length;
  const bad = cs.filter((c) =>
    ["failure", "failed", "error", "cancelled", "timed_out"].includes(
      (c.state ?? "").toLowerCase(),
    ),
  ).length;
  const mark = bad > 0 ? "✗" : ok === cs.length ? "✓" : "…";
  return `CI ${ok}/${cs.length} ${mark}`;
}

/** A `path:line` in a text (orders.py:39, src/Prefs.kt:4-9). */
export interface FileRef {
  path: string;
  line: number;
  start: number;
  end: number;
}

const FILE_REF =
  /(?<![\w/.-])((?:[\w.-]+\/)*[\w-]+\.[A-Za-z]\w{0,7}):(\d{1,6})(?:[-–](\d{1,6}))?/g;

export function fileRefs(text: string): FileRef[] {
  const out: FileRef[] = [];
  for (const m of text.matchAll(FILE_REF)) {
    out.push({
      path: m[1],
      line: Number(m[2]),
      start: m.index ?? 0,
      end: (m.index ?? 0) + m[0].length,
    });
  }
  return out;
}

/** The workflow the Start a flow picker suggests for a request. */
export function suggestWorkflow(
  request: string,
  ids: string[],
): string | undefined {
  const t = request.toLowerCase();
  const want = /\b(bug|fix|broken|crash|wrong|error|fails?)\b/.test(t)
    ? "fix"
    : /\b(rename|typo|tiny|one line|bump)\b/.test(t)
      ? "quick"
      : "feature";
  return ids.find((i) => i === want) ?? ids[0];
}

/** What the built-in workflows do (keel's own workflows have no description field). */
export const WORKFLOW_BLURBS: Record<string, string> = {
  feature: "Something new: spec, tests first, code, review",
  small: "A small feature, test-first, no long ship part",
  fix: "A bug: first a test that shows it",
  bug: "A bug: first a test that shows it",
  quick: "A tiny change: one agent, the tests, one look",
  review: "Review your branch; changes nothing",
};

/** The request text Start a flow begins with, from an editor selection. */
export function requestFromSelection(
  path: string,
  startLine: number,
  endLine: number,
  code: string,
): string {
  const todo = /(?:TODO|FIXME)[:\s]+(.+)/.exec(code)?.[1]?.trim();
  const where =
    startLine === endLine
      ? `${path}:${startLine}`
      : `${path}:${startLine}-${endLine}`;
  let s = "";
  if (todo) s += todo.charAt(0).toUpperCase() + todo.slice(1) + "\n\n";
  s += `Code: ${where}\n` + "```\n" + code.trimEnd() + "\n```\n";
  return s;
}

/** A title from the first words of a request. */
export function titleFrom(request: string, max = 60): string {
  const l =
    request
      .split(/\r?\n/)
      .map((s) => s.trim())
      .find((s) => s && !s.startsWith("```") && !s.startsWith("Code:")) ?? "";
  return firstLine(l.replace(/\.+$/, ""), max);
}

/** The text KeelBot gets for "Ask KeelBot about selection". */
export function askText(
  path: string,
  start: number,
  end: number,
  code: string,
): string {
  const where = start === end ? `${path}:${start}` : `${path}:${start}-${end}`;
  return `@${where}\n` + "```\n" + code.trimEnd() + "\n```\n";
}

/** The device name keel shows in Settings › Devices. */
export function deviceName(host: string): string {
  const h = host.replace(/\.local$/, "");
  return `VS Code on ${h || "this computer"}`;
}

/** "Ran 2 commands · read 3 files" from an answer's steps; "" when it used no tool. */
export function toolSummary(steps: { kind?: string }[]): string {
  const cmds = steps.filter((s) => s.kind === "tool").length;
  const reads = steps.filter((s) => s.kind === "read").length;
  const edits = steps.filter(
    (s) => s.kind === "edit" || s.kind === "write",
  ).length;
  const parts: string[] = [];
  if (cmds) parts.push(`ran ${cmds} command${cmds === 1 ? "" : "s"}`);
  if (reads) parts.push(`read ${reads} file${reads === 1 ? "" : "s"}`);
  if (edits) parts.push(`changed ${edits} file${edits === 1 ? "" : "s"}`);
  const s = parts.join(" · ");
  return s ? s.charAt(0).toUpperCase() + s.slice(1) : "";
}
