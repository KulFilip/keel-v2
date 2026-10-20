// keel TUI's clicks (the full screen with the wheel on: the terminal reports the mouse, SGR mode). A part of the screen
// that does something when clicked wraps itself in <Clickable act={…}>; the app finds the one under the click from
// where Ink laid it out (each box's place, from its yoga node up to the screen's top-left corner).
import React, { createContext, useContext, useLayoutEffect, useRef } from "react";
import { Box, type DOMElement } from "ink";

type Entry = { el: () => DOMElement | null; act: () => void };
export type Clicks = { add: (e: Entry) => () => void; hit: (col: number, row: number) => Entry | null };

/** Where a box is on the screen (0-based column and row), and its size. */
export function placeOf(el: DOMElement): { left: number; top: number; width: number; height: number } | null {
  const own = el.yogaNode;
  if (!own) return null;
  let left = 0;
  let top = 0;
  for (let n: DOMElement | undefined = el; n; n = n.parentNode) {
    if (!n.yogaNode) continue;
    left += n.yogaNode.getComputedLeft();
    top += n.yogaNode.getComputedTop();
  }
  return { left, top, width: own.getComputedWidth(), height: own.getComputedHeight() };
}

export function makeClicks(): Clicks {
  const entries = new Set<Entry>();
  return {
    add: (e) => {
      entries.add(e);
      return () => void entries.delete(e);
    },
    // the innermost (the smallest) box under the click wins: a line in a panel before the panel
    hit: (col, row) => {
      let best: { e: Entry; area: number } | null = null;
      for (const e of entries) {
        const el = e.el();
        const p = el && placeOf(el);
        if (!p || row < p.top || row >= p.top + p.height || col < p.left || col >= p.left + p.width) continue;
        const area = p.width * p.height;
        if (!best || area < best.area) best = { e, area };
      }
      return best?.e ?? null;
    },
  };
}

const Ctx = createContext<Clicks | null>(null);
export const ClicksProvider = ({ clicks, children }: { clicks: Clicks; children: React.ReactNode }) => <Ctx.Provider value={clicks}>{children}</Ctx.Provider>;

/** A part of the screen that does `act` when clicked (nothing without the full screen's mouse). */
export function Clickable({ act, children, flexDirection = "column" }: { act: () => void; children: React.ReactNode; flexDirection?: "row" | "column" }) {
  const clicks = useContext(Ctx);
  const ref = useRef<DOMElement>(null);
  const latest = useRef(act);
  latest.current = act;
  // in the commit that draws it: a passive effect can run after Ink wrote the frame (React 19 schedules it), and a
  // click on the new line in between would find nothing under it
  useLayoutEffect(() => clicks?.add({ el: () => ref.current, act: () => latest.current() }), [clicks]);
  return <Box ref={ref} flexDirection={flexDirection}>{children}</Box>;
}
