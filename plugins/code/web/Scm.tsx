// Source control (read-only): the uncommitted files grouped as staged / changed / untracked (a click opens the
// diff), the workspace Doctor when the tree is dirty, and this branch's commits against the base with each
// commit's files (keel's own commits marked). Worktrees and branches are at the end; with the Git plugin a branch opens
// as a tab (Branch.tsx): its commits, the files it changed, and Switch. The Git plugin's panel (commit, push, the pull
// request) comes from its part (slot code.activity, place "scm").

import { useMemo, useState, type ReactNode } from "react";
import { clock, ErrorBox, errorParts, SLOTS, useLoad, useSlot, type CodeActivityItem } from "@keel/web-sdk";
import { codeApi as api, type Change, type CommitView, type RepoInfo } from "./codeApi";
import { Chevron, FileIcon, Icon } from "./icons";
import { buildBranchTree, defaultOpen, filterTree, loadOpen, saveOpen, type TreeLeaf, type TreeNode } from "./branchTree";
import { acOf, decoOf, nameOf, parentOf } from "./model";

type Props = {
  pid: string;
  repo: RepoInfo | null;
  changes: Change[] | null;
  changesError: { message: string; hint?: string } | null;
  onOpenChange: (path: string, pin: boolean) => void;
  onOpenCommitFile: (sha: string, path: string, pin: boolean) => void;
  onDoctor: () => void;
  /** with the Git plugin: open a branch's tab (a single click a preview tab, a double click a pinned one) */
  onOpenBranch?: (name: string, pin: boolean) => void;
  /** v0.15.2 open the Git log on a branch ("" = the current one) */
  onOpenLog?: (branch: string) => void;
};

function Group({ title, count, children, start = true }: { title: string; count?: number; children: ReactNode; start?: boolean }) {
  const [open, setOpen] = useState(start);
  return (
    <section className="scm-g">
      <button type="button" className="scm-gh" aria-expanded={open} onClick={() => setOpen(!open)}>
        <span className="ex-tw"><Chevron open={open} /></span>
        <span className="scm-gt">{title}</span>
        {count !== undefined && <span className="sr-count">{count}</span>}
      </button>
      {open && <div className="scm-gb">{children}</div>}
    </section>
  );
}

function ChangeRow({ c, as, onOpen }: { c: Change; as: "staged" | "unstaged" | "untracked" | "conflict"; onOpen: (p: string, pin: boolean) => void }) {
  const letter = as === "untracked" ? "U" : as === "conflict" ? "!" : as === "staged" ? (c.staged === "C" ? "R" : c.staged ?? "M") : c.unstaged ?? "M";
  const d = decoOf(as === "staged" ? { path: c.path, staged: c.staged } : as === "unstaged" ? { path: c.path, unstaged: c.unstaged } : c);
  return (
    <button type="button" className={`scm-row t-${d?.tone ?? "mod"}`} onClick={() => onOpen(c.path, false)} onDoubleClick={() => onOpen(c.path, true)}
      title={`${c.path}${c.from ? ` (from ${c.from})` : ""} · ${d?.title ?? ""}`} aria-label={`Open the changes of ${c.path}`}>
      <FileIcon name={nameOf(c.path)} />
      <span className={`ex-name${letter === "D" ? " gone" : ""}`}>{nameOf(c.path)}</span>
      <span className="sr-dir">{parentOf(c.path)}</span>
      <span className={`ex-deco t-${d?.tone ?? "mod"}`}>{letter}</span>
    </button>
  );
}

export function CommitRow({ pid, c, onOpen }: { pid: string; c: { sha: string; message: string; author: string; at: string; keel?: boolean }; onOpen: (sha: string, path: string, pin: boolean) => void }) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CommitView | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const ac = acOf(c.message);
  const toggle = () => {
    setOpen(!open);
    if (!view && !open) api.commit(pid, c.sha).then(setView, (e) => setErr(errorParts(e)));
  };
  return (
    <div className="scm-c">
      <button type="button" className="scm-ch" aria-expanded={open} onClick={toggle} title={c.message}>
        <span className="ex-tw"><Chevron open={open} /></span>
        <span className="scm-cm">
          <span className="scm-msg">{c.keel && <span className="scm-keel" title="A keel commit">keel</span>}{ac && <span className="scm-ac">{ac}</span>}{c.message}</span>
          <span className="scm-meta mono">{c.sha.slice(0, 7)} · {c.author} · {clock(c.at, false)}</span>
        </span>
      </button>
      {open && (
        <div className="scm-cf">
          {err ? <ErrorBox error={err} /> : !view ? <span className="pg-spin" role="status">Reading the commit…</span> : view.files.map((f) => (
            <button key={f.path} type="button" className={`scm-row t-${f.status === "A" ? "add" : f.status === "D" ? "del" : "mod"}`}
              onClick={() => onOpen(c.sha, f.path, false)} onDoubleClick={() => onOpen(c.sha, f.path, true)} title={f.from ? `${f.path} (from ${f.from})` : f.path}
              aria-label={`Open the change of ${f.path} in ${c.sha.slice(0, 7)}`}>
              <FileIcon name={nameOf(f.path)} />
              <span className="ex-name">{nameOf(f.path)}</span>
              <span className="sr-dir">{parentOf(f.path)}</span>
              <span className={`ex-deco t-${f.status === "A" ? "add" : f.status === "D" ? "del" : "mod"}`}>{f.status}</span>
            </button>
          ))}
          {view && !view.files.length && <span className="sub">This commit changed no file.</span>}
        </div>
      )}
    </div>
  );
}

/** "1 commit ahead, 2 behind" — the words for ↑1 ↓2 */
export function aheadBehind(ahead: number, behind: number): string {
  if (!ahead && !behind) return "no new commits yet";
  const a = ahead ? `${ahead} commit${ahead === 1 ? "" : "s"} ahead` : "";
  const b = behind ? `${behind} behind` : "";
  return [a, b].filter(Boolean).join(", ");
}

/** The branches as a tree (branchTree.ts): Local, then one group per remote, folders by "/" prefix, a filter, counts. */
function BranchList({ pid, repo, gitOn, onOpenBranch, onOpenLog }: { pid: string; repo: RepoInfo; gitOn: boolean; onOpenBranch?: Props["onOpenBranch"]; onOpenLog?: Props["onOpenLog"] }) {
  const [q, setQ] = useState("");
  const [open, setOpen] = useState(() => loadOpen(pid));
  const remotes = repo.remote_branches ?? [];
  const total = repo.branches.length + remotes.length;
  const tree = useMemo(() => buildBranchTree(repo.branches, remotes, repo.branch), [repo.branches, remotes, repo.branch]);
  const filtering = q.trim().length > 0;
  const { groups, matches } = useMemo(() => filterTree(tree, q), [tree, q]);
  const isOpen = (id: string) => filtering || (open[id] ?? defaultOpen(id));
  const toggle = (id: string) => {
    const next = { ...open, [id]: !(open[id] ?? defaultOpen(id)) };
    setOpen(next);
    saveOpen(pid, next);
  };
  const row = (n: TreeLeaf, depth: number): ReactNode => {
    const b = n.branch;
    const isCur = !n.remote && b.name === repo.branch;
    const isBase = !n.remote && !isCur && b.name === repo.base;
    const body = (
      <>
        <Icon name="branch" size={14} />
        <span className="scm-cm">
          <span className="scm-bname">
            <b className="mono scm-msg">{b.name}</b>
            {isCur && <span className="scm-cur">current</span>}
            {isBase && <span className="scm-cur scm-base">base</span>}
          </span>
          {b.note && <span className="scm-meta">{b.note}</span>}
        </span>
      </>
    );
    const style = { paddingLeft: 24 + Math.max(depth - 1, 0) * 12 };
    const cls = `scm-row scm-br${isCur ? " on" : ""}`;
    if (gitOn && onOpenBranch) {
      return (
        <button key={n.id} type="button" className={cls} style={style} onClick={() => onOpenBranch(b.name, false)} onDoubleClick={() => onOpenBranch(b.name, true)}
          title={`${b.name}: its commits and changes against ${repo.base ?? "the base"}, and Switch`} aria-label={`Open the branch ${b.name}`}>
          {body}
        </button>
      );
    }
    if (onOpenLog) {
      return (
        <button key={n.id} type="button" className={cls} style={style} onClick={() => onOpenLog(b.name)} title={`${b.name}: its commits in the Git log`}
          aria-label={`Show the log of ${b.name}`}>
          {body}
        </button>
      );
    }
    return <div key={n.id} className="scm-wt"><b className="mono">{b.name}</b><span className="sub">{b.note}</span></div>;
  };
  const folder = (id: string, label: string, count: number, depth: number, kids: ReactNode, strong = false): ReactNode => (
    <div key={id} className="scm-bt">
      <button type="button" className={`scm-bfh${strong ? " strong" : ""}`} style={{ paddingLeft: 10 + depth * 12 }} aria-expanded={isOpen(id)} onClick={() => toggle(id)}
        aria-label={`${label} ${count}`}>
        <span className="ex-tw"><Chevron open={isOpen(id)} /></span>
        <span className="scm-gt mono">{label}</span>
        <span className="sr-count">{count}</span>
      </button>
      {isOpen(id) && kids}
    </div>
  );
  const nodes = (list: TreeNode[], depth: number): ReactNode[] =>
    list.map((n) => (n.type === "leaf" ? row(n, depth) : folder(n.id, n.label, n.count, depth, nodes(n.children, depth + 1))));
  return (
    <>
      {total > 8 && (
        <div className="sv-filter scm-bf">
          <input type="search" value={q} onChange={(e) => setQ(e.target.value)} placeholder={`Filter ${total} branches`} aria-label="Filter the branches" />
          {filtering && <span className="sub scm-bmatch" role="status">{matches} match{matches === 1 ? "" : "es"}</span>}
        </div>
      )}
      {groups.map((g) => folder(g.id, g.remote ? `${g.title} (remote)` : g.title, g.count, 0, nodes(g.nodes, 1), true))}
      {!groups.length && <p className="sub scm-none">No branch has “{q.trim()}” in its name.</p>}
    </>
  );
}

export function ScmView({ pid, repo, changes, changesError, onOpenChange, onOpenCommitFile, onDoctor, onOpenBranch, onOpenLog }: Props) {
  const branch = repo?.branch;
  const onBase = !!repo && repo.base === repo.branch;
  const commits = useLoad(`commits:${pid}:${onBase ? "all" : "branch"}`, () => api.commits(pid, 50, onBase ? undefined : "branch"));
  const plugins = useLoad(`plugins:${pid}`, () => api.plugins(pid), { live: false });
  const panel = useSlot<CodeActivityItem>(SLOTS.codeActivity)
    .flatMap((a) => (a.place === "scm" ? [a] : []))
    .find((a) => !a.plugin || !!plugins.data?.find((x) => x.name === a.plugin)?.enabled);
  // with the Git plugin on, Source control can change things (and a branch opens as a tab)
  const gitOn = !!panel;
  const list = changes ?? [];
  const staged = list.filter((c) => c.staged && !c.conflict);
  const unstaged = list.filter((c) => c.unstaged && !c.conflict);
  const untracked = list.filter((c) => c.untracked);
  const conflicts = list.filter((c) => c.conflict);
  const dirty = list.length;
  return (
    <div className="sv">
      <div className="sv-head">
        <h2 className="sv-title">Source control</h2>
        {onOpenLog && (
          <button type="button" className="btn sm ghost scm-log" onClick={() => onOpenLog("")} aria-label="Show the Git log"
            title="The Git log: every commit of a branch (or all branches) with a graph, who and when, and what is not committed">
            <Icon name="commit" size={14} /><span>Log</span>
          </button>
        )}
      </div>
      {/* one scroll for everything under the title: the Git panel and the Doctor's note can be taller than the view */}
      <div className="scm-scroll" data-testid="scm-scroll">
        <div className="scm-branch">
          <Icon name="branch" size={16} />
          <div className="scm-bn">
            <span className="scm-on">On branch</span>
            <b className="mono">{branch ?? "—"}</b>
            {repo && !onBase && (
              <span className="sub" title={`↑${repo.ahead} ↓${repo.behind} against ${repo.base}`}>
                from <span className="mono">{repo.base}</span> · {aheadBehind(repo.ahead, repo.behind)}
              </span>
            )}
          </div>
        </div>
        {panel ? <panel.component pid={pid} dirty={list.length} onChanged={() => void commits.reload()} />
          : <p className="scm-ro">Read-only: keel never stages, commits or changes files from this page. The Git plugin (Tools) adds commit, push and pull requests.</p>}
        {changesError && <div className="sv-pad"><ErrorBox error={changesError} /></div>}
        {dirty > 0 && (
          <div className="scm-dirty">
            <span>{dirty} uncommitted file{dirty === 1 ? "" : "s"}. A flow starts only on a clean tree.</span>
            <button className="btn sm" type="button" onClick={onDoctor}>Clean up with the Doctor</button>
          </div>
        )}
        {changes && !dirty && <p className="sv-pad sub">No uncommitted changes. The working tree is clean.</p>}
        {conflicts.length > 0 && <Group title="Conflicts" count={conflicts.length}>{conflicts.map((c) => <ChangeRow key={c.path} c={c} as="conflict" onOpen={onOpenChange} />)}</Group>}
        {staged.length > 0 && <Group title="Staged changes" count={staged.length}>{staged.map((c) => <ChangeRow key={c.path} c={c} as="staged" onOpen={onOpenChange} />)}</Group>}
        {unstaged.length > 0 && <Group title="Changes" count={unstaged.length}>{unstaged.map((c) => <ChangeRow key={c.path} c={c} as="unstaged" onOpen={onOpenChange} />)}</Group>}
        {untracked.length > 0 && <Group title="Untracked" count={untracked.length}>{untracked.map((c) => <ChangeRow key={c.path} c={c} as="untracked" onOpen={onOpenChange} />)}</Group>}
        <Group title={onBase ? `Recent commits on ${branch ?? "this branch"}` : `Commits on ${branch ?? "this branch"}, not in ${repo?.base ?? "the base"}`} count={commits.data?.length}>
          {commits.error ? <ErrorBox error={commits.error} /> : !commits.data ? <span className="pg-spin" role="status">Reading commits…</span>
            : commits.data.length ? commits.data.map((c) => <CommitRow key={c.sha} pid={pid} c={c} onOpen={onOpenCommitFile} />)
              : <p className="sub scm-none">No commits yet that {repo?.base ?? "the base"} does not have. A flow commits one step at a time: test(AC) for tests, feat(AC) for code.</p>}
        </Group>
        {repo && repo.worktrees.length > 1 && (
          <Group title="Worktrees (lanes)" count={repo.worktrees.length} start={false}>
            {repo.worktrees.map((w) => <div key={w.path} className="scm-wt"><b className="mono">{w.branch ?? "(detached)"}</b><span className="sub mono">{w.path}</span></div>)}
          </Group>
        )}
        {repo && repo.branches.length > 0 && (
          <Group key={gitOn ? "git" : "ro"} title="Branches" count={repo.branches.length + (repo.remote_branches?.length ?? 0)} start={gitOn}>
            <BranchList pid={pid} repo={repo} gitOn={gitOn} onOpenBranch={onOpenBranch} onOpenLog={onOpenLog} />
          </Group>
        )}
      </div>
    </div>
  );
}
