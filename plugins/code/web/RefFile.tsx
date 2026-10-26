// 0.18.57 A file as another branch, review ref or commit has it, and the editor's answer to a file the project folder
// does not have. A KeelBot answer, a review finding or a flow's citation made while looking at a branch that is not
// checked out here (a PR's head, a side session's worktree, a flow's worktree) links `path:line?ref=<ref>`: the editor
// shows that file read-only (GET /repo/file-at, nothing is checked out) under a banner "Showing <ref> — not checked
// out", with "Check out this branch" (asks first, refuses while the folder has uncommitted changes) and "Open in the
// worktree" when a side session or a flow has that branch out. A link without a ref to a file the work tree does not
// have looks for it on the refs keel knows (GET /repo/find) and offers "Found on <branch> — open it".

import { useEffect, useState } from "react";
import { ErrorBox, errorParts, useApp, useLoad } from "@keel/web-sdk";
import { codeApi as api, type RefFile } from "./codeApi";
import { CodeView, Notice, type Cmd, type Cursor, type Target } from "./Editor";
import { nameOf, refLabel } from "./model";

const isSide = (branch?: string | null) =>
  !!branch && branch.startsWith("keel/helper/");

/** The banner over a file shown from a ref: what it is, where the folder is, and what you can do. */
export function RefBanner({
  pid,
  f,
  onWorktree,
  onCheckedOut,
}: {
  pid: string;
  f: RefFile;
  /** show the worktree's copy (true) or the committed file (false) */
  onWorktree: (on: boolean) => void;
  onCheckedOut: (branch: string) => void;
}) {
  const { toast } = useApp();
  const [ask, setAsk] = useState<
    | null
    | { kind: "confirm" }
    | { kind: "dirty"; n: number }
    | { kind: "error"; error: { message: string; hint?: string } }
  >(null);
  const [busy, setBusy] = useState(false);
  const label = refLabel(f.ref);
  const where = f.checked_out ? (
    <>
      The project folder is on <b className="mono">{f.checked_out}</b>.
    </>
  ) : (
    <>The project folder has no branch checked out.</>
  );
  // "Check out" is for a branch no worktree has out (git refuses to check out one branch twice)
  const canCheckOut = !!f.branch && !f.worktree;
  const start = async () => {
    setBusy(true);
    try {
      const changes = await api.changes(pid);
      setAsk(
        changes.length
          ? { kind: "dirty", n: changes.length }
          : { kind: "confirm" },
      );
    } catch (e) {
      setAsk({ kind: "error", error: errorParts(e) });
    } finally {
      setBusy(false);
    }
  };
  const checkOut = async () => {
    if (!f.branch) return;
    setBusy(true);
    try {
      await api.gitSwitch(pid, f.branch);
      toast(`Checked out ${f.branch}.`);
      setAsk(null);
      onCheckedOut(f.branch);
    } catch (e) {
      setAsk({ kind: "error", error: errorParts(e) });
    } finally {
      setBusy(false);
    }
  };
  const tree = f.worktree;
  return (
    <div
      className="ref-banner"
      role="status"
      aria-label="Not the checked-out branch"
    >
      <p className="ref-what">
        {f.source === "worktree" ? (
          <>
            <b>Showing {label} in its worktree</b> — with what is not committed
            there yet. Read-only.{" "}
          </>
        ) : (
          <>
            <b>Showing {label} — not checked out.</b> Read-only
            {f.kind === "commit" ? "" : `, at ${f.sha.slice(0, 7)}`}.{" "}
          </>
        )}
        <span className="sub">{where}</span>
      </p>
      <div className="ref-acts">
        {canCheckOut && (
          <button
            type="button"
            className="btn sm"
            disabled={busy}
            onClick={() => void start()}
            title={`git switch ${f.branch} in the project folder`}
          >
            Check out this branch
          </button>
        )}
        {tree && f.source !== "worktree" && (
          <button
            type="button"
            className="btn sm"
            onClick={() => onWorktree(true)}
            title={tree.path}
          >
            {isSide(tree.branch)
              ? "Open in the side session's worktree"
              : "Open in the worktree"}
          </button>
        )}
        {f.source === "worktree" && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => onWorktree(false)}
          >
            Show the committed file
          </button>
        )}
      </div>
      {ask?.kind === "confirm" && (
        <div className="ref-ask" role="group" aria-label="Check out">
          <span>
            Check out <b className="mono">{f.branch}</b> in the project folder
            {f.checked_out ? (
              <>
                {" "}
                (now on <span className="mono">{f.checked_out}</span>)
              </>
            ) : null}
            ?
          </span>
          <button
            type="button"
            className="btn sm primary"
            disabled={busy}
            onClick={() => void checkOut()}
          >
            Check out
          </button>
          <button
            type="button"
            className="btn sm ghost"
            disabled={busy}
            onClick={() => setAsk(null)}
          >
            Cancel
          </button>
        </div>
      )}
      {ask?.kind === "dirty" && (
        <div className="errbox" role="alert">
          <b>
            Not checked out: the project folder has{" "}
            {ask.n === 1
              ? "1 uncommitted change"
              : `${ask.n} uncommitted changes`}
            .
          </b>
          <span className="sub">
            Commit or stash {ask.n === 1 ? "it" : "them"} first (Source
            control), then check out {f.branch}. You can read the file here
            meanwhile.
          </span>
          <div>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => setAsk(null)}
            >
              Close
            </button>
          </div>
        </div>
      )}
      {ask?.kind === "error" && <ErrorBox error={ask.error} />}
    </div>
  );
}

/** The editor body of a "ref" tab: the banner and the file as `ref` has it. A ref that is the checked-out branch hands
 *  the tab back to the work tree's file (onCurrent). */
export function RefFilePane({
  pid,
  path,
  refName,
  wrap,
  target,
  cmd,
  onCursor,
  onLink,
  scrollKey,
  onCurrent,
  onCheckedOut,
}: {
  pid: string;
  path: string;
  refName: string;
  wrap: boolean;
  target: Target | null;
  cmd: Cmd;
  onCursor: (c: Cursor) => void;
  onLink: (line: number) => void;
  scrollKey: string;
  onCurrent: () => void;
  onCheckedOut: (branch: string) => void;
}) {
  const [fromTree, setFromTree] = useState(false);
  const f = useLoad(
    `file-at:${pid}:${refName}:${path}:${fromTree ? "wt" : "ref"}`,
    () => api.fileAt(pid, path, refName, fromTree ? "worktree" : undefined),
    { live: false },
  );
  const data = f.data;
  useEffect(() => {
    if (data?.current) onCurrent();
  }, [data?.current]); // eslint-disable-line react-hooks/exhaustive-deps
  if (f.error && !data) {
    return (
      <div className="ed-note">
        <ErrorBox error={f.error} onRetry={() => void f.reload()} />
        {fromTree && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setFromTree(false)}
          >
            Show the committed file
          </button>
        )}
      </div>
    );
  }
  if (!data || data.current)
    return (
      <div className="ed-note">
        <span className="pg-spin" role="status">
          Opening {nameOf(path)} on {refLabel(refName)}…
        </span>
      </div>
    );
  return (
    <div className="ed-big">
      <RefBanner
        pid={pid}
        f={data}
        onWorktree={setFromTree}
        onCheckedOut={onCheckedOut}
      />
      {data.binary || data.text == null ? (
        <Notice title={`${nameOf(path)} is a binary file.`}>
          keel shows text files from another branch only.
        </Notice>
      ) : (
        <CodeView
          key={`${scrollKey}:${data.source}`}
          text={data.text}
          path={data.path}
          wrap={wrap}
          target={target}
          cmd={cmd}
          onCursor={onCursor}
          onLink={onLink}
          scrollKey={`${scrollKey}:${data.source}`}
        />
      )}
    </div>
  );
}

/** A file tab whose file could not be read: the error, and — when the work tree does not have the file — the
 *  branches and review refs keel knows that do ("Found on <branch> — open it"). */
export function FileError({
  pid,
  path,
  error,
  onRetry,
  onOpenRef,
}: {
  pid: string;
  path: string;
  error: { message: string; hint?: string };
  onRetry: () => void;
  onOpenRef: (ref: string) => void;
}) {
  const found = useLoad(`find:${pid}:${path}`, () => api.find(pid, path), {
    live: false,
  });
  const d = found.data;
  if (!d || d.in_work_tree)
    return (
      <div className="ed-note">
        <ErrorBox error={error} onRetry={onRetry} />
      </div>
    );
  const [first, ...more] = d.refs;
  return (
    <div
      className="ed-note ed-notice ref-missing"
      role="region"
      aria-label="File not in the project folder"
    >
      <b>
        {path} is not in the project folder
        {d.checked_out ? (
          <>
            {" "}
            (on <span className="mono">{d.checked_out}</span>)
          </>
        ) : null}
        .
      </b>
      {first ? (
        <>
          <span className="sub">
            It was probably written about another branch. keel found it here:
          </span>
          <div className="ref-acts">
            <button
              type="button"
              className="btn sm primary"
              onClick={() => onOpenRef(first.ref)}
            >
              Found on {first.label} — open it
            </button>
            {more.map((r) => (
              <button
                key={r.ref}
                type="button"
                className="btn sm"
                onClick={() => onOpenRef(r.ref)}
              >
                {r.label}
              </button>
            ))}
          </div>
        </>
      ) : (
        <span className="sub">
          keel found it on no branch or review it knows. It may have been moved
          or deleted, or it is on a branch that was not fetched.
        </span>
      )}
    </div>
  );
}
