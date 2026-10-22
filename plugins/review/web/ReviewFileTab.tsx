// v0.14.0 one file of a review in an editor tab: its diff (side by side or inline) with the threads, your pending
// comments and keel's findings on their lines, or the whole file as the reviewed commit has it (Jump to source, Go to
// declaration). A small bar: viewed, diff or whole file, previous / next file.

import { useEffect, useState } from "react";
import { Pill } from "@keel/web-sdk";
import { linesLabel, prLabel } from "./reviewApi";
import { neighbour } from "./ReviewSide";
import { FileAtView, ReviewDiff, type Anchor, type LineSpan } from "./ReviewDiff";
import { findingComment, ThreadCard } from "./ReviewPanel";
import { DraftCard } from "./PendingTab";
import { askAboutFinding } from "./ReviewSide";
import { keysFor } from "./keymap";
import * as R from "./store";
import type { Finding } from "./reviewApi";

export function ReviewFileTab({
  pid,
  reviewKey,
  path,
  view,
  mode,
}: {
  pid: string;
  reviewKey: string;
  path: string;
  view: R.FileView;
  mode: "split" | "inline";
}) {
  R.useReviewStore();
  const r = R.review(pid, reviewKey);
  const ui = R.uiState();
  useEffect(() => {
    if (!r.view && !r.loading && !r.error) void R.load(pid, reviewKey);
  }, [pid, reviewKey]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!r.ai) void R.loadAi(pid, reviewKey);
  }, [pid, reviewKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const v = r.view;
  const focus = ui.focus && ui.focus.key === reviewKey && ui.focus.path === path && ui.focus.line ? { line: ui.focus.line, side: ui.focus.side, n: ui.focus.n } : null;
  const change =
    ui.change && ui.change.key === reviewKey && ui.change.path === path
      ? { index: ui.change.index, n: ui.change.n }
      : null;
  const [, setChanges] = useState(0);

  if (!v)
    return (
      <div className="ed-note">
        {r.error ? (
          r.error.message
        ) : (
          <span className="pg-spin" role="status">
            Opening the review…
          </span>
        )}
      </div>
    );
  const isChanged = v.files.some((f) => f.path === path);
  const viewed = v.viewed.includes(path);
  const findings = r.ai?.findings?.result?.findings ?? [];
  const canComment = v.can_post || v.kind === "branch";

  const anchors: Anchor[] = [];
  // an outdated thread is on code that is not in this diff any more: it is not drawn at its old line (the Threads list has it)
  for (const t of v.threads.filter((x) => x.path === path && x.line && !x.outdated)) {
    anchors.push({
      line: t.line!,
      side: t.side,
      startLine: t.start_line,
      startSide: t.start_side,
      node: (
        <div className="rv-under">
          <ThreadCard
            t={t}
            canPost={v.can_post}
            compact
            onReply={(th, b) => R.reply(pid, reviewKey, th.id, b)}
            onResolve={(th, x) => R.resolve(pid, reviewKey, th.id, x)}
          />
        </div>
      ),
    });
  }
  for (const d of v.drafts.filter((x) => x.path === path && x.line)) {
    anchors.push({
      line: d.line!,
      side: d.side,
      startLine: d.start_line,
      startSide: d.start_side,
      node: (
        <DraftCard
          d={d}
          onSave={(b) => void R.editDraft(pid, reviewKey, d, b)}
          onDelete={() => void R.deleteDraft(pid, reviewKey, d)}
        />
      ),
    });
  }
  for (const f of findings.filter((x) => x.path === path && x.line)) {
    const dec = r.ai?.decisions[f.id];
    if (
      dec?.decision === "dismissed" ||
      dec?.decision === "commented" ||
      v.drafts.some((d) => d.finding_id === f.id)
    )
      continue;
    anchors.push({
      line: f.line!,
      side: f.side,
      node: (
        <InlineFinding
          f={f}
          canComment={canComment}
          onComment={() =>
            void R.addDraft(
              pid,
              reviewKey,
              findingComment(f, v.host?.kind === "gitlab"),
              { path, line: f.line!, side: f.side },
              f.id,
            ).then((d) => d && R.decide(pid, reviewKey, f.id, "commented"))
          }
          onDismiss={(why) =>
            void R.decide(pid, reviewKey, f.id, "dismissed", why)
          }
          onAsk={() => askAboutFinding(v, f)}
        />
      ),
    });
  }
  const composing =
    ui.composing && ui.composing.key === reviewKey && ui.composing.path === path
      ? ui.composing
      : null;
  if (composing?.line) {
    anchors.push({
      line: composing.line,
      side: composing.side,
      node: (
        <CommentBox
          where={`${path}:${linesLabel({ line: composing.line, side: composing.side, start_line: composing.startLine, start_side: composing.startSide })}`}
          busy={r.running.includes("draft")}
          onCancel={() => R.setUi({ composing: null })}
          onSave={(b) =>
            void R.addDraft(pid, reviewKey, b, {
              path,
              line: composing.line!,
              side: composing.side,
              startLine: composing.startLine,
              startSide: composing.startSide,
            })
          }
        />
      ),
    });
  }
  // a line number (or several: shift-click, drag) in the diff or the whole file starts a comment there
  const onLine = (fileView: R.FileView) => (l: LineSpan) => {
    const at = {
      key: reviewKey,
      path,
      view: fileView,
      line: l.line,
      side: l.side,
      startLine: l.startLine,
      startSide: l.startSide,
    };
    R.setUi({ current: at, composing: canComment ? at : null });
  };
  const picked = composing?.line
    ? {
        line: composing.line,
        side: composing.side,
        startLine: composing.startLine ?? null,
        startSide: composing.startSide ?? null,
      }
    : null;
  const go = (dir: 1 | -1) => {
    const next = neighbour(v, path, dir);
    if (next)
      R.openPlace({
        key: reviewKey,
        path: next,
        view: "diff",
        line: null,
        side: "RIGHT",
      });
  };

  return (
    <div
      className="rv-ftab"
      role="region"
      aria-label={`${path} in review ${v.kind === "pr" ? prLabel(v.host, v.number) : v.branch}`}
    >
      <div className="rv-fbar">
        <Pill tone="run">
          {v.kind === "pr" ? prLabel(v.host, v.number) : v.branch}
        </Pill>
        {isChanged && (
          <label className="chk rv-viewed">
            <input
              type="checkbox"
              checked={viewed}
              onChange={() => void R.toggleViewed(pid, reviewKey, path)}
            />{" "}
            Viewed
          </label>
        )}
        {isChanged && (
          <span className="rv-seg" role="group" aria-label="Show">
            <button
              type="button"
              aria-pressed={view === "diff"}
              onClick={() =>
                R.openPlace({
                  key: reviewKey,
                  path,
                  view: "diff",
                  line: ui.current?.line ?? null,
                  side: "RIGHT",
                })
              }
            >
              Changes
            </button>
            <button
              type="button"
              aria-pressed={view === "code"}
              onClick={() =>
                R.openPlace({
                  key: reviewKey,
                  path,
                  view: "code",
                  line: ui.current?.line ?? null,
                  side: "RIGHT",
                })
              }
              title={`Jump to source (${keysFor("jumpToSource")})`}
            >
              Whole file
            </button>
          </span>
        )}
        <span className="rv-fbar-r">
          {v.drafts.length > 0 && (
            <button
              type="button"
              className="rv-link rv-dim"
              title="Show them in the Review window's Pending tab"
              onClick={() => R.setUi({ pendingTab: Date.now() })}
            >
              {v.drafts.length} pending
            </button>
          )}
          <button
            type="button"
            className="ib"
            aria-label="Previous file"
            title={`Previous file (${keysFor("prevFile")})`}
            onClick={() => go(-1)}
          >
            ‹
          </button>
          <button
            type="button"
            className="ib"
            aria-label="Next file"
            title={`Next file (${keysFor("nextFile")})`}
            onClick={() => go(1)}
          >
            ›
          </button>
        </span>
      </div>
      {view === "code" || !isChanged ? (
        <FileAtView
          pid={pid}
          reviewKey={reviewKey}
          path={path}
          line={focus?.line ?? null}
          changed={isChanged}
          anchors={anchors}
          picked={picked}
          onLine={onLine("code")}
          onWord={(w) => void R.lookUp(pid, reviewKey, w, "declaration")}
          onBackToDiff={() =>
            R.openPlace({
              key: reviewKey,
              path,
              view: "diff",
              line: null,
              side: "RIGHT",
            })
          }
        />
      ) : (
        <ReviewDiff
          pid={pid}
          reviewKey={reviewKey}
          path={path}
          mode={mode}
          anchors={anchors}
          focus={focus}
          change={change}
          onChanges={(n) => {
            setChanges(n);
            R.uiState().changes = n;
          }}
          picked={picked}
          onLine={onLine("diff")}
          onWord={(w, l) => {
            if (l)
              R.setUi({
                current: {
                  key: reviewKey,
                  path,
                  view: "diff",
                  line: l.line,
                  side: l.side,
                },
              });
            void R.lookUp(pid, reviewKey, w, "declaration");
          }}
        />
      )}
      <div className="rv-hint" aria-hidden="true">
        {keysFor("nextChange")} next change · {keysFor("declaration")}{" "}
        declaration · {keysFor("usages")} usages · {keysFor("back")} back ·{" "}
        {keysFor("findAction")} all keys
      </div>
    </div>
  );
}

function CommentBox({
  where,
  busy,
  onSave,
  onCancel,
}: {
  where: string;
  busy: boolean;
  onSave: (body: string) => void;
  onCancel: () => void;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="rv-under rv-compose"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) onSave(text.trim());
      }}
    >
      <span className="rv-dim">Comment on {where}</span>
      <textarea
        className="rv-ta"
        aria-label={`Comment on ${where}`}
        value={text}
        onChange={(e) => setText(e.target.value)}
        autoFocus
        onKeyDown={(e) => {
          if (e.key === "Escape") onCancel();
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter" && text.trim()) {
            e.preventDefault();
            e.stopPropagation();
            onSave(text.trim());
          }
        }}
        placeholder="issue (blocking): … · suggestion: … · question: …"
      />
      <div className="rv-row">
        <button
          type="submit"
          className="btn sm primary"
          disabled={busy || !text.trim()}
        >
          Add comment
        </button>
        <button type="button" className="btn sm ghost" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </form>
  );
}

function InlineFinding({
  f,
  canComment,
  onComment,
  onDismiss,
  onAsk,
}: {
  f: Finding;
  canComment: boolean;
  onComment: () => void;
  onDismiss: (why: string) => void;
  onAsk: () => void;
}) {
  const [asking, setAsking] = useState(false);
  const [why, setWhy] = useState("");
  return (
    <div className="rv-under rv-ai" data-finding={f.id}>
      <div className="rv-comment-h">
        <Pill
          tone={
            f.severity === "blocking"
              ? "bad"
              : f.severity === "should_fix"
                ? "warn"
                : "idle"
          }
        >
          {f.severity.replace("_", " ")}
        </Pill>
        {f.check === "confirmed" && <Pill tone="ok">checked</Pill>}
        {f.check === "not checked" && <Pill tone="warn">not checked</Pill>}
        <b>keel</b>
        <span className="rv-dim">{f.category}</span>
      </div>
      <p>
        <b>{f.title}</b>
        {f.why ? ` ${f.why}` : ""}
      </p>
      {f.suggestion && <pre className="rv-sugg">{f.suggestion}</pre>}
      {asking ? (
        <form
          className="rv-row"
          onSubmit={(e) => {
            e.preventDefault();
            if (why.trim()) onDismiss(why.trim());
          }}
        >
          <input
            className="rv-in"
            aria-label={`Why dismiss: ${f.title}`}
            value={why}
            onChange={(e) => setWhy(e.target.value)}
            placeholder="why it is not a problem"
            autoFocus
          />
          <button type="submit" className="btn sm" disabled={!why.trim()}>
            Dismiss
          </button>
        </form>
      ) : (
        <div className="rv-row">
          {canComment && (
            <button
              type="button"
              className="btn sm primary"
              onClick={onComment}
            >
              Add as comment
            </button>
          )}
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => setAsking(true)}
          >
            Dismiss…
          </button>
          <button type="button" className="btn sm ghost" onClick={onAsk}>
            Ask KeelBot
          </button>
        </div>
      )}
    </div>
  );
}
