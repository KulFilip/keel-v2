// The flow panel's view models (pure: the unit tests read them without VS Code).

import type { FlowView, RunRow } from "../api/models";
import type { AcVm, FlowVm, GateVm, LineVm } from "../views/protocol";
import type { ActivityLine } from "./activity";
import { ago, clock, ktokens, STEP_NAMES, stepOf, usd } from "./format";
import { defaultButton, gateButtons, reasonLabel } from "./gate";
import { renderMarkdown } from "./markdown";

/** Active flows first (waiting, then running), then the rest by last change. */
export function sortRuns(rows: RunRow[]): RunRow[] {
  const rank = (r: RunRow) =>
    r.waiting ? 0 : r.status === "running" ? 1 : r.status === "waiting" ? 0 : 2;
  return [...rows].sort(
    (a, b) =>
      rank(a) - rank(b) ||
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
  );
}

export const ACTIVE = new Set(["running", "waiting", "paused", "interrupted"]);

const DONE = new Set(["done", "failed", "stopped", "cancelled"]);

/** An activity line as the webview shows it (the markdown of an answer rendered here, safely). */
export function lineVm(l: ActivityLine): LineVm {
  const vm: LineVm = {
    key: l.key,
    clock: clock(l.at) || "--:--",
    agent: l.agent,
    kind: l.kind,
    title: l.title,
    path: l.path,
    added: l.added,
    removed: l.removed,
    exit: l.exit,
    ok: l.ok,
    failed: l.failed,
  };
  if (l.detail?.trim()) {
    if (l.markdown) vm.detailHtml = renderMarkdown(l.detail);
    else
      vm.detail =
        l.detail.length > 20_000
          ? l.detail.slice(0, 20_000) +
            "\n… (cut: the job page in keel has all of it)"
          : l.detail;
  }
  return vm;
}

function acState(s: string | undefined): string {
  switch (s) {
    case "done":
    case "green":
    case "passed":
      return "green";
    case "red":
    case "failed":
      return "red";
    case "doing":
    case "running":
    case "active":
    case "in_progress":
      return "doing";
    default:
      return "todo";
  }
}

/** The flow detail as the webview shows it. */
export function flowVm(
  v: FlowView,
  extra: { where?: string; branch?: string; cost?: number; spec?: string },
): FlowVm | undefined {
  const t = v.thread;
  if (!t) return undefined;
  const status = t.status ?? "running";
  const waits = !!t.waiting && !DONE.has(status);
  const step = stepOf(t.phase, status);
  const current =
    (t.current && v.workflow?.steps?.find((s) => s.id === t.current)?.name) ||
    t.current ||
    t.phase ||
    "";
  let gate: GateVm | undefined;
  if (t.waiting && waits) {
    const w = t.waiting;
    const buttons = gateButtons(w);
    gate = {
      id: w.id ?? undefined,
      title: w.title || "keel waits for you",
      detailHtml: w.detail
        ? renderMarkdown(
            w.detail.length > 6000 ? w.detail.slice(0, 6000) + "…" : w.detail,
          )
        : "",
      kind: w.kind ?? "gate",
      buttons: buttons.map((b) => ({
        name: b.name,
        label: b.label,
        description: b.description,
        why: b.why,
        reasonLabel: reasonLabel(b),
      })),
      picked: defaultButton(buttons)?.name,
      questions: (w.questions ?? []).map((q) => ({
        id: q.id,
        question: q.question,
        why: q.why ?? undefined,
        multiple: !!q.multiple,
        options: (q.options ?? []).map((o) => ({
          label: o.label,
          description: o.description ?? undefined,
          recommended: !!o.recommended,
          picked: !!q.multiple && !!o.recommended,
        })),
      })),
    };
  }
  const cost = extra.cost || t.usage?.cost_usd || 0;
  const tokens = (t.usage?.tokens_in ?? 0) + (t.usage?.tokens_out ?? 0);
  const acs: AcVm[] = (t.acs ?? []).map((a) => ({
    id: a.id,
    layer: (a.layer ?? "").toLowerCase(),
    title: a.title ?? "",
    state: acState(a.status),
  }));
  return {
    threadId: t.thread_id,
    title: t.title || t.thread_id,
    status,
    waits,
    meta: [
      t.workflow_id,
      extra.where,
      tokens ? `${ktokens(tokens)} tokens` : undefined,
      cost ? usd(cost) : undefined,
    ]
      .filter(Boolean)
      .join(" · "),
    steps: STEP_NAMES.map((name, i) => ({
      name,
      state:
        i < step || status === "done"
          ? "done"
          : i === step
            ? "current"
            : "todo",
    })),
    phase: t.phase ?? "",
    current,
    error: t.error ?? undefined,
    acs,
    gate,
    canStop: ACTIVE.has(status),
    canResume: ["stopped", "failed", "error", "cancelled"].includes(status),
    updated: t.updated_at ? ago(t.updated_at) : "",
    branch: extra.branch,
    spec: extra.spec,
  };
}

