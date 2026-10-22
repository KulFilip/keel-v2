// Your pending review in one place: every comment you wrote (on a line, on several lines, or on the whole change),
// with edit and delete, the comments of a review you started on GitHub's site, and Submit as Comment, Approve or
// Request changes, all in one review. A branch takes no review: its pending comments move to its pull request.

import { useState } from "react";
import { ErrorBox, Pill } from "@keel/web-sdk";
import {
  linesLabel,
  prLabel,
  prWord,
  type Draft,
  type ReviewView,
  type SubmitEvent,
} from "./reviewApi";
import { keysFor, type Keymap } from "./keymap";
import * as R from "./store";

export function PendingTab({
  pid,
  reviewKey,
  view: v,
  onOpen,
  onOpenReview,
}: {
  pid: string;
  reviewKey: string;
  view: ReviewView;
  onOpen: (path: string, line?: number | null, side?: "RIGHT" | "LEFT") => void;
  onOpenReview: (key: string) => void;
}) {
  R.useReviewStore();
  const r = R.review(pid, reviewKey);
  const onHost = v.threads.filter((t) => t.pending);
  const byFile = new Map<string, Draft[]>();
  for (const d of v.drafts.filter((x) => x.path)) {
    byFile.set(d.path!, [...(byFile.get(d.path!) ?? []), d]);
  }
  for (const list of byFile.values())
    list.sort(
      (a, b) => (a.start_line ?? a.line ?? 0) - (b.start_line ?? b.line ?? 0),
    );
  const general = v.drafts.filter((d) => !d.path);
  const site = v.host?.kind === "gitlab" ? "GitLab" : "GitHub";
  const card = (d: Draft) => (
    <DraftCard
      key={d.id}
      d={d}
      onSave={(b) => void R.editDraft(pid, reviewKey, d, b)}
      onDelete={() => void R.deleteDraft(pid, reviewKey, d)}
    />
  );
  return (
    <div className="rv-stack rv-pending">
      <section className="rv-group" aria-label="Pending comments">
        {v.drafts.length + onHost.length === 0 ? (
          <p className="rv-dim">
            No pending comment. Click a line number in a file's changes to
            comment on it; shift-click another or drag over the numbers for
            several lines.
          </p>
        ) : (
          <p className="rv-dim">
            {v.drafts.length + onHost.length} pending comment
            {v.drafts.length + onHost.length === 1 ? "" : "s"}: nobody sees them
            until you submit your review.
          </p>
        )}
        {[...byFile.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([path, list]) => (
            <div key={path} className="rv-pfile">
              <h4 className="mono">{path}</h4>
              {list.map((d) => (
                <div key={d.id} className="rv-pitem">
                  <button
                    type="button"
                    className="rv-link mono rv-where"
                    onClick={() => onOpen(path, d.line, d.side)}
                    aria-label={`Open ${path}:${linesLabel(d)}`}
                  >
                    {d.start_line != null ? "Lines" : "Line"} {linesLabel(d)}
                  </button>
                  {card(d)}
                </div>
              ))}
            </div>
          ))}
        {general.length > 0 && (
          <div className="rv-pfile">
            <h4>On the whole change</h4>
            {general.map(card)}
          </div>
        )}
        {onHost.length > 0 && (
          <div className="rv-pfile">
            <h4>In your pending review on {site}</h4>
            <p className="rv-dim">
              You started it on {site}'s site. It goes out with your review
              here; edit it there.
            </p>
            {onHost.map((t) => (
              <div key={t.id} className="rv-pitem">
                {t.path && (
                  <button
                    type="button"
                    className="rv-link mono rv-where"
                    onClick={() => onOpen(t.path!, t.line, t.side)}
                  >
                    {t.path}:{linesLabel(t)}
                  </button>
                )}
                {t.comments.map((c) => (
                  <pre key={c.id} className="rv-body-text">
                    {c.body}
                  </pre>
                ))}
              </div>
            ))}
          </div>
        )}
        {(v.can_post || v.kind === "branch") && (
          <GeneralComment
            busy={r.running.includes("draft")}
            onAdd={(body) => R.addDraft(pid, reviewKey, body, null)}
          />
        )}
      </section>
      <section className="rv-group" aria-label="Submit your review">
        <h4>Submit your review</h4>
        {v.kind === "branch" ? (
          v.branch_pr != null ? (
            <>
              <p className="rv-dim">
                A branch takes no review; its {prWord(v.host)}{" "}
                {prLabel(v.host, v.branch_pr)} does. Move your pending comments
                there to send them.
              </p>
              <button
                type="button"
                className="btn sm primary"
                disabled={!v.drafts.length || r.running.includes("move")}
                onClick={() =>
                  void R.moveDrafts(pid, reviewKey, `pr:${v.branch_pr}`).then(
                    (ok) => ok && onOpenReview(`pr:${v.branch_pr}`),
                  )
                }
              >
                Move to {prLabel(v.host, v.branch_pr)} and review it
              </button>
              {r.err && <ErrorBox error={r.err} />}
            </>
          ) : (
            <p className="rv-dim">
              A branch takes no review. Push it and open a {prWord(v.host)}:
              then review the {prWord(v.host)}, and your pending comments can
              move there.
            </p>
          )
        ) : v.can_post ? (
          <SubmitForm pid={pid} reviewKey={reviewKey} inline />
        ) : (
          <p className="rv-dim">
            {v.state && v.state !== "open"
              ? `${prLabel(v.host, v.number)} is ${v.state}: it takes no review.`
              : `keel cannot post to this ${prWord(v.host)}: add a token in Connections.`}
          </p>
        )}
      </section>
    </div>
  );
}

function GeneralComment({
  busy,
  onAdd,
}: {
  busy: boolean;
  onAdd: (body: string) => Promise<unknown>;
}) {
  const [text, setText] = useState("");
  return (
    <form
      className="rv-compose"
      onSubmit={(e) => {
        e.preventDefault();
        const t = text.trim();
        if (t) void onAdd(t).then((d) => d && setText(""));
      }}
    >
      <textarea
        className="rv-ta"
        aria-label="A comment on the whole change"
        value={text}
        onChange={(e) => setText(e.target.value)}
        placeholder="A comment on the whole change (pending until you submit)"
      />
      <div className="rv-row">
        <button
          type="submit"
          className="btn sm"
          disabled={busy || !text.trim()}
        >
          Add pending comment
        </button>
      </div>
    </form>
  );
}

/** Submit: a summary, Comment / Approve / Request changes, and every pending comment with it, as one review. */
export function SubmitForm({
  pid,
  reviewKey,
  initial,
  keymap,
  inline,
  onClose,
  onDone,
}: {
  pid: string;
  reviewKey: string;
  initial?: SubmitEvent;
  keymap?: Keymap;
  /** in the Pending tab: no Cancel, no focus on open */
  inline?: boolean;
  onClose?: () => void;
  onDone?: (msg: string) => void;
}) {
  const r = R.review(pid, reviewKey);
  const v = r.view!;
  const own = !!v.mine;
  const [event, setEvent] = useState<SubmitEvent>(
    initial && !own ? initial : "COMMENT",
  );
  const [body, setBody] = useState("");
  const gitlab = v.host?.kind === "gitlab";
  const opts: [SubmitEvent, string, string][] = [
    ["COMMENT", "Comment", "General feedback, no decision."],
    [
      "APPROVE",
      "Approve",
      own ? "You cannot approve your own change." : "Ready to merge.",
    ],
    [
      "REQUEST_CHANGES",
      "Request changes",
      own
        ? "You cannot request changes on your own change."
        : gitlab
          ? "Sent as a note, and your approval is taken back."
          : "Must be fixed before merging.",
    ],
  ];
  const lines = v.drafts.filter((d) => d.path && d.line).length;
  const onHost = v.threads.filter((t) => t.pending).length;
  const send = async () => {
    const res = await R.submit(pid, reviewKey, event, body);
    if (!res) return;
    setBody("");
    onDone?.(
      `Review sent: ${res.posted} line comment${res.posted === 1 ? "" : "s"}${res.in_body ? `, ${res.in_body} in the text` : ""}.`,
    );
  };
  return (
    <form
      className="rv-submit"
      aria-label={inline ? "Submit your review" : undefined}
      onSubmit={(e) => {
        e.preventDefault();
        void send();
      }}
    >
      <textarea
        className="rv-ta"
        aria-label="Your review"
        value={body}
        onChange={(e) => setBody(e.target.value)}
        autoFocus={!inline}
        placeholder="A summary for the author (optional)"
        onKeyDown={(e) => {
          if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
            e.preventDefault();
            e.stopPropagation();
            void send();
          }
        }}
      />
      {own && (
        <p className="rv-dim">
          This is your own {prWord(v.host)}: {gitlab ? "GitLab" : "GitHub"} does
          not take an approval or a change request from its author, so your
          comments go out as a comment.
        </p>
      )}
      {opts.map(([k, l, t]) => (
        <label key={k} className="rv-radio">
          <input
            type="radio"
            name={inline ? "rv-event-inline" : "rv-event"}
            checked={event === k}
            disabled={own && k !== "COMMENT"}
            onChange={() => setEvent(k)}
          />
          <span>
            <b>{l}</b>
            <br />
            <span className="rv-dim">{t}</span>
          </span>
        </label>
      ))}
      <span className="rv-dim">
        {lines} line comment{lines === 1 ? "" : "s"} and{" "}
        {v.drafts.length - lines} general comment
        {v.drafts.length - lines === 1 ? "" : "s"}
        {onHost
          ? `, and ${onHost} from your pending review on ${gitlab ? "GitLab" : "GitHub"},`
          : ""}{" "}
        go with it.
      </span>
      {r.err && <ErrorBox error={r.err} />}
      <div className="rv-row">
        <button
          type="submit"
          className="btn sm primary"
          disabled={r.running.includes("submit")}
        >
          {r.running.includes("submit")
            ? "Sending…"
            : event === "APPROVE"
              ? "Submit and approve"
              : event === "REQUEST_CHANGES"
                ? "Submit and request changes"
                : "Submit review"}
        </button>
        {onClose && (
          <button type="button" className="btn sm ghost" onClick={onClose}>
            Cancel
          </button>
        )}
        {keymap && <span className="rv-dim">{keysFor("submit", keymap)}</span>}
      </div>
    </form>
  );
}

/** A pending comment: where it is, its text, Edit and Delete. */
export function DraftCard({
  d,
  onSave,
  onDelete,
}: {
  d: Draft;
  onSave: (b: string) => void;
  onDelete: () => void;
}) {
  const [edit, setEdit] = useState(false);
  const [text, setText] = useState(d.body);
  return (
    <div className="rv-under rv-draft" data-draft={d.id}>
      <div className="rv-comment-h">
        <Pill tone="run">pending</Pill>
        {d.start_line != null && (
          <span className="rv-dim">lines {linesLabel(d)}</span>
        )}
        {d.finding_id && <span className="rv-dim">from keel</span>}
      </div>
      {edit ? (
        <form
          onSubmit={(e) => {
            e.preventDefault();
            onSave(text);
            setEdit(false);
          }}
        >
          <textarea
            className="rv-ta"
            aria-label="Edit the pending comment"
            value={text}
            onChange={(e) => setText(e.target.value)}
            autoFocus
          />
          <div className="rv-row">
            <button type="submit" className="btn sm primary">
              Save
            </button>
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => setEdit(false)}
            >
              Cancel
            </button>
          </div>
        </form>
      ) : (
        <>
          <pre className="rv-body-text">{d.body}</pre>
          <div className="rv-row">
            <button
              type="button"
              className="btn sm ghost"
              onClick={() => {
                setText(d.body);
                setEdit(true);
              }}
            >
              Edit
            </button>
            <button type="button" className="btn sm ghost" onClick={onDelete}>
              Delete
            </button>
          </div>
        </>
      )}
    </div>
  );
}
