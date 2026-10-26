// The switch between the classic Review view and the new one (0.18.57): remembered in this browser (localStorage, read
// and written in a try/catch by useStored), the classic one until the person picks the new one.
//
//   classic view:  … the classic Review window …
//                  ✦ Try the new review view                     ← one line at its foot
//   new view:      Review                     [ Classic | New view ]

import { useStored } from "@keel/web-sdk";
import { isMode, MODE_KEY, type ReviewMode } from "./model";

/** The Review view this browser shows, and a setter (every component that reads it follows at once). */
export function useReviewMode(): [ReviewMode, (m: ReviewMode) => void] {
  const [mode, setMode] = useStored<ReviewMode>(MODE_KEY, "classic", {
    store: "local",
    valid: isMode,
  });
  return [mode, (m) => setMode(m)];
}

/** Classic | New view, as two pressed-or-not buttons. */
export function ModeSwitch({
  mode,
  onPick,
}: {
  mode: ReviewMode;
  onPick: (m: ReviewMode) => void;
}) {
  return (
    <div className="rvn-switch" role="group" aria-label="Review view">
      {(
        [
          ["classic", "Classic"],
          ["next", "New view"],
        ] as [ReviewMode, string][]
      ).map(([m, label]) => (
        <button
          key={m}
          type="button"
          aria-pressed={mode === m}
          onClick={() => onPick(m)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}

/** The classic view's one-line hint: it switches this browser to the new view. */
export function TryNewHint({ onTry }: { onTry: () => void }) {
  return (
    <div className="rvn-hint">
      <button type="button" className="rvn-hint-b" onClick={onTry}>
        <span aria-hidden="true">✦</span> Try the new review view
      </button>
    </div>
  );
}
