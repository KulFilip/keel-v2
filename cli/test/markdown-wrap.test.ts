// keel TUI 0.18.38 KeelBot's answers in the transcript: every line folds at the screen's width (no word is cut at the
// right edge, also in a table), and **bold** keeps working around code, links and file:line paths.
import { describe, expect, it } from "vitest";
import stringWidth from "string-width";
import { blockLines } from "../src/core/lines";
import { renderMarkdown } from "../src/core/markdown";
import { makeTheme, PLAIN } from "../src/core/theme";
import { plain } from "../src/core/select";

const color = makeTheme({ KEEL_TUI_THEME: "dark" }, 3).paint;
const ANSWER = [
  "I read the four review comments on the pull request. Here is what each one asks and whether it is right. I did not check the CI run yet, because it was still running when I looked.",
  "",
  "**Comment 1: keep `vat_updated_at`?** Valid, the column is read by the checkout page and the nightly export, so removing it would break both of them silently.",
  "**Comment 2: why raw SQL?** The query builder cannot express the lateral join here.",
  "**Comment 4: use a factory in PricingEngineVatAbsentKeepsStoredTest.php:50.** Valid but optional. I changed nothing in that test file because it passes and the factory would only shorten it by a few lines.",
].join("\n");
const words = (s: string) => s.replace(/\*\*|`/g, "").split(/\s+/).filter(Boolean).join(" ");

describe("an answer in the transcript", () => {
  for (const width of [80, 120]) {
    it(`folds every line at ${width} columns and loses no character`, () => {
      for (const p of [PLAIN, color]) {
        const ls = blockLines({ kind: "markdown", text: ANSWER }, width, p);
        for (const l of ls) expect(stringWidth(l)).toBeLessThanOrEqual(width);
        expect(words(ls.map(plain).join(" "))).toBe(words(ANSWER));
        // a folded row starts at the text's edge, not one space in
        for (const l of ls) expect(plain(l)).not.toMatch(/^ {3}\S/);
      }
    });
  }

  it("folds a table's long cells onto more lines of their row instead of cutting them", () => {
    const md = "| # | Verdict |\n|---|---|\n| 1 | Valid, the column is read by the checkout page. I did not check the CI run yet. |\n| 4 | Valid but optional. I changed nothing in that file. |";
    const ls = blockLines({ kind: "markdown", text: md }, 40, color).map(plain);
    for (const l of ls) expect(stringWidth(l)).toBeLessThanOrEqual(40);
    expect(ls.join("\n")).not.toContain("…");
    const cells = ls.filter((l) => l.includes("│")).map((l) => l.split("│")[2]?.trim() ?? "").filter(Boolean);
    expect(cells.join(" ")).toBe("Verdict Valid, the column is read by the checkout page. I did not check the CI run yet. Valid but optional. I changed nothing in that file.");
  });
});

describe("bold around other inline styles", () => {
  const BOLD_ON = "\x1b[1m";
  it("takes code, a file:line and a link inside it, with no literal asterisks", () => {
    const cases: [string, string][] = [
      ["**Comment 1: keep `vat_updated_at`?** Valid", "Comment 1: keep vat_updated_at? Valid"],
      ["**Comment 4: use a factory in PricingEngineVatAbsentKeepsStoredTest.php:50.** Valid but optional.",
        "Comment 4: use a factory in PricingEngineVatAbsentKeepsStoredTest.php:50. Valid but optional."],
      ["**see [the docs](https://x.io) first** then", "see the docs (https://x.io) first then"],
      ["**`run()` in src/app.ts:3**", "run() in src/app.ts:3"],
      ["**Comment 2: why raw SQL?** fine", "Comment 2: why raw SQL? fine"],
      ["__bold `code`__ and *it `x` alic*", "bold code and it x alic"],
    ];
    for (const [md, want] of cases) {
      const out = renderMarkdown(md, color);
      expect(plain(out)).toBe(want);
      expect(out.startsWith(BOLD_ON) || out.includes(BOLD_ON)).toBe(true);
    }
    // the bold goes around the whole lead-in: from its first word to the end of the path, with the path still a link
    const out = renderMarkdown("**Comment 4: use a factory in Test.php:50.** Valid", color);
    expect(out.indexOf(BOLD_ON)).toBe(0);
    expect(out).toContain("Test.php:50");
    expect(out.indexOf("\x1b[22m", out.indexOf("Test.php:50"))).toBeLessThan(out.indexOf("Valid"));
    expect(out.slice(out.indexOf("Valid"))).not.toContain(BOLD_ON);
    // what the renderer gives (no colours), as the person reads it
    expect(renderMarkdown("**Comment 1: keep `vat_updated_at`?** Valid, **Comment 4: Test.php:50.** ok", PLAIN))
      .toBe("Comment 1: keep vat_updated_at? Valid, Comment 4: Test.php:50. ok");
  });

  it("leaves a lone ** and a path's own underscores as they are", () => {
    expect(plain(renderMarkdown("a ** b src/scores/__init__.py:1 c", color))).toBe("a ** b src/scores/__init__.py:1 c");
    expect(plain(renderMarkdown("2 ** 3 is 8", color))).toBe("2 ** 3 is 8");
  });
});
