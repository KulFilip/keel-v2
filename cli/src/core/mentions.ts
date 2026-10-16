// What the person points KeelBot at, and what they paste. No UI: keel TUI's prompt uses it, another front end can too.
//
//   @src/app.ts       a file of the project (GET …/repo/files, as the dashboard's KeelBot @)
//   @ScoreService     a symbol of the code graph (GET …/graph/search)
//   @AC-2             a criterion of the project's flow
//   a paste of many lines → "[pasted 120 lines #1]" in the prompt; the whole text goes to KeelBot
//   an image (a pasted path to a .png …) → "[image shot.png #2]"; KeelBot takes no images yet, so it gets the path

import { kb } from "../../../plugins/keelbot/web/keelbotApi";
import type { HelperMention } from "./sdk";

export type MentionKind = "file" | "symbol" | "ac";
export type MentionItem = { kind: MentionKind; value: string; label: string; hint?: string; file?: string; line?: number };

/** A fuzzy score: every query letter in order (higher is better), a bonus for a match at the start of a word or the
 *  file name, and for letters next to each other; null when not every letter is there. */
export function fuzzy(query: string, text: string): number | null {
  if (!query) return 0;
  const q = query.toLowerCase();
  const t = text.toLowerCase();
  let score = 0;
  let at = -1;
  let prev = -2;
  const base = t.lastIndexOf("/") + 1;
  for (const ch of q) {
    const i = t.indexOf(ch, at + 1);
    if (i < 0) return null;
    score += 1;
    if (i === prev + 1) score += 3;                                   // next to the one before
    if (i === 0 || i === base || /[/_.\-\s]/.test(t[i - 1] ?? "")) score += 2;   // the start of a word or of the name
    if (i >= base) score += 1;                                        // in the file's own name
    prev = i;
    at = i;
  }
  return score - Math.max(0, t.length - q.length) * 0.01;
}

/** The best matches of `query` among `items` (by their value), at most `max`. */
export function rank(query: string, items: MentionItem[], max = 8): MentionItem[] {
  return items
    .map((it) => ({ it, s: fuzzy(query, it.value) }))
    .filter((x): x is { it: MentionItem; s: number } => x.s !== null)
    .sort((a, b) => b.s - a.s || a.it.value.length - b.it.value.length || a.it.value.localeCompare(b.it.value))
    .slice(0, max)
    .map((x) => x.it);
}

/** The `@query` being typed at the end of the line, or null. */
export function typingMention(line: string): { query: string; start: number } | null {
  const m = /(^|\s)@([^\s@]*)$/.exec(line);
  return m ? { query: m[2], start: line.length - m[2].length - 1 } : null;
}

/** Where mentions come from: the project's files (asked once), the code graph (asked as the person types) and the
 *  flow's criteria. */
export class Mentions {
  private files: string[] | null = null;
  private symbols = new Map<string, MentionItem>();
  constructor(private pid: () => string | null, private acs: () => { id: string; title: string }[]) {}

  async load(): Promise<void> {
    const pid = this.pid();
    if (!pid || this.files) return;
    this.files = (await kb.repoFiles(pid).catch(() => ({ files: [] as string[] }))).files;
  }

  reset() {
    this.files = null;
    this.symbols.clear();
  }

  /** Candidates for `@query`: criteria first when the query looks like one, then files and symbols. */
  async complete(query: string, max = 8): Promise<MentionItem[]> {
    await this.load();
    const acs: MentionItem[] = this.acs().map((a) => ({ kind: "ac", value: a.id, label: `@${a.id}`, hint: a.title }));
    const files: MentionItem[] = (this.files ?? []).map((f) => ({ kind: "file", value: f, label: `@${f}`, hint: "file" }));
    const pid = this.pid();
    if (pid && query.length >= 2 && !query.includes("/") && !query.includes(".")) {
      const hits = await kb.graphSearch(pid, query).catch(() => ({ available: false, results: [] }));
      for (const h of hits.results ?? []) {
        this.symbols.set(h.name, { kind: "symbol", value: h.name, label: `@${h.name}`, hint: `${h.kind} · ${h.file}:${h.line}`, file: h.file, line: h.line });
      }
    }
    const pool = [...acs, ...rank(query, files, 40), ...this.symbols.values()];
    return rank(query, pool, max);
  }

  /** The mentions in a line the person sends: each @word that is a known file, symbol or criterion. */
  mentionsIn(text: string): HelperMention[] {
    const files = new Set(this.files ?? []);
    const acs = new Set(this.acs().map((a) => a.id));
    const out: HelperMention[] = [];
    for (const m of text.matchAll(/(?:^|\s)@([^\s@]+)/g)) {
      const v = m[1].replace(/[.,;:!?)]+$/, "");
      if (acs.has(v)) out.push({ kind: "ac", value: v });
      else if (files.has(v)) out.push({ kind: "file", value: v });
      else if (this.symbols.has(v)) {
        const s = this.symbols.get(v)!;
        out.push({ kind: "symbol", value: v, file: s.file, line: s.line });
      }
    }
    return out.filter((x, i, all) => all.findIndex((y) => y.kind === x.kind && y.value === x.value) === i);
  }
}

// ------------------------------------------------------------------ paste

export type Pasted = { n: number; kind: "text" | "image"; text: string; lines: number; name?: string };

/** A dropped or pasted image file: an absolute, ~ or ./ path (or a file:// url) to a picture, on one line. */
const IMAGE = /^(?:file:\/\/)?((?:~|\.{1,2})?\/[^\n]*?([^/\n]+\.(png|jpe?g|gif|webp|bmp|heic|tiff?)))$/i;
/** A paste is kept whole behind a short placeholder when it has more than this many lines or characters. */
export const PASTE_LINES = 3;
export const PASTE_CHARS = 400;

/** A chunk of input that is a paste, not typing: more than one line, a long text, or a dropped image path. */
export function isPaste(chunk: string): boolean {
  if (chunk.length < 2) return false;
  return /[\r\n]/.test(chunk.replace(/[\r\n]+$/, "")) || chunk.length >= PASTE_CHARS || IMAGE.test(chunk.trim().replace(/\\ /g, " "));
}

/** The pastes of one prompt: what the placeholders stand for. */
export class Pastes {
  private items: Pasted[] = [];
  private next = 1;

  /** What to put in the prompt for a pasted chunk: the text itself (short), or a placeholder. */
  add(raw: string): { insert: string; pasted?: Pasted } {
    const text = raw.replace(/\r\n?/g, "\n").replace(/\x1b\[20[01]~/g, "");
    const one = text.trim();
    const img = IMAGE.exec(one.replace(/\\ /g, " "));
    if (img && !one.includes("\n")) {
      const p: Pasted = { n: this.next++, kind: "image", text: img[1], lines: 1, name: img[2] };
      this.items.push(p);
      return { insert: `[image ${p.name} #${p.n}]`, pasted: p };
    }
    const lines = text.split("\n").length;
    if (lines <= PASTE_LINES && text.length <= PASTE_CHARS) return { insert: text.replace(/\n/g, " ") };
    const p: Pasted = { n: this.next++, kind: "text", text, lines };
    this.items.push(p);
    return { insert: `[pasted ${lines} lines #${p.n}]`, pasted: p };
  }

  /** The line with each placeholder replaced by what it stands for (an image: its path, with a note for KeelBot). */
  expand(line: string): { text: string; images: Pasted[] } {
    const images: Pasted[] = [];
    const text = line.replace(/\[(pasted \d+ lines|image [^\]#]+) #(\d+)\]/g, (whole, _w: string, n: string) => {
      const p = this.items.find((x) => x.n === Number(n));
      if (!p) return whole;
      if (p.kind === "image") {
        images.push(p);
        return `(an image at ${p.text})`;
      }
      return `\n${p.text}\n`;
    });
    return { text: text.trim(), images };
  }

  clear() {
    this.items = [];
    this.next = 1;
  }

  get size() {
    return this.items.length;
  }
}
