// v0.10.0 Code › Source control › Git (the Git plugin): the branch against its remote and its base, the buttons to
// commit, bring the base in, push and make a branch, and the pull request with its CI checks and review comments.
// keel's rules hold here too: never a force push, never a push to main or master, a commit only after the secret check.
// The Git plugin's panel part (plugins/git): it imports only react and @keel/web-sdk.
//
// 0.18.38 Source control lays the pieces out itself (ScmPanelProps.layout): the push pills and buttons under the branch,
// the pull request card, the commit box under the changes, New branch in the Branches head, Ask KeelBot at the bottom.
// When GitHub does not answer in time (the engine tried twice) the card says so in amber and tries again every 30 s
// while Source control is on screen; any other error is a red card with what GitHub said.

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  askAssistant,
  errorParts,
  SLOTS,
  useApp,
  useLoad,
  useDraft,
  useSlot,
  type ScmPanelParts,
  type ScmPanelProps,
} from "@keel/web-sdk";
import { gitApi, type PullRequest } from "./gitApi";

const FAILED = new Set([
  "failure",
  "failed",
  "error",
  "cancelled",
  "timed_out",
  "action_required",
]);
const PASSED = new Set(["success", "neutral", "skipped"]);
/** How long the amber "GitHub did not answer" card waits before it asks again. */
export const PR_RETRY_MS = 30_000;

export function addressComments(pr: PullRequest): string {
  const lines = pr.comments.map(
    (c) =>
      `- ${c.author}${c.path ? ` (${c.path}${c.line ? `:${c.line}` : ""})` : ""}: ${c.body.replace(/\s+/g, " ").slice(0, 400)}`,
  );
  return `Address the review comments on PR #${pr.number} (${pr.title}):\n${lines.join("\n")}\nSay what you would change for each one, with file:line.`;
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** The pull request's state as a word and a tone: Draft, Open, Merged, Closed. */
export function prState(p: Pick<PullRequest, "state" | "draft">): {
  label: string;
  tone: "ok" | "accent" | "idle" | "bad";
} {
  const s = (p.state || "").toUpperCase();
  if (s === "MERGED") return { label: "Merged", tone: "accent" };
  if (s === "CLOSED") return { label: "Closed", tone: "bad" };
  if (p.draft) return { label: "Draft", tone: "idle" };
  return { label: "Open", tone: "ok" };
}

// how many comments the person has seen on a pull request (Open review, On GitHub or Ask KeelBot marks them), per browser
const seenKey = (pid: string, n: number) => `keel.scm.pr-seen.${pid}.${n}`;
function readSeen(pid: string, n: number): number {
  try {
    return Number(localStorage.getItem(seenKey(pid, n))) || 0;
  } catch {
    return 0;
  }
}
function writeSeen(pid: string, n: number, count: number) {
  try {
    localStorage.setItem(seenKey(pid, n), String(count));
  } catch {
    // storage blocked: the comments stay "new"
  }
}

const Sparkle = () => (
  <svg
    width="15"
    height="15"
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2"
    strokeLinejoin="round"
    aria-hidden="true"
  >
    <path d="M12 3l1.8 4.7L18.5 9.5l-4.7 1.8L12 16l-1.8-4.7L5.5 9.5l4.7-1.8z" />
  </svg>
);

function PrCard({
  pid,
  p,
  assistant,
  reviewHref,
}: {
  pid: string;
  p: PullRequest;
  assistant: boolean;
  reviewHref?: (n: number) => string;
}) {
  const total = p.comments_total ?? p.comments.length;
  const [seen, setSeen] = useState(() => readSeen(pid, p.number));
  const fresh = Math.max(0, total - seen);
  const markSeen = () => {
    writeSeen(pid, p.number, total);
    setSeen(total);
  };
  const st = prState(p);
  const checks = p.checks.length;
  const passed = p.checks.filter((c) => PASSED.has(c.state)).length;
  const running = checks - p.checks_done;
  const waiting = p.review_requests?.length ?? 0;
  const review = (p.review || "").toUpperCase();
  const reviewText =
    review === "APPROVED"
      ? "Review: approved"
      : review === "CHANGES_REQUESTED"
        ? "Review: changes requested"
        : waiting > 0
          ? `Review: waiting for ${plural(waiting, "person", "people")}`
          : review
            ? `Review: ${review.toLowerCase().replace(/_/g, " ")}`
            : "";
  return (
    <div
      className="scm-card gp-pr"
      role="group"
      aria-label={`Pull request #${p.number}`}
    >
      <div className="gp-pr-top">
        <span className={`scm-pill strong tone-${st.tone}`}>
          <span aria-hidden="true">●</span> {st.label}
        </span>
        <span className="mono gp-pr-n">#{p.number}</span>
        {p.base && (
          <span className="gp-pr-to">
            <span aria-hidden="true">→</span>
            <span className="sr-only">into</span>{" "}
            <span className="mono">{p.base}</span>
          </span>
        )}
      </div>
      <p className="gp-pr-title">{p.title}</p>
      <ul className="gp-facts">
        {checks > 0 && (
          <li>
            <span
              className={`gp-fact-i tone-${p.checks_failed ? "bad" : running ? "warn" : "ok"}`}
              aria-hidden="true"
            >
              {p.checks_failed ? "✕" : running ? "…" : "✓"}
            </span>
            <span>
              Checks: {passed} of {checks} passed
            </span>
            {p.checks_failed > 0 ? (
              <span className="gp-fact-r tone-bad">
                {plural(p.checks_failed, "check")} failed
              </span>
            ) : running > 0 ? (
              <span className="gp-fact-r tone-warn">{running} running</span>
            ) : null}
          </li>
        )}
        {reviewText && (
          <li>
            <span
              className={`gp-fact-i tone-${review === "APPROVED" ? "ok" : review === "CHANGES_REQUESTED" ? "bad" : "warn"}`}
              aria-hidden="true"
            >
              ◆
            </span>
            <span>{reviewText}</span>
          </li>
        )}
        {total > 0 && (
          <li>
            <span className="gp-fact-i tone-accent" aria-hidden="true">
              {fresh || total}
            </span>
            <span>
              {fresh > 0
                ? `${plural(fresh, "new comment")}`
                : plural(total, "comment")}
            </span>
          </li>
        )}
      </ul>
      {checks > 0 && (
        <details className="gp-more">
          <summary>All {plural(checks, "check")}</summary>
          <ul className="gp-checks">
            {p.checks.map((c) => (
              <li key={c.name}>
                <span
                  className={`gp-dot ${FAILED.has(c.state) ? "bad" : PASSED.has(c.state) ? "ok" : "run"}`}
                  aria-hidden="true"
                />
                <span>
                  {c.url ? (
                    <a href={c.url} target="_blank" rel="noreferrer">
                      {c.name}
                    </a>
                  ) : (
                    c.name
                  )}
                  : {c.state}
                </span>
              </li>
            ))}
          </ul>
        </details>
      )}
      {p.comments.length > 0 && (
        <details className="gp-more">
          <summary>Latest comments</summary>
          {p.comments.slice(-3).map((c, i) => (
            <p key={i} className="gp-comment">
              <b>{c.author}</b>
              {c.path ? ` · ${c.path}${c.line ? `:${c.line}` : ""}` : ""}:{" "}
              {c.body.slice(0, 240)}
            </p>
          ))}
        </details>
      )}
      <div className="scm-btns">
        {reviewHref && (
          <a
            className="scm-btn primary"
            href={reviewHref(p.number)}
            onClick={markSeen}
          >
            Open review
          </a>
        )}
        <a
          className="scm-btn"
          href={p.url}
          target="_blank"
          rel="noreferrer"
          onClick={markSeen}
        >
          On GitHub <span aria-hidden="true">↗</span>
          <span className="sr-only"> (opens a new tab)</span>
        </a>
        {assistant && p.comments.length > 0 && (
          <button
            type="button"
            className="scm-btn"
            onClick={() => {
              markSeen();
              askAssistant(addressComments(p));
            }}
          >
            Ask KeelBot to address the comments
          </button>
        )}
        {assistant && p.checks_failed > 0 && (
          <button
            type="button"
            className="scm-btn"
            onClick={() => askAssistant("/ci")}
          >
            Why did CI fail?
          </button>
        )}
      </div>
    </div>
  );
}

/** GitHub did not answer in time: the branch is fine; Try again now, the raw error on demand, and a new try every 30 s
 *  while Source control is on screen. */
function PrRetry({
  error,
  busy,
  onRetry,
}: {
  error: { message: string; hint?: string };
  busy: boolean;
  onRetry: () => void;
}) {
  const [details, setDetails] = useState(false);
  const id = useId();
  const box = useRef<HTMLDivElement>(null);
  const retry = useRef(onRetry);
  retry.current = onRetry;
  useEffect(() => {
    // only while it can be seen: not while Source control is a hidden side view or the browser tab is in the background
    const t = window.setInterval(() => {
      if (document.hidden || box.current?.closest("[hidden]")) return;
      retry.current();
    }, PR_RETRY_MS);
    return () => window.clearInterval(t);
  }, []);
  return (
    <div ref={box} className="scm-card scm-warn" role="status">
      <div className="scm-warn-top">
        <span className="scm-warn-i" aria-hidden="true">
          <svg
            width="14"
            height="14"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2.2"
            strokeLinecap="round"
          >
            <path d="M5 12.5a10 10 0 0 1 14 0" />
            <path d="M8.5 16a5 5 0 0 1 7 0" />
            <path d="M12 19.5h.01" />
            <path d="M3 3l18 18" />
          </svg>
        </span>
        <div>
          <p className="scm-warn-t">GitHub did not answer in time</p>
          <p className="scm-warn-s">
            Your branch and commits are fine. keel tried twice; it tries again
            in 30 s.
          </p>
        </div>
      </div>
      <div className="scm-warn-acts">
        <button
          type="button"
          className="scm-btn warn"
          disabled={busy}
          onClick={onRetry}
        >
          {busy ? "Trying…" : "Try again now"}
        </button>
        <button
          type="button"
          className="scm-link"
          aria-expanded={details}
          aria-controls={id}
          onClick={() => setDetails(!details)}
        >
          {details ? "Hide details" : "Show details"}
        </button>
      </div>
      <pre id={id} className="scm-raw" hidden={!details}>
        {error.message}
      </pre>
    </div>
  );
}

export function GitPanel({
  pid,
  dirty,
  onChanged,
  layout,
  reviewHref,
  refresh = 0,
}: ScmPanelProps) {
  const { toast } = useApp();
  // the assistant that answers askAssistant (KeelBot): its buttons only when this keel has one
  const assistant = useSlot(SLOTS.assistant).length > 0;
  const status = useLoad(`git:${pid}`, () => gitApi.status(pid));
  const pr = useLoad(`git-pr:${pid}`, () => gitApi.pr(pid), { live: false });
  const [busy, setBusy] = useState<string | null>(null);
  // the commit message you are writing, kept per project (localStorage) until the commit is made
  const [message, setMessage] = useDraft(`keel2.git.msg.${pid}`);
  const [newBranch, setNewBranch] = useState<string | null>(null);
  const msgId = useId();
  const st = status.data;
  const reload = () => {
    void status.reload();
    void pr.reload();
    onChanged();
  };
  // Refresh in Source control: the status and the pull request again (the first render loads them already)
  const firstRefresh = useRef(refresh);
  const reloadRef = useRef({ status, pr });
  reloadRef.current = { status, pr };
  useEffect(() => {
    if (refresh === firstRefresh.current) return;
    void reloadRef.current.status.reload();
    void reloadRef.current.pr.reload();
  }, [refresh]);
  const act = async (what: string, fn: () => Promise<string>) => {
    setBusy(what);
    try {
      toast(await fn());
      reload();
    } catch (e) {
      const p = errorParts(e);
      toast(p.hint ? `${p.message} ${p.hint}` : p.message);
    } finally {
      setBusy(null);
    }
  };

  const parts: ScmPanelParts = {};
  if (status.error) {
    parts.actions = (
      <p className="db-err" role="alert">
        {status.error.message}
      </p>
    );
  } else if (!st) {
    parts.actions = (
      <span className="sub" role="status">
        Reading git…
      </span>
    );
  } else {
    const onBase = st.branch === st.base;
    const canPush = !st.upstream || st.ahead > 0;
    parts.pills = (
      <>
        {st.upstream ? (
          st.ahead ? (
            <span className="scm-pill tone-accent">↑ {st.ahead} to push</span>
          ) : (
            <span className="scm-pill">
              pushed <span aria-hidden="true">✓</span>
            </span>
          )
        ) : (
          <span className="scm-pill">not pushed yet</span>
        )}
        {st.behind > 0 && (
          <span className="scm-pill tone-warn">↓ {st.behind} to pull</span>
        )}
      </>
    );
    if (!onBase) {
      parts.actions = (
        <div className="scm-btns">
          <button
            type="button"
            className="scm-btn"
            disabled={!!busy || dirty > 0}
            title={
              dirty
                ? "Commit or stash your changes first"
                : `Merge ${st.base} into this branch (never a rebase, never a force)`
            }
            onClick={() =>
              void act("sync", async () => {
                const r = await gitApi.sync(pid);
                return r.merged
                  ? `Merged ${r.from} into ${r.branch}.`
                  : `${r.branch} already has ${r.from}.`;
              })
            }
          >
            {busy === "sync"
              ? "Updating…"
              : `Update from ${st.base}${st.base_behind > 0 ? ` (${st.base_behind})` : ""}`}
          </button>
          {canPush ? (
            <button
              type="button"
              className="scm-btn primary"
              disabled={!!busy}
              onClick={() =>
                void act("push", async () => {
                  const r = await gitApi.push(pid);
                  return `Pushed ${r.branch} (${r.sha.slice(0, 7)}).`;
                })
              }
            >
              {busy === "push" ? "Pushing…" : "Push"}
              {busy !== "push" && st.ahead > 0 && (
                <span className="scm-btn-n" aria-hidden="true">
                  {st.ahead} ↑
                </span>
              )}
            </button>
          ) : (
            <button type="button" className="scm-btn" disabled>
              Nothing to push
            </button>
          )}
        </div>
      );
    }
    parts.branchActions =
      newBranch === null ? (
        <button
          type="button"
          className="scm-btn sm primary"
          onClick={() => setNewBranch("feat/")}
        >
          <span aria-hidden="true">+</span> New branch
        </button>
      ) : (
        <form
          className="scm-newbr"
          onSubmit={(e) => {
            e.preventDefault();
            void act("new", async () => {
              const r = await gitApi.switch(pid, newBranch, true);
              setNewBranch(null);
              return `Created ${r.branch}.`;
            });
          }}
        >
          <input
            className="inline-input mono"
            aria-label="New branch name"
            value={newBranch}
            autoFocus
            onChange={(e) => setNewBranch(e.target.value)}
            onKeyDown={(e) => e.key === "Escape" && setNewBranch(null)}
          />
          <button
            type="submit"
            className="scm-btn sm primary"
            disabled={!!busy || !newBranch.trim()}
          >
            Create
          </button>
          <button
            type="button"
            className="scm-btn sm"
            onClick={() => setNewBranch(null)}
          >
            Cancel
          </button>
        </form>
      );
    if (dirty > 0) {
      parts.commit = (
        <form
          className="gp-commit"
          onSubmit={(e) => {
            e.preventDefault();
            void act("commit", async () => {
              const r = await gitApi.commit(pid, message);
              setMessage("");
              return `Committed ${r.sha.slice(0, 7)} ${r.subject}.`;
            });
          }}
        >
          <label htmlFor={msgId} className="scm-label">
            Commit message
          </label>
          <textarea
            id={msgId}
            className="inline-input"
            rows={3}
            placeholder={`What changed in ${plural(dirty, "file")}, and why`}
            value={message}
            onChange={(e) => setMessage(e.target.value)}
          />
          <div className="scm-btns">
            {assistant && (
              <button
                type="button"
                className="scm-btn"
                onClick={() => askAssistant("/commit")}
                title="KeelBot reads the changes and writes the message"
              >
                <span aria-hidden="true">✦</span> Write it for me
              </button>
            )}
            <button
              type="submit"
              className="scm-btn ok"
              disabled={!!busy || !message.trim()}
              title={
                message.trim() ? undefined : "Write a commit message first"
              }
            >
              {busy === "commit"
                ? "Committing…"
                : `Commit ${plural(dirty, "file")}`}
            </button>
          </div>
        </form>
      );
    }
    const p = pr.data?.pr;
    const err = pr.data?.error;
    if (p) {
      parts.pr = (
        <PrCard
          key={p.number}
          pid={pid}
          p={p}
          assistant={assistant}
          reviewHref={reviewHref}
        />
      );
      if (assistant) {
        parts.footer = (
          <button
            type="button"
            className="scm-ask"
            onClick={() =>
              askAssistant(
                `Tell me where the pull request #${p.number} (${p.title}) stands: its checks, its reviews and the open comments, and what I should do next.`,
              )
            }
          >
            <Sparkle />
            Ask KeelBot about this pull request
          </button>
        );
      }
    } else if (err?.transient) {
      parts.pr = (
        <PrRetry
          error={err}
          busy={pr.loading}
          onRetry={() => void pr.reload()}
        />
      );
    } else if (pr.error) {
      parts.pr = (
        <div className="scm-card scm-bad" role="alert">
          <p className="scm-warn-t">Pull request: {pr.error.message}</p>
          {pr.error.hint && <p className="scm-warn-s">{pr.error.hint}</p>}
          <div className="scm-warn-acts">
            <button
              type="button"
              className="scm-btn"
              disabled={pr.loading}
              onClick={() => void pr.reload()}
            >
              {pr.loading ? "Trying…" : "Try again"}
            </button>
          </div>
        </div>
      );
    } else if (!pr.data) {
      parts.pr = (
        <span className="sub" role="status">
          Reading the pull request…
        </span>
      );
    } else if (!onBase) {
      parts.pr =
        assistant && st.upstream ? (
          <button
            type="button"
            className="scm-ask"
            onClick={() => askAssistant("/pr")}
          >
            <Sparkle />
            Ask KeelBot to draft the pull request
          </button>
        ) : (
          <p className="scm-note">
            {st.upstream
              ? "No pull request for this branch yet."
              : "No pull request yet: push the branch first."}
          </p>
        );
    }
    const stats: NonNullable<ScmPanelParts["stats"]> = {};
    for (const c of st.changes)
      if (c.added !== undefined && c.deleted !== undefined)
        stats[c.path] = { added: c.added, deleted: c.deleted };
    parts.stats = stats;
  }

  if (layout) return <>{layout(parts)}</>;
  // a host without a layout (an older Source control): the pieces in one column, as before
  const stack: ReactNode[] = [
    parts.pills && <div className="row gp-counts">{parts.pills}</div>,
    parts.actions,
    parts.branchActions,
    parts.commit,
    parts.pr,
    parts.footer,
  ];
  return (
    <div className="gp" aria-label="Git">
      {stack.map((x, i) => (x ? <div key={i}>{x}</div> : null))}
    </div>
  );
}
