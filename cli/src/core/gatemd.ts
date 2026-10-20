// A gate's detail is Markdown from the engine (## headings, paragraphs, tables, a **bold** verdict, `ids` in code, and
// every diff / JSON / log in a fence). In a terminal it keeps that structure as plain text: headings bold without the
// ## marks, fence lines dropped and the code inside indented in the code role, a ```diff fence's lines coloured
// (+ green, - red, @@ and file headers quiet), **bold** without the stars, `code` without the backticks.

import type { Paint, Role } from "./theme";

type Look = Role | "bold";
type Seg = { t: string; look?: Look[] };
/** One display line: its pieces, and whether it is plain prose (painted like other gate text, "label: text"). */
export type GateLine = { segs: Seg[]; prose?: boolean };

const plainText = (l: GateLine) => l.segs.map((s) => s.t).join("");

/** `**bold**` and `` `code` `` inside a line, as pieces without their marks. */
function inline(text: string, base: Look[] = []): Seg[] {
  const out: Seg[] = [];
  const re = /`([^`]+)`|\*\*([^*]+)\*\*/g;
  let last = 0;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text))) {
    if (m.index > last) out.push({ t: text.slice(last, m.index), look: base });
    out.push(
      m[1] !== undefined
        ? { t: m[1], look: [...base, "code"] }
        : { t: m[2], look: [...base, "bold"] },
    );
    last = m.index + m[0].length;
  }
  if (last < text.length) out.push({ t: text.slice(last), look: base });
  return out;
}

/** A table row's cells (split on unescaped `|`; `\|` shows as `|`). */
const cells = (line: string) => {
  let t = line.trim();
  if (t.startsWith("|")) t = t.slice(1);
  if (t.endsWith("|") && !t.endsWith("\\|")) t = t.slice(0, -1);
  return t.split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|"));
};

const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

/** The detail as display lines (no colour yet). Blank lines stay (one at most in a row). */
export function gateLines(text: string): GateLine[] {
  const src = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: GateLine[] = [];
  const blank = () => {
    if (out.length && out[out.length - 1].segs.length) out.push({ segs: [] });
  };
  for (let i = 0; i < src.length; i++) {
    const line = src[i];
    const fence = line.match(/^\s*(```+|~~~+)\s*([\w+#.-]*)/);
    if (fence) {
      const diff = /^(diff|patch)$/i.test(fence[2]);
      let header = false;
      for (i++; i < src.length && !closes(src[i], fence[1]); i++) {
        const l = src[i];
        let look: Look = "code";
        if (diff) {
          const isHeader: boolean =
            /^(diff --git|index |new file mode|deleted file mode|similarity index|rename (from|to) )/.test(
              l,
            ) ||
            (l.startsWith("--- ") && (src[i + 1] ?? "").startsWith("+++ ")) ||
            (l.startsWith("+++ ") && header);
          header = l.startsWith("--- ") && isHeader;
          look =
            isHeader || l.startsWith("@@") || l.startsWith("\\")
              ? "meta"
              : l.startsWith("+")
                ? "ok"
                : l.startsWith("-")
                  ? "bad"
                  : "code";
        }
        out.push({ segs: [{ t: "  " }, { t: l, look: [look] }] });
      }
      continue;
    }
    if (!line.trim()) {
      blank();
      continue;
    }
    const h = line.match(/^#{1,6}\s+(.*?)\s*#*\s*$/);
    if (h) {
      blank();
      out.push({ segs: inline(h[1], ["bold"]) });
      continue;
    }
    if (line.trim().startsWith("|")) {
      if (/^\s*\|?\s*:?-{2,}/.test(line)) continue; // the |---|---| rule under a header
      const head = /^\s*\|?\s*:?-{2,}/.test(src[i + 1] ?? "");
      const segs: Seg[] = [];
      cells(line).forEach((c, j) => {
        if (j) segs.push({ t: " │ ", look: ["meta"] });
        segs.push(...inline(c, head ? ["bold"] : []));
      });
      out.push({ segs: [{ t: "  " }, ...segs] });
      continue;
    }
    const segs = inline(line.trimEnd());
    out.push({ segs, prose: segs.every((s) => !s.look?.length) });
  }
  while (out.length && !out[out.length - 1].segs.length) out.pop();
  return out;
}

/** One display line in colour, cut to `max` characters ("…") when given. `prose` paints a plain line (label: text). */
export function paintGateLine(
  l: GateLine,
  c: Paint,
  max?: number,
  prose?: (s: string) => string,
): string {
  let room = max ?? Infinity;
  let s = "";
  for (const seg of l.segs) {
    if (room <= 0) break;
    let t = seg.t;
    if (t.length > room) t = t.slice(0, Math.max(0, room - 1)).trimEnd() + "…";
    room -= seg.t.length;
    if (l.prose && prose) {
      s += prose(t);
      continue;
    }
    s += (seg.look ?? []).reduceRight(
      (acc, r) => (r === "bold" ? c.bold(acc) : c[r](acc)),
      t,
    );
  }
  return s;
}

/** A gate's detail as terminal lines: the structure kept, cut after about `budget` characters of text (" …"). */
export function gateDetailLines(
  text: string,
  c: Paint,
  opts: { budget?: number; prose?: (s: string) => string } = {},
): string[] {
  const lines = gateLines(text);
  const budget = opts.budget ?? Infinity;
  const out: string[] = [];
  let used = 0;
  for (const l of lines) {
    const len = plainText(l).length;
    if (used + len > budget) {
      const left = Math.max(0, budget - used);
      if (left > 20)
        out.push(
          paintGateLine(l, c, left, opts.prose),
        );
      else out.push(c.meta("…"));
      break;
    }
    used += len;
    out.push(paintGateLine(l, c, undefined, opts.prose));
  }
  return out;
}

/** The first `n` lines with text (blank ones skipped), each fitted to `width`. */
export function gateFirstLines(
  text: string,
  c: Paint,
  n: number,
  width: number,
  prose?: (s: string) => string,
): string[] {
  return gateLines(text)
    .filter((l) => plainText(l).trim())
    .slice(0, n)
    .map((l) =>
      paintGateLine(
        {
          ...l,
          segs: l.segs.map((s, j) => (j ? s : { ...s, t: s.t.trimStart() })),
        },
        c,
        width,
        prose,
      ),
    );
}
