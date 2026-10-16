// Markdown for the terminal: KeelBot's answers (and keel's own texts) as styled lines, in keel's colours. No UI: it
// returns text with ANSI styles from a Paint (theme.ts; PLAIN for none), so any terminal front end can print it.
//
//   # Heading         accent, bold                **bold**  *italic*  `code` (tinted)
//   - item / 1. item  "  • item" (accent bullet)  [text](url) → text (url)
//   ```lang code```   highlighted by language (highlight.js, the web's highlighter), a diff green and red
//   > quote           "  ┃ quote"                 path/file.ts:12 → a file link (FILE_LINE)

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

// a code span, or a file:line: both are kept as they are (no bold or italic inside a path like __init__.py:1)
const SPANS = /(`[^`]+`)|(\*\*)?((?<![\w/.-])(?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,7}:\d+(?::\d+)?(?![\w]))(\*\*)?/g;

function inline(text: string, p: Paint): string {
  let out = "";
  let i = 0;
  for (const m of text.matchAll(SPANS)) {
    out += prose(text.slice(i, m.index), p);
    if (m[1]) {
      const inner = m[1].slice(1, -1);
      out += isFileLine(inner) ? p.underline(p.run(inner)) : p.kw(inner);
    } else {
      // **path:line** is a bold link; a lone ** next to a path stays as it was written
      const link = p.underline(p.run(m[3]));
      out += m[2] && m[4] ? p.bold(link) : (m[2] ?? "") + link + (m[4] ?? "");
    }
    i = (m.index ?? 0) + m[0].length;
  }
  return out + prose(text.slice(i), p);
}

function prose(t: string, p: Paint): string {
  return t
    .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, x: string, u: string) => (x === u ? p.underline(p.run(u)) : `${x} (${p.underline(p.run(u))})`))
    .replace(/\*\*([^*]+)\*\*|(?<!\w)__([^_]+)__(?!\w)/g, (_, a?: string, b?: string) => p.bold(a ?? b ?? ""))
    .replace(/(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])|(?<![_\w])_([^_\s][^_]*?)_(?![_\w])/g, (_, a?: string, b?: string) => p.italic(a ?? b ?? ""));
}

/** Markdown → terminal lines (joined with \n). An unclosed code block (an answer still being written) is code too. */
export function renderMarkdown(md: string, p: Paint = PLAIN): string {
  const out: string[] = [];
  let fence: { mark: string; lang: string; lines: string[] } | null = null;
  const flush = () => {
    if (!fence) return;
    highlight(fence.lines.join("\n"), fence.lang, p).forEach((l) => out.push(p.faint("  │ ") + l));
  };
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const f = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
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
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(p.bold(p.accent(inline(h[2].replace(/\s+#+\s*$/, ""), PLAIN))));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(p.faint("─".repeat(40)));
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(p.faint("  ┃ ") + p.italic(p.dim(inline(q[1], p))));
      continue;
    }
    const li = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (li) {
      const box = li[2] === undefined ? p.accent("•") : li[2] === " " ? p.dim("☐") : p.ok("☑");
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
  // no more than one empty line in a row, none at the ends
  const tidy: string[] = [];
  for (const l of out) if (!(l.trim() === "" && (tidy.length === 0 || tidy[tidy.length - 1].trim() === ""))) tidy.push(l);
  while (tidy.length && tidy[tidy.length - 1].trim() === "") tidy.pop();
  return tidy.join("\n");
}
