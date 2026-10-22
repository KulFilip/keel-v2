// KeelBot's Skill action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, CodeBlock, errorParts, go, useLoad } from "@keel/web-sdk";
import { kb } from "./keelbotApi";

/** A SKILL.md's front matter as KeelBot writes it: name, description, and the agents that should load it (a list or
 *  words with commas). */
export function skillHead(body: string): { name: string; description: string; agents: string[] } {
  const m = /^---\n([\s\S]*?)\n---/.exec((body ?? "").replace(/\r\n?/g, "\n"));
  const fm = m?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
  const agents = field("agents").replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return { name: field("name").replace(/^["']|["']$/g, ""), description: field("description"), agents };
}

/** 0.18.6 a skill KeelBot wrote (```keel-skill```): its text and the agents to load it (from its front matter, the
 *  person changes them); Save adds it to the project's skills and puts it on those agents. */
export function SkillCard({ pid, body }: { pid: string; body: string }) {
  const head = skillHead(body);
  const agents = useLoad(pid ? `kb-agents:${pid}` : null, () => kb.agentIds(pid), { live: false });
  const [who, setWho] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  if (!head.name) return <p className="kb-card bad" role="note">KeelBot's skill has no name in its front matter. Ask it to give it again.</p>;
  const known = (agents.data ?? []).map((a) => a.id);
  const picked = who ?? head.agents.filter((a) => !agents.data || known.includes(a));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await kb.saveSkill(pid, body);
      if (picked.length) await kb.skillAgents(pid, s.id, picked);
      setDone(`Saved ${s.id}` + (picked.length ? `: loaded by ${picked.join(", ")} from their next run.` : ". Put it on agents on the Skills page."));
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New skill: ${head.name}`}>
      <div className="kb-card-h"><span className="kb-tag">Skill</span><b>{head.name}</b><span className="sub">~{Math.round(body.length / 4)} tokens</span></div>
      {head.description && <p>{head.description}</p>}
      <CodeBlock text={body} gutter={false} />
      {known.length > 0 && !done && (
        <div className="row" role="group" aria-label="Agents that load it" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="sub">Load it for:</span>
          {known.map((a) => (
            <label key={a} className="chk">
              <input type="checkbox" checked={picked.includes(a)}
                onChange={(e) => setWho(e.target.checked ? [...picked, a] : picked.filter((x) => x !== a))} /> {a}
            </label>
          ))}
        </div>
      )}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the skill KeelBot wrote`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("skills")}>Open Skills ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the skill"}</button></div>}
    </section>
  );
}
