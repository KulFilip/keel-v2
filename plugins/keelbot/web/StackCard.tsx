// KeelBot's Stack action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, CodeBlock, errorParts, go, useLoad } from "@keel/web-sdk";
import { kb } from "./keelbotApi";

/** 0.18.9 a stack KeelBot wrote (```keel-stack```): keel checks it first (nothing is saved), then Save writes
 *  .keel/stacks/<name>.yml. */
export function StackCard({ pid, body }: { pid: string; body: string }) {
  const check = useLoad(pid && body.trim() ? `kb-stack-check:${pid}:${body.length}:${body.slice(0, 80)}` : null,
    () => kb.checkStack(pid, body), { live: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = /^name:\s*(\S+)/m.exec(body)?.[1] ?? "stack";
  const c = check.data;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.saveStack(pid, body);
      setDone(`Saved ${name} as ${r.path}: keel uses it from the next step on.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New stack: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Stack</span><b>{name}</b>{c?.review?.lane && <span className="sub">{c.review.lane}</span>}</div>
      <CodeBlock text={body} gutter={false} />
      {c && !c.ok && <div className="kb-err" role="alert"><b>keel cannot save it yet:</b>{(c.errors ?? []).map((e) => <div key={e} className="sub">{e}</div>)}</div>}
      {c?.ok && !!c.warnings?.length && <div className="sub">{c.warnings.map((w) => <div key={w}>warning: {w}</div>)}</div>}
      {c?.replaces === "keel" && <p className="sub">keel has a stack called {name}: in this project this one is used in its place.</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the stack ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("stacks")}>Open Stacks ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy || !c?.ok} onClick={() => void save()}>{busy ? "Saving…" : "Save the stack"}</button></div>}
    </section>
  );
}
