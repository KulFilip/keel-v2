import { measureElement } from "ink";
import { view } from "../../core/lines";
import { useCallback, useEffect, useRef, useState } from "react";
import { type DOMElement } from "ink";

/** The full screen's scroll: lines up from the newest (`offset`), the transcript area's height (`viewH`, read after Ink
 *  laid the screen out) and `scroll` by some lines. */
export function useScroll(lineCount: number, height: number, screen: boolean) {
  const [offset, setOffset] = useState(0);
  const [viewH, setViewH] = useState(Math.max(3, height - 8));
  const viewRef = useRef<DOMElement>(null);
  // scrolled up while new lines come: the view stays where the person is reading
  const seen = useRef(0);
  useEffect(() => {
    const grew = lineCount - seen.current;
    seen.current = lineCount;
    if (grew > 0) setOffset((o) => (o > 0 ? o + grew : 0));
  }, [lineCount]);
  const scroll = useCallback((by: number) => setOffset((o) => Math.max(0, Math.min(o + by, Math.max(0, lineCount - viewH)))), [lineCount, viewH]);
  // the transcript area's height, after Ink laid the screen out
  useEffect(() => {
    if (!screen || !viewRef.current) return;
    const h = measureElement(viewRef.current).height;
    if (h > 0 && h !== viewH) setViewH(h);
  });
  return { offset, setOffset, viewH, viewRef, scroll };
}
