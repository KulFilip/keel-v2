// KeelBot's Agent action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, errorParts, go } from "@keel/web-sdk";
import { kb } from "./keelbotApi";
import { parseJson } from "./cardUtil";

type AgentSpec = { name?: string; label?: string; about?: string; prompt?: string; tools?: string[]; phases?: string[] };

/** 0.18.5 an agent KeelBot wrote (```keel-agent```): its tools and instructions; Save adds it to the project. */
export function AgentCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseJson<AgentSpec>(body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = spec?.name ?? spec?.label ?? "";
  if (!spec || !name || !spec.prompt) return <p className="kb-card bad" role="note">KeelBot's agent could not be read. Ask it to give it again.</p>;
  const tools = spec.tools?.length ? spec.tools : ["Read", "Grep", "Glob"];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a = await kb.saveAgent(pid, { name, about: spec.about ?? "", prompt: spec.prompt!, tools, phases: spec.phases?.length ? spec.phases : ["any"] });
      setDone(`Saved ${a.id}. A workflow uses it with agent: ${a.id}.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New agent: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Agent</span><b>{name}</b><span className="sub">{tools.join(", ")}</span></div>
      {spec.about && <p>{spec.about}</p>}
      <p className="kb-request"><span className="sub">Its instructions:</span> {spec.prompt}</p>
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the agent ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("agents")}>Open Agents ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the agent"}</button></div>}
    </section>
  );
}
