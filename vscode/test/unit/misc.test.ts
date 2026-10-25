import { describe, expect, it } from "vitest";
import { localCandidates, matchProject, relativeTo } from "../../src/logic/paths";
import { renderMarkdown } from "../../src/logic/markdown";
import { ago, askText, ciSummary, elapsed, fileRefs, ktokens, requestFromSelection, stepOf, suggestWorkflow, threadStateOf, titleFrom, usd } from "../../src/logic/format";

const projects = [
  { id: "shop", name: "shop", root: "/projects/shop" },
  { id: "billing", name: "Billing API", root: "/projects/billing-api" },
];

describe("project mapping", () => {
  it("a pick wins, then the path, the folder name, the project name", () => {
    expect(matchProject(["/Users/ana/code/shop"], projects, "billing")?.how).toBe("picked");
    expect(matchProject(["/projects/shop"], projects)?.how).toBe("path");
    expect(matchProject(["/Users/ana/code/shop"], projects)).toMatchObject({ how: "folder", folder: "/Users/ana/code/shop" });
    expect(matchProject(["/Users/bo/src/billingapi"], projects)?.project.id).toBe("billing");
    expect(matchProject(["/Users/ana/notes", "/Users/ana/code/shop"], projects)?.project.id).toBe("shop");
    expect(matchProject(["/Users/ana/elsewhere"], projects)).toBeUndefined();
  });

  it("maps keel's paths onto this folder", () => {
    expect(localCandidates("src/cart.ts", "/projects/shop", "/Users/ana/code/shop")).toEqual(["/Users/ana/code/shop/src/cart.ts"]);
    expect(localCandidates("/projects/shop/src/cart.ts", "/projects/shop", "/Users/ana/code/shop")[0]).toBe("/Users/ana/code/shop/src/cart.ts");
    const wt = localCandidates("/data/worktrees/shop/feat-x/src/cart.ts", "/projects/shop", "/Users/ana/code/shop");
    expect(wt).toContain("/Users/ana/code/shop/src/cart.ts");
    expect(relativeTo("/Users/ana/code/shop", "/Users/ana/code/shop/src/a.ts")).toBe("src/a.ts");
  });
});

describe("markdown", () => {
  it("escapes everything and adds only known tags", () => {
    const html = renderMarkdown('# Plan\nUse **bold** and `<b>`\n<script>alert(1)</script>\n\n- one\n- two [docs](https://example.com/a?b=1)\n\n```ts\nconst a = "<x>";\n```');
    expect(html).toContain("<h3>Plan</h3>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain("<code>&lt;b&gt;</code>");
    expect(html).toContain("&lt;script&gt;alert(1)&lt;/script&gt;");
    expect(html).not.toContain("<script>");
    expect(html).toContain('<ul><li>one</li><li>two <a href="https://example.com/a?b=1">docs</a></li></ul>');
    expect(html).toContain('<pre><code class="lang-ts">const a = &quot;&lt;x&gt;&quot;;</code></pre>');
  });

  it("turns path:line into an open link and never a javascript: link", () => {
    const html = renderMarkdown("See src/cart.ts:12 and [x](javascript:alert(1))");
    expect(html).toContain('data-open="src/cart.ts" data-line="12"');
    expect(html).not.toContain('href="javascript');
  });
});

describe("format", () => {
  it("steps, money, tokens, time", () => {
    expect(stepOf("spec")).toBe(0);
    expect(stepOf("red")).toBe(1);
    expect(stepOf("green")).toBe(2);
    expect(stepOf("review")).toBe(3);
    expect(stepOf("review", "done")).toBe(4);
    expect(usd(0.125)).toBe("$0.13");
    expect(ktokens(1500)).toBe("2k");
    expect(ktokens(2_500_000)).toBe("2.5M");
    expect(elapsed(65_000)).toBe("1:05");
    expect(elapsed(3_725_000)).toBe("1:02:05");
    expect(ago("2026-10-25T10:00:00Z", Date.parse("2026-10-25T10:12:00Z"))).toBe("12 min");
  });

  it("threads, CI, refs, requests", () => {
    expect(threadStateOf({ id: "1", comments: [{ id: "a", author: "bo" }] }, "ana")).toBe("waiting");
    expect(threadStateOf({ id: "1", comments: [{ id: "a", author: "Ana" }] }, "ana")).toBe("open");
    expect(threadStateOf({ id: "1", resolved: true }, "ana")).toBe("resolved");
    expect(ciSummary([{ name: "a", state: "success" }, { name: "b", state: "failure" }])).toBe("CI 1/2 ✗");
    expect(fileRefs("in orders.py:39 and src/Prefs.kt:4-9").map((r) => [r.path, r.line])).toEqual([
      ["orders.py", 39],
      ["src/Prefs.kt", 4],
    ]);
    expect(suggestWorkflow("fix the broken cart", ["feature", "fix"])).toBe("fix");
    expect(titleFrom("Add refunds to orders.\nmore")).toBe("Add refunds to orders");
    expect(requestFromSelection("src/a.ts", 3, 3, "// TODO: round totals\nx()")).toContain("Round totals\n\nCode: src/a.ts:3");
    expect(askText("src/a.ts", 1, 2, "a\nb\n")).toBe("@src/a.ts:1-2\n```\na\nb\n```\n");
  });
});
