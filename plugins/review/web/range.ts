// Picking the lines of a comment, GitHub's way: click a line number, shift-click another, or drag over the line
// numbers. The diff (unified and split) and the whole-file view use it with their own rows.

import { useEffect, useRef, useState, type MouseEvent } from "react";

export type Side = "RIGHT" | "LEFT";
/** A line number in a view: its row, side and number; an unchanged line also has the other side's number (alt). */
export type Point = { row: number; line: number; side: Side; alt?: number | null };
/** What a comment is on: one line (startLine null), or from startLine on startSide to line on side. */
export type Span = {
  line: number;
  side: Side;
  startLine: number | null;
  startSide: Side | null;
};

const one = (p: Point): Span => ({ line: p.line, side: p.side, startLine: null, startSide: null });

/**
 * The span between two picked lines, top to bottom. An unchanged line stands on either side, so a range keeps one
 * side where it can; the old side may start a range that ends on the new side, never the other way (then it is the
 * last line alone).
 */
export function spanOf(a: Point, b: Point): Span {
  if (a.row === b.row && a.side === b.side) return one(a);
  let [s, e] = a.row < b.row || (a.row === b.row && a.side === "LEFT") ? [a, b] : [b, a];
  let startSide = s.side;
  let startLine = s.line;
  if (startSide !== e.side && s.alt != null) {
    startSide = e.side;
    startLine = s.alt;
  }
  if (startSide === "RIGHT" && e.side === "LEFT" && e.alt != null) e = { ...e, side: "RIGHT", line: e.alt };
  if (startSide === "RIGHT" && e.side === "LEFT") return one(e);
  if (startSide === e.side && startLine >= e.line) return one(e);
  return { line: e.line, side: e.side, startLine, startSide };
}

/** The gutter's mouse handlers and the rows a drag covers now (for the highlight). */
export function useLineRange(onPick: (s: Span, end: Point) => void) {
  const [drag, setDrag] = useState<{ from: Point; to: Point } | null>(null);
  const live = useRef(drag);
  live.current = drag;
  const pick = useRef(onPick);
  pick.current = onPick;
  // the first line of a shift-click range
  const anchor = useRef<Point | null>(null);
  // a drag ends on mouseup; the click that may follow it is not a new pick
  const dragged = useRef(false);
  const dragging = drag != null;
  useEffect(() => {
    if (!dragging) return;
    const up = () => {
      const d = live.current;
      setDrag(null);
      if (!d || (d.from.row === d.to.row && d.from.side === d.to.side)) return;
      dragged.current = true;
      window.setTimeout(() => (dragged.current = false), 0);
      anchor.current = d.from;
      pick.current(spanOf(d.from, d.to), d.to);
    };
    window.addEventListener("mouseup", up);
    return () => window.removeEventListener("mouseup", up);
  }, [dragging]);
  const on = (p: Point | null) =>
    p == null
      ? {}
      : {
          onMouseDown: (e: MouseEvent) => {
            if (e.button !== 0 || e.shiftKey) return;
            e.preventDefault(); // no text selection while dragging over the numbers
            setDrag({ from: p, to: p });
          },
          onMouseOver: () => {
            if (live.current) setDrag((d) => (d ? { ...d, to: p } : d));
          },
          onClick: (e: MouseEvent) => {
            if (dragged.current) {
              dragged.current = false;
              return;
            }
            if (e.shiftKey && anchor.current) {
              pick.current(spanOf(anchor.current, p), p);
              return;
            }
            anchor.current = p;
            pick.current(one(p), p);
          },
        };
  const rows = drag ? ([Math.min(drag.from.row, drag.to.row), Math.max(drag.from.row, drag.to.row)] as const) : null;
  return { on, rows };
}

/** The rows from a span's first line to its last, by a view's lookup of a side's line; null when one is not shown. */
export function rowsOf(
  span: { line: number | null; side: Side; startLine?: number | null; startSide?: Side | null },
  rowOf: (side: Side, line: number) => number | undefined,
): readonly [number, number] | null {
  if (span.line == null) return null;
  const end = rowOf(span.side, span.line);
  const start = span.startLine != null ? rowOf(span.startSide ?? span.side, span.startLine) : end;
  if (end == null || start == null) return null;
  return [Math.min(start, end), Math.max(start, end)] as const;
}
