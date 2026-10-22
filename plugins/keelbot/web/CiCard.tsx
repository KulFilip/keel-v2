// KeelBot's Ci action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, errorParts, go } from "@keel/web-sdk";
import { kb } from "./keelbotApi";
import { parseJson } from "./cardUtil";

/** A CI step KeelBot gives as a button (CI/CD plugin): fix starts the ci-fix flow on this branch; rerun runs the failed
 *  jobs of the run again. */
export function CiCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseJson<{ op?: string; run?: number }>(body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ text: string; tid?: string } | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const op = spec?.op ?? "";
  if (!spec || !["fix", "rerun"].includes(op)) return <p className="kb-card bad" role="note">KeelBot's CI button could not be read. Ask it to give it again.</p>;
  const go_ = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (op === "fix") {
        const t = await kb.ciFix(pid, spec.run);
        setDone({ text: "The fix flow started: it reads the failure, fixes it, commits, pushes and waits for CI.", tid: t.thread_id });
      } else {
        const run = spec.run ?? (await kb.ciRuns(pid)).find((r) => r.failed)?.id;
        if (!run) {
          setDone({ text: "No failed run to start again." });
        } else {
          await kb.ciRerun(pid, run);
          setDone({ text: `The failed jobs of run #${run} run again.` });
        }
      }
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const label = op === "fix" ? "Fix it" : "Run the failed jobs again";
  return (
    <section className="kb-card" aria-label={`CI: ${label}`}>
      <div className="kb-card-h"><span className="kb-tag">CI</span><b>{label}</b>{spec.run ? <span className="sub">run #{spec.run}</span> : null}</div>
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`KeelBot's CI button "${label}"`} error={err} />
      {done ? (
        <p className="kb-done" role="status">{done.text}{" "}
          {done.tid && <button type="button" className="btn sm" onClick={() => go("flow", done.tid)}>Open the flow ▸</button>}</p>
      ) : (
        <div className="row">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void go_()}>{busy ? "Starting…" : label}</button>
          {op === "fix" && <span className="sub">It pushes the fix with the Git plugin, following your push setting.</span>}
        </div>
      )}
    </section>
  );
}
