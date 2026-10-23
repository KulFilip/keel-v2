// A gate's detail is real Markdown from the engine: ## headings, tables, a bold verdict, `ids` in code, and every diff
// in a ```diff fence. The dashboard shows the structure: headings, a table, a coloured diff (folded after 30 lines).

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { InboxItem, InboxView } from "../inboxApi";
import { commandLine, GateDetail } from "../pages/Flow";
import { server } from "./setup";

const diffBody = [
  "diff --git a/config/contracts/messages/webhook_tracking_update.json b/config/contracts/messages/webhook_tracking_update.json",
  "index 4d6c39b..d842eb7 100644",
  "--- a/config/contracts/messages/webhook_tracking_update.json",
  "+++ b/config/contracts/messages/webhook_tracking_update.json",
  "@@ -2,11 +2,43 @@",
  '   "title": "webhook_tracking_update",',
  '-  "required": ["shipment_id", "status", "updated_at"],',
  '+  "required": [',
  ...Array.from(
    { length: 34 },
    (_, i) => `+    "field_${i}": { "type": ["string", "null"] },`,
  ),
  "-  }",
  "+  }",
  "   }",
];

const DETAIL = `## In plain words

The queue message \`webhook_tracking_update\` gets two new optional fields: \`expected_delivery\` and \`vat_updated_at\`. Old messages stay valid; plain words like snake_case_words and vat_updated_at stay as they are.

## What changes

### \`config/contracts/messages/webhook_tracking_update.json\` · message schema (JSON Schema)

| field | change | type | required? |
|---|---|---|---|
| \`expected_delivery\` | new | string \\| null | no |
| \`vat_updated_at\` | new | string \\| null | no |

## Compatibility

**Verdict: safe for a rolling deploy.**

## Diff

\`config/contracts/messages/webhook_tracking_update.json\` (+36 / -4)

\`\`\`diff
${diffBody.join("\n")}
\`\`\`
`;

// rows the diff shows: everything but the four file-header lines
const DIFF_ROWS = diffBody.length - 4;

describe("gate detail as Markdown", () => {
  it("shows headings, literal snake_case names, the table, the verdict and a coloured, folded diff", async () => {
    const { container } = render(<GateDetail text={DETAIL} />);
    expect(
      screen.getByRole("heading", { level: 2, name: "In plain words" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { level: 2, name: "Compatibility" }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", {
        level: 3,
        name: /webhook_tracking_update\.json · message schema/,
      }),
    ).toBeInTheDocument();

    // underscores in code and in plain words are not italics
    expect(container.querySelector("em")).toBeNull();
    expect(
      screen.getByText(
        /plain words like snake_case_words and vat_updated_at stay as they are/,
      ),
    ).toBeInTheDocument();
    expect(
      [...container.querySelectorAll(".gate-md code")].map(
        (c) => c.textContent,
      ),
    ).toEqual(
      expect.arrayContaining([
        "webhook_tracking_update",
        "vat_updated_at",
        "config/contracts/messages/webhook_tracking_update.json",
      ]),
    );

    // the table, with an escaped pipe kept inside its cell
    const table = screen.getByRole("table", { name: "" });
    expect(
      within(table)
        .getAllByRole("columnheader")
        .map((c) => c.textContent),
    ).toEqual(["field", "change", "type", "required?"]);
    expect(
      within(table).getAllByRole("cell", { name: "string | null" }),
    ).toHaveLength(2);
    expect(
      within(table).getByRole("cell", { name: "vat_updated_at" }),
    ).toBeInTheDocument();

    expect(
      screen.getByText("Verdict: safe for a rolling deploy.").tagName,
    ).toBe("B");

    // the diff is a DiffView with coloured rows, no list items from its - lines
    const diff = container.querySelector(".diffview")!;
    expect(diff).not.toBeNull();
    expect(diff.getAttribute("data-lines")).toBe(String(DIFF_ROWS));
    expect(diff.querySelectorAll(".dl.add").length).toBeGreaterThan(0);
    expect(diff.querySelectorAll(".dl.del").length).toBeGreaterThan(0);
    expect(diff.querySelector(".dl.hunk")).toHaveTextContent(
      "@@ -2,11 +2,43 @@",
    );
    expect(container.querySelectorAll("li")).toHaveLength(0);
    expect(diff.textContent).not.toContain("diff --git");

    // folded after 30 rows, with the gate's wording
    expect(diff.querySelectorAll(".dl")).toHaveLength(30);
    const more = screen.getByRole("button", {
      name: `Show the full diff, ${DIFF_ROWS} lines`,
    });
    await userEvent.setup().click(more);
    expect(diff.querySelectorAll(".dl")).toHaveLength(DIFF_ROWS);
    expect(
      screen.getByRole("button", { name: "Show less" }),
    ).toBeInTheDocument();
  });

  it("folds a long code fence after 30 lines with 'Show all N lines'", () => {
    const json = Array.from(
      { length: 42 },
      (_, i) => `  "k${i}": "v${i}",`,
    ).join("\n");
    render(<GateDetail text={`## Payload\n\n\`\`\`json\n${json}\n\`\`\``} />);
    expect(
      screen.getByRole("button", { name: "Show all 42 lines" }),
    ).toBeInTheDocument();
  });

  it("splits off `$ command` output only outside fences", () => {
    const inFence = [
      "## Run",
      "",
      "```text",
      "$ npm test",
      "ok",
      "```",
      "",
      "Done.",
    ];
    expect(commandLine(inFence)).toBe(-1);
    render(<GateDetail text={inFence.join("\n")} />);
    expect(screen.queryByTestId("gate-cmd")).toBeNull();
    expect(screen.getByText("Done.")).toBeInTheDocument();
    expect(commandLine([...inFence, "$ npm run lint", "clean"])).toBe(8);
  });
});

describe("gate detail in the Inbox", () => {
  it("keeps the headings, table and diff inside the folded detail", async () => {
    const item: InboxItem = {
      project_id: "shipping",
      project_name: "shipping",
      thread_id: "th_c1",
      flow: "Tracking ETA",
      workflow_id: "feature",
      step: "contract_gate",
      kind: "gate",
      title: "Contract gate",
      detail: DETAIL,
      more: false,
      options: ["approve", "reject"],
      id: "q-ct",
      run_mode: "manual",
      since: new Date().toISOString(),
    };
    server.use(
      http.get("/api/inbox", () =>
        HttpResponse.json({
          items: [item],
          count: 1,
          kinds: ["gate"],
          projects: [{ id: "shipping", name: "shipping", count: 1 }],
        } satisfies InboxView),
      ),
    );
    location.hash = "#/inbox";
    render(<App />);
    await screen.findByRole("heading", { name: "Inbox" });
    const detail = await screen.findByTestId("gate-detail");
    expect(
      within(detail).getByRole("heading", { level: 2, name: "What changes" }),
    ).toBeInTheDocument();
    expect(within(detail).getAllByRole("columnheader")).toHaveLength(4);
    expect(detail.querySelector(".diffview .dl.add")).not.toBeNull();
    expect(detail.querySelector("em")).toBeNull();
    const more = screen.getByRole("button", { name: "Show more" });
    await userEvent.setup().click(more);
    expect(detail.closest(".inbox-detail")).toHaveClass("open");
  });
});
