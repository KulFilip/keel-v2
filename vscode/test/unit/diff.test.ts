import { describe, expect, it } from "vitest";
import { askWhatChanged, decorationRanges, nextRange, placeThreads, prChangeRanges, prFileStatusOf, rangeAt } from "../../src/logic/diff";

const DIFF = [
  "diff --git a/src/cart.ts b/src/cart.ts",
  "--- a/src/cart.ts",
  "+++ b/src/cart.ts",
  "@@ -1,6 +1,7 @@",
  " import { Item } from './item';",
  "-export const TAX = 0.2;",
  "+export const TAX = 0.21;",
  " ",
  "+// totals in cents",
  " export function total(items: Item[]) {",
  "-  let sum = 0;",
  "   return items.reduce((s, i) => s + i.price, 0);",
  "@@ -20,3 +21,4 @@",
  " }",
  "+export const SHOPS = 'SHOPS-1234';",
  "\\ No newline at end of file",
].join("\n");

describe("diff → change ranges", () => {
  const ranges = prChangeRanges(DIFF);

  it("finds modified, added and deleted blocks in head lines", () => {
    expect(ranges.map((r) => [r.kind, r.start, r.end])).toEqual([
      ["modified", 2, 2],
      ["added", 4, 4],
      ["deleted", 6, 5],
      ["added", 22, 22],
    ]);
    expect(ranges[0].oldLines).toEqual(["export const TAX = 0.2;"]);
    expect(ranges[0].newLines).toEqual(["export const TAX = 0.21;"]);
    expect(ranges[2].oldLines).toEqual(["  let sum = 0;"]);
  });

  it("maps to 0-based decoration spans, removal markers and clamps to the document", () => {
    const d = decorationRanges(ranges, 22);
    expect(d.modified).toEqual([{ start: 1, end: 1 }]);
    expect(d.added).toEqual([
      { start: 3, end: 3 },
      { start: 21, end: 21 },
    ]);
    expect(d.deleted).toEqual([5]);
    const short = decorationRanges(ranges, 10);
    expect(short.added).toEqual([{ start: 3, end: 3 }]); // line 22 is past the end of a 10-line file
    expect(decorationRanges(ranges, 0)).toEqual({ added: [], modified: [], deleted: [] });
  });

  it("a removal at the end of the file marks the last line", () => {
    const r = prChangeRanges("@@ -1,3 +1,2 @@\n a\n b\n-c\n");
    expect(r).toEqual([{ kind: "deleted", start: 3, end: 2, oldStart: 3, oldEnd: 3, oldLines: ["c"], newLines: [] }]);
    expect(decorationRanges(r, 2).deleted).toEqual([1]);
  });

  it("finds the block of a line and the next block", () => {
    expect(rangeAt(ranges, 4)?.kind).toBe("added");
    expect(rangeAt(ranges, 5)?.kind).toBe("deleted");
    expect(rangeAt(ranges, 10)).toBeUndefined();
    expect(nextRange(ranges, 2)?.start).toBe(4);
    expect(nextRange(ranges, 30)?.start).toBe(2);
  });

  it("asks KeelBot with the old and new lines", () => {
    const t = askWhatChanged("src/cart.ts", ranges[0], 7);
    expect(t).toContain("What changed here in PR #7");
    expect(t).toContain("@src/cart.ts:2");
    expect(t).toContain("-export const TAX = 0.2;\n+export const TAX = 0.21;");
  });
});

describe("files and threads", () => {
  it("reads host file statuses", () => {
    expect(prFileStatusOf("added")).toBe("new");
    expect(prFileStatusOf("D")).toBe("deleted");
    expect(prFileStatusOf("renamed")).toBe("renamed");
    expect(prFileStatusOf("modified")).toBe("modified");
  });

  it("places threads on head lines, the rest at the top", () => {
    const threads = [
      { id: "a", path: "src/cart.ts", line: 4, side: "RIGHT" },
      { id: "b", path: "src/cart.ts", line: 2, side: "LEFT" },
      { id: "c", path: "src/cart.ts", line: 3, outdated: true },
      { id: "d", path: "src/cart.ts", line: 99 },
      { id: "e", path: "src/other.ts", line: 1 },
    ];
    const p = placeThreads(threads, "src/cart.ts", 22);
    expect(p.inline.map((x) => [x.line, x.thread.id])).toEqual([[4, "a"]]);
    expect(p.top.map((t) => t.id)).toEqual(["b", "c", "d"]);
  });
});
