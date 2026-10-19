// The wiki's order: the menu grouped by kind (Overview, Architecture & knowledge, Specs by build status, Decisions,
// Workflows), a stable order in each group (specs newest first, decisions by number, knowledge not written last),
// readable titles, the same file once, empty groups left out, the filter, and on a page its breadcrumb and "On this page".
// A keel before the order (only id, title, status) gets the same menu from the ids.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import type { SpecStatus, WikiTree } from "../../../../web/src/api";
import { server } from "../../../../web/src/test/setup";
import {
  buildNav,
  filterNav,
  firstPage,
  groupItems,
  labelOf,
  numberOf,
  placeOf,
} from "../nav";

const status = (spec: string, state: SpecStatus["state"]): SpecStatus => ({
  spec,
  path: spec.slice(5),
  title: spec,
  acs: 1,
  state,
  flows: [],
});

/** A real project's wiki as this keel sends it. */
const tree: WikiTree = {
  layout: "repo",
  sections: [
    {
      id: "specs",
      title: "Specs",
      items: [
        {
          id: "spec:docs/specs/SPEC-101-wave.md",
          title: "SPEC-101: Wave fallback",
          kind: "spec",
          number: "101",
          label: "Wave fallback",
          path: "docs/specs/SPEC-101-wave.md",
        },
        {
          id: "spec:docs/specs/SPEC-102-parse.md",
          title: "SPEC-102: Fail-soft parsing",
          kind: "spec",
          number: "102",
          label: "Fail-soft parsing",
        },
        {
          id: "spec:docs/specs/SPEC-110-cleanup.md",
          title: "SPEC-110: Cleanup",
          kind: "spec",
          number: "110",
          label: "Cleanup",
          also: [".keel/specs/SPEC-110-cleanup.md"],
          path: "docs/specs/SPEC-110-cleanup.md",
        },
        {
          id: "spec:docs/specs/SPEC-200-web.md",
          title: "SPEC-200 — Web port",
          kind: "spec",
          number: "200",
          label: "Web port",
        },
      ],
    },
    {
      id: "knowledge",
      title: "Knowledge",
      items: [
        {
          id: "kb:index",
          title: "What an agent needs to know",
          status: "written",
          kind: "overview",
        },
        {
          id: "kb:architecture",
          title: "Architecture",
          status: "written",
          kind: "knowledge",
          label: "Architecture",
        },
        {
          id: "kb:domain",
          title: "Domain",
          status: "missing",
          kind: "knowledge",
          label: "Domain",
        },
        {
          id: "kb:data",
          title: "Data",
          status: "stale",
          kind: "knowledge",
          label: "Data",
        },
      ],
    },
    {
      id: "workflows",
      title: "Workflows",
      items: [
        { id: "wf:fix", title: "fix (keel)", kind: "workflow" },
        { id: "wf:feature", title: "feature (keel)", kind: "workflow" },
      ],
    },
    {
      id: "runbook",
      title: "Runbook",
      items: [
        { id: "runbook", title: "How to run this project", kind: "runbook" },
      ],
    },
    {
      id: "decisions",
      title: "Decisions",
      items: [
        {
          id: "adr:0010-z.md",
          title: "ADR 0010 — Ten",
          kind: "decision",
          number: "0010",
          label: "Ten",
        },
        {
          id: "adr:0002-b.md",
          title: "ADR 0002 — Two",
          kind: "decision",
          number: "0002",
          label: "Two",
        },
      ],
    },
  ],
};

const specs = new Map<string, SpecStatus>([
  [
    "spec:docs/specs/SPEC-101-wave.md",
    status("spec:docs/specs/SPEC-101-wave.md", "built"),
  ],
  [
    "spec:docs/specs/SPEC-102-parse.md",
    status("spec:docs/specs/SPEC-102-parse.md", "built"),
  ],
  [
    "spec:docs/specs/SPEC-110-cleanup.md",
    status("spec:docs/specs/SPEC-110-cleanup.md", "in_progress"),
  ],
]);

const ids = (xs: { id: string }[]) => xs.map((x) => x.id);

describe("the menu's order (nav.ts)", () => {
  it("groups by kind in a fixed order and leaves empty groups out", () => {
    const g = buildNav(tree, specs);
    expect(g.map((x) => x.title)).toEqual([
      "Overview",
      "Architecture & knowledge",
      "Specs",
      "Decisions",
      "Workflows",
    ]);
    expect(ids(groupItems(g[0]))).toEqual(["kb:index", "runbook"]);
    const noAdr = buildNav({
      sections: tree.sections.filter((s) => s.id !== "decisions"),
    });
    expect(noAdr.map((x) => x.id)).not.toContain("decisions");
  });

  it("knowledge keeps keel's order with the sections not written yet last", () => {
    expect(ids(groupItems(buildNav(tree)[1]))).toEqual([
      "kb:architecture",
      "kb:data",
      "kb:domain",
    ]);
  });

  it("specs by build status (in progress, stopped, not built yet, done), newest first in each", () => {
    const s = buildNav(tree, specs).find((x) => x.id === "specs")!;
    expect(s.parts.map((p) => [p.title, ids(p.items)])).toEqual([
      ["In progress", ["spec:docs/specs/SPEC-110-cleanup.md"]],
      ["Not built yet", ["spec:docs/specs/SPEC-200-web.md"]],
      [
        "Done",
        [
          "spec:docs/specs/SPEC-102-parse.md",
          "spec:docs/specs/SPEC-101-wave.md",
        ],
      ],
    ]);
    // without the status: one list, newest first
    const plain = buildNav(tree).find((x) => x.id === "specs")!;
    expect(plain.parts).toHaveLength(1);
    expect(plain.parts[0].items.map((i) => i.number)).toEqual([
      "200",
      "110",
      "102",
      "101",
    ]);
  });

  it("decisions by number, workflows by title, titles without their number", () => {
    const g = buildNav(tree);
    expect(
      groupItems(g.find((x) => x.id === "decisions")!).map((i) => [
        i.number,
        i.title,
      ]),
    ).toEqual([
      ["0002", "Two"],
      ["0010", "Ten"],
    ]);
    expect(
      groupItems(g.find((x) => x.id === "workflows")!).map((i) => i.title),
    ).toEqual(["feature (keel)", "fix (keel)"]);
  });

  it("an older keel's tree (id, title, status only) gets the same groups, numbers and labels from the ids", () => {
    const old: WikiTree = {
      sections: [
        {
          id: "specs",
          title: "Specs",
          items: [
            { id: "spec:docs/specs/SPEC-2-a.md", title: "SPEC-2: Alpha" },
            { id: "spec:docs/specs/SPEC-10-b.md", title: "SPEC-10: Beta" },
          ],
        },
        {
          id: "knowledge",
          title: "Knowledge",
          items: [
            { id: "kb:architecture", title: "Architecture", status: "written" },
          ],
        },
        {
          id: "runbook",
          title: "Runbook",
          items: [{ id: "runbook", title: "How to run this project" }],
        },
        {
          id: "decisions",
          title: "Decisions",
          items: [{ id: "adr:0001-x.md", title: "ADR 0001 — Use X" }],
        },
        {
          id: "extra",
          title: "Extra",
          items: [{ id: "note:1", title: "A note" }],
        },
      ],
    };
    const g = buildNav(old);
    expect(g.map((x) => x.id)).toEqual([
      "overview",
      "knowledge",
      "specs",
      "decisions",
      "extra",
    ]);
    expect(groupItems(g[2]).map((i) => [i.number, i.title])).toEqual([
      ["10", "Beta"],
      ["2", "Alpha"],
    ]);
    expect(groupItems(g[3])[0].title).toBe("Use X");
    expect(firstPage(g)).toBe("kb:architecture");
    expect(
      numberOf({ id: "spec:docs/specs/v1.1.0-plugin.md", title: "x" }),
    ).toBeUndefined();
    expect(
      labelOf({ id: "spec:a/SPEC-7-x.md", title: "SPEC-8: Other" }, "7"),
    ).toBe("SPEC-8: Other");
  });

  it("each page once, the overview opens first, and a page knows its place", () => {
    const dup: WikiTree = {
      sections: [
        ...tree.sections,
        {
          id: "again",
          title: "Again",
          items: [{ id: "kb:architecture", title: "Architecture" }],
        },
      ],
    };
    const g = buildNav(dup, specs);
    expect(
      groupItems(g.find((x) => x.id === "knowledge")!).filter(
        (i) => i.id === "kb:architecture",
      ),
    ).toHaveLength(1);
    expect(g.map((x) => x.id)).not.toContain("again");
    expect(firstPage(g)).toBe("kb:index");
    const at = placeOf(g, "spec:docs/specs/SPEC-110-cleanup.md")!;
    expect([at.group.title, at.part.title, at.item.also]).toEqual([
      "Specs",
      "In progress",
      [".keel/specs/SPEC-110-cleanup.md"],
    ]);
  });

  it("the filter keeps the matching pages (title, number, path; every word) and drops empty groups", () => {
    const g = buildNav(tree, specs);
    expect(filterNav(g, "  ")).toBe(g);
    const f = filterNav(g, "110");
    expect(f.map((x) => x.id)).toEqual(["specs"]);
    expect(ids(groupItems(f[0]))).toEqual([
      "spec:docs/specs/SPEC-110-cleanup.md",
    ]);
    expect(ids(filterNav(g, "WAVE").flatMap(groupItems))).toEqual([
      "spec:docs/specs/SPEC-101-wave.md",
    ]);
    expect(ids(filterNav(g, "keel fix").flatMap(groupItems))).toEqual([
      "wf:fix",
    ]);
    expect(filterNav(g, "nothing-like-this")).toEqual([]);
  });
});

const LONG =
  "# What an agent needs to know\n\nIntro.\n\n## Layers\n\nText.\n\n## Data\n\nText.\n\n### Tables\n\nText.\n";

function serve() {
  server.use(
    http.get("/api/projects/:pid/wiki", () => HttpResponse.json(tree)),
    http.get("/api/projects/:pid/specs/status", () =>
      HttpResponse.json([...specs.values()]),
    ),
    http.get("/api/projects/:pid/wiki/page", ({ request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      const item = tree.sections
        .flatMap((s) => s.items)
        .find((i) => i.id === id);
      return HttpResponse.json({
        id,
        title: item?.title ?? id,
        markdown:
          id === "kb:index" ? LONG : `# ${item?.title ?? id}\n\nShort.\n`,
        meta: id.startsWith("spec:")
          ? { path: id.slice(5), acs: 1 }
          : { status: "written" },
      });
    }),
  );
}

describe("the Wiki page in order", () => {
  it("opens on the overview with a breadcrumb and On this page; the menu has the groups with counts and status parts", async () => {
    const user = userEvent.setup();
    serve();
    location.hash = "#/wiki";
    render(<App />);
    expect(
      await screen.findByRole("heading", {
        name: "What an agent needs to know",
        level: 2,
      }),
    ).toBeInTheDocument();
    const crumbs = screen.getByRole("navigation", { name: "Breadcrumb" });
    expect(crumbs).toHaveTextContent("Wiki›Overview");
    const toc = screen.getByRole("list", { name: "On this page" });
    expect(
      within(toc)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["Layers", "Data", "Tables"]);
    await user.click(within(toc).getByRole("button", { name: "Data" }));

    const n = screen.getByRole("navigation", { name: "Wiki pages" });
    const heads = within(n)
      .getAllByRole("button")
      .map((b) => b.getAttribute("aria-label") ?? b.textContent);
    expect(heads.map((h) => h?.replace(/[▾▸]/g, ""))).toEqual([
      "Overview2",
      "Architecture & knowledge3",
      "Specs4",
      "Decisions2",
      "Workflows2",
    ]);
    const inProgress = await within(n).findByRole("group", {
      name: "Specs: In progress",
    });
    expect(
      within(inProgress).getByRole("link", { name: /Cleanup/ }),
    ).toHaveTextContent("110Cleanupin progress×2");
    const done = within(n).getByRole("group", { name: "Specs: Done" });
    expect(
      within(done)
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["102Fail-soft parsingbuilt", "101Wave fallbackbuilt"]);
    expect(within(n).getByRole("link", { name: /Domain/ })).toHaveTextContent(
      "not written",
    );
  });

  it("a spec page says where it is and that the same file is in another folder; old links still open", async () => {
    serve();
    location.hash = "#/wiki/spec%3Adocs%2Fspecs%2FSPEC-110-cleanup.md";
    render(<App />);
    const crumbs = await screen.findByRole("navigation", {
      name: "Breadcrumb",
    });
    await waitFor(() =>
      expect(crumbs).toHaveTextContent("Wiki›Specs›In progress"),
    );
    expect(
      await screen.findByText(/The same file is also in/),
    ).toHaveTextContent(".keel/specs/SPEC-110-cleanup.md");
    expect(
      screen.queryByRole("list", { name: "On this page" }),
    ).not.toBeInTheDocument();
  });

  it("the search filters the groups and says when nothing matches", async () => {
    const user = userEvent.setup();
    serve();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await screen.findByRole("navigation", { name: "Wiki pages" });
    const box = screen.getByRole("searchbox", { name: "Search the wiki" });
    await user.type(box, "parsing");
    await waitFor(() =>
      expect(
        within(n)
          .getAllByRole("link")
          .map((a) => a.textContent),
      ).toEqual(["102Fail-soft parsingbuilt"]),
    );
    expect(
      within(n).queryByRole("button", { name: /^Decisions/ }),
    ).not.toBeInTheDocument();
    await user.clear(box);
    await user.type(box, "zzz");
    expect(await within(n).findByText(/No page matches/)).toBeInTheDocument();
  });
});
