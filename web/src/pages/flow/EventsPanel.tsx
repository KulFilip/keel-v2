import { useState } from "react";
import { api, errorParts, type Checkpoint, type EngineEvent, type ThreadState } from "../../api";
import { eventLine } from "../../components/events";
import { FoldPanel } from "../../components/FoldPanel";
import { Confirm, ErrorBox } from "../../components/ui";
import { clock } from "../../format";
import { useApp } from "../../state";

/** How many saved steps the Events panel shows under the live events. */
const EARLIER = 8;

/** What happened in this flow, newest first: the events of this visit, then the saved steps (checkpoints) before them,
 * so a flow that waits still says how it got here. v0.15.2 `step`: only that step's events since it started (the
 * step's Now view). Hide folds it (this browser remembers it); ⤢ shows every event and saved step in a large view. */
export function EventsPanel({ pid, thread, history, onAll, step, title = "Events", readOnly }: {
  pid: string; thread: ThreadState; history?: Checkpoint[] | null; onAll?: () => void; step?: string; title?: string;
  /** v0.15.4 an earlier run: no "Allow this file" */
  readOnly?: boolean;
}) {
  return (
    <FoldPanel id="flow.events" title={title}
      extra={onAll && (history?.length ?? 0) > 0 ? <button className="btn sm ghost" type="button" onClick={onAll}>All checkpoints</button> : undefined}
      big={() => <EventList pid={pid} thread={thread} history={history} step={step} all readOnly={readOnly} />}>
      <EventList pid={pid} thread={thread} history={history} step={step} readOnly={readOnly} />
    </FoldPanel>
  );
}

/** v0.15.2 One step's events since it last started (a step that runs again, for the next criterion, starts over). */
function sinceStart(events: EngineEvent[], step: string): EngineEvent[] {
  const mine = events.filter((e) => (e.step ?? "").replace(/__fix$/, "") === step);
  const at = mine.map((e) => e.type).lastIndexOf("step.started");
  return at > 0 ? mine.slice(at) : mine;
}

/** The event lines: the newest 12 events and 8 saved steps before them; `all` (the big view): every one. */
function EventList({ pid, thread, history, step, all, readOnly }: {
  pid: string; thread: ThreadState; history?: Checkpoint[] | null; step?: string; all?: boolean; readOnly?: boolean;
}) {
  const { recent } = useApp();
  const ofThread = recent.filter((e: EngineEvent) => e.thread_id === thread.thread_id && e.type !== "agent.step");
  const shown = step ? sinceStart(ofThread, step) : ofThread;
  const mine = (all ? shown : shown.slice(-12)).slice().reverse();
  const [asking, setAsking] = useState<EngineEvent | null>(null);
  // the saved steps from before the oldest live event (the history is newest first); none in a step's Now view
  const oldest = mine.length ? Date.parse(mine[mine.length - 1].at) : Infinity;
  const before = step ? [] : (history ?? []).filter((c) => !(Date.parse(c.at) >= oldest));
  const earlier = all ? before : before.slice(0, EARLIER);
  return (
    <>
      <div className="events" aria-label="What happened, newest first">
        {mine.map((e, i) => {
          const l = eventLine(e);
          const path = e.type === "guard.refused" && typeof e.data?.path === "string" ? e.data.path : null;
          return (
            <div key={i}>
              <span className="t mono sub">{clock(e.at, false)}</span><span className="k">{l.k}</span>
              <span>{l.text}{path && !readOnly && asking !== e && (
                <> <button className="btn sm ghost" type="button" onClick={() => setAsking(e)} aria-label={`Allow ${path} in this phase`}>Allow this file in this phase</button></>
              )}</span>
            </div>
          );
        })}
        {mine.length > 0 && earlier.length > 0 && <span className="ev-sep sub">Earlier</span>}
        {earlier.map((c) => (
          <div key={c.id} className="ev-cp" data-testid="event-checkpoint">
            <span className="t mono sub">{clock(c.at, false)}</span>
            <span title={c.note}><b className="mono">{c.step}</b> <span className="sub">{c.note}</span></span>
          </div>
        ))}
        {before.length > earlier.length && <span className="hint">{before.length - earlier.length} older steps are under Checkpoints.</span>}
        {!mine.length && !earlier.length && (
          step ? <span className="sub">Nothing happened in this step yet. Its events show here as they happen.</span>
            : history === undefined || (history !== null && !history.length)
              ? <span className="sub">Nothing happened yet. Events show here as they happen.</span>
              : history === null ? <span className="sub loading">Loading what happened…</span> : null
        )}
      </div>
      {asking && <UnlockConfirm pid={pid} path={String(asking.data.path)} phase={typeof asking.data.phase === "string" ? asking.data.phase : thread.phase} onClose={() => setAsking(null)} />}
    </>
  );
}

function UnlockConfirm({ pid, path, phase, onClose }: { pid: string; path: string; phase: string; onClose: () => void }) {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const yes = async () => {
    setBusy(true);
    setErr(null);
    try {
      await api.unlock(pid, path, phase || undefined);
      toast(`${path} is allowed in ${phase || "this phase"}. The unlock is logged.`);
      onClose();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="grid" style={{ gap: 8, marginTop: 10 }}>
      <Confirm text={<>The guard stopped a write to <b className="mono">{path}</b>{phase ? <> in <b>{phase}</b></> : null}. Allow agents to edit this file in this phase, for this flow only?
        The unlock is logged in the flow's events.</>}
        yes="Yes, allow it" busy={busy} onYes={yes} onNo={onClose} />
      {err && <ErrorBox error={err} />}
    </div>
  );
}
