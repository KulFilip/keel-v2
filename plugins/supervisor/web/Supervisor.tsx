// The Supervisor's Jobs tab (plugins/supervisor): the flow of this project that waits now, its Supervisor switch and mode,
// and the audit log (GET /api/projects/{pid}/supervisor/decisions). It imports only react and @keel/web-sdk.

import { useState } from "react";
import { EmptyState, get, post, useLoad } from "@keel/web-sdk";

export type Decision = {
  id: string;
  thread_id: string;
  step: string | null;
  ac: string | null;
  kind: string | null;
  action: string;
  decision: string | null;
  choice: string | null;
  why: string | null;
  confidence: string | null;
  evidence: string[];
  code: string | null;
  summary: string | null;
  tokens: number;
  outcome: string;
  at: string;
};

type Settings = { on: boolean; mode: "shadow" | "act"; effort?: string; cap_tokens: number };
type FlowView = { thread: { thread_id: string; title?: string; status?: string } | null };
type SupView = { settings: Settings; used: { tokens: number } };

const base = (pid: string) => `/projects/${encodeURIComponent(pid)}`;
export const supervisor = {
  decisions: (pid: string) => get<{ decisions: Decision[] }>(`${base(pid)}/supervisor/decisions?limit=100`),
  flow: (pid: string) => get<FlowView>(`${base(pid)}/flow`),
  settings: (pid: string, tid: string) => get<SupView>(`${base(pid)}/flows/${encodeURIComponent(tid)}/supervisor`),
  change: (pid: string, tid: string, body: Partial<Settings>) =>
    post<SupView>(`${base(pid)}/flows/${encodeURIComponent(tid)}/supervisor`, body),
};

/** One row's result in plain words. */
export function outcomeText(d: Decision): string {
  if (d.outcome === "applied") return d.action === "send_back" || d.decision === "reject" ? "sent back" : `answered ${d.choice ?? d.decision ?? ""}`.trim();
  if (d.outcome === "suggested") return "suggested";
  if (d.outcome === "stale") return "too late (you answered)";
  return "asked you";
}

function FlowSwitch({ pid, tid, title, onChanged }: { pid: string; tid: string; title: string; onChanged: () => void }) {
  const s = useLoad(`supervisor:${pid}:${tid}`, () => supervisor.settings(pid, tid));
  const [busy, setBusy] = useState(false);
  const set = async (body: Partial<Settings>) => {
    setBusy(true);
    try {
      s.setData(await supervisor.change(pid, tid, body));
      onChanged();
    } finally {
      setBusy(false);
    }
  };
  const cur = s.data?.settings;
  return (
    <section aria-label="Supervisor for this flow" className="panel">
      <h3>{title}</h3>
      {s.error && <p role="alert">{s.error.message}</p>}
      {cur && (
        <p>
          <label>
            <input type="checkbox" checked={cur.on} disabled={busy} onChange={(e) => void set({ on: e.target.checked })} />{" "}
            Supervisor on
          </label>{" "}
          <label>
            Mode{" "}
            <select value={cur.mode} disabled={busy} onChange={(e) => void set({ mode: e.target.value as Settings["mode"] })}>
              <option value="shadow">shadow: only suggests</option>
              <option value="act">act: answers when sure</option>
            </select>
          </label>{" "}
          <span>
            {s.data!.used.tokens.toLocaleString()} of {cur.cap_tokens.toLocaleString()} tokens used
          </span>
        </p>
      )}
    </section>
  );
}

export function SupervisorView({ pid }: { pid: string }) {
  const rows = useLoad(`supervisor-log:${pid}`, () => supervisor.decisions(pid));
  const flow = useLoad(`supervisor-flow:${pid}`, () => supervisor.flow(pid));
  const t = flow.data?.thread;
  const live = t && t.status !== "done" && t.status !== "stopped" && t.status !== "failed";
  const list = rows.data?.decisions ?? [];
  return (
    <div>
      {live && <FlowSwitch pid={pid} tid={t.thread_id} title={t.title || t.thread_id} onChanged={() => void rows.reload()} />}
      {rows.error && <p role="alert">{rows.error.message}</p>}
      {!rows.loading && list.length === 0 ? (
        <EmptyState title="The Supervisor has not looked at anything yet.">
          Turn it on for a flow: it looks at each gate, answers when it is sure (mode act) or only suggests (mode shadow), and
          asks you when it is not sure, when only you may answer, or when its budget is used up.
        </EmptyState>
      ) : (
        <table aria-label="Supervisor decisions">
          <thead>
            <tr><th>When</th><th>Step</th><th>Result</th><th>Sure</th><th>Why</th><th>Tokens</th></tr>
          </thead>
          <tbody>
            {list.map((d) => (
              <tr key={d.id}>
                <td>{new Date(d.at).toLocaleTimeString()}</td>
                <td>{[d.step, d.ac].filter(Boolean).join(" ")}</td>
                <td>{outcomeText(d)}</td>
                <td>{d.confidence ?? ""}</td>
                <td title={(d.evidence || []).join("\n")}>{d.summary || d.why || ""}</td>
                <td>{d.tokens.toLocaleString()}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </div>
  );
}
