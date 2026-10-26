// A small, safe Markdown renderer for wiki pages and agent output (no HTML passthrough): headings,
// paragraphs, lists, fenced code (highlighted, folded when long), block quotes, tables, rules, and inline
// code / bold / italic / links, and GitHub's <details><summary> fold-outs (as in keel's PR bodies). A fence closes
// only on a plain fence of the same kind at least as long (a ``` block inside a ```` block stays text).
// `file:line` in backticks shows as a citation chip. With `breaks`, a single newline inside a paragraph stays a
// line break (agents write like that). A list item indented under another is a nested list.
// With `answer` (KeelBot's answers, 0.18.38): a paragraph that starts with a bold lead-in ending in ":" or "?" is a
// small heading line, a verdict tag after it (`**Comment 1: keep x?** [valid]`) is a chip, a paragraph that starts with
// "Open items:" is a note box, and a few fixed "I did not check this" sentences ("Not verified: …", "I did not run …",
// "I changed no files.") are dimmer. Nothing else is guessed: an unknown tag stays text.

import { createContext, Fragment, useContext, type ClipboardEvent, type ReactNode } from "react";
import { codeHref, fileLink } from "../format";
import { CodeBlock, DiffView, FOLD, type FoldLabel } from "./Code";

const CITE = /^[\w@./-]+\.[\w]+:\d+(-\d+)?$/;

/** The verdict tags KeelBot may put after a lead-in or a heading, and the chip each one is. */
const VERDICTS: Record<string, string> = { valid: "valid", partly: "partly", "not valid": "bad", optional: "optional", unclear: "unclear" };
const verdictChip = (tag: string, key: number) => {
  const t = tag.trim().toLowerCase().replace(/\s+/g, " ");
  return VERDICTS[t] ? <span key={`v${key}`} className={`md-verdict ${VERDICTS[t]}`}>{t.toUpperCase()}</span> : null;
};
/** "**Lead-in:** rest" or "**Lead-in?** [tag] rest" at the very start of a paragraph. */
const LEAD = /^\*\*([^*]+?[:?])\*\*(?:\s*\[([^\]\n]+)\](?!\())?\s*(.*)$/;
/** A heading that ends with a verdict tag: "### Comment 1 [valid]". */
const HEAD_TAG = /^(.*?)\s*\[([a-z ]+)\]\s*$/i;
const CALLOUT = /^(?:\*\*)?Open items:(?:\*\*)?\s*(.*)$/i;
/** The sentences that say what KeelBot did not check or change: shown dimmer, from where they start to the line's end. */
const DIM = /(?:^|(?<=[.!?)]\s+))(?:Not verified:|Not checked(?: in the code)?:|Unverified:|I did not (?:run|check|verify|test|read|open|change)\b|I didn't (?:run|check|verify|test)\b|I changed no files\b|I made no changes\b|No files (?:were )?changed\b)/i;

/** 0.18.57 Inside this, a `file:line` chip is a link to the Code page, at `ref` when the text was made from a branch,
 *  review ref or commit (a flow's worktree branch, a reviewed PR): the link opens that file, not the work tree's.
 *  Without it a chip stays a plain chip (KeelBot's panel opens its chips itself). */
export const CiteLinks = createContext<{ ref?: string | null } | null>(null);

function Cite({ text }: { text: string }) {
  const links = useContext(CiteLinks);
  const link = links ? fileLink(text) : null;
  if (!link) return <span className="cite">{text}</span>;
  return (
    <a className="cite" href={codeHref(link.path, link.line, links?.ref)}
      title={`Open ${text}${links?.ref ? ` as ${links.ref} has it` : ""} in the Code page`}>{text}</a>
  );
}

function inline(text: string, key = 0): ReactNode[] {
  const out: ReactNode[] = [];
  // `_x_` / `__x__` are emphasis only at word boundaries (as on GitHub): snake_case_words stay as they are
  const re = /(`[^`]+`)|(\*\*[^*]+\*\*)|((?<![\p{L}\p{N}_])__[^_\s][^_]*__(?![\p{L}\p{N}_]))|(\*[^*\s][^*]*\*)|((?<![\p{L}\p{N}_])_[^_\s][^_]*_(?![\p{L}\p{N}_]))|(\[[^\]]+\]\([^)\s]+\))/gu;
  let last = 0;
  let m: RegExpExecArray | null;
  let k = key * 1000;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push(text.slice(last, m.index));
    const t = m[0];
    if (m[1]) {
      const c = t.slice(1, -1);
      out.push(CITE.test(c) ? <Cite key={k++} text={c} /> : <code key={k++}>{c}</code>);
    } else if (m[2] || m[3]) out.push(<b key={k++}>{inline(t.slice(2, -2), k)}</b>);
    else if (m[4] || m[5]) out.push(<em key={k++}>{inline(t.slice(1, -1), k)}</em>);
    else if (m[6]) {
      const mm = t.match(/^\[([^\]]+)\]\(([^)\s]+)\)$/)!;
      const href = /^(https?:|#|\/)/.test(mm[2]) ? mm[2] : undefined;
      // "//host/path" goes to another site like http:// does: open it as an outside link, not in this tab
      const outside = !!href && (href.startsWith("http") || href.startsWith("//"));
      out.push(href ? <a key={k++} href={href} target={outside ? "_blank" : undefined} rel="noreferrer">{mm[1]}</a> : <span key={k++} className="mono">{mm[1]}</span>);
    }
    last = m.index + t.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

/** Inline Markdown, with a "Not verified: …" tail dimmer (answers only; never inside a `code` span). */
function prose(text: string, key: number, answer: boolean): ReactNode[] {
  const m = answer ? DIM.exec(text) : null;
  if (!m || (text.slice(0, m.index).split("`").length - 1) % 2) return inline(text, key);
  const head = text.slice(0, m.index);
  return [...(head ? inline(head, key) : []), <span key={`d${key}`} className="md-dim">{inline(text.slice(m.index), key + 500)}</span>];
}

type ListItem = { text: string; sub: string[] };
const LIST_LINE = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const indentOf = (line: string) => line.replace(/\t/g, "    ").match(/^ */)![0].length;

/** A list from line `i`: its items, each with the lines of a list indented under it; ends at a blank or other line. */
function readList(lines: string[], i: number): { ordered: boolean; items: ListItem[]; end: number } {
  const first = lines[i].match(LIST_LINE)!;
  const base = indentOf(lines[i]);
  const items: ListItem[] = [];
  while (i < lines.length) {
    const l = lines[i];
    const m = l.match(LIST_LINE);
    const last = items[items.length - 1];
    if (m && (indentOf(l) < base + 2 || !last)) items.push({ text: m[3], sub: [] });
    else if (m) last.sub.push(l);
    else if (l.trim() && /^\s{2,}/.test(l) && last) {
      if (last.sub.length) last.sub.push(l);
      else last.text += " " + l.trim();
    } else break;
    i++;
  }
  return { ordered: /\d/.test(first[2]), items, end: i };
}

function listNode(list: { ordered: boolean; items: ListItem[] }, key: number, answer: boolean): ReactNode {
  const L = list.ordered ? "ol" : "ul";
  return (
    <L key={key}>{list.items.map((t, j) => {
      const sub = t.sub.length ? readList(t.sub, 0) : null;
      return <li key={j}>{prose(t.text, j, answer)}{sub && listNode(sub, 0, answer)}</li>;
    })}</L>
  );
}

/** A table row's cells: split on unescaped `|` only; `\|` inside a cell shows as `|`. */
const cells = (line: string) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

/** Lines joined by `<br>` (breaks) or by a space (classic Markdown). */
function joined(lines: string[], breaks: boolean, key: number, answer = false): ReactNode[] {
  if (!breaks) return prose(lines.join(" "), key, answer);
  return lines.flatMap((l, j) => (j ? [<br key={`br${j}`} />, ...prose(l, key + j, answer)] : prose(l, key, answer)));
}

const DETAILS = /^\s*<details>\s*(?:<summary>(.*?)<\/summary>)?\s*$/i;
const SUMMARY = /^\s*<summary>(.*?)<\/summary>\s*$/i;
const END_DETAILS = /^\s*<\/details>\s*$/i;

/** Does this line close a fence opened with `open` (``` or ~~~, n long)? Same char, at least as long, nothing after. */
const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

/** The fold buttons' text while folded, for code and for diff fences (the defaults say "Show all (N lines)"). */
export type FoldLabels = { code?: FoldLabel; diff?: FoldLabel };

const DIFF_LANG = /^(diff|patch)$/i;

export function Markdown({ text, breaks = false, fold = FOLD, sources = false, foldLabels, answer = false }: {
  text: string; breaks?: boolean; fold?: number; foldLabels?: FoldLabels;
  /** 0.18.38 KeelBot's answer look: lead-in headings, verdict chips, the Open items note, dimmer "not verified" lines */
  answer?: boolean;
  /** v0.15.3 each block keeps its own Markdown (data-md), so a copy can give the Markdown back (MarkdownView) */
  sources?: boolean;
}) {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: ReactNode[] = [];
  const srcs: string[] = [];
  let i = 0;
  let key = 0;
  // the lines a block came from: from where the last iteration began to where it ended
  let mark = { from: 0, n: 0 };
  const flush = () => { if (blocks.length > mark.n) srcs.push(lines.slice(mark.from, i).join("\n").trim()); };
  while (i < lines.length) {
    flush();
    mark = { from: i, n: blocks.length };
    const line = lines[i];
    if (!line.trim()) { i++; continue; }
    const det = line.match(DETAILS);
    if (det) {
      // <details><summary>…</summary> … </details>: a fold-out with Markdown inside (nested ones count)
      let summary = det[1] ?? "";
      const body: string[] = [];
      let depth = 1;
      i++;
      if (!summary && i < lines.length && SUMMARY.test(lines[i])) summary = lines[i++].match(SUMMARY)![1];
      let fenceOpen: string | null = null;
      while (i < lines.length) {
        const l = lines[i];
        const f = l.match(/^\s*(```+|~~~+)/);
        if (fenceOpen) { if (closes(l, fenceOpen)) fenceOpen = null; }
        else if (f) fenceOpen = f[1];
        else if (DETAILS.test(l)) depth++;
        else if (END_DETAILS.test(l) && --depth === 0) break;
        body.push(l);
        i++;
      }
      i++;
      blocks.push(
        <details key={key++} className="md-details">
          <summary>{inline(summary.replace(/<[^>]+>/g, "") || "Details", key)}</summary>
          <Markdown text={body.join("\n")} breaks={breaks} fold={fold} foldLabels={foldLabels} answer={answer} />
        </details>,
      );
      continue;
    }
    if (END_DETAILS.test(line) || SUMMARY.test(line)) { i++; continue; }
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      const body: string[] = [];
      const close = fence[1];
      i++;
      while (i < lines.length && !closes(lines[i], close)) body.push(lines[i++]);
      i++;
      // a ```diff / ```patch fence is a diff: green added and red removed lines, never list or italic text
      blocks.push(DIFF_LANG.test(fence[2])
        ? <DiffView key={key++} className="md-diff" diff={body.join("\n")} fold={fold} foldLabel={foldLabels?.diff} />
        : <CodeBlock key={key++} className="md-code" text={body.join("\n")} lang={fence[2]} gutter={body.length > 3} fold={fold} foldLabel={foldLabels?.code} />);
      continue;
    }
    const h = line.match(/^(#{1,6})\s+(.*)$/);
    if (h) {
      const level = Math.min(4, h[1].length);
      const Tag = `h${level}` as "h1" | "h2" | "h3" | "h4";
      const tagged = answer ? h[2].match(HEAD_TAG) : null;
      const chip = tagged ? verdictChip(tagged[2], key) : null;
      blocks.push(chip ? <Tag key={key++} className="md-tagged">{inline(tagged![1], key)} {chip}</Tag> : <Tag key={key++}>{inline(h[2], key)}</Tag>);
      i++;
      continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(line)) { blocks.push(<hr key={key++} />); i++; continue; }
    if (line.trim().startsWith("|") && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const head = cells(line);
      i += 2;
      const rows: string[][] = [];
      while (i < lines.length && lines[i].trim().startsWith("|")) rows.push(cells(lines[i++]));
      blocks.push(
        <div key={key++} className="table-wrap"><table>
          <thead><tr>{head.map((c, j) => <th key={j}>{inline(c, j)}</th>)}</tr></thead>
          <tbody>{rows.map((r, ri) => <tr key={ri}>{r.map((c, j) => <td key={j}>{inline(c, ri * 50 + j)}</td>)}</tr>)}</tbody>
        </table></div>,
      );
      continue;
    }
    if (/^\s*>/.test(line)) {
      const body: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) body.push(lines[i++].replace(/^\s*>\s?/, ""));
      blocks.push(<blockquote key={key++}>{joined(body, breaks, key)}</blockquote>);
      continue;
    }
    if (LIST_LINE.test(line)) {
      const list = readList(lines, i);
      i = list.end;
      blocks.push(listNode(list, key++, answer));
      continue;
    }
    const para: string[] = [];
    while (i < lines.length && lines[i].trim() && !/^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*([-*+]|\d+[.)])\s|\s*<\/?details>)/i.test(lines[i]) && !lines[i].trim().startsWith("|")) {
      para.push(lines[i++].trim());
    }
    if (!para.length) { para.push(lines[i++]); }
    const note = answer ? para[0].match(CALLOUT) : null;
    if (note) {
      // "Open items: …" (and a list right under it): a note box
      const rest = [note[1], ...para.slice(1)].filter((l) => l.trim());
      const list = i < lines.length && LIST_LINE.test(lines[i]) ? readList(lines, i) : null;
      if (list) i = list.end;
      blocks.push(
        <div key={key++} role="note" className="md-callout">
          <b className="md-callout-h">Open items</b>{" "}
          <div className="md-callout-b">{rest.length > 0 && <p>{joined(rest, breaks, key, answer)}</p>}{list && listNode(list, 0, answer)}</div>
        </div>,
      );
      continue;
    }
    const lead = answer ? para[0].match(LEAD) : null;
    if (lead) {
      // "**Comment 1: keep x?** [valid] Valid, …": the lead-in is a small heading line, its tag a chip
      const chip = lead[2] ? verdictChip(lead[2], key) : null;
      const first = (lead[2] && !chip ? `[${lead[2]}] ` : "") + lead[3];
      const rest = [first, ...para.slice(1)].filter((l) => l.trim());
      blocks.push(<h4 key={key++} className="md-lead">{inline(lead[1].replace(/:$/, ""), key)}{chip && " "}{chip}</h4>);
      if (rest.length) blocks.push(<p key={key++}>{joined(rest, breaks, key, answer)}</p>);
      continue;
    }
    blocks.push(<p key={key++}>{joined(para, breaks, key, answer)}</p>);
  }
  flush();
  if (sources) return <Fragment>{blocks.map((b, j) => <div key={j} className="md-src" data-md={srcs[j] ?? ""}>{b}</div>)}</Fragment>;
  return <Fragment>{blocks}</Fragment>;
}

/** v0.15.3 Markdown shown nicely that copies as Markdown: a selection over whole blocks (or more than one) copies their
 *  Markdown source; a few words inside one block copy as text; Copy Markdown copies all of it. */
export function MarkdownView({ text, fold = FOLD }: { text: string; fold?: number }) {
  const onCopy = (e: ClipboardEvent<HTMLDivElement>) => {
    const sel = window.getSelection();
    if (!sel || sel.isCollapsed) return;
    // only the blocks the selection really overlaps (a triple click ends at the start of the next block)
    const r = sel.getRangeAt(0);
    const els = [...e.currentTarget.querySelectorAll<HTMLElement>(".md-src")].filter((el) => {
      const b = document.createRange();
      b.selectNodeContents(el);
      return r.compareBoundaryPoints(Range.START_TO_END, b) > 0 && r.compareBoundaryPoints(Range.END_TO_START, b) < 0;
    });
    if (!els.length) return;
    const whole = els.length > 1 || sel.containsNode(els[0], false) || sel.toString().trim() === (els[0].textContent ?? "").trim();
    if (!whole) return;
    e.preventDefault();
    e.clipboardData.setData("text/plain", els.map((el) => el.dataset.md ?? "").join("\n\n"));
  };
  return <div className="md md-view" onCopy={onCopy}><Markdown text={text} fold={fold} sources /></div>;
}
