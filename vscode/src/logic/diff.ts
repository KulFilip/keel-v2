// Review mode's pure parts: a PR's diff as changed line ranges of the head file, the editor decoration ranges, file
// badges and where threads go. A port of the JetBrains plugin's ReviewModeLogic.kt.

import type { ReviewThread } from "../api/models";

export type ChangeKind = "added" | "modified" | "deleted";

/**
 * One changed block of a file, in the head (new) file's 1-based lines. added / modified: lines start..end.
 * deleted: nothing left on the head side; the removed lines sat just before line `start` (end = start - 1).
 * oldStart..oldEnd are the base lines it replaced (empty for added: oldEnd = oldStart - 1).
 */
export interface ChangeRange {
  kind: ChangeKind;
  start: number;
  end: number;
  oldStart: number;
  oldEnd: number;
  oldLines: string[];
  newLines: string[];
}

const HUNK_HEAD = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;

/** A unified diff (keel's review diff, or `git diff base...HEAD -- path`) as changed blocks of the head file. */
export function prChangeRanges(diff: string): ChangeRange[] {
  const out: ChangeRange[] = [];
  let removed: [number, string][] = [];
  let added: [number, string][] = [];
  let nextNew = 1;
  let nextOld = 1;
  let inHunk = false;
  const flush = () => {
    if (!removed.length && !added.length) return;
    const oldStart = removed.length ? removed[0][0] : nextOld;
    const oldEnd = removed.length
      ? removed[removed.length - 1][0]
      : oldStart - 1;
    if (!added.length) {
      out.push({
        kind: "deleted",
        start: nextNew,
        end: nextNew - 1,
        oldStart,
        oldEnd,
        oldLines: removed.map((x) => x[1]),
        newLines: [],
      });
    } else {
      out.push({
        kind: removed.length ? "modified" : "added",
        start: added[0][0],
        end: added[added.length - 1][0],
        oldStart,
        oldEnd,
        oldLines: removed.map((x) => x[1]),
        newLines: added.map((x) => x[1]),
      });
    }
    removed = [];
    added = [];
  };
  for (const raw0 of diff.split("\n")) {
    const raw = raw0.endsWith("\r") ? raw0.slice(0, -1) : raw0;
    const h = HUNK_HEAD.exec(raw);
    if (h) {
      flush();
      nextOld = Number(h[1]);
      nextNew = Number(h[2]);
      inHunk = true;
      continue;
    }
    if (!inHunk) continue;
    if (raw.startsWith("diff --git")) {
      flush();
      inHunk = false;
    } else if (raw.startsWith("+")) {
      added.push([nextNew++, raw.slice(1)]);
    } else if (raw.startsWith("-")) {
      if (added.length) flush(); // a new block: unified diffs list a block's removals first
      removed.push([nextOld++, raw.slice(1)]);
    } else if (raw.startsWith("\\")) {
      // "\ No newline at end of file"
    } else {
      flush();
      nextOld++;
      nextNew++;
    }
  }
  flush();
  return out;
}

/** Whether a head line (1-based) belongs to a block; a removal belongs to the lines around its gap. */
export function touches(r: ChangeRange, line: number): boolean {
  return r.kind === "deleted"
    ? line === r.start || line === r.start - 1
    : line >= r.start && line <= r.end;
}

/** The block a head line (1-based) is in, if any. */
export function rangeAt(
  ranges: ChangeRange[],
  line: number,
): ChangeRange | undefined {
  return (
    ranges.find(
      (r) => r.kind !== "deleted" && line >= r.start && line <= r.end,
    ) ?? ranges.find((r) => touches(r, line))
  );
}

/** A whole-line span of an editor, 0-based and inclusive. */
export interface LineSpan {
  start: number;
  end: number;
}

/** The editor decorations of a file's blocks: 0-based line spans, clamped to the document. */
export interface DecorationRanges {
  added: LineSpan[];
  modified: LineSpan[];
  /** the 0-based line a removal marker goes on (the line after the gap, or the last line at the end of the file) */
  deleted: number[];
}

export function decorationRanges(
  ranges: ChangeRange[],
  lineCount: number,
): DecorationRanges {
  const out: DecorationRanges = { added: [], modified: [], deleted: [] };
  if (lineCount <= 0) return out;
  const last = lineCount - 1;
  for (const r of ranges) {
    if (r.kind === "deleted") {
      out.deleted.push(Math.min(Math.max(r.start - 1, 0), last));
      continue;
    }
    const s = r.start - 1;
    if (s > last) continue; // past the end: the file on disk is not the PR's head
    const span = { start: Math.max(0, s), end: Math.min(r.end - 1, last) };
    (r.kind === "added" ? out.added : out.modified).push(span);
  }
  out.deleted = [...new Set(out.deleted)].sort((a, b) => a - b);
  return out;
}

/** The next block after a 1-based line (wraps to the first); undefined when the file has none. */
export function nextRange(
  ranges: ChangeRange[],
  line: number,
): ChangeRange | undefined {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  return sorted.find((r) => r.start > line) ?? sorted[0];
}

/** A changed file's badge. */
export type PrFileStatus = "new" | "modified" | "renamed" | "deleted";

/** The host's file status (GitHub: added, modified, removed, renamed, copied, changed; git: A, M, D, R, C). */
export function prFileStatusOf(
  status: string | null | undefined,
): PrFileStatus {
  const s = (status ?? "").trim().toLowerCase();
  if (["added", "a", "new", "copied", "c"].includes(s)) return "new";
  if (["removed", "deleted", "d"].includes(s)) return "deleted";
  if (s === "renamed" || s.startsWith("r")) return "renamed";
  return "modified";
}

/** Where a file's review threads go in a normal editor: on their head line, or at the top as a note. */
export interface ThreadPlaces {
  inline: { line: number; thread: ReviewThread }[];
  top: ReviewThread[];
}

/**
 * A thread sits on its head line (RIGHT side) when the line still exists. Outdated threads, comments on removed lines
 * (LEFT side) and lines past the end of the file go to the top of the file.
 */
export function placeThreads(
  threads: ReviewThread[],
  path: string,
  lineCount: number,
): ThreadPlaces {
  const mine = threads.filter((t) => t.path === path);
  const inline: ThreadPlaces["inline"] = [];
  const top: ReviewThread[] = [];
  for (const t of mine) {
    if (
      !t.outdated &&
      t.side !== "LEFT" &&
      t.line != null &&
      t.line >= 1 &&
      t.line <= lineCount
    )
      inline.push({ line: t.line, thread: t });
    else top.push(t);
  }
  inline.sort((a, b) => a.line - b.line);
  return { inline, top };
}

/** The text KeelBot gets for "Ask KeelBot what changed here". */
export function askWhatChanged(
  path: string,
  r: ChangeRange,
  pr: number | null | undefined,
): string {
  const where =
    r.kind === "deleted"
      ? `${path} (removed before line ${r.start})`
      : r.start === r.end
        ? `${path}:${r.start}`
        : `${path}:${r.start}-${r.end}`;
  let s = "What changed here";
  if (pr != null) s += ` in PR #${pr}`;
  s += `, and why might it matter? @${where}\n` + "```diff\n";
  for (const l of r.oldLines) s += `-${l}\n`;
  for (const l of r.newLines) s += `+${l}\n`;
  return s + "```\n";
}

/** "line 4", "lines 4–9", "lines removed before line 4". */
export function rangeLabel(r: ChangeRange): string {
  if (r.kind === "deleted") return `lines removed before line ${r.start}`;
  return r.start === r.end ? `line ${r.start}` : `lines ${r.start}–${r.end}`;
}
