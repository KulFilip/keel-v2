// Markdown for the terminal: KeelBot's answers (and keel's own texts) as styled lines, in keel's colours. No UI: it
// returns text with ANSI styles from a Paint (theme.ts; PLAIN for none), so any terminal front end can print it.
//
//   # Heading         the heading role (bold)     **bold**  *italic*  `code` (the code role)
//   - item / 1. item  "  • item" (accent bullet)  [text](url) → text (url)
//   ```lang code```   highlighted by language (highlight.js, the web's highlighter), a diff green and red
//   > quote           "  ┃ quote"                 path/file.ts:12 → a file link (FILE_LINE)
//   | a | b |         a table in a box, its header in the accent
//
// The table layout (fitColumns) and the bullets by depth are adapted from xal (https://github.com/xal-sh/xal,
// apps/cli/src/plugins/tui/markdown/render.ts), MIT License, Copyright (c) 2026 Saeed Vaziry. See THIRD_PARTY_NOTICES.md.

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { highlight } from "./highlight";
import { PLAIN, type Paint } from "./theme";

export type Style = Paint;
/** No styles (pipes, tests, NO_COLOR). */
export const plain: Paint = PLAIN;

/** path/to/file.ext:line[:col] — the same shape keel's web links (web fileLink). */
export const FILE_LINE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,7}):(\d+)(?::(\d+))?(?![\w])/g;

/** Every file:line in a text, in order: for "open in the editor" and tests. */
export function fileLines(text: string): { path: string; line: number }[] {
  return [...text.matchAll(FILE_LINE)].map((m) => ({ path: m[1], line: Number(m[2]) }));
}

const isFileLine = (s: string) => {
  FILE_LINE.lastIndex = 0;
  const ok = FILE_LINE.test(s);
  FILE_LINE.lastIndex = 0;
  return ok;
};

// Inline styles nest: a code span, a file:line or a link inside **bold** (or *italic*) keeps its own style and the bold
// goes around it. The spans that must stay whole (code, file:line, links) are styled first and held behind a
// placeholder, so the bold and italic rules never see their insides (no bold inside a path like __init__.py:1) and
// pair up across them; an outer style gets the inner styled text, so its colour codes nest (chalk re-opens the outer).
const HOLD_OPEN = "\uE000";
const HOLD_CLOSE = "\uE001";
const HELD = /\uE000(\d+)\uE001/g;
const CODE_SPAN = /`([^`]+)`/g;
const LINK = /\[([^\]]+)\]\(([^)\s]+)\)/g;
const BOLD = /\*\*(?=\S)(.+?)(?<=\S)\*\*|(?<![\w\uE001])__(?=\S)(.+?)(?<=\S)__(?![\w\uE000])/g;
const ITALIC = /(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])|(?<![_\w])_([^_\s][^_]*?)_(?![_\w])/g;

function inline(text: string, p: Paint): string {
  const held: string[] = [];
  const hold = (s: string) => `${HOLD_OPEN}${held.push(s) - 1}${HOLD_CLOSE}`;
  const open = (s: string): string => s.replace(HELD, (_, i: string) => open(held[Number(i)]));
  let t = text.replace(CODE_SPAN, (_, inner: string) => hold(isFileLine(inner) ? p.strong("path", inner) : p.code(inner)));
  FILE_LINE.lastIndex = 0;
  t = t.replace(FILE_LINE, (m: string) => hold(p.strong("path", m)));
  t = t.replace(LINK, (_, x: string, u: string) => hold(x === u ? p.strong("link", u) : `${p.strong("link", open(x))} ${p.meta(`(${u})`)}`));
  const italic = (s: string) => s.replace(ITALIC, (_, a?: string, b?: string) => hold(p.italic(open(a ?? b ?? ""))));
  t = t.replace(BOLD, (_, a?: string, b?: string) => hold(p.bold(open(italic(a ?? b ?? "")))));
  return open(italic(t));
}

const BULLETS = ["•", "◦", "▪", "·"];

/** Column widths that fit `target`: the widest shrinks first, then the most cramped grows (xal's fitColumns). */
export function fitColumns(natural: number[], target: number): number[] {
  const widths = natural.map((w) => Math.max(1, w));
  let total = widths.reduce((a, b) => a + b, 0);
  while (total > target) {
    const i = widths.indexOf(Math.max(...widths));
    if (widths[i] <= 1) break;
    widths[i] -= 1;
    total -= 1;
  }
  return widths;
}

/** A table in a box that fits `width`: a cell longer than its column folds onto more lines of its row (never cut). */
function table(rows: string[][], p: Paint, width: number): string[] {
  const count = Math.max(...rows.map((r) => r.length));
  const cells = rows.map((r, i) => Array.from({ length: count }, (_, c) => (i === 0 ? p.strong("heading", inline(r[c] ?? "", PLAIN)) : inline(r[c] ?? "", p))));
  const natural = Array.from({ length: count }, (_, c) => Math.max(...cells.map((r) => stringWidth(r[c]))));
  const widths = fitColumns(natural, Math.max(count, width - (3 * count + 1)));
  const fold = (s: string, w: number) => (s ? wrapAnsi(s, w, { hard: true, trim: true }).split("\n") : [""]);
  const pad = (s: string, w: number) => s + " ".repeat(Math.max(0, w - stringWidth(s)));
  const rule = (l: string, j: string, r: string) => p.border(l + widths.map((w) => "─".repeat(w + 2)).join(j) + r);
  const row = (r: string[]): string[] => {
    const parts = r.map((c, i) => fold(c, widths[i]));
    const h = Math.max(...parts.map((x) => x.length));
    return Array.from({ length: h }, (_, k) => p.border("│") + parts.map((x, i) => ` ${pad(x[k] ?? "", widths[i])} `).join(p.border("│")) + p.border("│"));
  };
  return [rule("┌", "┬", "┐"), ...row(cells[0]), rule("├", "┼", "┤"), ...cells.slice(1).flatMap(row), rule("└", "┴", "┘")];
}

const tableCells = (line: string) => line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|").map((c) => c.trim());

/** Markdown → terminal lines (joined with \n). An unclosed code block (an answer still being written) is code too. */
export function renderMarkdown(md: string, p: Paint = PLAIN, width = 100): string {
  const out: string[] = [];
  let rows: string[][] | null = null;
  const endTable = () => {
    if (rows && rows.length) out.push(...table(rows, p, width - 2).map((l) => "  " + l));
    rows = null;
  };
  let fence: { mark: string; lang: string; lines: string[] } | null = null;
  const flush = () => {
    if (!fence) return;
    highlight(fence.lines.join("\n"), fence.lang, p).forEach((l) => out.push(p.faint("  │ ") + l));
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const f = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (f && fence === null) endTable();
    if (f) {
      if (fence === null) {
        fence = { mark: f[1], lang: f[2], lines: [] };
        if (f[2]) out.push(p.faint(`  ${f[2]}`));
      } else if (f[1] === fence.mark) {
        flush();
        fence = null;
      } else fence.lines.push(line);
      continue;
    }
    if (fence !== null) {
      fence.lines.push(line);
      continue;
    }
    if (/^\s*\|.*\|\s*$/.test(line)) {
      if (/^\s*\|[\s:|-]+\|\s*$/.test(line) && rows && rows.length === 1) continue;   // the |---|---| line
      (rows ??= []).push(tableCells(line));
      continue;
    }
    endTable();
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      const text = inline(h[2].replace(/\s+#+\s*$/, ""), PLAIN);
      out.push(h[1].length <= 2 ? p.strong("heading", text) : p.bold(text));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(p.faint("─".repeat(40)));
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(p.meta("  ┃ ") + p.italic(p.detail(inline(q[1], PLAIN))));
      continue;
    }
    const li = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (li) {
      const depth = Math.min(3, Math.floor(li[1].length / 2));
      const box = li[2] === undefined ? (depth ? p.faint(BULLETS[depth]) : p.accent(BULLETS[0])) : li[2] === " " ? p.dim("☐") : p.ok("☑");
      out.push(`${li[1]}  ${box} ${inline(li[3], p)}`);
      continue;
    }
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}  ${p.accent(ol[2] + ".")} ${inline(ol[3], p)}`);
      continue;
    }
    out.push(inline(line, p));
  }
  flush();
  endTable();
  // no more than one empty line in a row, none at the ends
  const tidy: string[] = [];
  for (const l of out) if (!(l.trim() === "" && (tidy.length === 0 || tidy[tidy.length - 1].trim() === ""))) tidy.push(l);
  while (tidy.length && tidy[tidy.length - 1].trim() === "") tidy.pop();
  return tidy.join("\n");
}
