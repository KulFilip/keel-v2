// keel 0.18.62 the new Review view as its own page in the menu (#/review, #/review/pr:42): the pull requests on the
// left (NextSide, without the Classic | New view switch) and the one you picked on the right (NextReview). The classic
// view stays in Code › Review as it was.
//
//   ┌ Review ─────────────┬──────────────────────────────────────────┐
//   │ 2 reviews are asked │  Review #42  Fix the cart total          │
//   │ #42 Fix the cart …  │  Comments · Files · Problems · Submit    │
//   │ #41 Euro prices     │  …                                       │
//   └─────────────────────┴──────────────────────────────────────────┘
//
// On a phone one at a time: the list, then the pull request with "‹ All pull requests" back to the list.

import { useCallback, useEffect, useState } from "react";
import { go, useRoute, type CodeOpen, type PageProps } from "@keel/web-sdk";
import { NextReview } from "./NextReview";
import { NextSide } from "./NextSide";

const PHONE = "(max-width: 720px)";

/** True on a phone-wide screen; it follows the window. */
function usePhone(): boolean {
  const [phone, setPhone] = useState(() => !!window.matchMedia?.(PHONE).matches);
  useEffect(() => {
    const m = window.matchMedia?.(PHONE);
    if (!m) return;
    const on = () => setPhone(m.matches);
    m.addEventListener("change", on);
    return () => m.removeEventListener("change", on);
  }, []);
  return phone;
}

/** The review key of a link's rest: "pr:42" or "branch:feat/x"; null for anything else. */
export const reviewArg = (arg?: string): string | null =>
  arg && /^(pr:\d+|branch:.+)$/.test(arg) ? arg : null;

export function ReviewPage({ pid }: PageProps) {
  const { arg } = useRoute();
  const [key, setKey] = useState<string | null>(() => reviewArg(arg));
  const phone = usePhone();
  // the link decides (back and forward, the launcher): #/review/pr:42 shows #42
  useEffect(() => setKey(reviewArg(arg)), [arg]);
  // NextSide opens a review the way the Code page opens an editor tab ("pr:42|"): here it is the page's link
  const open = useCallback<CodeOpen>((ref) => {
    const k = reviewArg(ref.path.split("|")[0]);
    if (!k) return;
    setKey(k);
    go("review", k);
  }, []);
  if (!pid)
    return (
      <p className="rvn-dim rvn-page-empty">
        Pick a project to see its pull requests.
      </p>
    );
  return (
    <div className={`rvn-page${phone ? ` phone ${key ? "s-pr" : "s-list"}` : ""}`}>
      {!(phone && key) && (
        <aside className="rvn-page-side">
          <NextSide pid={pid} open={open} activeKey={key} />
        </aside>
      )}
      <main className="rvn-page-main" aria-label="Pull request">
        {phone && key && (
          <button
            type="button"
            className="rvn-btn rvn-page-back"
            onClick={() => {
              setKey(null);
              go("review");
            }}
          >
            ‹ All pull requests
          </button>
        )}
        {key ? (
          <NextReview key={key} pid={pid} reviewKey={key} />
        ) : phone ? null : (
          <p className="rvn-dim rvn-page-empty">
            Pick a pull request on the left, or press “Review #…” for the next one that asks you.
          </p>
        )}
      </main>
    </div>
  );
}
