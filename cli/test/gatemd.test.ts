// A gate's detail is Markdown from the engine; keel TUI shows its structure as plain text: headings bold without ##,
// fences gone and the code indented in the code role, a ```diff fence's lines coloured, **bold** and `code` without marks.
import { describe, expect, it } from "vitest";
import { status, waitingLines } from "../src/core/format";
import { gateDetailLines } from "../src/core/gatemd";
import { makeTheme, PLAIN, ROLES, type Paint, type Role } from "../src/core/theme";
import { stripAnsi } from "../src/script";

/** A paint that tags each role, so a test sees which role a piece got: <ok>+x</ok>, <b>bold</b>. */
const tags: Paint = { ...PLAIN, ...(Object.fromEntries(ROLES.map((r) => [r, (s: string) => `<${r}>${s}</${r}>`])) as Record<Role, (s: string) => string>),
  bold: (s) => `<b>${s}</b>`, colored: true };

const DETAIL = `## In plain words

The queue message \`webhook_tracking_update\` gets two new optional fields: \`expected_delivery\` and \`eta_updated_at\`.

## What changes

| field | change |
|---|---|
| \`eta_updated_at\` | new: string \\| null |

## Compatibility

**Verdict: safe for a rolling deploy.**

## Diff

\`\`\`diff
diff --git a/x.json b/x.json
index 4d6c39b..d842eb7 100644
--- a/x.json
+++ b/x.json
@@ -2,3 +2,4 @@
   "title": "webhook_tracking_update",
-  "required": ["shipment_id"],
+  "required": ["shipment_id", "eta_updated_at"],
\`\`\`

\`\`\`json
{ "a": 1 }
\`\`\``;

describe("gate detail in keel TUI", () => {
  const lines = gateDetailLines(DETAIL, tags);
  const plain = gateDetailLines(DETAIL, PLAIN);

  it("shows ## headings as bold lines without the marks, summary first", () => {
    expect(lines[0]).toBe("<b>In plain words</b>");
    expect(plain).toContain("Compatibility");
    expect(plain.some((l) => l.includes("##"))).toBe(false);
    expect(plain[2]).toMatch(/^The queue message webhook_tracking_update gets/);
  });

  it("drops the fence lines, indents the code and colours the diff", () => {
    expect(plain.some((l) => l.includes("```"))).toBe(false);
    expect(lines).toContain('  <bad>-  "required": ["shipment_id"],</bad>');
    expect(lines).toContain('  <ok>+  "required": ["shipment_id", "eta_updated_at"],</ok>');
    expect(lines).toContain("  <meta>@@ -2,3 +2,4 @@</meta>");
    expect(lines).toContain("  <meta>--- a/x.json</meta>");
    expect(lines).toContain('  <code>{ "a": 1 }</code>');
  });

  it("shows **bold** without stars, `code` without backticks, and table cells split on unescaped pipes", () => {
    expect(lines).toContain("<b>Verdict: safe for a rolling deploy.</b>");
    expect(lines[2]).toContain("<code>webhook_tracking_update</code>");
    expect(plain.join("\n")).not.toMatch(/[`*]/);
    expect(plain).toContain("  field │ change");
    expect(plain).toContain("  eta_updated_at │ new: string | null");
  });

  it("colours the diff with the real theme (green +, red -) in the waiting lines, cut near 600 characters", () => {
    const dark = makeTheme({ KEEL_TUI_THEME: "dark" }, 3).paint;
    const w = { step: "contract_gate", kind: "gate", title: "Contract", detail: DETAIL, options: ["approve", "reject"] } as never;
    const out = waitingLines(w, dark);
    const add = out.find((l) => stripAnsi(l).includes('+  "required"'))!;
    expect(add).toContain("\x1b[32m");
    expect(out.find((l) => stripAnsi(l).includes('-  "required"'))).toContain("\x1b[31m");
    expect(stripAnsi(out.find((l) => stripAnsi(l).includes("In plain words"))!)).toBe("          In plain words");
    const long = { ...(w as object), detail: "## Diff\n\n```diff\n" + Array.from({ length: 80 }, (_, i) => `+ line ${i} of the new file`).join("\n") + "\n```" } as never;
    const cutOut = waitingLines(long, PLAIN);
    expect(cutOut.join("\n").length).toBeLessThan(600 + 40 * cutOut.length);
    expect(cutOut.at(-1)).toMatch(/…$/);
  });

  it("puts the first two lines of text under /status, without the Markdown marks", () => {
    const view = { thread: { thread_id: "t1", title: "ETA", workflow_id: "feature", status: "waiting", current: "contract_gate", phase: "contract",
      run_mode: "manual", acs: [], usage: {}, waiting: { step: "contract_gate", kind: "gate", title: "Contract", detail: DETAIL, options: ["approve", "reject"] } },
      workflow: null } as never;
    const s = status({ id: "shipping", branch: "main" } as never, view, PLAIN);
    expect(s).toContain("\n  In plain words\n  The queue message webhook_tracking_update gets");
    expect(s).not.toContain("## In plain words");
  });
});
