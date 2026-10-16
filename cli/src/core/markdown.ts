// Markdown for the terminal: KeelBot's answers (and keel's own texts) as styled lines. No UI: it returns text with
// ANSI styles from a Style (chalk by default; `plain` for none), so any terminal front end can print it.
//
//   # Heading         bold, underlined         **bold**  *italic*  `code`
//   - item / 1. item  "  • item"               [text](url) → text (url)
//   ```code```        "  │ line" in a colour    > quote → "  ┃ quote"
//   path/file.ts:12   marked as a file link (FILE_LINE): the person can open it in the editor or the dashboard

import chalk from "chalk";

export type Style = {
  bold: (s: string) => string; italic: (s: string) => string; dim: (s: string) => string; code: (s: string) => string;
  heading: (s: string) => string; link: (s: string) => string; file: (s: string) => string; quote: (s: string) => string;
};

export const ansi: Style = {
  bold: (s) => chalk.bold(s), italic: (s) => chalk.italic(s), dim: (s) => chalk.dim(s), code: (s) => chalk.cyan(s),
  heading: (s) => chalk.bold.underline(s), link: (s) => chalk.blue.underline(s), file: (s) => chalk.cyan.underline(s),
  quote: (s) => chalk.dim.italic(s),
};
const id = (s: string) => s;
export const plain: Style = { bold: id, italic: id, dim: id, code: id, heading: id, link: id, file: id, quote: id };

/** path/to/file.ext:line[:col] — the same shape keel's web links (web fileLink). */
export const FILE_LINE = /(?<![\w/.-])((?:[\w.-]+\/)*[\w.-]+\.[A-Za-z][\w]{0,7}):(\d+)(?::(\d+))?(?![\w])/g;

/** Every file:line in a text, in order: for "open in the editor" and tests. */
export function fileLines(text: string): { path: string; line: number }[] {
  return [...text.matchAll(FILE_LINE)].map((m) => ({ path: m[1], line: Number(m[2]) }));
}

function inline(text: string, st: Style): string {
  // code spans first: their insides stay as they are
  const parts = text.split(/(`[^`]+`)/g);
  return parts.map((p) => {
    if (p.length > 1 && p.startsWith("`") && p.endsWith("`")) {
      const inner = p.slice(1, -1);
      return FILE_LINE.test(inner) ? (FILE_LINE.lastIndex = 0, st.file(inner)) : (FILE_LINE.lastIndex = 0, st.code(inner));
    }
    return p
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t: string, u: string) => (t === u ? st.link(u) : `${t} (${st.link(u)})`))
      .replace(/\*\*([^*]+)\*\*|__([^_]+)__/g, (_, a?: string, b?: string) => st.bold(a ?? b ?? ""))
      .replace(/(?<![*\w])\*([^*\s][^*]*?)\*(?![*\w])|(?<![_\w])_([^_\s][^_]*?)_(?![_\w])/g, (_, a?: string, b?: string) => st.italic(a ?? b ?? ""))
      .replace(FILE_LINE, (m) => st.file(m));
  }).join("");
}

/** Markdown → terminal lines (joined with \n). */
export function renderMarkdown(md: string, st: Style = ansi): string {
  const out: string[] = [];
  let fence: string | null = null;
  for (const raw of md.replace(/\r\n?/g, "\n").split("\n")) {
    const line = raw.replace(/\t/g, "  ");
    const f = /^\s*(```|~~~)\s*([\w+-]*)\s*$/.exec(line);
    if (f) {
      if (fence === null) {
        fence = f[1];
        if (f[2]) out.push(st.dim(`  ${f[2]}`));
      } else if (f[1] === fence) fence = null;
      continue;
    }
    if (fence !== null) {
      out.push(st.dim("  │ ") + st.code(line));
      continue;
    }
    const h = /^(#{1,6})\s+(.*)$/.exec(line);
    if (h) {
      out.push(st.heading(inline(h[2].replace(/\s+#+\s*$/, ""), st)));
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
      out.push(st.dim("─".repeat(40)));
      continue;
    }
    const q = /^\s*>\s?(.*)$/.exec(line);
    if (q) {
      out.push(st.dim("  ┃ ") + st.quote(inline(q[1], st)));
      continue;
    }
    const li = /^(\s*)[-*+]\s+(?:\[( |x|X)\]\s+)?(.*)$/.exec(line);
    if (li) {
      const box = li[2] === undefined ? "•" : li[2] === " " ? "☐" : "☑";
      out.push(`${li[1]}  ${box} ${inline(li[3], st)}`);
      continue;
    }
    const ol = /^(\s*)(\d+)[.)]\s+(.*)$/.exec(line);
    if (ol) {
      out.push(`${ol[1]}  ${ol[2]}. ${inline(ol[3], st)}`);
      continue;
    }
    out.push(inline(line, st));
  }
  // no more than one empty line in a row, none at the ends
  const tidy: string[] = [];
  for (const l of out) if (!(l.trim() === "" && (tidy.length === 0 || tidy[tidy.length - 1].trim() === ""))) tidy.push(l);
  while (tidy.length && tidy[tidy.length - 1].trim() === "") tidy.pop();
  return tidy.join("\n");
}
