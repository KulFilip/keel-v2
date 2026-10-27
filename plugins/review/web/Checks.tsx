// 0.18.61 the pull request's checks (GitHub's check runs and statuses, GitLab's pipeline jobs), for the classic view
// and the new one: the CI summary opens a list with each check's state and a link to it on the host. It starts open
// when a check failed, so the red one shows at once.
//
//   [CI 0/2] ▾
//   ┌──────────────────────────────────┐
//   │ ● test    failed     Open ↗      │
//   │ ● build   running    Open ↗      │
//   └──────────────────────────────────┘

import { useState, type ReactNode } from "react";
import type { CheckRun } from "./reviewApi";

const GREEN = ["success", "skipped", "neutral"];
const RED = ["failure", "failed", "error", "cancelled", "timed_out"];

export type CheckTone = "ok" | "bad" | "run";
export const checkTone = (state: string): CheckTone =>
  RED.includes(state) ? "bad" : GREEN.includes(state) ? "ok" : "run";

const ORDER: Record<CheckTone, number> = { bad: 0, run: 1, ok: 2 };

/** The checks, failed first, then running, then green; the host's order inside each. */
export function sortChecks(checks: CheckRun[]): CheckRun[] {
  return checks
    .map((c, i) => ({ c, i }))
    .sort(
      (a, b) =>
        ORDER[checkTone(a.c.state)] - ORDER[checkTone(b.c.state)] || a.i - b.i,
    )
    .map((x) => x.c);
}

/** [summary] opens the list of [checks]; [summary] is the view's own pill. */
export function ChecksList({
  checks,
  summary,
  where,
}: {
  checks: CheckRun[];
  summary: ReactNode;
  /** GitHub or GitLab, for the links' names */
  where: string;
}) {
  const [open, setOpen] = useState(() =>
    checks.some((c) => checkTone(c.state) === "bad"),
  );
  if (!checks.length) return null;
  return (
    <details
      className="rv-checks"
      open={open}
      onToggle={(e) => setOpen((e.currentTarget as HTMLDetailsElement).open)}
    >
      <summary
        aria-label={`Checks: ${checks.length}, ${open ? "hide" : "show"} them`}
      >
        {summary}
        <span className="rv-checks-arrow" aria-hidden="true">
          {open ? "▴" : "▾"}
        </span>
      </summary>
      <ul className="rv-checks-list" aria-label="Checks">
        {sortChecks(checks).map((c, i) => {
          const tone = checkTone(c.state);
          return (
            <li key={`${c.name}:${i}`} className={`rv-check t-${tone}`}>
              <span className="rv-check-dot" aria-hidden="true" />
              <span className="rv-check-name" title={c.name}>
                {c.name}
              </span>
              <span className="rv-check-state">{c.state}</span>
              {c.url ? (
                <a
                  className="rv-check-link"
                  href={c.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label={`Open ${c.name} on ${where}`}
                >
                  Open ↗
                </a>
              ) : (
                <span className="rv-check-link" />
              )}
            </li>
          );
        })}
      </ul>
    </details>
  );
}
