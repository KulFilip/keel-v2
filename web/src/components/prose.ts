// Readable step text: a workflow step's instructions are often one folded paragraph (YAML `>-`) with run-on lists in it
// ("It starts with the six sections a reader scans first: In plain words (…), For engineers (…), What will change (…)").
// listify() turns only that clear shape into Markdown bullets; anything else stays as it was. No React here.

/** Is `i` inside (…) in `s`? Depth of round brackets before index i. */
function depthAt(s: string, i: number): number {
  let d = 0;
  for (let j = 0; j < i; j++) {
    if (s[j] === "(") d++;
    else if (s[j] === ")") d = Math.max(0, d - 1);
  }
  return d;
}

/** `s` split on `sep` where it is outside brackets. */
function splitTop(s: string, sep: string): string[] {
  const out: string[] = [];
  let d = 0;
  let from = 0;
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c === "(") d++;
    else if (c === ")") d = Math.max(0, d - 1);
    else if (d === 0 && s.startsWith(sep, i)) {
      out.push(s.slice(from, i));
      from = i + sep.length;
      i += sep.length - 1;
    }
  }
  out.push(s.slice(from));
  return out;
}

/** The index of the end of the sentence that starts at `from` (a "." outside brackets, then a space or the end). */
function sentenceEnd(s: string, from: number): number {
  let d = depthAt(s, from);
  for (let i = from; i < s.length; i++) {
    const c = s[i];
    if (c === "(") d++;
    else if (c === ")") d = Math.max(0, d - 1);
    else if (
      d === 0 &&
      c === "." &&
      (i + 1 === s.length || /\s/.test(s[i + 1]))
    )
      return i;
  }
  return s.length;
}

/** One list item: "Name (what it holds)" — a short name that starts with a capital, then one bracket group to its end. */
const ITEM = /^(?:and\s+)?([A-Z][^(),:;]{0,48}?)\s+(\(.*\))$/s;

/** A bracket group that closes where the item ends (no "(a) b (c)" items). */
function oneGroup(g: string): boolean {
  let d = 0;
  for (let i = 0; i < g.length; i++) {
    if (g[i] === "(") d++;
    else if (g[i] === ")" && --d === 0 && i !== g.length - 1) return false;
  }
  return d === 0;
}

/** One paragraph (no newlines): each "lead: Item (…), Item (…), Item (…)." becomes the lead, a bullet list, then the rest. */
function listifyParagraph(p: string): string {
  let i = 0;
  while (i < p.length) {
    const colon = p.indexOf(": ", i);
    if (colon < 0) break;
    if (depthAt(p, colon) > 0) {
      i = colon + 2;
      continue;
    }
    const start = colon + 2;
    const end = sentenceEnd(p, start);
    const parts = splitTop(p.slice(start, end), ", ").map((x) => x.trim());
    const items = parts.map((x) => x.match(ITEM));
    if (parts.length >= 3 && items.every((m) => m && oneGroup(m[2]))) {
      const lead = p.slice(0, colon + 1).trim();
      const list = items
        .map((m) => `- **${m![1].trim()}** ${m![2]}`)
        .join("\n");
      const rest = p.slice(end + 1).trim();
      return `${lead}\n\n${list}${rest ? `\n\n${listifyParagraph(rest)}` : ""}`;
    }
    i = colon + 2;
  }
  return p;
}

/** Markdown text with its run-on "lead: A (…), B (…), C (…)." lists as bullets. Fenced code, lists, headings, quotes and
 *  tables are left as they are; so is any sentence that does not have that exact shape (3 or more items, each a short
 *  capitalised name and one bracket group). */
export function listify(text: string): string {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  let fence: string | null = null;
  for (const line of lines) {
    const f = line.match(/^\s*(```+|~~~+)/);
    if (fence) {
      out.push(line);
      if (f && line.trim().startsWith(fence)) fence = null;
      continue;
    }
    if (f) {
      fence = f[1];
      out.push(line);
      continue;
    }
    if (!line.trim() || /^\s*(#{1,6}\s|[-*+]\s|\d+[.)]\s|>|\|)/.test(line)) {
      out.push(line);
      continue;
    }
    out.push(listifyParagraph(line));
  }
  return out.join("\n");
}
