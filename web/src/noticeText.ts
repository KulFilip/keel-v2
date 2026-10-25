// 0.18.55 readable notifications: a title a person understands (one line) and at most three short lines.
// The api sends `summary` (the short lines); an older notification has only its body, so lines are made from it here,
// by whole lines and whole words ("+N more", never a cut word). The full body stays for the Inbox / the opened item.

import type { Notification as Note, NotificationType } from "./api";

export const MAX_LINES = 3;
const LINE = 80;
const MARKS = ["◆", "✓", "⤼", "✗", "▸", "•"];
const SMALL = new Set(["a", "an", "the", "of", "to", "and", "or", "in", "on", "at", "for", "with", "by", "because", "is", "are"]);

/** The mark of a notification type, shown before a title that has none. */
export const MARK: Record<NotificationType, string> = { review: "◆", budget: "◆", failed: "✗", finished: "✓", started: "▸" };

/** A snake_case id ("hand_over") as words; paths and file names stay as they are. */
export function humanize(s: string): string {
  return s.replace(/(?<![\w./])[a-z][a-z0-9]*(?:_[a-z0-9]+)+(?![\w./])/g, (m) => m.replace(/_/g, " "));
}

/** `text` on one line, at most `max` characters, cut only after a whole word, with "…". */
export function words(text: string, max = LINE): string {
  const t = text.replace(/\s+/g, " ").trim();
  if (t.length <= max) return t;
  const room = t.slice(0, max - 1);
  const cut = room.lastIndexOf(" ");
  if (cut < max / 3) return room.trimEnd() + "…";
  let kept = room.slice(0, cut).replace(/[,;:·\-— ]+$/, "");
  for (;;) {
    const last = kept.slice(kept.lastIndexOf(" ") + 1);
    if (!SMALL.has(last.toLowerCase()) || kept.length - last.length <= max / 3) break;
    kept = kept.slice(0, kept.length - last.length).replace(/[,;: ]+$/, "");
  }
  return kept + "…";
}

/** At most `max` lines; more become max-1 lines and "+N more". */
export function clip(lines: string[], max = MAX_LINES): string[] {
  const kept = lines.map((l) => words(l)).filter(Boolean);
  return kept.length <= max ? kept : [...kept.slice(0, max - 1), `+${kept.length - (max - 1)} more`];
}

/** Short lines from a markdown body: one per line or sentence, markdown marks removed. */
export function linesFromBody(body: string | null | undefined, max = MAX_LINES): string[] {
  const text = String(body ?? "")
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/`([^`]*)`/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
  const lines = text.split("\n")
    .map((l) => l.trim().replace(/^#{1,6}\s+/, "").replace(/^[-*]\s+/, "").replace(/\*\*/g, "").trim())
    .filter((l) => l && !/^-{3,}$/.test(l))
    .flatMap((l) => (l.length <= LINE ? [l] : l.split(/(?<=[.!?])\s+(?=[A-Z0-9])/).map((x) => x.trim()).filter(Boolean)));
  return clip(lines, max);
}

/** What a toast or a bell row shows: the title without its mark, the mark, and the short lines. */
export function noticeView(n: Note): { mark: string; title: string; lines: string[] } {
  const raw = humanize(String(n.title ?? "").trim()) || "keel";
  const own = MARKS.find((m) => raw.startsWith(m));
  const title = own ? raw.slice(own.length).trim() : raw;
  const lines = n.summary?.length ? clip(n.summary) : linesFromBody(n.body);
  return { mark: own ?? MARK[n.type] ?? "◆", title, lines };
}
