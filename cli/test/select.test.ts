// keel TUI: select with the mouse and it is copied. The pure parts (the reports, the cells as text, a word's bounds)
// (the app's drag, double-click and notice: copy.test.tsx).
import { describe, expect, it } from "vitest";
import { MOUSE } from "../src/core/lines";
import {
  colsOn,
  highlight,
  mouseEvents,
  plain,
  selectedText,
  sliceCols,
  wordAt,
} from "../src/core/select";

describe("mouseEvents", () => {
  it("reads the left button's press, drag and release, 0-based, and leaves out the wheel and other buttons", () => {
    expect(mouseEvents("\x1b[<0;5;3M\x1b[<32;20;3M\x1b[<0;20;3m")).toEqual([
      { kind: "press", col: 4, row: 2, mods: 0 },
      { kind: "drag", col: 19, row: 2, mods: 0 },
      { kind: "release", col: 19, row: 2, mods: 0 },
    ]);
    expect(
      mouseEvents("\x1b[<64;5;3M\x1b[<65;5;3M\x1b[<2;5;3M\x1b[<1;5;3m"),
    ).toEqual([]);
    expect(mouseEvents("[<4;1;1M")).toEqual([
      { kind: "press", col: 0, row: 0, mods: 4 },
    ]);
  });
  it("turns drag reports on, and off again", () => {
    expect(MOUSE.on).toContain("\x1b[?1002h");
    expect(MOUSE.on).toContain("\x1b[?1006h");
    expect(MOUSE.off).toContain("\x1b[?1002l");
  });
});

describe("a selection's text", () => {
  const lines = ["\x1b[31mhello world\x1b[39m   ", "  second line", "third"];
  it("covers both ends' cells, across lines, without colours or trailing spaces", () => {
    expect(selectedText(lines, { line: 0, col: 6 }, { line: 0, col: 10 })).toBe(
      "world",
    );
    expect(selectedText(lines, { line: 1, col: 8 }, { line: 0, col: 6 })).toBe(
      "world\n  second",
    );
    expect(
      selectedText(lines, { line: 0, col: 0 }, { line: 2, col: 1e6 }),
    ).toBe("hello world\n  second line\nthird");
    expect(selectedText(lines, { line: 2, col: 9 }, { line: 2, col: 12 })).toBe(
      "",
    );
  });
  it("counts a wide character as two cells", () => {
    expect(sliceCols("a界b", 1, 3)).toBe("界");
    expect(sliceCols("a界b", 3, 4)).toBe("b");
  });
  it("knows each line's columns, and shows them inverse", () => {
    expect(colsOn(0, { line: 0, col: 3 }, { line: 2, col: 1 })).toEqual([
      3,
      Infinity,
    ]);
    expect(colsOn(1, { line: 0, col: 3 }, { line: 2, col: 1 })).toEqual([
      0,
      Infinity,
    ]);
    expect(colsOn(2, { line: 0, col: 3 }, { line: 2, col: 1 })).toEqual([0, 2]);
    expect(colsOn(3, { line: 0, col: 3 }, { line: 2, col: 1 })).toBeNull();
    expect(highlight(lines[0], 6, 11)).toBe("hello \x1b[7mworld\x1b[27m   ");
    expect(plain(highlight(lines[0], 6, 11))).toBe(plain(lines[0]));
  });
});

describe("wordAt", () => {
  it("finds the word under a column: a path is one word, a space or a quote is none", () => {
    const s = `  open "cli/src/core/select.ts" now`;
    expect(wordAt(s, 10)).toEqual([8, 29]);
    expect(s.slice(8, 30)).toBe("cli/src/core/select.ts");
    expect(wordAt(s, 3)).toEqual([2, 5]);
    expect(wordAt(s, 1)).toBeNull();
    expect(wordAt(s, 7)).toBeNull();
    expect(wordAt(s, 99)).toBeNull();
  });
});
