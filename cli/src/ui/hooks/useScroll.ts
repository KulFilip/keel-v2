import { measureElement } from "ink";
import { useCallback, useEffect, useRef, useState, type SetStateAction } from "react";
import { type DOMElement } from "ink";

/** The full screen's scroll: lines up from the newest (`offset`), the transcript area's height (`viewH`, read after Ink
 *  laid the screen out) and `scroll` by some lines. `scroll` and `shown` are stable (the same functions on every
 *  render) and read the latest numbers from refs, so a handler set up once (the mouse's) never sees stale ones;
 *  `scroll` returns the lines it really moved (none past the oldest or the newest line). */
export function useScroll(lineCount: number, height: number, screen: boolean) {
  const [offset, setOffsetState] = useState(0);
  const [viewH, setViewH] = useState(Math.max(3, height - 8));
  const viewRef = useRef<DOMElement>(null);
  const offRef = useRef(0);
  const countRef = useRef(lineCount);
  countRef.current = lineCount;
  const hRef = useRef(viewH);
  hRef.current = viewH;
  const setOffset = useCallback((x: SetStateAction<number>) => {
    offRef.current = typeof x === "function" ? x(offRef.current) : x;
    setOffsetState(offRef.current);
  }, []);
  // scrolled up while new lines come: the view stays where the person is reading
  const seen = useRef(0);
  useEffect(() => {
    const grew = lineCount - seen.current;
    seen.current = lineCount;
    if (grew > 0) setOffset((o) => (o > 0 ? o + grew : 0));
  }, [lineCount, setOffset]);
  const scroll = useCallback((by: number): number => {
    const max = Math.max(0, countRef.current - hRef.current);
    const from = Math.max(0, Math.min(offRef.current, max));
    const to = Math.max(0, Math.min(from + by, max));
    if (to !== offRef.current) setOffset(to);
    return to - from;
  }, [setOffset]);
  /** The lines that show now (as `view` in core/lines.ts picks them): the first one's index and how many. */
  const shown = useCallback(() => {
    const h = Math.max(1, hRef.current);
    const off = Math.max(0, Math.min(offRef.current, Math.max(0, countRef.current - h)));
    const end = countRef.current - off;
    const above = Math.max(0, end - h);
    return { above, count: end - above };
  }, []);
  // the transcript area's height, after Ink laid the screen out
  useEffect(() => {
    if (!screen || !viewRef.current) return;
    const h = measureElement(viewRef.current).height;
    if (h > 0 && h !== viewH) setViewH(h);
  });
  return { offset, setOffset, viewH, viewRef, scroll, shown };
}
