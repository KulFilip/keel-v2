import { useStdin } from "ink";
import { placeOf } from "../click";
import { DOUBLE_MS, type Sel } from "./types";
import { wheel } from "../../core/lines";
import { copiedText, copyText, NATIVE_SELECT } from "../../core/clipboard";
import { mouseEvents, plain, selectedText, wordAt, type MouseEv, type Point } from "../../core/select";
import { useEffect, useRef, type MutableRefObject, type RefObject } from "react";
import { type DOMElement } from "ink";
import type { Dispatch, SetStateAction } from "react";
import type { ModeSession } from "../../core/modes";

type Env = {
  screen: boolean;
  mode: ModeSession | null;
  stdout: NodeJS.WriteStream | undefined;
  lines: string[];
  line: string;
  owners: MutableRefObject<number[]>;
  viewRef: RefObject<DOMElement | null>;
  promptRef: RefObject<DOMElement | null>;
  clicks: ReturnType<typeof import("../click").makeClicks>;
  toggleToolRef: MutableRefObject<(id: number) => boolean>;
  selRef: MutableRefObject<Sel | null>;
  setSel: (x: Sel | null) => void;
  setFlash: (x: string | null) => void;
  scroll: (by: number) => number;
  shown: () => { above: number; count: number };
  setOffset: Dispatch<SetStateAction<number>>;
};

/** Lines one notch of the wheel moves. */
export const WHEEL_STEP = 3;
/** The wheel's notches within this many ms move the view once (a trackpad sends dozens a second; one frame each would
 *  stutter): the first at once, the rest together at the end. */
export const WHEEL_MS = 30;
/** A drag held past the transcript's top or bottom scrolls it this many lines every AUTO_MS (the terminal reports the
 *  mouse only when it moves, so a timer keeps it going). */
export const AUTO_LINES = 2;
export const AUTO_MS = 60;

/** The mouse in the full screen: a press, drag and release select text in the transcript or the prompt (a release copies it,
 *  a double-click takes the word, a plain click on a tool call opens it or answers what it hit), and the wheel, Home and
 *  End, read from the raw input. A drag past the transcript's top or bottom scrolls it (and the wheel while dragging
 *  too), the selection going with it. `shownRef` is set by the screen: which lines of the transcript show. */
export function useMouse(env: Env) {
  const { screen, mode, stdout, lines, line, owners, viewRef, promptRef, clicks, toggleToolRef, selRef, setSel, setFlash, scroll, shown,
    setOffset } = env;
  const lastPress = useRef({ t: 0, col: -1, row: -1 });
  // where a cell of the screen is in the transcript shown (after scrolling) or in the prompt
  const shownRef = useRef({ above: 0, count: 0 });
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;
  const lineRef = useRef("");
  lineRef.current = line;
  // the left button is held (between a press on text and its release)
  const dragging = useRef(false);
  /** The transcript's or the prompt's cell at a column and row of the screen; with `keep`, a cell outside it is moved
   *  to its nearest edge (a drag past the transcript's top or bottom, or off the prompt's line). */
  const cellAt = (col: number, row: number, keep?: Sel["area"]): { area: Sel["area"]; at: Point } | null => {
    const vp = viewRef.current && placeOf(viewRef.current);
    const { above, count } = shownRef.current;
    if (vp && count && keep !== "prompt") {
      const i = row - (vp.top + vp.height - count);      // the lines sit at the bottom of the transcript's area
      const c = Math.max(0, col - vp.left);
      if (i >= 0 && i < count && col >= vp.left && col < vp.left + vp.width) return { area: "view", at: { line: above + i, col: c } };
      if (keep === "view") return { area: "view", at: i < 0 ? { line: above, col: 0 } : i >= count ? { line: above + count - 1, col: 1e6 } : { line: above + i, col: c } };
    }
    const pp = promptRef.current && placeOf(promptRef.current);
    // the prompt's text starts after its border, its padding and "› "
    if (pp && lineRef.current && (keep === "prompt" || row === pp.top + 1)) return { area: "prompt", at: { line: 0, col: Math.max(0, col - pp.left - 4) } };
    return null;
  };
  /** Where a drag at `row` is: above the transcript's lines (+1: scroll to older ones), below its area (-1), or in it. */
  const edgeOf = (row: number): number => {
    const vp = viewRef.current && placeOf(viewRef.current);
    if (!vp) return 0;
    const { count } = shownRef.current;
    if (row < vp.top + vp.height - Math.min(count, vp.height)) return 1;
    if (row >= vp.top + vp.height) return -1;
    return 0;
  };
  // the drag held at an edge: the transcript scrolls, the selection's end stays at the edge's line
  const auto = useRef<{ dir: number; timer: ReturnType<typeof setInterval> | null }>({ dir: 0, timer: null });
  const stopAuto = () => {
    if (auto.current.timer) clearInterval(auto.current.timer);
    auto.current = { dir: 0, timer: null };
  };
  const autoTick = () => {
    const cur = selRef.current;
    const dir = auto.current.dir;
    if (!cur || cur.area !== "view" || !dragging.current || !dir) return stopAuto();
    scroll(dir * AUTO_LINES);
    const { above, count } = shown();
    if (!count) return;
    const b = dir > 0 ? { line: above, col: 0 } : { line: above + count - 1, col: 1e6 };
    if (b.line !== cur.b.line || b.col !== cur.b.col || !cur.moved) setSel({ ...cur, b, moved: true });
  };
  const edgeScroll = (dir: number) => {
    if (!dir) return stopAuto();
    auto.current.dir = dir;
    if (auto.current.timer) return;
    autoTick();
    auto.current.timer = setInterval(() => onRaw.current.autoTick(), AUTO_MS);
  };
  const onMouse = (e: MouseEv) => {
    if (e.kind === "press") {
      stopAuto();
      const hit = cellAt(e.col, e.row);
      if (!hit) {
        dragging.current = false;
        setSel(null);
        clicks.hit(e.col, e.row)?.act();
        return;
      }
      dragging.current = true;
      const lp = lastPress.current;
      const now = Date.now();
      lastPress.current = { t: now, col: e.col, row: e.row };
      if (now - lp.t < DOUBLE_MS && lp.col === e.col && lp.row === e.row) {
        // a double-click: the word under it
        const text = hit.area === "view" ? linesRef.current[hit.at.line] ?? "" : lineRef.current;
        const w = wordAt(plain(text), hit.at.col);
        if (w) return setSel({ area: hit.area, a: { line: hit.at.line, col: w[0] }, b: { line: hit.at.line, col: w[1] }, moved: true });
      }
      setSel({ area: hit.area, a: hit.at, b: hit.at, moved: false });
      return;
    }
    const cur = selRef.current;
    if (!cur) return;
    if (e.kind === "drag") {
      const hit = cellAt(e.col, e.row, cur.area);
      if (!hit) return;
      const moved = cur.moved || hit.at.line !== cur.a.line || hit.at.col !== cur.a.col;
      if (moved && !cur.moved) setFlash(`selecting · release copies · drag past the top or bottom to scroll · ${NATIVE_SELECT}`);
      if (moved !== cur.moved || hit.at.line !== cur.b.line || hit.at.col !== cur.b.col) setSel({ ...cur, b: hit.at, moved });
      if (cur.area === "view") edgeScroll(edgeOf(e.row));
      return;
    }
    // the release: what is selected goes to the clipboard at once; a plain click selects nothing (on a tool call's
    // line it opens or folds its output)
    dragging.current = false;
    stopAuto();
    if (!cur.moved) {
      setSel(null);
      setFlash(null);
      const id = cur.area === "view" ? owners.current[cur.a.line] : undefined;
      if (id !== undefined) toggleToolRef.current(id);
      return;
    }
    const text = selectedText(cur.area === "view" ? linesRef.current : [lineRef.current], cur.a, cur.b);
    if (!text.trim()) {
      setFlash(null);
      return setSel(null);
    }
    const c = copyText(text, stdout);
    setFlash(copiedText(c) + (c.note ? "" : ` · ${NATIVE_SELECT}`));
  };
  // the wheel: its notches gathered for a moment (WHEEL_MS), then the view moves once
  const wheelAcc = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushWheel = () => {
    const n = wheelAcc.current;
    wheelAcc.current = 0;
    if (!n) return;
    if (mode) return mode.wheel(n * WHEEL_STEP);
    const moved = scroll(n * WHEEL_STEP);
    // the wheel while dragging: the selection's end is the line now under the mouse (the lines moved under it)
    const cur = selRef.current;
    if (moved && dragging.current && cur?.area === "view") {
      const line = Math.max(0, Math.min(linesRef.current.length - 1, cur.b.line - moved));
      setSel({ ...cur, b: { line, col: cur.b.col }, moved: true });
    }
  };
  const onWheel = (n: number) => {
    wheelAcc.current += n;
    if (wheelTimer.current) return;
    flushWheel();
    wheelTimer.current = setTimeout(() => {
      wheelTimer.current = null;
      onRaw.current.flushWheel();
    }, WHEEL_MS);
  };
  useEffect(() => () => {
    if (wheelTimer.current) clearTimeout(wheelTimer.current);
    if (auto.current.timer) clearInterval(auto.current.timer);
  }, []);
  // the wheel, Home and End: read from the raw input (Ink gives no key for them). The listener is set up once; it
  // calls this render's handlers (a listener set up again on every render could miss or double a report).
  const onInput = (s: string) => {
    const n = wheel(s);
    if (n) return onWheel(n);
    for (const e of mouseEvents(s)) onMouse(e);
    const end = /^\x1b(\[(F|4~|8~)|OF)$/.test(s);
    const home = /^\x1b(\[(H|1~|7~)|OH)$/.test(s);
    if (mode && (end || home)) void mode.press(end ? "end" : "home");
    else if (end) setOffset(0);
    else if (home) setOffset(Number.MAX_SAFE_INTEGER);
  };
  const onRaw = useRef({ onInput, flushWheel, autoTick });
  onRaw.current = { onInput, flushWheel, autoTick };
  const { internal_eventEmitter: rawInput } = useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter };
  useEffect(() => {
    if (!screen || !rawInput) return;
    const on = (chunk: string | Buffer) => onRaw.current.onInput(String(chunk));
    rawInput.on("input", on);
    return () => void rawInput.off("input", on);
  }, [rawInput, screen]);
  return { shownRef };
}
