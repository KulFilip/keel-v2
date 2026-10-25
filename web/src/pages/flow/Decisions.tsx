// keel 0.18.54 "What did I decide in this run?": every answer given at a gate of this flow — the decision, who gave it
// (you, the Supervisor, the run mode, keel), when, the answers as question → answer, the round — and what the Supervisor
// said. The Decisions tab lists them all, oldest first; a step's panel shows the ones given at that step. The stored
// events (GET .../flows/{tid}/decisions) plus this visit's live ones; the gate log when the events cannot be read.

import { useMemo } from "react";
import {
  api,
  type StepExplanation,
  type ThreadState,
  type Workflow,
} from "../../api";
import {
  DECISION_TYPES,
  decisionsOf,
  logDecision,
  mergeEvents,
  WHO_LABEL,
  type DecisionItem,
} from "../../components/eventRows";
import { Panel } from "../../components/ui";
import { clock } from "../../format";
import { useApp, useLoad } from "../../state";
import { FoldMd, QaList } from "./EventsPanel";

/** The flow's decisions, oldest first. `fromLog`: read from the gate log (no times, no who) because the events could not be. */
export function useDecisions(
  pid: string,
  thread: ThreadState,
  workflow: Workflow,
) {
  const { recent } = useApp();
  const stored = useLoad(`decisions:${pid}:${thread.thread_id}`, () =>
    api.flowDecisions(pid, thread.thread_id),
  );
  const tid = thread.thread_id;
  const live = useMemo(
    () =>
      recent.filter(
        (e) => e.thread_id === tid && DECISION_TYPES.includes(e.type),
      ),
    [recent, tid],
  );
  const nameOf = useMemo(
    () => (id: string) => workflow.steps.find((s) => s.id === id)?.name,
    [workflow],
  );
  const items = useMemo(
    () => decisionsOf(mergeEvents(stored.data ?? [], live), nameOf),
    [stored.data, live, nameOf],
  );
  const fromLog = !!stored.error && !items.length;
  const logged = useMemo(
    () =>
      fromLog
        ? (thread.gate_log ?? [])
            .map((l) => logDecision(l, nameOf))
            .filter((d): d is DecisionItem => !!d)
        : [],
    [fromLog, thread.gate_log, nameOf],
  );
  return {
    items: fromLog ? logged : items,
    loading: !stored.data && !stored.error,
    fromLog,
  };
}

/** When: the time today, else the day and the time ("Oct 17 10:09"). */
function when(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const t = clock(iso, false);
  return d.toDateString() === new Date().toDateString() ? t : `${t} ${d.toTimeString().slice(0, 5)}`;
}

/** One decision: the badge, the step (and criterion, and round), who and when, then the answers or the note. */
export function DecisionCard({
  it,
  showStep = true,
}: {
  it: DecisionItem;
  showStep?: boolean;
}) {
  return (
    <li className={`dc dc-${it.source}`} data-testid="decision">
      <div className="dc-head">
        <span
          className={`pill p-${it.decision.tone}`}
          data-testid="decision-badge"
        >
          {it.decision.label}
        </span>
        {showStep && (
          <b className="dc-step">
            {it.source === "supervisor"
              ? `supervisor · ${it.stepName}`
              : it.stepName}
          </b>
        )}
        {it.ac && <span className="mono sub">{it.ac}</span>}
        {it.rounds > 1 && (
          <span
            className="dc-round"
            title={`This step was decided ${it.rounds} times in this flow`}
          >
            round {it.round} of {it.rounds}
          </span>
        )}
      </div>
      <div className="dc-meta">
        <span>
          by <b className={`dc-by by-${it.by}`}>{WHO_LABEL[it.by]}</b>
        </span>
        {it.at ? (
          <time dateTime={it.at} title={new Date(it.at).toLocaleString()}>{when(it.at)}</time>
        ) : (
          <span className="sub">time not kept</span>
        )}
        {it.source === "gate" && it.gate !== it.stepName && (
          <span className="sub">{it.gate}</span>
        )}
      </div>
      {it.answers && <QaList answers={it.answers} />}
      {it.note && <FoldMd text={it.note} />}
    </li>
  );
}

/** The Decisions tab: every decision of this flow, oldest first. */
export function DecisionsPanel({
  pid,
  thread,
  workflow,
}: {
  pid: string;
  thread: ThreadState;
  workflow: Workflow;
}) {
  const { items, loading, fromLog } = useDecisions(pid, thread, workflow);
  const counts = items.reduce(
    (m, it) => ({ ...m, [it.by]: (m[it.by] ?? 0) + 1 }),
    {} as Record<string, number>,
  );
  return (
    <Panel
      title="Decisions"
      extra={<span className="hint">↓ Oldest first</span>}
    >
      {loading ? (
        <div className="empty loading">Loading the decisions…</div>
      ) : !items.length ? (
        <div className="empty">
          No decision yet. Each answer at a gate — yours, the supervisor's or
          the run mode's — shows here, with what the supervisor said.
        </div>
      ) : (
        <div className="grid" style={{ gap: 8 }}>
          <span className="sub" data-testid="decisions-sum">
            {items.length} {items.length === 1 ? "decision" : "decisions"}:{" "}
            {Object.entries(counts)
              .map(
                ([by, n]) => `${n} by ${WHO_LABEL[by as DecisionItem["by"]]}`,
              )
              .join(", ")}
          </span>
          {fromLog && (
            <span className="hint">
              From the flow's gate log: the times and who answered were not
              readable.
            </span>
          )}
          <ol
            className="dc-list"
            aria-label="Decisions of this flow, oldest first"
          >
            {items.map((it) => (
              <DecisionCard key={it.key} it={it} />
            ))}
          </ol>
        </div>
      )}
    </Panel>
  );
}

/** A step's panel: what was decided at this step in this flow (every round), or, for a gate, that nobody answered yet.
 *  Shows nothing for a step that never decides anything. */
export function StepDecisions({
  pid,
  thread,
  workflow,
  stepId,
  x,
}: {
  pid: string;
  thread: ThreadState;
  workflow: Workflow;
  stepId: string;
  x?: StepExplanation | null;
}) {
  const { items, loading } = useDecisions(pid, thread, workflow);
  const step = workflow.steps.find((s) => s.id === stepId);
  const mine = items.filter((it) => it.step === stepId);
  // no events for it (an older flow, or they could not be read): what the step's last runs logged
  const logged = !mine.length
    ? (x?.last_runs?.runs ?? [])
        .flatMap((r) =>
          (r.decided ?? []).map((l) => {
            const d = logDecision(
              l,
              (id) => workflow.steps.find((s) => s.id === id)?.name,
            );
            return d ? { ...d, at: r.at, key: `${r.checkpoint}:${l}` } : null;
          }),
        )
        .filter((d): d is DecisionItem => !!d)
    : [];
  const shown = mine.length ? mine : logged;
  const waits =
    thread.status === "waiting" &&
    (thread.waiting?.step ?? "").replace(/__fix$/, "") === stepId;
  if (!shown.length && step?.kind !== "gate") return null;
  const rounds = shown.filter((it) => it.source === "gate").length;
  return (
    <section className="xsec dc-sec" aria-label="What was decided here" data-testid="step-decisions">
      <h3>
        What was decided here{rounds > 1 ? <span className="dc-times"> ×{rounds}</span> : null}
        {shown.length > 0 && <span className="hint dc-order"> · oldest first</span>}
      </h3>
      {loading && !shown.length ? (
        <span className="sub loading">Reading the answers…</span>
      ) : !shown.length ? (
        <span className="sub">{waits ? "It waits for your answer now. Your answer shows here once you give it." : "Not answered in this run yet."}</span>
      ) : (
        <ol className="dc-list">
          {shown.map((it) => <DecisionCard key={it.key} it={it} showStep={false} />)}
        </ol>
      )}
    </section>
  );
}
