// 0.18.55 the Wiki's sidebar, easier to scan: workflows by purpose from their metadata (Product only while keel Product
// is on, a workflow keel does not name goes to Other, the user's own to Yours), the knowledge sections not written yet
// folded into one row with "Write them", a search that opens the groups with a match and marks it (Esc and Clear end
// it), the last pages opened (Recent, newest first) and group titles in sentence case without a caps transform.

import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import type { WikiTree } from "../../../../web/src/api";
import { db, server } from "../../../../web/src/test/setup";
import { buildNav, groupItems, pushRecent, recentItems } from "../nav";

const PID = "ludus-engine";

const workflows: WikiTree["sections"][number] = {
  id: "workflows",
  title: "Workflows",
  items: [
    { id: "wf:fix", title: "fix (keel)", kind: "workflow", source: "keel" },
    {
      id: "wf:clarify",
      title: "clarify (keel)",
      kind: "workflow",
      source: "keel",
    },
    {
      id: "wf:feature",
      title: "feature (keel)",
      kind: "workflow",
      source: "keel",
    },
    {
      id: "wf:diagnose",
      title: "diagnose (keel)",
      kind: "workflow",
      source: "keel",
    },
    {
      id: "wf:review-pr",
      title: "review a PR (keel)",
      kind: "workflow",
      source: "keel",
    },
    {
      id: "wf:hunt-next",
      title: "hunt next (keel)",
      kind: "workflow",
      source: "keel",
    },
    {
      id: "wf:knowledge-refresh",
      title: "knowledge refresh (keel)",
      kind: "workflow",
      source: "keel",
    },
    { id: "wf:init", title: "init (keel)", kind: "workflow", source: "keel" },
    {
      id: "wf:product-discover",
      title: "discover (keel Product)",
      kind: "workflow",
      source: "keel",
      addon: "product",
    },
    {
      id: "wf:release-notes",
      title: "Release notes",
      kind: "workflow",
      source: "yours",
      based_on: "ship",
    },
    {
      id: "wf:ci-fix",
      title: "ci fix (keel)",
      kind: "workflow",
      source: "keel",
    },
  ],
};

const tree: WikiTree = {
  sections: [
    {
      id: "specs",
      title: "Specs",
      items: [
        {
          id: "spec:.keel/specs/export.md",
          title: "Export a report",
          kind: "spec",
        },
        {
          id: "spec:.keel/specs/login.md",
          title: "Sign in with email",
          kind: "spec",
        },
      ],
    },
    {
      id: "knowledge",
      title: "Knowledge",
      items: [
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
          status: "missing",
          kind: "knowledge",
          label: "Data",
        },
        {
          id: "kb:journeys",
          title: "Journeys",
          status: "missing",
          kind: "knowledge",
          label: "Journeys",
        },
      ],
    },
    workflows,
  ],
};

function serve() {
  server.use(
    http.get("/api/projects/:pid/wiki", () => HttpResponse.json(tree)),
    http.get("/api/projects/:pid/specs/status", () => HttpResponse.json([])),
    http.get("/api/projects/:pid/wiki/page", ({ request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      return HttpResponse.json({
        id,
        title: id,
        markdown: `# ${id}\n\nText.\n`,
        meta: { status: "written" },
      });
    }),
  );
}

const nav = () => screen.findByRole("navigation", { name: "Wiki pages" });
/** A page's link by its id (the search marks the match, and jsdom reads a <mark> as its own word in the name). */
const linkTo = (n: HTMLElement, id: string) =>
  n.querySelector<HTMLAnchorElement>(
    `a[href="#/wiki/${encodeURIComponent(id)}"]`,
  );
const listOf = (b: HTMLElement) =>
  document.getElementById(b.getAttribute("aria-controls")!)!;
const parts = (t: WikiTree, opts?: { product?: boolean }) =>
  buildNav(t, new Map(), opts)
    .find((g) => g.id === "workflows")!
    .parts.map((p) => [p.title, p.items.map((i) => i.title)]);

describe("workflows by purpose", () => {
  it("groups keel's workflows by purpose from their metadata, without the (keel) suffix; unknown ones go to Other", () => {
    expect(parts({ sections: [workflows] })).toEqual([
      ["Build", ["feature", "clarify"]],
      ["Fix", ["fix", "diagnose"]],
      ["Check & ship", ["review a PR", "hunt next"]],
      ["Set up & learn", ["init", "knowledge refresh"]],
      ["Product", ["discover"]],
      ["Yours", ["Release notes"]],
      ["Other", ["ci fix"]],
    ]);
    const g = buildNav({ sections: [workflows] })[0];
    expect(g.parts.every((p) => p.fold === "sub")).toBe(true);
    const items = groupItems(g);
    // a tag only on the ones that are not keel's own
    expect(items.filter((i) => i.tag).map((i) => [i.title, i.tag])).toEqual([
      ["discover", "Product"],
      ["Release notes", "yours"],
    ]);
    expect(items.find((i) => i.id === "wf:release-notes")?.basedOn).toBe(
      "ship",
    );
  });

  it("leaves the Product group out when keel Product is off", () => {
    expect(
      parts({ sections: [workflows] }, { product: false }).map((p) => p[0]),
    ).toEqual([
      "Build",
      "Fix",
      "Check & ship",
      "Set up & learn",
      "Yours",
      "Other",
    ]);
    // keel lists no Product workflow while it is off: no Product group either
    const off = {
      ...workflows,
      items: workflows.items.filter((i) => i.addon !== "product"),
    };
    expect(parts({ sections: [off] }).map((p) => p[0])).not.toContain(
      "Product",
    );
  });

  it("an older keel without the metadata gets the same purposes from the names", () => {
    const old: WikiTree = {
      sections: [
        {
          id: "workflows",
          title: "Workflows",
          items: [
            { id: "wf:fix", title: "fix (keel)" },
            { id: "wf:product-plan", title: "plan (keel Product)" },
            { id: "wf:my-flow", title: "My flow" },
          ],
        },
      ],
    };
    expect(parts(old)).toEqual([
      ["Fix", ["fix"]],
      ["Product", ["plan"]],
      ["Yours", ["My flow"]],
    ]);
  });
});

describe("knowledge not written yet", () => {
  it("folds into one row, expandable, and Write them starts the librarians for those sections", async () => {
    const user = userEvent.setup();
    serve();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    expect(
      within(n).getByRole("button", { name: /^Project knowledge/ }),
    ).toHaveAccessibleName("Project knowledge 1 page");
    const row = within(n).getByRole("button", { name: /^3 not written/ });
    expect(row).toHaveAttribute("aria-expanded", "false");
    expect(linkTo(n, "kb:domain")).toBeNull();
    await user.click(row);
    expect(row).toHaveAttribute("aria-expanded", "true");
    expect(
      within(listOf(row))
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Domain", "Data", "Journeys"]);

    await user.click(within(n).getByRole("button", { name: "Write them" }));
    await waitFor(() =>
      expect(
        db.calls.filter(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/projects/${PID}/wiki/refresh`,
        )[0]?.body,
      ).toEqual({ sections: ["domain", "data", "journeys"] }),
    );
    expect(await within(n).findByRole("status")).toHaveAttribute(
      "href",
      "#/flow/th_kr1",
    );
  });

  it("knowledge's parts: the written sections, then one folded row", () => {
    const k = buildNav(tree).find((g) => g.id === "knowledge")!;
    expect(
      k.parts.map((p) => [p.fold ?? "", p.items.map((i) => i.id)]),
    ).toEqual([
      ["", ["kb:architecture"]],
      ["missing", ["kb:domain", "kb:data", "kb:journeys"]],
    ]);
  });
});

describe("the search", () => {
  it("filters across groups, opens the ones with a match, marks it; No page matches has Clear; Esc clears", async () => {
    const user = userEvent.setup();
    serve();
    localStorage.setItem(
      `keel.wiki.closed.${PID}`,
      JSON.stringify(["specs", "workflows"]),
    );
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    const box = screen.getByRole("searchbox", { name: "Search the wiki" });
    expect(
      within(n).getByRole("button", { name: /^Workflows/ }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.type(box, "diag");
    const fix = within(n).getByRole("button", { name: /^Fix/ });
    expect(
      within(n).getByRole("button", { name: /^Workflows/ }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(fix).toHaveAttribute("aria-expanded", "true");
    expect(linkTo(n, "wf:diagnose")).toBeVisible();
    expect(linkTo(n, "wf:diagnose")!.querySelector("mark")).toHaveTextContent(
      "diag",
    );
    expect(linkTo(n, "wf:fix")).toBeNull();
    expect(
      within(n).queryByRole("button", { name: /^Specs/ }),
    ).not.toBeInTheDocument();

    // a match in another group opens that one too
    await user.clear(box);
    await user.type(box, "report");
    expect(within(n).getByRole("button", { name: /^Specs/ })).toHaveAttribute(
      "aria-expanded",
      "true",
    );
    expect(linkTo(n, "spec:.keel/specs/export.md")).toBeVisible();

    await user.clear(box);
    await user.type(box, "zzz");
    expect(within(n).getByRole("status")).toHaveTextContent(
      "No page matches “zzz”.",
    );
    await user.click(within(n).getByRole("button", { name: "Clear search" }));
    expect(box).toHaveValue("");
    expect(box).toHaveFocus();
    expect(
      within(n).getByRole("button", { name: /^Workflows/ }),
    ).toHaveAttribute("aria-expanded", "false");

    await user.type(box, "fix");
    expect(linkTo(n, "wf:fix")).toBeVisible();
    await user.keyboard("{Escape}");
    expect(box).toHaveValue("");
    expect(linkTo(n, "wf:fix")).toBeNull();
  });
});

describe("recent pages", () => {
  it("keeps the last pages opened, newest first, each once, at most six", () => {
    expect(pushRecent(["a", "b", "c"], "b")).toEqual(["b", "a", "c"]);
    expect(pushRecent(["1", "2", "3", "4", "5", "6"], "7")).toEqual([
      "7",
      "1",
      "2",
      "3",
      "4",
      "5",
    ]);
    const g = buildNav(tree);
    // without the open page and pages the wiki no longer has
    expect(
      recentItems(
        g,
        ["kb:architecture", "spec:gone.md", "wf:fix", "kb:domain"],
        "kb:architecture",
      ).map((i) => i.id),
    ).toEqual(["wf:fix", "kb:domain"]);
  });

  it("shows Recent at the top of the menu, newest first, without the open page", async () => {
    const user = userEvent.setup();
    serve();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    expect(
      within(n).queryByRole("button", { name: /^Recent/ }),
    ).not.toBeInTheDocument();
    await user.click(linkTo(n, "spec:.keel/specs/export.md")!);
    await waitFor(() =>
      expect(location.hash).toBe("#/wiki/spec%3A.keel%2Fspecs%2Fexport.md"),
    );
    await user.click(linkTo(n, "spec:.keel/specs/login.md")!);
    await waitFor(() =>
      expect(location.hash).toBe("#/wiki/spec%3A.keel%2Fspecs%2Flogin.md"),
    );
    const recent = await within(n).findByRole("button", { name: /^Recent/ });
    expect(
      within(listOf(recent))
        .getAllByRole("link")
        .map((a) => a.textContent),
    ).toEqual(["Export a report", "Architecture"]);
    // marked once: in its group, not in Recent
    expect(n.querySelectorAll('a[aria-current="page"]')).toHaveLength(1);
    expect(
      JSON.parse(localStorage.getItem(`keel.wiki.recent.${PID}`)!),
    ).toEqual([
      "spec:.keel/specs/login.md",
      "spec:.keel/specs/export.md",
      "kb:architecture",
    ]);
  });
});

describe("group titles", () => {
  it("are sentence case, on one line, with no caps transform or letter spacing", async () => {
    serve();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    expect(
      [...n.querySelectorAll("button.wt-h .wt-ht")].map((t) => t.textContent),
    ).toEqual(["Specs", "Project knowledge", "Workflows"]);
    const css = [
      "../../../../web/src/styles.css",
      "../../../../web/src/styles/pages.css",
    ]
      .map((f) =>
        readFileSync(fileURLToPath(new URL(f, import.meta.url)), "utf8"),
      )
      .join("\n");
    const rules = [...css.matchAll(/([^{}]+)\{([^}]*)\}/g)].filter(([, sel]) =>
      /\.wt-h(?![\w-])/.test(sel),
    );
    expect(rules.length).toBeGreaterThan(0);
    for (const [, sel, body] of rules) {
      expect(body, sel).not.toMatch(/text-transform:\s*uppercase/);
      expect(body, sel).not.toMatch(/letter-spacing:\s*(?!0[;\s]|normal)/);
    }
    const main = rules.find(([, sel]) => sel.trim() === ".wt-h")!;
    const size = Number(/font-size:\s*([\d.]+)px/.exec(main[2])?.[1]);
    expect(size).toBeGreaterThanOrEqual(13);
    expect(size).toBeLessThanOrEqual(14);
    expect(css).toMatch(
      /\.wt-ht\s*\{[^}]*text-overflow:\s*ellipsis[^}]*white-space:\s*nowrap/,
    );
  });
});
