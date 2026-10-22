// keel TUI 0.18.38 KeelBot's answers in clearer colours ("all text is white, it's hard to read"): headings and bold
// lead-ins in the heading look, inline code in sand, paths in the accent, bullets in the accent, what the answer did not
// do quiet, and verdict tags after a lead-in as coloured words. Body text stays the terminal's own colour.
import { describe, expect, it } from "vitest";
import { renderMarkdown } from "../src/core/markdown";
import { DARK, KEEL, LIGHT, makeTheme, PLAIN } from "../src/core/theme";
import { plain } from "../src/core/select";

const rgb = (hex: string) => `\x1b[38;2;${[1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16)).join(";")}m`;
const keel = makeTheme({ KEEL_TUI_THEME: "keel" }, 3).paint;
const BOLD = "\x1b[1m";

describe("KeelBot's answer colours", () => {
  it("inline code is sand and paths are the accent, in every palette, apart from each other", () => {
    for (const pal of [KEEL, DARK, LIGHT]) {
      expect(pal.code).not.toBe(pal.path);
      expect(pal.path).toBe(pal.accent);
    }
    const out = renderMarkdown("Run `npm test` and open src/app.ts:3.", keel);
    expect(out).toContain(`${rgb(KEEL.code)}npm test`);
    expect(out).toContain(`${rgb(KEEL.accent)}src/app.ts:3`);
    expect(out.startsWith("Run ")).toBe(true);                          // body text: the terminal's own colour
  });

  it("headings and bold lead-ins are bright and bold; bold in a sentence is only bold", () => {
    const h = renderMarkdown("## Review", keel);
    expect(h).toContain(rgb(KEEL.heading));
    expect(h).toContain(BOLD);
    const lead = renderMarkdown("**Comment 1: keep `eta_updated_at`?** Valid, it is read.", keel);
    expect(lead.indexOf(rgb(KEEL.heading))).toBeLessThan(lead.indexOf("Comment 1"));
    expect(lead).toContain(BOLD);
    expect(lead).toContain(`${rgb(KEEL.code)}eta_updated_at`);
    const mid = renderMarkdown("It is **really** read.", keel);
    expect(mid).toBe(`It is ${BOLD}really\x1b[22m read.`);
    const item = renderMarkdown("- **Comment 2: why raw SQL?** fine", keel);
    expect(item).toContain(`${rgb(KEEL.accent)}•`);
    expect(item).toContain(BOLD + rgb(KEEL.heading) + "Comment 2");
  });

  it("bullets at every depth are the accent", () => {
    const out = renderMarkdown("- one\n  - two\n    - three", keel);
    for (const b of ["•", "◦", "▪"]) expect(out).toContain(`${rgb(KEEL.accent)}${b}`);
  });

  it("what the answer did not do is quiet", () => {
    for (const l of ["Not verified: the CI run.", "I did not run the tests.", "I changed no files.", "- I did not run the e2e."]) {
      const out = renderMarkdown(l, keel);
      expect(out, l).toContain(rgb(KEEL.meta));
      expect(out, l).not.toContain(BOLD);
    }
    expect(renderMarkdown("I did the change.", keel)).toBe("I did the change.");
  });

  it("a verdict tag after a lead-in is a coloured word; another tag stays plain", () => {
    const tag = (t: string) => renderMarkdown(`**Comment 1: keep it?** [${t}] because`, keel);
    expect(tag("valid")).toContain(`${rgb(KEEL.ok)}valid`);
    expect(tag("partly")).toContain(`${rgb(KEEL.warn)}partly`);
    expect(tag("not valid")).toMatch(/\x1b\[31mnot valid/);              // keel's red is the terminal's red
    expect(tag("optional")).toContain(`${rgb(KEEL.dim)}optional`);
    expect(tag("unclear")).toContain(`${rgb(KEEL.dim)}unclear`);
    expect(plain(tag("valid"))).toBe("Comment 1: keep it? valid because");
    expect(plain(tag("maybe"))).toBe("Comment 1: keep it? [maybe] because");
    expect(tag("maybe")).toContain(" [maybe] because");
    // not after a lead-in: plain text
    expect(renderMarkdown("It is [valid] here", keel)).toBe("It is [valid] here");
  });

  it("follows NO_COLOR (no escapes, the tag keeps its brackets) and the person's colours", () => {
    const md = "## Review\n\n- **Comment 1: keep `x`?** [valid] yes, in src/a.ts:1\n\nNot verified: CI.";
    expect(renderMarkdown(md, PLAIN)).toBe("Review\n\n  • Comment 1: keep x? [valid] yes, in src/a.ts:1\n\nNot verified: CI.");
    const none = makeTheme({ NO_COLOR: "1", KEEL_TUI_THEME: "keel" }, 3).paint;
    expect(renderMarkdown(md, none)).not.toContain("\x1b[");
    const mine = makeTheme({ KEEL_TUI_THEME: "keel", KEEL_TUI_COLORS: "code=#112233,path=#445566" }, 3).paint;
    const out = renderMarkdown("`x` in src/a.ts:1", mine);
    expect(out).toContain(`${rgb("#112233")}x`);
    expect(out).toContain(`${rgb("#445566")}src/a.ts:1`);
  });
});
