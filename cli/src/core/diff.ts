// A unified diff in a terminal: each line with its line number (the new file's; the old file's for a removed line),
// added lines green, removed red, hunk headers amber, file headers faint.
//
// classifyDiff is adapted from xal (https://github.com/xal-sh/xal, apps/cli/src/plugins/tui/output/diff.ts),
// MIT License, Copyright (c) 2026 Saeed Vaziry. See cli/THIRD_PARTY_NOTICES.md.

import type { Paint } from "./theme";

export type DiffKind = "plain" | "faint" | "added" | "removed" | "hunk";
export type DiffLine = { number: string; text: string; kind: DiffKind };

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/;
const FILE_HEADER = /^(?:diff |index |--- |\+\+\+ |old mode |new mode |new file |deleted file |similarity |rename |Binary files )/;

export function classifyDiff(lines: string[]): DiffLine[] {
  const out: DiffLine[] = [];
  let oldLine: number | undefined;
  let newLine: number | undefined;
  const num = (v: number | undefined) => (v === undefined ? "" : String(v));
  for (const line of lines) {
    const hunk = HUNK.exec(line);
    if (hunk) {
      oldLine = Number(hunk[1]);
      newLine = Number(hunk[2]);
      out.push({ number: "", text: line, kind: "hunk" });
    } else if (FILE_HEADER.test(line)) {
      oldLine = newLine = undefined;
      out.push({ number: "", text: line, kind: "faint" });
    } else if (line.startsWith("-")) {
      out.push({ number: num(oldLine), text: line, kind: "removed" });
      if (oldLine !== undefined) oldLine += 1;
    } else if (line.startsWith("+")) {
      out.push({ number: num(newLine), text: line, kind: "added" });
      if (newLine !== undefined) newLine += 1;
    } else if (line.startsWith(" ") || line === "") {
      out.push({ number: num(newLine), text: line, kind: "plain" });
      if (oldLine !== undefined) oldLine += 1;
      if (newLine !== undefined) newLine += 1;
    } else out.push({ number: "", text: line, kind: line.startsWith("\\") ? "plain" : "faint" });
  }
  return out;
}

/** The diff's lines, each with a 4-column line-number gutter when the diff has hunks. */
export function renderDiff(text: string, p: Paint): string[] {
  const lines = classifyDiff(text.split("\n"));
  const gutter = lines.some((l) => l.number);
  return lines.map((l) => {
    const n = gutter ? p.faint((l.number || "").padStart(4) + " ") : "";
    const body = l.kind === "added" ? p.add(l.text) : l.kind === "removed" ? p.del(l.text) : l.kind === "hunk" ? p.warn(l.text)
      : l.kind === "faint" ? p.faint(l.text) : p.dim(l.text);
    return n + body;
  });
}
