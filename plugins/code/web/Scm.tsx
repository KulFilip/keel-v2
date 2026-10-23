// Source control: the branch (its ticket key, how far it is from the base), the pull request, the uncommitted files
// (a click opens the diff) with the workspace Doctor when the tree is dirty, this branch's commits against the base
// with each commit's files (keel's own commits marked), worktrees, and the branches. Read-only on its own; the Git
// plugin's panel (slot code.activity, place "scm") adds push, the pull request card, the commit box and New branch,
// and Source control places each of its pieces (ScmPanelProps.layout). With the Git plugin a branch opens as a tab
// (Branch.tsx: its commits, the files it changed, and Switch), and can be switched to or checked out from the list.
//
// 0.18.38 the redesign: one card per part, the side bar wider and resizable (Ide.tsx), and a layout that follows its
// width (CSS container queries in styles/scm.css: two buttons a row when there is room, one when narrow).

import { useMemo, useState, type ReactNode } from "react";
import {
  clock,
  ErrorBox,
  errorParts,
  get,
  SLOTS,
  useApp,
  useHasPage,
  useLoad,
  useSlot,
  useStored,
  useStoredScroll,
  type CodeActivityItem,
  type ScmPanelParts,
} from "@keel/web-sdk";
import {
  codeApi as api,
  type Change,
  type CommitView,
  type GitBranchInfo,
  type RepoInfo,
} from "./codeApi";
import { Chevron, FileIcon, Icon } from "./icons";
import {
  buildBranchTree,
  defaultOpen,
  filterTree,
  loadOpen,
  saveOpen,
  type TreeLeaf,
  type TreeNode,
} from "./branchTree";
import { acOf, decoOf, nameOf, parentOf } from "./model";
import { ageOf, isStale, splitBranch, ticketKey } from "./scmModel";

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
  /** 0.18.38 the branch or the files changed (a switch, Refresh): read the repo and the changes again */
  onRepoChanged?: () => void;
};

type Stats = NonNullable<ScmPanelParts["stats"]>;
type ChangeKind = "staged" | "unstaged" | "untracked" | "conflict";

// sections the person opened or closed, remembered per browser ("commits": the commits on this branch)
const openKey = (id: string) => `keel.scm.open.${id}`;
function readOpen(id: string, fallback: boolean): boolean {
  try {
    const v = localStorage.getItem(openKey(id));
    return v === null ? fallback : v === "1";
  } catch {
    return fallback;
  }
}
function writeOpen(id: string, open: boolean) {
  try {
    localStorage.setItem(openKey(id), open ? "1" : "0");
  } catch {
    // storage blocked: the section starts as default next time
  }
}

function Group({
  title,
  count,
  meta,
  children,
  start = true,
  store,
  sub = false,
  label,
}: {
  title: string;
  count?: number;
  meta?: string;
  children: ReactNode;
  start?: boolean;
  /** remember open or closed under this id */
  store?: string;
  /** a group inside a section (staged, untracked …): smaller */
  sub?: boolean;
  /** the tooltip: what the group holds in full words */
  label?: string;
}) {
  const [open, setOpen] = useState(() =>
    store ? readOpen(store, start) : start,
  );
  const toggle = () => {
    setOpen(!open);
    if (store) writeOpen(store, !open);
  };
  return (
    <section className={`scm-g${sub ? " sub" : ""}`}>
      <button
        type="button"
        className="scm-gh"
        aria-expanded={open}
        onClick={toggle}
        title={label}
      >
        <span className="ex-tw">
          <Chevron open={open} />
        </span>
        <span className="scm-gt">{title}</span>
        {count !== undefined && <span className="sr-count">{count}</span>}
        {meta && <span className="scm-gmeta">{meta}</span>}
      </button>
      {open && <div className="scm-gb">{children}</div>}
    </section>
  );
}

const TONE: Record<string, string> = {
  M: "mod",
  A: "add",
  U: "add",
  D: "del",
  R: "ren",
  C: "ren",
  "!": "del",
};

function ChangeRow({
  c,
  as,
  stats,
  onOpen,
}: {
  c: Change;
  as: ChangeKind;
  stats?: Stats;
  onOpen: (p: string, pin: boolean) => void;
}) {
  const letter =
    as === "untracked"
      ? "U"
      : as === "conflict"
        ? "!"
        : as === "staged"
          ? c.staged === "C"
            ? "R"
            : (c.staged ?? "M")
          : (c.unstaged ?? "M");
  const d = decoOf(
    as === "staged"
      ? { path: c.path, staged: c.staged }
      : as === "unstaged"
        ? { path: c.path, unstaged: c.unstaged }
        : c,
  );
  const tone = TONE[letter] ?? d?.tone ?? "mod";
  const s = stats?.[c.path];
  return (
    <button
      type="button"
      className={`scm-row scm-chg t-${tone}`}
      onClick={() => onOpen(c.path, false)}
      onDoubleClick={() => onOpen(c.path, true)}
      title={`${c.path}${c.from ? ` (from ${c.from})` : ""} · ${d?.title ?? ""}`}
      aria-label={`Open the changes of ${c.path}`}
    >
      <span className={`scm-letter t-${tone}`} aria-hidden="true">
        {letter}
      </span>
      <span className="scm-path">
        <span className={`ex-name${letter === "D" ? " gone" : ""}`}>
          {nameOf(c.path)}
        </span>
        <span className="sr-dir">{parentOf(c.path)}</span>
      </span>
      {s && (s.added > 0 || s.deleted > 0) && (
        <span className="scm-delta mono" aria-hidden="true">
          {s.added > 0 && <span className="add">+{s.added}</span>}
          {s.deleted > 0 && <span className="del">−{s.deleted}</span>}
        </span>
      )}
    </button>
  );
}

export function CommitRow({
  pid,
  c,
  onOpen,
}: {
  pid: string;
  c: {
    sha: string;
    message: string;
    author: string;
    at: string;
    keel?: boolean;
  };
  onOpen: (sha: string, path: string, pin: boolean) => void;
}) {
  const [open, setOpen] = useState(false);
  const [view, setView] = useState<CommitView | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const ac = acOf(c.message);
  const toggle = () => {
    setOpen(!open);
    if (!view && !open)
      api.commit(pid, c.sha).then(setView, (e) => setErr(errorParts(e)));
  };
  return (
    <div className="scm-c">
      <button
        type="button"
        className="scm-ch"
        aria-expanded={open}
        onClick={toggle}
        title={c.message}
      >
        <span className="ex-tw">
          <Chevron open={open} />
        </span>
        <span className="scm-cm">
          <span className="scm-msg">
            {c.keel && (
              <span className="scm-keel" title="A keel commit">
                keel
              </span>
            )}
            {ac && <span className="scm-ac">{ac}</span>}
            {c.message}
          </span>
          <span className="scm-meta mono">
            {c.sha.slice(0, 7)} · {c.author} · {clock(c.at, false)}
          </span>
        </span>
      </button>
      {open && (
        <div className="scm-cf">
          {err ? (
            <ErrorBox error={err} />
          ) : !view ? (
            <span className="pg-spin" role="status">
              Reading the commit…
            </span>
          ) : (
            view.files.map((f) => (
              <button
                key={f.path}
                type="button"
                className={`scm-row t-${f.status === "A" ? "add" : f.status === "D" ? "del" : "mod"}`}
                onClick={() => onOpen(c.sha, f.path, false)}
                onDoubleClick={() => onOpen(c.sha, f.path, true)}
                title={f.from ? `${f.path} (from ${f.from})` : f.path}
                aria-label={`Open the change of ${f.path} in ${c.sha.slice(0, 7)}`}
              >
                <FileIcon name={nameOf(f.path)} />
                <span className="ex-name">{nameOf(f.path)}</span>
                <span className="sr-dir">{parentOf(f.path)}</span>
                <span
                  className={`ex-deco t-${f.status === "A" ? "add" : f.status === "D" ? "del" : "mod"}`}
                >
                  {f.status}
                </span>
              </button>
            ))
          )}
          {view && !view.files.length && (
            <span className="sub">This commit changed no file.</span>
          )}
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

/** The branch name with its folder prefix dimmed: feature/ ERPDM-1769-…; long names wrap anywhere. */
export function BranchName({
  name,
  className = "",
}: {
  name: string;
  className?: string;
}) {
  const { prefix, rest } = splitBranch(name);
  return (
    <span className={`scm-bn mono ${className}`.trim()}>
      {prefix && <span className="scm-prefix">{prefix}</span>}
      {rest}
    </span>
  );
}

type Chip = "all" | "mine" | "stale";

/** The branches: a filter that finds names and ticket keys, chips (Mine, Stale) where the Git plugin gives the data, the
 *  tree (branchTree.ts: the current branch on top, folders by prefix), the branches only a remote has, Switch and Check
 *  out with the Git plugin, and Clean up merged branches. */
function BranchList({
  pid,
  repo,
  gitOn,
  info,
  actions,
  onOpenBranch,
  onOpenLog,
  onSwitched,
}: {
  pid: string;
  repo: RepoInfo;
  gitOn: boolean;
  info: GitBranchInfo[] | null;
  actions?: ReactNode;
  onOpenBranch?: Props["onOpenBranch"];
  onOpenLog?: Props["onOpenLog"];
  onSwitched: () => void;
}) {
  const { toast } = useApp();
  // the branch filter, kept per project for this browser tab (leaving the Code page and coming back keeps it)
  const [q, setQ] = useStored<string>(`keel2.scm.q.${pid}`, "", {
    valid: (v) => typeof v === "string",
  });
  const [chip, setChip] = useStored<Chip>(`keel2.scm.chip.${pid}`, "all", {
    valid: (v) => v === "all" || v === "mine" || v === "stale",
  });
  const [open, setOpen] = useState(() => loadOpen(pid));
  const [busy, setBusy] = useState<string | null>(null);
  const [confirmClean, setConfirmClean] = useState(false);
  const byName = useMemo(
    () => new Map((info ?? []).map((b) => [b.name, b])),
    [info],
  );
  const localNames = useMemo(
    () => new Set(repo.branches.map((b) => b.name)),
    [repo.branches],
  );
  // a remote branch with a local twin is the same work: the remote groups list only what is not here yet
  const remoteOnly = useMemo(
    () =>
      (repo.remote_branches ?? []).filter(
        (b) => !localNames.has(b.name.slice(b.name.indexOf("/") + 1)),
      ),
    [repo.remote_branches, localNames],
  );
  const hasMine = !!info?.some((b) => b.mine !== undefined);
  const local = useMemo(() => {
    if (chip === "all" || !info) return repo.branches;
    return repo.branches.filter(
      (b) =>
        b.name === repo.branch ||
        (chip === "mine"
          ? byName.get(b.name)?.mine
          : isStale(byName.get(b.name)?.date)),
    );
  }, [chip, info, repo.branches, repo.branch, byName]);
  const total = repo.branches.length + remoteOnly.length;
  const tree = useMemo(
    () => buildBranchTree(local, chip === "all" ? remoteOnly : [], repo.branch),
    [local, chip, remoteOnly, repo.branch],
  );
  const filtering = q.trim().length > 0;
  const { groups, matches } = useMemo(() => filterTree(tree, q), [tree, q]);
  const merged = useMemo(
    () =>
      (info ?? []).filter(
        (b) =>
          !b.current &&
          b.ahead === 0 &&
          b.name !== repo.base &&
          b.name !== "main" &&
          b.name !== "master",
      ),
    [info, repo.base],
  );
  const isOpen = (id: string) => filtering || (open[id] ?? defaultOpen(id));
  const toggle = (id: string) => {
    const next = { ...open, [id]: !(open[id] ?? defaultOpen(id)) };
    setOpen(next);
    saveOpen(pid, next);
  };
  const run = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    try {
      toast(await fn());
      onSwitched();
    } catch (e) {
      const p = errorParts(e);
      toast(p.hint ? `${p.message} ${p.hint}` : p.message);
    } finally {
      setBusy(null);
    }
  };
  const switchTo = (name: string) =>
    void run(
      name,
      async () => `On ${(await api.gitSwitch(pid, name)).branch} now.`,
    );
  const row = (n: TreeLeaf, depth: number): ReactNode => {
    const b = n.branch;
    const isCur = !n.remote && b.name === repo.branch;
    const isBase = !n.remote && !isCur && b.name === repo.base;
    const g = n.remote ? undefined : byName.get(b.name);
    const short = n.remote ? b.name.slice(n.remote.length + 1) : b.name;
    const facts = g
      ? [
          g.ahead ? `↑${g.ahead}` : "",
          g.behind ? `↓${g.behind}` : "",
          g.mine === false && g.author ? `by ${g.author}` : "",
          ageOf(g.date),
        ]
          .filter(Boolean)
          .join(" · ")
      : "";
    const old = !!g && !isCur && !isBase && (isStale(g.date) || g.behind > 50);
    const body = (
      <>
        <span
          className={`scm-dot${isCur ? " on" : ""}${n.remote ? " remote" : ""}`}
          aria-hidden="true"
        />
        <span className="scm-cm">
          <span className="scm-bname">
            <b className="mono scm-msg">{b.name}</b>
            {isCur && <span className="scm-cur">current</span>}
            {isBase && <span className="scm-cur scm-base">base</span>}
          </span>
          {b.note && <span className="scm-meta">{b.note}</span>}
          {facts && (
            <span className={`scm-meta scm-facts${old ? " old" : ""}`}>
              {facts}
            </span>
          )}
        </span>
      </>
    );
    const style = { paddingLeft: 16 + Math.max(depth - 1, 0) * 12 };
    const cls = `scm-row scm-br${isCur ? " on" : ""}`;
    const main =
      gitOn && onOpenBranch ? (
        <button
          type="button"
          className={cls}
          style={style}
          onClick={() => onOpenBranch(b.name, false)}
          onDoubleClick={() => onOpenBranch(b.name, true)}
          title={`${b.name}: its commits and changes against ${repo.base ?? "the base"}, and Switch`}
          aria-label={`Open the branch ${b.name}`}
        >
          {body}
        </button>
      ) : onOpenLog ? (
        <button
          type="button"
          className={cls}
          style={style}
          onClick={() => onOpenLog(b.name)}
          title={`${b.name}: its commits in the Git log`}
          aria-label={`Show the log of ${b.name}`}
        >
          {body}
        </button>
      ) : (
        <div className="scm-wt">
          <b className="mono">{b.name}</b>
          <span className="sub">{b.note}</span>
        </div>
      );
    const side =
      !gitOn || isCur ? null : n.remote ? (
        <button
          type="button"
          className="scm-mini accent"
          disabled={!!busy}
          onClick={() => switchTo(short)}
          aria-label={`Check out ${b.name}`}
          title={`Make a local branch ${short} that tracks ${b.name}, and switch to it`}
        >
          {busy === short ? "…" : "Check out"}
        </button>
      ) : (
        <button
          type="button"
          className="scm-mini"
          disabled={!!busy}
          onClick={() => switchTo(b.name)}
          aria-label={`Switch to ${b.name}`}
        >
          {busy === b.name ? "…" : "Switch"}
        </button>
      );
    return (
      <div key={n.id} className={`scm-brow${isCur ? " on" : ""}`}>
        {main}
        {side}
      </div>
    );
  };
  const folder = (
    id: string,
    label: string,
    count: number,
    depth: number,
    kids: ReactNode,
    strong = false,
  ): ReactNode => (
    <div key={id} className="scm-bt">
      <button
        type="button"
        className={`scm-bfh${strong ? " strong" : ""}`}
        style={{ paddingLeft: 8 + depth * 12 }}
        aria-expanded={isOpen(id)}
        onClick={() => toggle(id)}
        aria-label={`${label} ${count}`}
      >
        <span className="ex-tw">
          <Chevron open={isOpen(id)} />
        </span>
        <span className="scm-gt mono">{label}</span>
        <span className="sr-count">{count}</span>
      </button>
      {isOpen(id) && kids}
    </div>
  );
  const nodes = (list: TreeNode[], depth: number): ReactNode[] =>
    list.map((n) =>
      n.type === "leaf"
        ? row(n, depth)
        : folder(n.id, n.label, n.count, depth, nodes(n.children, depth + 1)),
    );
  const chips: { id: Chip; label: string; title: string }[] = info
    ? [
        { id: "all", label: "All", title: "Every branch" },
        ...(hasMine
          ? [
              {
                id: "mine" as Chip,
                label: "Mine",
                title: "Branches whose last commit is yours (git user.email)",
              },
            ]
          : []),
        { id: "stale", label: "Stale", title: "No commit in 14 days" },
      ]
    : [];
  const findId = `scm-find-${pid}`;
  return (
    <div className="scm-brs">
      {(total > 8 || filtering || actions) && (
        <div className="scm-brs-top">
          {(total > 8 || filtering) && (
            <div className="scm-find">
              <label htmlFor={findId} className="scm-label">
                Filter the branches
              </label>
              <div className="scm-search">
                <Icon name="search" size={14} />
                <input
                  id={findId}
                  type="search"
                  value={q}
                  onChange={(e) => setQ(e.target.value)}
                  placeholder={`Filter ${total} branches`}
                  aria-describedby={`${findId}-tip`}
                />
                {filtering && (
                  <span className="scm-bmatch" role="status">
                    {matches} match{matches === 1 ? "" : "es"}
                  </span>
                )}
              </div>
              <span id={`${findId}-tip`} className="sr-only">
                A part of the name or a ticket key, like ERPDM-1769
              </span>
            </div>
          )}
          {actions && <div className="scm-brs-acts">{actions}</div>}
        </div>
      )}
      {chips.length > 1 && (
        <div className="scm-chips" role="group" aria-label="Show branches">
          {chips.map((c) => (
            <button
              key={c.id}
              type="button"
              className="scm-chip"
              aria-pressed={chip === c.id}
              title={c.title}
              onClick={() => setChip(c.id)}
            >
              {c.label}
            </button>
          ))}
        </div>
      )}
      {groups.map((g) =>
        folder(
          g.id,
          g.remote ? `On ${g.title} only` : g.title,
          g.count,
          0,
          nodes(g.nodes, 1),
          true,
        ),
      )}
      {!groups.length &&
        (filtering ? (
          <p className="sub scm-none">
            No branch has “{q.trim()}” in its name.
          </p>
        ) : (
          <p className="sub scm-none">No branch fits this filter.</p>
        ))}
      {(remoteOnly.length > 0 || (gitOn && merged.length > 0)) && (
        <div className="scm-brs-foot">
          <span>
            {repo.branches.length} local
            {remoteOnly.length
              ? ` · ${remoteOnly.length} only on a remote`
              : ""}
          </span>
          {gitOn &&
            merged.length > 0 &&
            (confirmClean ? (
              <span
                className="scm-confirm"
                role="group"
                aria-label="Clean up merged branches"
              >
                <span>
                  Delete {merged.length} merged branch
                  {merged.length === 1 ? "" : "es"}?
                </span>
                <button
                  type="button"
                  className="scm-mini accent"
                  disabled={!!busy}
                  onClick={() => {
                    setConfirmClean(false);
                    void run("cleanup", async () => {
                      const gone = (await api.gitCleanup(pid)).deleted ?? [];
                      return gone.length
                        ? `Deleted ${gone.length} merged branch${gone.length === 1 ? "" : "es"}: ${gone.join(", ")}.`
                        : "No branch was merged yet.";
                    });
                  }}
                >
                  Delete
                </button>
                <button
                  type="button"
                  className="scm-mini"
                  onClick={() => setConfirmClean(false)}
                >
                  Cancel
                </button>
              </span>
            ) : (
              <button
                type="button"
                className="scm-link"
                disabled={!!busy}
                onClick={() => setConfirmClean(true)}
                title={`Delete the local branches ${repo.base ?? "the base"} already has (git branch -d: nothing unmerged is lost): ${merged.map((b) => b.name).join(", ")}`}
              >
                Clean up merged branches ({merged.length})
              </button>
            ))}
        </div>
      )}
    </div>
  );
}

type Team = { keys?: string | null; projects?: string[] };

export function ScmView({
  pid,
  repo,
  changes,
  changesError,
  onOpenChange,
  onOpenCommitFile,
  onDoctor,
  onOpenBranch,
  onOpenLog,
  onRepoChanged,
}: Props) {
  const branch = repo?.branch;
  const onBase = !!repo && repo.base === repo.branch;
  const commits = useLoad(`commits:${pid}:${onBase ? "all" : "branch"}`, () =>
    api.commits(pid, 50, onBase ? undefined : "branch"),
  );
  const plugins = useLoad(`plugins:${pid}`, () => api.plugins(pid), {
    live: false,
  });
  const on = (plugin?: string) =>
    !plugin || !!plugins.data?.find((x) => x.name === plugin)?.enabled;
  const activity = useSlot<CodeActivityItem>(SLOTS.codeActivity);
  const panel = activity
    .flatMap((a) => (a.place === "scm" ? [a] : []))
    .find((a) => on(a.plugin));
  // keel's review (the Code Review plugin) opens a pull request from its link, when it is on here
  const review = activity.find(
    (a) => a.id === "review" && a.place !== "scm" && on(a.plugin),
  );
  // with the Git plugin on, Source control can change things (and a branch opens as a tab)
  const gitOn = !!panel;
  // where you had scrolled to, back once the changes and the plugin list are here
  const scrollRef = useStoredScroll<HTMLDivElement>(
    `keel2.scm.scroll.${pid}`,
    !!changes && !!plugins.data,
  );
  const gitBranches = useLoad(
    gitOn ? `scm-git-branches:${pid}` : null,
    () => api.gitBranches(pid),
    { live: false },
  );
  // the team's ticket-key pattern (keel Product › Teams), else the generic one
  const productOn = useHasPage("teams");
  const teams = useLoad(
    productOn ? "scm-teams" : null,
    () => get<Team[]>("/teams"),
    { live: false },
  );
  const pattern =
    teams.data?.find((t) => t.keys && t.projects?.includes(pid))?.keys ?? null;
  const [refresh, setRefresh] = useState(0);
  const list = changes ?? [];
  const staged = list.filter((c) => c.staged && !c.conflict);
  const unstaged = list.filter((c) => c.unstaged && !c.conflict);
  const untracked = list.filter((c) => c.untracked);
  const conflicts = list.filter((c) => c.conflict);
  const kinds = [conflicts, staged, unstaged, untracked].filter(
    (x) => x.length,
  ).length;
  const dirty = list.length;
  const key = branch ? ticketKey(branch, pattern) : null;
  const remotes = repo?.remote_branches?.length ?? 0;
  const changed = () => {
    void commits.reload();
    void gitBranches.reload();
    onRepoChanged?.();
  };

  const layout = (parts: ScmPanelParts): ReactNode => {
    const rows = (items: Change[], as: ChangeKind) =>
      items.map((c) => (
        <ChangeRow
          key={`${as}:${c.path}`}
          c={c}
          as={as}
          stats={parts.stats}
          onOpen={onOpenChange}
        />
      ));
    // one kind of change: a plain list; several (or a conflict): a group per kind
    const group = (title: string, items: Change[], as: ChangeKind) =>
      items.length > 0 &&
      (kinds > 1 || as === "conflict" ? (
        <Group key={as} sub title={title} count={items.length}>
          {rows(items, as)}
        </Group>
      ) : (
        <div key={as} className="scm-flat">
          {rows(items, as)}
        </div>
      ));
    return (
      <>
        <div ref={scrollRef} className="scm-scroll" data-testid="scm-scroll">
          <div className="scm-top">
            <section className="scm-sec scm-head" aria-label="Branch">
              <div className="scm-onrow">
                <span className="scm-on">On branch</span>
                {key && (
                  <span
                    className="scm-ticket mono"
                    title={`The ticket key in the branch name${pattern ? " (your team's pattern)" : ""}`}
                  >
                    {key}
                  </span>
                )}
              </div>
              {branch ? (
                <BranchName name={branch} className="scm-name" />
              ) : (
                <b className="scm-name mono">—</b>
              )}
              {repo && (
                <div className="scm-pills">
                  {!onBase && (
                    <span className="scm-pill">
                      from <span className="mono">{repo.base}</span>
                    </span>
                  )}
                  {!onBase && repo.ahead > 0 && (
                    <span
                      className="scm-pill tone-ok"
                      title={aheadBehind(repo.ahead, 0)}
                    >
                      ↑ {repo.ahead} ahead
                    </span>
                  )}
                  {!onBase && repo.behind > 0 && (
                    <span
                      className="scm-pill tone-warn"
                      title={`${repo.behind} commit${repo.behind === 1 ? "" : "s"} on ${repo.base} this branch does not have`}
                    >
                      ↓ {repo.behind} behind {repo.base}
                    </span>
                  )}
                  {!onBase && !repo.ahead && !repo.behind && (
                    <span className="scm-pill">no new commits yet</span>
                  )}
                  {onBase && <span className="scm-pill">the base branch</span>}
                  {parts.pills}
                </div>
              )}
              {parts.actions}
              {!panel && (
                <p className="scm-ro">
                  Read-only: keel never stages, commits or changes files from
                  this page. The Git plugin (Tools) adds commit, push and pull
                  requests.
                </p>
              )}
            </section>
            {parts.pr && (
              <section className="scm-sec" aria-labelledby={`scm-pr-${pid}`}>
                <h3 className="scm-h" id={`scm-pr-${pid}`}>
                  Pull request
                </h3>
                {parts.pr}
              </section>
            )}
          </div>
          <section className="scm-sec" aria-labelledby={`scm-ch-${pid}`}>
            <div className="scm-sec-h">
              <h3 className="scm-h" id={`scm-ch-${pid}`}>
                Changes
              </h3>
              {dirty > 0 && (
                <span className="scm-count">
                  {dirty} file{dirty === 1 ? "" : "s"}
                </span>
              )}
            </div>
            {changesError && <ErrorBox error={changesError} />}
            {dirty > 0 && (
              <div className="scm-dirty">
                <span>
                  {dirty} uncommitted file{dirty === 1 ? "" : "s"}. A flow
                  starts only on a clean tree.
                </span>
                <button className="scm-btn sm" type="button" onClick={onDoctor}>
                  Clean up with the Doctor
                </button>
              </div>
            )}
            {changes && !dirty && (
              <p className="scm-clean">
                <span className="scm-clean-i" aria-hidden="true">
                  ✓
                </span>
                Nothing to commit. The working tree is clean.
              </p>
            )}
            {dirty > 0 && (
              <div className="scm-changes">
                {group("Conflicts", conflicts, "conflict")}
                {group("Staged changes", staged, "staged")}
                {group("Not staged", unstaged, "unstaged")}
                {group("Untracked", untracked, "untracked")}
              </div>
            )}
            {parts.commit}
          </section>
          <div className="scm-rows">
            <Group
              store="commits"
              start={false}
              title={
                onBase
                  ? `Recent commits on ${branch ?? "this branch"}`
                  : "Commits on this branch"
              }
              label={
                onBase
                  ? undefined
                  : `Commits on ${branch ?? "this branch"} that ${repo?.base ?? "the base"} does not have`
              }
              count={commits.data?.length}
            >
              {commits.error ? (
                <ErrorBox error={commits.error} />
              ) : !commits.data ? (
                <span className="pg-spin" role="status">
                  Reading commits…
                </span>
              ) : commits.data.length ? (
                commits.data.map((c) => (
                  <CommitRow
                    key={c.sha}
                    pid={pid}
                    c={c}
                    onOpen={onOpenCommitFile}
                  />
                ))
              ) : (
                <p className="sub scm-none">
                  No commits yet that {repo?.base ?? "the base"} does not have.
                  A flow commits one step at a time: test(AC) for tests,
                  feat(AC) for code.
                </p>
              )}
            </Group>
            {repo && repo.worktrees.length > 1 && (
              <Group
                title="Worktrees (lanes)"
                count={repo.worktrees.length}
                start={false}
              >
                {repo.worktrees.map((w) => (
                  <div key={w.path} className="scm-wt">
                    <b className="mono">{w.branch ?? "(detached)"}</b>
                    <span className="sub mono">{w.path}</span>
                  </div>
                ))}
              </Group>
            )}
            {repo && repo.branches.length > 0 && (
              <Group
                key={gitOn ? "git" : "ro"}
                title="Branches"
                meta={`${repo.branches.length} local${remotes ? ` · ${remotes} remote` : ""}`}
                start={gitOn}
              >
                <BranchList
                  pid={pid}
                  repo={repo}
                  gitOn={gitOn}
                  info={gitBranches.data}
                  actions={parts.branchActions}
                  onOpenBranch={onOpenBranch}
                  onOpenLog={onOpenLog}
                  onSwitched={changed}
                />
              </Group>
            )}
          </div>
        </div>
        {parts.footer && <div className="scm-foot">{parts.footer}</div>}
      </>
    );
  };

  return (
    <div className="sv scm">
      <div className="sv-head">
        <h2 className="sv-title">Source control</h2>
        <span className="scm-tools">
          <button
            type="button"
            className="scm-icon"
            aria-label="Refresh"
            title="Read the branch, the changes and the pull request again"
            onClick={() => {
              setRefresh((n) => n + 1);
              changed();
            }}
          >
            <Icon name="refresh" size={14} />
          </button>
          {onOpenLog && (
            <button
              type="button"
              className="btn sm ghost scm-log"
              onClick={() => onOpenLog("")}
              aria-label="Show the Git log"
              title="The Git log: every commit of a branch (or all branches) with a graph, who and when, and what is not committed"
            >
              <Icon name="commit" size={14} />
              <span>Log</span>
            </button>
          )}
        </span>
      </div>
      {/* one scroll for everything under the title: the pull request and the Doctor's note can be taller than the view */}
      {panel ? (
        <panel.component
          pid={pid}
          dirty={list.length}
          onChanged={changed}
          layout={layout}
          refresh={refresh}
          reviewHref={
            review ? (n: number) => `#/repo/@review/pr:${n}` : undefined
          }
        />
      ) : (
        layout({})
      )}
    </div>
  );
}
