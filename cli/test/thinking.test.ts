// 0.18.23 KeelBot's thinking in keel TUI: the folded line, the open block, and the line under an answer.
import { describe, expect, it } from "vitest";
import { answeredBy, thinkingLines, thoughtLine, THINKING_HEAD } from "../src/core/thinking";

describe("KeelBot's thinking lines", () => {
  it("folds to one line with its seconds; the open block shows the last lines under its head", () => {
    expect(thoughtLine(12_400)).toBe("⋮ Thought for 12s (Ctrl+T to show)");
    expect(thoughtLine(100)).toBe("⋮ Thought for 1s (Ctrl+T to show)");
    const lines = thinkingLines(Array.from({ length: 10 }, (_, i) => `line ${i}`).join("\n"), 80, 3);
    expect(lines).toEqual([THINKING_HEAD, "  line 7", "  line 8", "  line 9"]);
    expect(thinkingLines("word ".repeat(40).trim(), 30).slice(1).every((l) => l.length <= 28)).toBe(true);
  });

  it("names the mode and the model under the answer", () => {
    expect(answeredBy("ask", "Claude Sonnet 5.5")).toBe("■ Ask · Claude Sonnet 5.5");
    expect(answeredBy("side", "")).toBe("■ Side");
  });
});
