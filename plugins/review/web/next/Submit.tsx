// The new Review view's Submit drawer (0.18.57): your pending comments (remove one with ×), a summary for the author,
// and your decision: Comment, Approve or Request changes. Your own pull request takes a comment only (GitHub and GitLab
// do not take an approval or a change request from its author). The same api as the classic submit (R.submit), and the
// same kept summary draft.

import { useState } from "react";
import { Drawer, ErrorBox } from "@keel/web-sdk";
import {
  linesLabel,
  prLabel,
  prWord,
  type SubmitEvent,
  type SubmitResult,
} from "../reviewApi";
import * as R from "../store";
import { firstLine } from "../Threads";
import { whereOf } from "./model";

export function SubmitDrawer({
  pid,
  reviewKey,
  onClose,
  onDone,
}: {
  pid: string;
  reviewKey: string;
  onClose: () => void;
  onDone: (r: SubmitResult) => void;
}) {
  R.useReviewStore();
  const r = R.review(pid, reviewKey);
  const v = r.view!;
  const own = !!v.mine;
  const gitlab = v.host?.kind === "gitlab";
  const [event, setEvent] = useState<SubmitEvent>("COMMENT");
  // the summary: the classic submit keeps the same draft (localStorage) until the review is sent
  const [body, setBody] = R.useReviewDraft(pid, reviewKey, "submit");
  const sending = r.running.includes("submit");
  const onHost = v.threads.filter((t) => t.pending);
  const pendingN = v.drafts.length + onHost.length;
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
  const send = async () => {
    const res = await R.submit(pid, reviewKey, event, body);
    if (!res) return;
    setBody("");
    onDone(res);
  };
  const label = v.kind === "pr" ? prLabel(v.host, v.number) : v.branch;
  return (
    <Drawer
      title={`Submit your review of ${label}`}
      onClose={onClose}
      className="rvn-drawer"
      footer={
        <div className="rvn-row rvn-drawer-f">
          <button type="button" className="rvn-btn" onClick={onClose}>
            Cancel
          </button>
          <button
            type="submit"
            form="rvn-submit"
            className="rvn-btn primary"
            disabled={sending}
          >
            {sending
              ? "Sending…"
              : event === "APPROVE"
                ? "Submit and approve"
                : event === "REQUEST_CHANGES"
                  ? "Submit and request changes"
                  : "Submit review"}
          </button>
        </div>
      }
    >
      <form
        id="rvn-submit"
        className="rvn-stack"
        onSubmit={(e) => {
          e.preventDefault();
          void send();
        }}
      >
        <section className="rvn-stack" aria-label="Pending comments">
          <h3 className="rvn-h3">
            Pending comments <span className="rvn-dim">{pendingN}</span>
          </h3>
          {pendingN === 0 && (
            <p className="rvn-dim">
              None yet. Comments you add in Files and Problems wait here until
              you submit.
            </p>
          )}
          {v.drafts.map((d) => (
            <div key={d.id} className="rvn-pending">
              <div className="rvn-pending-b">
                <span className="rvn-mono rvn-dim">
                  {d.path
                    ? `${whereOf(d.path, null)}${d.line != null ? ` · line ${linesLabel(d)}` : ""}`
                    : "General comment"}
                </span>
                <span>{firstLine(d.body)}</span>
              </div>
              <button
                type="button"
                className="rvn-x"
                aria-label={`Remove the pending comment${d.line != null ? ` on line ${d.line}` : ""}`}
                disabled={r.running.includes("draft")}
                onClick={() => void R.deleteDraft(pid, reviewKey, d)}
              >
                ×
              </button>
            </div>
          ))}
          {onHost.map((t) => (
            <div key={t.id} className="rvn-pending">
              <div className="rvn-pending-b">
                <span className="rvn-mono rvn-dim">
                  {whereOf(t.path, t.line)} · started on{" "}
                  {gitlab ? "GitLab" : "GitHub"}
                </span>
                <span>{firstLine(t.comments[0]?.body ?? "")}</span>
              </div>
            </div>
          ))}
        </section>
        <label className="rvn-field">
          <span>A summary for the author (optional)</span>
          <textarea
            rows={3}
            value={body}
            onChange={(e) => setBody(e.target.value)}
            onKeyDown={(e) => {
              if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
                e.preventDefault();
                void send();
              }
            }}
          />
        </label>
        {own && (
          <p className="rvn-dim">
            This is your own {prWord(v.host)}: it takes a comment only.{" "}
            {gitlab ? "GitLab" : "GitHub"} does not take an approval or a change
            request from its author.
          </p>
        )}
        <div className="rvn-events" role="radiogroup" aria-label="Your decision">
          {opts.map(([k, l, help]) => {
            const off = own && k !== "COMMENT";
            return (
              <label
                key={k}
                className={`rvn-event${event === k ? " on" : ""}${off ? " off" : ""}`}
              >
                <input
                  type="radio"
                  name="rvn-event"
                  value={k}
                  checked={event === k}
                  disabled={off}
                  onChange={() => setEvent(k)}
                />
                <span>
                  <b>{l}</b>
                  <br />
                  <span className="rvn-dim">{help}</span>
                </span>
              </label>
            );
          })}
        </div>
        {r.err && <ErrorBox error={r.err} />}
      </form>
    </Drawer>
  );
}
