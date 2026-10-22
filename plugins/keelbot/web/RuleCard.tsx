// KeelBot's Rule action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, CodeBlock, errorParts, go, useLoad } from "@keel/web-sdk";
import { kb } from "./keelbotApi";

/** 0.18.5 a rule pack KeelBot wrote (```keel-rule```): keel checks it and says what it would have refused lately; Save
 *  puts it in .keel/rules/. */
export function RuleCard({ pid, body }: { pid: string; body: string }) {
  const check = useLoad(pid && body.trim() ? `kb-rule-check:${pid}:${body.length}:${body.slice(0, 80)}` : null,
    () => kb.checkRule(pid, body), { live: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = /^name:\s*(\S+)/m.exec(body)?.[1] ?? "rule pack";
  const c = check.data;
  const blocked = c?.dry_run?.blocked ?? [];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.saveRule(pid, body);
      setDone(`Saved ${r.pack?.id ?? name}: it applies from the next tool call.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New rule pack: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Rule pack</span><b>{name}</b></div>
      <CodeBlock text={body} gutter={false} />
      {c && !c.ok && <div className="kb-err" role="alert"><b>keel cannot save it yet:</b>{(c.errors ?? []).map((e) => <div key={e} className="sub">{e}</div>)}</div>}
      {c?.ok && <p className="sub">On the recent tool calls it would have refused {blocked.length} of {c.dry_run?.checked ?? 0}.</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the rule pack ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("rules")}>Open Rules ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy || !c?.ok} onClick={() => void save()}>{busy ? "Saving…" : "Save the rule pack"}</button></div>}
    </section>
  );
}
