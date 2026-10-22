// Picking the lines of a comment: two picked line numbers become one span, top to bottom, the way GitHub takes it.

import { describe, expect, it } from "vitest";
import { rowsOf, spanOf, type Point } from "../range";

const p = (
  row: number,
  side: "RIGHT" | "LEFT",
  line: number,
  alt?: number,
): Point => ({ row, side, line, alt });

describe("spanOf", () => {
  it("is one line when both picks are the same line", () => {
    expect(spanOf(p(3, "RIGHT", 5), p(3, "RIGHT", 5))).toEqual({
      line: 5,
      side: "RIGHT",
      startLine: null,
      startSide: null,
    });
  });

  it("runs top to bottom whatever the order of the picks", () => {
    const down = { line: 7, side: "RIGHT", startLine: 4, startSide: "RIGHT" };
    expect(spanOf(p(2, "RIGHT", 4), p(5, "RIGHT", 7))).toEqual(down);
    expect(spanOf(p(5, "RIGHT", 7), p(2, "RIGHT", 4))).toEqual(down);
  });

  it("starts on the old side and ends on the new one, as a unified diff shows a change", () => {
    expect(spanOf(p(2, "LEFT", 3), p(4, "RIGHT", 4))).toEqual({
      line: 4,
      side: "RIGHT",
      startLine: 3,
      startSide: "LEFT",
    });
  });

  it("keeps one side when the first line is unchanged (it is on both sides)", () => {
    expect(spanOf(p(1, "RIGHT", 2, 2), p(3, "LEFT", 3))).toEqual({
      line: 3,
      side: "LEFT",
      startLine: 2,
      startSide: "LEFT",
    });
  });

  it("never runs from the new side back to the old one: then it is the last line alone", () => {
    expect(spanOf(p(1, "RIGHT", 2), p(4, "LEFT", 5))).toEqual({
      line: 5,
      side: "LEFT",
      startLine: null,
      startSide: null,
    });
  });
});

describe("rowsOf", () => {
  const rows = new Map([
    ["R2", 1],
    ["R3", 2],
    ["R4", 3],
    ["L3", 0],
  ]);
  const rowOf = (side: "RIGHT" | "LEFT", line: number) =>
    rows.get(`${side === "LEFT" ? "L" : "R"}${line}`);

  it("covers the rows from the first line to the last", () => {
    expect(
      rowsOf(
        { line: 4, side: "RIGHT", startLine: 2, startSide: "RIGHT" },
        rowOf,
      ),
    ).toEqual([1, 3]);
    expect(
      rowsOf(
        { line: 4, side: "RIGHT", startLine: 3, startSide: "LEFT" },
        rowOf,
      ),
    ).toEqual([0, 3]);
    expect(rowsOf({ line: 3, side: "RIGHT" }, rowOf)).toEqual([2, 2]);
  });

  it("is nothing when a line is not shown", () => {
    expect(rowsOf({ line: 9, side: "RIGHT", startLine: 2 }, rowOf)).toBeNull();
    expect(rowsOf({ line: null, side: "RIGHT" }, rowOf)).toBeNull();
  });
});
