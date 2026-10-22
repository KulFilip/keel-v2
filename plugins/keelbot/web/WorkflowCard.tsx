// KeelBot's Workflow action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useEffect, useState } from "react";
import { CodeBlock, errorParts, go, type Workflow, type WorkflowCheck } from "@keel/web-sdk";
import { kb } from "./keelbotApi";
import { plural } from "./cardUtil";

/** A workflow KeelBot wrote: keel's check of it, the YAML, and Save (into a folder of the Workflows page). */
export function WorkflowCard({
  pid,
  body,
  onAsk,
}: {
  pid: string;
  body: string;
  onAsk?: (text: string) => void;
}) {
  const [check, setCheck] = useState<WorkflowCheck | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    kb.checkWorkflow(pid, body).then(
      (c) => live && setCheck(c),
      (e) => live && setCheckErr(errorParts(e).message),
    );
    return () => {
      live = false;
    };
  }, [pid, body]);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.importWorkflow(pid, {
        yaml: body,
        ...(folder.trim() ? { folder: folder.trim() } : {}),
      });
      setSaved(r.workflow);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const name = check?.name || "New workflow";
  const problems = check && !check.valid ? check.errors : [];
  return (
    <section className="kb-card" aria-label={`New workflow: ${name}`}>
      <div className="kb-card-h">
        <span className="kb-tag">New workflow</span>
        <b>{name}</b>
      </div>
      {!check && !checkErr && <p className="sub">keel checks it…</p>}
      {checkErr && (
        <p className="kb-err" role="alert">
          keel could not check it: {checkErr}
        </p>
      )}
      {check && (
        <p className="sub kb-meta">
          {plural(check.steps, "step")} · {plural(check.gates, "gate")} ·{" "}
          {check.agents.length
            ? `agents: ${check.agents.join(", ")}`
            : "no agents (code steps only, no model runs)"}
          {check.commands.length > 0 && (
            <>
              {" "}
              · runs{" "}
              {check.commands.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </>
          )}
        </p>
      )}
      {check?.warnings.map((w) => (
        <p key={w} className="kb-warn">
          {w}
        </p>
      ))}
      {problems.length > 0 && (
        <div className="kb-err" role="alert">
          <b>keel cannot run it yet:</b>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {onAsk && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                onAsk(
                  `keel's check found problems in the workflow "${name}":\n${problems.map((p) => `- ${p}`).join("\n")}\nFix them and give the whole workflow again.`,
                )
              }
            >
              Ask KeelBot to fix it
            </button>
          )}
        </div>
      )}
      <details className="kb-yaml">
        <summary>Show the YAML</summary>
        <CodeBlock text={body} lang="yaml" gutter={false} />
      </details>
      {saved ? (
        <p className="kb-done">
          Saved as <b>{saved.name}</b>
          {saved.folder ? (
            <>
              {" "}
              in the folder <b>{saved.folder}</b>
            </>
          ) : null}
          .{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => go("workflows", saved.id)}
          >
            Open it ▸
          </button>
        </p>
      ) : (
        <>
          {err && (
            <p className="kb-err" role="alert">
              <b>{err.message}</b>
              {err.hint && <span className="sub"> {err.hint}</span>}
            </p>
          )}
          <div className="row">
            <input
              className="inline-input kb-folder"
              placeholder="Folder (optional)"
              aria-label="Folder for the workflow"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !check?.valid}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save the workflow"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}
