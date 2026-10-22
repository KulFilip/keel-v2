import { useStdin } from "ink";
import { placeOf } from "../click";
import { DOUBLE_MS, type Sel } from "./types";
import { wheel } from "../../core/lines";
import { osc52 } from "../../core/clipboard";
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
  setOffset: Dispatch<SetStateAction<number>>;
};

/** Lines one notch of the wheel moves. */
export const WHEEL_STEP = 3;
/** The wheel's notches within this many ms move the view once (a trackpad sends dozens a second; one frame each would
 *  stutter): the first at once, the rest together at the end. */
export const WHEEL_MS = 30;

/** The mouse in the full screen: a press, drag and release select text in the transcript or the prompt (a release copies it,
 *  a double-click takes the word, a plain click on a tool call opens it or answers what it hit), and the wheel, Home and
 *  End, read from the raw input. `shownRef` is set by the screen: which lines of the transcript show. */
export function useMouse(env: Env) {
  const { screen, mode, stdout, lines, line, owners, viewRef, promptRef, clicks, toggleToolRef, selRef, setSel, setFlash, scroll, setOffset } = env;
  const lastPress = useRef({ t: 0, col: -1, row: -1 });
  // where a cell of the screen is in the transcript shown (after scrolling) or in the prompt
  const shownRef = useRef({ above: 0, count: 0 });
  const linesRef = useRef<string[]>([]);
  linesRef.current = lines;
  const lineRef = useRef("");
  lineRef.current = line;
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
  const onMouse = (e: MouseEv) => {
    if (e.kind === "press") {
      const hit = cellAt(e.col, e.row);
      if (!hit) {
        setSel(null);
        clicks.hit(e.col, e.row)?.act();
        return;
      }
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
      if (moved !== cur.moved || hit.at.line !== cur.b.line || hit.at.col !== cur.b.col) setSel({ ...cur, b: hit.at, moved });
      return;
    }
    // the release: what is selected goes to the clipboard at once; a plain click selects nothing (on a tool call's
    // line it opens or folds its output)
    if (!cur.moved) {
      setSel(null);
      const id = cur.area === "view" ? owners.current[cur.a.line] : undefined;
      if (id !== undefined) toggleToolRef.current(id);
      return;
    }
    const text = selectedText(cur.area === "view" ? linesRef.current : [lineRef.current], cur.a, cur.b);
    if (!text.trim()) return setSel(null);
    stdout?.write(osc52(text));
    const n = [...text].length;
    setFlash(`copied ${n} character${n === 1 ? "" : "s"}`);
  };
  // the wheel: its notches gathered for a moment (WHEEL_MS), then the view moves once
  const wheelAcc = useRef(0);
  const wheelTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const flushWheel = () => {
    const n = wheelAcc.current;
    wheelAcc.current = 0;
    if (!n) return;
    if (mode) mode.wheel(n * WHEEL_STEP);
    else scroll(n * WHEEL_STEP);
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
  useEffect(() => () => void (wheelTimer.current && clearTimeout(wheelTimer.current)), []);
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
  const onRaw = useRef({ onInput, flushWheel });
  onRaw.current = { onInput, flushWheel };
  const { internal_eventEmitter: rawInput } = useStdin() as unknown as { internal_eventEmitter?: NodeJS.EventEmitter };
  useEffect(() => {
    if (!screen || !rawInput) return;
    const on = (chunk: string | Buffer) => onRaw.current.onInput(String(chunk));
    rawInput.on("input", on);
    return () => void rawInput.off("input", on);
  }, [rawInput, screen]);
  return { shownRef };
}
