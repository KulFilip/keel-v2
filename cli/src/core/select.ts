// keel TUI: select with the mouse and it is copied (as in opencode and Claude Code). The full screen takes the mouse
// (for the wheel), so the terminal cannot select text itself; keel TUI reads the left button's press, drag and
// release (DECSET 1002, SGR 1006), shows the selected cells inverse and puts their text on the clipboard (OSC 52).
// No UI here: the reports, the cells of a selection as text, and a word's bounds. Columns are screen cells.

import stringWidth from "string-width";

/** The left button's reports (0-based column and row): press, drag (motion with it held) and release. `mods` is the
 *  report's Shift (4), Meta/Option (8) and Ctrl (16) bits. */
export type MouseEv = {
  kind: "press" | "drag" | "release";
  col: number;
  row: number;
  mods: number;
};

/** The left button's press, drag and release in a chunk of input (SGR reports); the wheel and other buttons are left out. */
export function mouseEvents(chunk: string): MouseEv[] {
  const out: MouseEv[] = [];
  for (const m of chunk.matchAll(/\x1b?\[<(\d+);(\d+);(\d+)([Mm])/g)) {
    const b = Number(m[1]);
    if (b & 64 || (b & 3) !== 0) continue; // the wheel, the middle or right button
    const at = { col: Number(m[2]) - 1, row: Number(m[3]) - 1, mods: b & 28 };
    out.push({
      kind: m[4] === "m" ? "release" : b & 32 ? "drag" : "press",
      ...at,
    });
  }
  return out;
}

/** A cell in the transcript: its line and its column. */
export type Point = { line: number; col: number };

/** The two ends of a selection, the first one first. */
export function ordered(a: Point, b: Point): [Point, Point] {
  return a.line < b.line || (a.line === b.line && a.col <= b.col)
    ? [a, b]
    : [b, a];
}

/** The columns of line `i` a selection from `a` to `b` covers (both ends' cells in), as [from, to), or null. */
export function colsOn(i: number, a: Point, b: Point): [number, number] | null {
  const [s, e] = ordered(a, b);
  if (i < s.line || i > e.line) return null;
  return [i === s.line ? s.col : 0, i === e.line ? e.col + 1 : Infinity];
}

/** Text without its colours and other escape sequences. */
export const plain = (s: string) =>
  s.replace(/\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "");

/** The cells of `s` (plain text) from column `from` up to `to`: a wide character counts two cells, and is in when its
 *  first cell is. */
export function sliceCols(s: string, from: number, to: number): string {
  let col = 0;
  let out = "";
  for (const ch of s) {
    const w = stringWidth(ch);
    if (col >= to && w > 0) break;
    if (col >= from) out += ch;
    col += w;
  }
  return out;
}

/** What a selection from `a` to `b` covers in `lines` (plain or coloured): each line's trailing spaces cut, the lines
 *  joined with \n. */
export function selectedText(lines: string[], a: Point, b: Point): string {
  const [s, e] = ordered(a, b);
  const out: string[] = [];
  for (
    let i = Math.max(0, s.line);
    i <= Math.min(lines.length - 1, e.line);
    i++
  ) {
    const [from, to] = colsOn(i, s, e)!;
    out.push(sliceCols(plain(lines[i]), from, to).replace(/\s+$/, ""));
  }
  return out.join("\n");
}

/** A line with columns [from, to) shown inverse (the line's own colours left out while it is selected). */
export function highlight(line: string, from: number, to: number): string {
  const s = plain(line);
  const mid = sliceCols(s, from, to);
  if (!mid) return s;
  return (
    sliceCols(s, 0, from) +
    "\x1b[7m" +
    mid +
    "\x1b[27m" +
    sliceCols(s, to, Infinity)
  );
}

const WORD = /[^\s"'`()[\]{}<>│|,;]/u;

/** The word under column `col` of `s` (plain): its first and last column, or null on a space. A word runs between
 *  spaces, quotes, brackets and box lines, so a path or a URL is one word. */
export function wordAt(s: string, col: number): [number, number] | null {
  const cells: { ch: string; col: number; w: number }[] = [];
  let c = 0;
  for (const ch of plain(s)) {
    const w = stringWidth(ch);
    cells.push({ ch, col: c, w });
    c += w;
  }
  const i = cells.findIndex(
    (x) => col >= x.col && col < x.col + Math.max(1, x.w),
  );
  if (i < 0 || !WORD.test(cells[i].ch)) return null;
  let a = i;
  let b = i;
  while (a > 0 && WORD.test(cells[a - 1].ch)) a--;
  while (b < cells.length - 1 && WORD.test(cells[b + 1].ch)) b++;
  return [cells[a].col, cells[b].col + Math.max(1, cells[b].w) - 1];
}
