// v0.15.9 keel's file history in the app: a file's versions with a diff and Restore (Wiki pages), the files that are
// missing or changed outside keel (Code › keel files), and what a flow applied (Flow page).

import { useState } from "react";
import { errorParts } from "../api";
import { byText, docHistoryApi, type DocFile } from "../docHistoryApi";
import { useApp, useLoad } from "../state";
import { ErrorBox, Pill } from "./ui";

const STATE: Record<DocFile["state"], ["ok" | "warn" | "idle", string]> = {
  ok: ["ok", "ok"], changed: ["warn", "changed outside keel"], missing: ["warn", "missing"], deleted: ["idle", "deleted"],
};

function Diff({ text }: { text: string }) {
  return (
    <pre className="mono dh-diff" aria-label="Changes">
      {text.split("\n").map((l, i) => (
        <span key={i} className={l.startsWith("+") && !l.startsWith("+++") ? "dh-add" : l.startsWith("-") && !l.startsWith("---") ? "dh-del" : undefined}>
          {l}{"\n"}
        </span>
      ))}
    </pre>
  );
}

/** One file's versions, newest first: pick one to see what changed since (to the file now), restore it. */
export function DocHistoryPanel({ pid, path, onRestored }: { pid: string; path: string; onRestored?: () => void }) {
  const { toast } = useApp();
  const list = useLoad(`dochistory:${pid}:${path}`, () => docHistoryApi.versions(pid, path));
  const [open, setOpen] = useState<string | null>(null);
  const [diff, setDiff] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  if (list.error) return <ErrorBox error={list.error} />;
  const versions = list.data ?? [];
  if (!versions.length) return null;
  const show = async (id: string) => {
    setOpen(id);
    setDiff(null);
    try {
      setDiff((await docHistoryApi.diff(pid, path, id, "file")).diff);
    } catch (e) {
      setErr(errorParts(e));
    }
  };
  const restore = async (id: string, n: number) => {
    if (!window.confirm(`Put version ${n} of ${path} back into the file? The text there now is kept as a version.`)) return;
    try {
      await docHistoryApi.restore(pid, id);
      toast(`Version ${n} is back in ${path}.`);
      await list.reload();
      onRestored?.();
    } catch (e) {
      setErr(errorParts(e));
    }
  };
  return (
    <section className="dh" aria-label="History">
      <h3 className="wh">History</h3>
      {err && <ErrorBox error={err} />}
      <ul className="dh-list">
        {versions.map((v) => (
          <li key={v.id}>
            <button type="button" className="linkbtn" onClick={() => void show(v.id)} aria-pressed={open === v.id}>
              Version {v.version}
            </button>{" "}
            <span className="sub">
              {v.deleted ? "deleted" : `${v.size} bytes`} · {byText(v)}{v.phase ? ` · ${v.phase}` : ""} · {v.at}
              {v.commit_sha ? ` · commit ${v.commit_sha.slice(0, 7)}` : ""}
            </span>{" "}
            {!v.deleted && v.version !== versions[0].version && (
              <button type="button" className="btn sm" onClick={() => void restore(v.id, v.version)}>Restore</button>
            )}
          </li>
        ))}
      </ul>
      {open && (diff === null ? <p className="sub">Loading the changes…</p> : <><p className="sub">From this version to the file now:</p><Diff text={diff} /></>)}
    </section>
  );
}

/** keel's files that are missing (Restore) or were changed outside keel. Nothing when all is well. */
export function DocProblems({ pid }: { pid: string }) {
  const { toast } = useApp();
  const files = useLoad(`docfiles:${pid}`, () => docHistoryApi.files(pid));
  const odd = (files.data ?? []).filter((f) => f.state === "missing" || f.state === "changed");
  if (!odd.length) return null;
  const restore = async (f: DocFile) => {
    const newest = (await docHistoryApi.versions(pid, f.path)).find((v) => !v.deleted);
    if (!newest || !window.confirm(`Restore ${f.path} (version ${newest.version})?`)) return;
    await docHistoryApi.restore(pid, newest.id);
    toast(`${f.path} is back.`);
    await files.reload();
  };
  return (
    <ul className="dh-problems" aria-label="keel files that need a look">
      {odd.map((f) => (
        <li key={f.path}>
          <span className="mono">{f.path}</span> <Pill tone={STATE[f.state][0]}>{STATE[f.state][1]}</Pill>{" "}
          {f.state === "missing" && <button type="button" className="btn sm" onClick={() => void restore(f)}>Restore</button>}
        </li>
      ))}
    </ul>
  );
}

/** What a flow applied on top of the repo: its branch and worktree, its commits, the files it recorded instead. */
export function AppliedPanel({ tid }: { tid: string }) {
  const a = useLoad(`applied:${tid}`, () => docHistoryApi.applied(tid));
  const items = a.data?.items ?? [];
  if (!items.length) return null;
  const label: Record<string, string> = { branch: "branch", worktree: "worktree", commit: "commit", recorded: "recorded (not in git)", file: "file" };
  return (
    <details className="dh-applied">
      <summary>What keel applied ({items.length})</summary>
      <ul>
        {items.map((x, i) => (
          <li key={i}>
            <span className="sub">{label[x.kind] ?? x.kind}</span> <span className="mono">{x.kind === "commit" ? x.ref.slice(0, 7) : x.ref}</span>
            {x.subject ? ` ${x.subject}` : ""}
            {x.files.length > 0 && <span className="sub"> · {x.files.length} file{x.files.length === 1 ? "" : "s"}</span>}
          </li>
        ))}
      </ul>
    </details>
  );
}
