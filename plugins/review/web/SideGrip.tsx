// The Review tool window's own width: a drag handle (and arrow keys) on its right edge, remembered in this browser.
// The Code page sizes its side bar for every view; while the Review view shows, review.css gives the side bar
// --rv-side-w instead (set here on the page root), so the threads get the room they need and the other views keep
// their width.
//
//   ┌ act ┬──── Review (--rv-side-w) ────┃┬──── editor ────┐
//   │     │ threads, cards, code …        ┃│                │
//   └─────┴───────────────────────────────┃┴────────────────┘
//                                         ↑ drag, ← → (⇧ for big steps), Home / End, double-click: default

import { useEffect, useRef, useState, type PointerEvent } from "react";

export const SIDE_KEY = "keel2.review.sideW";
export const SIDE_DEFAULT = 440;
export const SIDE_MIN = 280;
const SIDE_CAP = 1400;
/** the activity bar and the least the editor keeps */
const KEEP = 48 + 360;

function readWidth(): number | null {
  try {
    const v = Number(localStorage.getItem(SIDE_KEY));
    return Number.isFinite(v) && v > 0 ? v : null;
  } catch {
    return null;
  }
}

function saveWidth(w: number | null) {
  try {
    if (w == null) localStorage.removeItem(SIDE_KEY);
    else localStorage.setItem(SIDE_KEY, String(Math.round(w)));
  } catch {
    /* private window */
  }
}

export function SideGrip() {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState<number>(() => readWidth() ?? SIDE_DEFAULT);
  const max = () => {
    const ide =
      ref.current?.closest(".ide")?.getBoundingClientRect().width ||
      window.innerWidth ||
      1200;
    return Math.max(SIDE_MIN, Math.min(SIDE_CAP, ide - KEEP));
  };
  const clamp = (w: number) =>
    Math.round(Math.min(max(), Math.max(SIDE_MIN, w)));
  useEffect(() => {
    document.documentElement.style.setProperty("--rv-side-w", `${width}px`);
  }, [width]);
  useEffect(
    () => () => {
      document.documentElement.style.removeProperty("--rv-side-w");
    },
    [],
  );
  const set = (w: number) => {
    const c = clamp(w);
    setWidth(c);
    saveWidth(c);
  };
  const drag = (e: PointerEvent<HTMLDivElement>) => {
    e.preventDefault();
    const startX = e.clientX;
    const start = width;
    const move = (ev: globalThis.PointerEvent) =>
      setWidth(clamp(start + ev.clientX - startX));
    const up = (ev: globalThis.PointerEvent) => {
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
      document.body.classList.remove("ide-dragging");
      set(start + ev.clientX - startX);
    };
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    document.body.classList.add("ide-dragging");
  };
  return (
    <div
      ref={ref}
      className="rv-grip"
      role="separator"
      aria-orientation="vertical"
      aria-label="Resize the review panel"
      aria-valuenow={width}
      aria-valuemin={SIDE_MIN}
      aria-valuemax={SIDE_CAP}
      tabIndex={0}
      title="Drag to resize (double-click: default width)"
      onPointerDown={drag}
      onDoubleClick={() => {
        setWidth(SIDE_DEFAULT);
        saveWidth(null);
      }}
      onKeyDown={(e) => {
        const step = e.shiftKey ? 96 : 24;
        if (e.key === "ArrowLeft") set(width - step);
        else if (e.key === "ArrowRight") set(width + step);
        else if (e.key === "Home") set(SIDE_MIN);
        else if (e.key === "End") set(max());
        else return;
        e.preventDefault();
      }}
    />
  );
}
