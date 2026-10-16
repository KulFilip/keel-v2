// v0.15.3 Resume for a stopped or failed flow (the Flow page's, and since 0.17.3 the Wiki's spec status through the SDK):
// it asks for the last saved step, then rewinds to it. Only the last stopped flow can be resumed (the api refuses others).

import { useEffect, useState } from "react";
import { api, errorParts, type Checkpoint, type ThreadState } from "../api";
import { useApp } from "../state";

/** v0.15.3 a stopped or failed flow: go on from its last saved step (a rewind to the newest checkpoint, asked
 *  first because agents run again), or pick an earlier step. Nothing is lost: every finished step is saved. */
export function ResumeRow({ thread, onDone, onCheckpoints, autoAsk, onCancel }: {
  thread: Pick<ThreadState, "thread_id"> & { status: string }; onDone: () => Promise<void>; onCheckpoints?: () => void;
  /** v0.15.4 from the Runs history: ask about the last saved step right away, and Cancel closes it */
  autoAsk?: boolean; onCancel?: () => void;
}) {
  const { toast } = useApp();
  const [last, setLast] = useState<Checkpoint | null>(null);
  const [busy, setBusy] = useState(false);
  const ask = async () => {
    setBusy(true);
    try {
      const h = await api.history(thread.thread_id);
      const newest = [...h].sort((a, b) => b.n - a.n)[0];
      if (newest) setLast(newest);
      else toast("This flow has no saved step yet: start it again.");
    } catch (e) {
      toast(errorParts(e).message);
    } finally {
      setBusy(false);
    }
  };
  useEffect(() => {
    if (autoAsk) void ask();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [autoAsk]);
  const resume = async () => {
    if (!last) return;
    setBusy(true);
    try {
      await api.rewind(thread.thread_id, last.id);
      toast(`Resumed after “${last.step}”. The next step runs now.`);
      setLast(null);
      await onDone();
    } catch (e) {
      const p = errorParts(e);
      toast(p.hint ? `${p.message} ${p.hint}` : p.message);
    } finally {
      setBusy(false);
    }
  };
  return (
    <div className="fl-resume">
      <span className="hint">
        {thread.status === "stopped"
          ? "It stopped while a step ran (Stop flow, or keel itself was stopped). Every finished step is saved."
          : "Every finished step is saved: go on from the last one, or go back to an earlier one."}
      </span>
      {last ? (
        <div className="row" role="group" aria-label="Resume the flow">
          <span>Resume after <b className="mono">{last.step}</b>{last.note ? ` (${last.note.slice(0, 80)}${last.note.length > 80 ? "…" : ""})` : ""}? The next step runs again.</span>
          <button className="btn primary sm" type="button" disabled={busy} onClick={() => void resume()}>{busy ? "Resuming…" : "Yes, resume"}</button>
          <button className="btn ghost sm" type="button" disabled={busy} onClick={() => { setLast(null); onCancel?.(); }}>Cancel</button>
        </div>
      ) : (
        <div className="row">
          <button className="btn primary sm" type="button" disabled={busy} onClick={() => void ask()}>Resume the flow</button>
          {onCheckpoints && <button className="btn sm" type="button" onClick={onCheckpoints}>Go back to an earlier step…</button>}
        </div>
      )}
    </div>
  );
}
