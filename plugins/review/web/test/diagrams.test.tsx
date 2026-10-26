// keel 0.18.57 the overview's Database and System tabs (GET /review/diagrams, read from git with no model): the tabs
// (Database only when the change touches the database, with its count), the Mermaid diagram drawn as SVG, the ASCII
// text (the Text view, and the fallback when Mermaid cannot draw), Copy Mermaid / ASCII, the phone's list, the risks
// and the files keel could not read ("not parsed — open the file"). Demo data: a "shop" with orders and refunds.

import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { server } from "../../../../web/src/test/setup";
import type { Diagrams, ReviewView } from "../reviewApi";

import { draw } from "../Diagrams";
import { OverviewTab } from "../ReviewPanel";

// jsdom cannot lay out an SVG, so keel's Mermaid renderer and the clipboard are stand-ins here
const sdk = { render: vi.fn<(text: string, o?: { dark?: boolean }) => Promise<string>>(), copied: [] as string[] };
const real = { ...draw };

const SVG = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 400 200"><g><text>refunds</text></g></svg>';
const ER = 'erDiagram\n  refunds["+ refunds"] {\n    bigint id PK\n  }\n';
const ER_ASCII = "database: 1 new table(s)\n\n+- [+] refunds ---+\n|     PK id bigint |\n+------------------+";
const FLOW = 'flowchart LR\n  n1["RefundController · http"]\n';

function diagrams(shown: boolean): Diagrams {
  return {
    key: "pr:7",
    base: "b".repeat(40),
    head: "a".repeat(40),
    text: "== System ==",
    database: shown
      ? {
          shown: true,
          count: 3,
          before: "the base branch's migrations",
          after: "the head's migrations",
          notes: [],
          changes: { new: 1, changed: 1, removed: 0 },
          tables: [
            { name: "refunds", status: "new", columns: [
              { name: "id", type: "bigint", pk: true, fk: null, unique: false, nullable: false, default: null, status: "new", was: null },
              { name: "order_id", type: "bigint", pk: false, fk: "orders.id", unique: false, nullable: false, default: null, status: "new", was: null },
            ], indexes: [], fks: [] },
            { name: "orders", status: "changed", columns: [
              { name: "refund_total", type: "numeric(10,2)", pk: false, fk: null, unique: false, nullable: false, default: null, status: "new", was: null },
            ], indexes: [], fks: [] },
          ],
          migrations: [
            { path: "db/migration/V2__refunds.sql", framework: "SQL", status: "A", role: "migration", parsed: true,
              steps: [{ line: 2, text: "creates table refunds (2 columns, foreign key to orders)", kind: "create_table", table: "refunds" },
                      { line: 8, text: "adds column orders.refund_total (numeric(10,2), not null)", kind: "add_column", table: "orders" }] },
            { path: "src/Entity/Refund.php", framework: "ORM mapping", status: "A", role: "mapping", parsed: false, steps: [] },
          ],
          risks: [{ kind: "not_null_no_default", severity: "high", path: "db/migration/V2__refunds.sql", line: 8,
                    text: "orders.refund_total is added NOT NULL without a default to a table that already exists" }],
          not_parsed: [{ path: "src/Entity/Refund.php", line: 1, why: "ORM mapping: keel does not read entity classes" }],
          mermaid: ER,
          ascii: ER_ASCII,
        }
      : { shown: false, count: 0 },
    system: {
      source: "paths",
      nodes: [{ id: "n1", label: "RefundController", layer: "http", area: "Refund", files: ["src/Refund/RefundController.php"], status: "added" }],
      edges: [{ from: "x_http_in", to: "n1", label: "", kind: "data" }],
      groups: [{ id: "a_Refund", title: "Refund", nodes: ["n1"] }],
      externals: [{ id: "x_http_in", label: "HTTP request", kind: "http-in", detail: "", files: [] }],
      collapsed: null,
      tests: 1,
      skipped: 0,
      mermaid: FLOW,
      ascii: "system: 1 changed part(s)\n\n+- Refund ---+\n| [+] RefundController  (http) |",
    },
  };
}

const VIEW = {
  key: "pr:7", kind: "pr", number: 7, title: "Refunds", author: "ana", body: null, base: "main", branch: "feat/refunds",
  base_sha: "b".repeat(40), head_sha: "a".repeat(40), url: null, state: "open", draft: false, same_repo: true, checks: [],
  approved: [], changes_requested: [], added: 20, removed: 1, commits: [], threads: [], conversation: [], drafts: [], viewed: [],
  can_post: true, host: null, me: "me", notes: [],
  files: [
    { path: "db/migration/V2__refunds.sql", status: "A", added: 10, removed: 0, binary: false },
    { path: "src/Entity/Refund.php", status: "A", added: 3, removed: 0, binary: false },
  ],
} as ReviewView;

let calls: string[] = [];
function serve(d: Diagrams | null) {
  server.use(
    http.get("/api/projects/:pid/review/diagrams", ({ request }) => {
      calls.push(new URL(request.url).search);
      return d ? HttpResponse.json(d) : HttpResponse.json({ error: "The engine is not running, so keel cannot draw the diagrams" }, { status: 409 });
    }),
  );
}

function show(onOpen = vi.fn()) {
  render(<OverviewTab pid="shop" view={VIEW} ai={null} busy={null} blocking={0} onStart={() => {}} onOpen={onOpen} />);
  return onOpen;
}

describe("the overview's Database and System tabs", () => {
  beforeEach(() => {
    calls = [];
    sdk.copied = [];
    sdk.render.mockReset();
    sdk.render.mockResolvedValue(SVG);
    draw.mermaid = (t, o) => sdk.render(t, o);
    draw.copy = async (t: string) => {
      sdk.copied.push(t);
      return true;
    };
  });
  afterEach(() => {
    Object.assign(draw, real);
    vi.restoreAllMocks();
  });

  it("shows Database with its count when the change touches the database, and draws the diagram", async () => {
    serve(diagrams(true));
    const onOpen = show();
    const tabs = await screen.findByRole("tablist", { name: "Overview parts" });
    await waitFor(() => expect(within(tabs).getByRole("tab", { name: "Database, 3 changes" })).toBeInTheDocument());
    expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "Database3", "System"]);
    expect(calls).toEqual(["?key=pr%3A7"]);
    fireEvent.click(within(tabs).getByRole("tab", { name: "Database, 3 changes" }));
    const img = await screen.findByRole("img", { name: "Database change diagram" });
    expect(img.tagName.toLowerCase()).toBe("svg");
    expect(sdk.render).toHaveBeenCalledWith(ER, { dark: false });
    expect(screen.getByText("1 new")).toBeInTheDocument();
    expect(screen.getByText(/Before: the base branch's migrations/)).toBeInTheDocument();
    // risks with file:line (a link: the file is in the review), each step in plain words, the file keel did not read
    const risk = screen.getByText(/added NOT NULL without a default/).closest("li")!;
    fireEvent.click(within(risk).getByRole("button", { name: "db/migration/V2__refunds.sql:8" }));
    expect(onOpen).toHaveBeenCalledWith("db/migration/V2__refunds.sql", 8);
    expect(screen.getByText("adds column orders.refund_total (numeric(10,2), not null)")).toBeInTheDocument();
    expect(screen.getAllByText(/not parsed — open the file/).length).toBe(2);
    const notRead = screen.getByRole("list", { name: "Files keel could not read" });
    expect(within(notRead).getByRole("button", { name: "src/Entity/Refund.php" })).toBeInTheDocument();
    // Copy Mermaid / Copy ASCII: ready to paste into a pull request
    fireEvent.click(screen.getByRole("button", { name: "Copy Mermaid" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy ASCII" }));
    await waitFor(() => expect(sdk.copied).toEqual(["```mermaid\n" + ER + "```\n", "```\n" + ER_ASCII + "\n```\n"]));
    expect(await screen.findByText("ASCII copied")).toBeInTheDocument();
    // Text: the ASCII picture
    fireEvent.click(screen.getByRole("radio", { name: "Text" }));
    expect(screen.getByLabelText("Database change diagram as text").textContent).toBe(ER_ASCII);
    // List: the tables and their columns, marked
    fireEvent.click(screen.getByRole("radio", { name: "List" }));
    expect(screen.getByText("+ refunds", { selector: "b" })).toBeInTheDocument();
  });

  it("hides Database when no changed file holds the database; System is always there", async () => {
    serve(diagrams(false));
    show();
    const tabs = await screen.findByRole("tablist", { name: "Overview parts" });
    await waitFor(() => expect(calls.length).toBe(1));
    await waitFor(() => expect(within(tabs).getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "System"]));
    fireEvent.click(within(tabs).getByRole("tab", { name: "System" }));
    expect(await screen.findByRole("img", { name: "System diagram" })).toBeInTheDocument();
    expect(sdk.render).toHaveBeenCalledWith(FLOW, { dark: false });
    expect(screen.getByText("HTTP request")).toBeInTheDocument();
    expect(screen.getByText(/1 changed part in 1 area, 1 test file/)).toBeInTheDocument();
  });

  it("falls back to the ASCII text when Mermaid cannot draw", async () => {
    sdk.render.mockRejectedValue(new Error("Parse error on line 2"));
    serve(diagrams(true));
    show();
    fireEvent.click(await screen.findByRole("tab", { name: "Database, 3 changes" }));
    expect(await screen.findByText(/Mermaid could not draw this one/)).toBeInTheDocument();
    expect(screen.getByLabelText("Database change diagram as text").textContent).toBe(ER_ASCII);
    expect(screen.queryByRole("img", { name: "Database change diagram" })).toBeNull();
    expect(screen.getByRole("button", { name: "Save Database change diagram as SVG" })).toBeDisabled();
  });

  it("on a phone the diagram starts as a list, and a failed load says why with a retry", async () => {
    const mm = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width"), media: q, addEventListener() {}, removeEventListener() {},
      onchange: null })) as unknown as typeof window.matchMedia;
    try {
      serve(diagrams(true));
      show();
      fireEvent.click(await screen.findByRole("tab", { name: "Database, 3 changes" }));
      expect(await screen.findByRole("radio", { name: "List" })).toHaveAttribute("aria-checked", "true");
      expect(screen.getByText("+ refunds", { selector: "b" })).toBeInTheDocument();
      expect(sdk.render).not.toHaveBeenCalled();                     // no Mermaid until the diagram is asked for
    } finally {
      window.matchMedia = mm;
    }
  });

  it("an engine that is down: System shows the error with a retry, Overview still works", async () => {
    serve(null);
    show();
    fireEvent.click(await screen.findByRole("tab", { name: "System" }));
    expect(await screen.findByText("The engine is not running, so keel cannot draw the diagrams")).toBeInTheDocument();
    serve(diagrams(false));
    fireEvent.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("img", { name: "System diagram" })).toBeInTheDocument();
    expect(calls).toEqual(["?key=pr%3A7", "?key=pr%3A7&refresh=true"]);
    fireEvent.click(screen.getByRole("tab", { name: "keel's overview" }));
    expect(screen.getByRole("button", { name: "Explain this change" })).toBeInTheDocument();
  });
});
