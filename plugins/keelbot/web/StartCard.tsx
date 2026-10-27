// KeelBot's Start action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { errorParts, go, useLoad } from "@keel/web-sdk";
import { kb } from "./keelbotApi";

/** 0.18.28 `mode`: the run mode the person asked for (manual | important | auto | readonly); else the project's */
type StartSpec = { workflow: string; title: string; request?: string; mode?: "manual" | "important" | "auto" | "readonly"; branch?: "continue" };
const START_MODES = ["manual", "important", "auto", "readonly"] as const;

function parseStart(body: string): StartSpec | null {
  try {
    const v = JSON.parse(body) as Partial<StartSpec>;
    return v && typeof v.workflow === "string" && v.workflow
      ? {
          workflow: v.workflow,
          title: String(v.title ?? ""),
          request: v.request ? String(v.request) : undefined,
          mode: START_MODES.includes(v.mode as never) ? v.mode : undefined,
          branch: v.branch === "continue" ? "continue" : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/** "Start a flow": the workflow KeelBot suggests, a title the person can change, and the request every agent gets. */
export function StartCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseStart(body);
  const wfs = useLoad(pid ? `wfs:${pid}` : null, () => kb.workflows(pid), {
    live: false,
  });
  const [title, setTitle] = useState(spec?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<{ tid: string; title: string } | null>(
    null,
  );
  const [err, setErr] = useState<{
    message: string;
    hint?: string;
    dirty?: boolean;
    /** 0.18.62 the local base and origin's went their own ways: start on the folder's branch instead */
    diverged?: boolean;
  } | null>(null);
  if (!spec)
    return (
      <p className="kb-card bad" role="note">
        KeelBot's start button could not be read. Ask it to give the button
        again.
      </p>
    );
  const wf = wfs.data?.find((w) => w.id === spec.workflow);
  const unknown = !!wfs.data && !wf;
  const start = async (allowDirty = false, branch = spec.branch) => {
    setBusy(true);
    setErr(null);
    try {
      const t = await kb.startFlow(pid, {
        workflow_id: spec.workflow,
        title: title.trim(),
        request: spec.request,
        ...(spec.mode ? { run_mode: spec.mode } : {}),
        ...(allowDirty ? { allow_dirty: true } : {}),
        ...(branch ? { branch } : {}),
      });
      setStarted({ tid: t.thread_id, title: title.trim() });
    } catch (e) {
      const p = errorParts(e);
      setErr({ ...p, dirty: /uncommitted changes/i.test(p.message),
        diverged: !branch && /went their own ways/i.test(p.message) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="kb-card"
      aria-label={`Start a flow: ${spec.title || spec.workflow}`}
    >
      <div className="kb-card-h">
        <span className="kb-tag">Start a flow</span>
        <b>{wf?.name ?? spec.workflow}</b>
      </div>
      {started ? (
        <p className="kb-done">
          Started <b>{started.title}</b>.{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => go("flow", started.tid)}
          >
            Open the flow ▸
          </button>
        </p>
      ) : (
        <>
          <label className="kb-field">
            <span>Title</span>
            <input
              className="inline-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Title of the flow"
            />
          </label>
          {spec.request && (
            <p className="kb-request">
              <span className="sub">What the agents get:</span> {spec.request}
            </p>
          )}
          {spec.mode && (
            <p className="kb-request" data-testid="kb-start-mode">
              <span className="sub">Run mode:</span> {spec.mode}
            </p>
          )}
          {unknown && (
            <p className="kb-err" role="alert">
              This project has no workflow called {spec.workflow}.
            </p>
          )}
          {err && (
            <div className="kb-err" role="alert">
              <b>{err.message}</b>
              {err.hint && <span className="sub"> {err.hint}</span>}
              {err.dirty && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void start(true)}
                  disabled={busy}
                >
                  Start anyway
                </button>
              )}
              {err.diverged && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void start(false, "continue")}
                  disabled={busy}
                >
                  Start on the current branch
                </button>
              )}
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !title.trim() || unknown}
              onClick={() => void start()}
            >
              {busy ? "Starting…" : "Start the flow"}
            </button>
            {wf && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => go("workflows", wf.id)}
              >
                See the workflow
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}
