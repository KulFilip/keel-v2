// 0.17.3 (docs/plugins/24-wiki-sections-spec-status.md): the Wiki menu's sections open and close (click, Enter, Space;
// aria-expanded and aria-controls; a closed one shows its page count; kept per project in localStorage, and working
// without it; the open page's section stays open; the same in the phone dropdown), and a spec's build status (the pill
// in the menu; built, in progress, stopped with Resume or why and Start, not built with Start and its estimate).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../../web/src/App";
import type { SpecStatus, WikiTree } from "../../../../web/src/api";
import { db, server } from "../../../../web/src/test/setup";

const PID = "ludus-engine";
const KEY = `keel.wiki.closed.${PID}`;

const tree: WikiTree = {
  sections: [
    {
      id: "specs", title: "Specs", items: [
        { id: "spec:.keel/specs/scores.md", title: "Scores" },
        { id: "spec:.keel/specs/login.md", title: "Login" },
        { id: "spec:.keel/specs/export.md", title: "Export" },
        { id: "spec:.keel/specs/ranks.md", title: "Ranks" },
        { id: "spec:.keel/specs/old.md", title: "Old" },
      ],
    },
    { id: "knowledge", title: "Knowledge base", items: [{ id: "kb:architecture", title: "architecture", status: "written" }] },
    { id: "workflows", title: "Workflows", items: [{ id: "wf:feature", title: "feature (keel)" }, { id: "wf:fix", title: "fix (keel)" }] },
  ],
};

const flow = (id: string, state: "built" | "in_progress" | "stopped", status: string, extra: Partial<SpecStatus["flows"][number]> = {}) => ({
  thread_id: id, workflow: "feature", title: `flow ${id}`, status, state, phase: "red", waiting: null,
  created_at: "2026-10-10T10:00:00Z", updated_at: "2026-10-10T10:00:00Z", resumable: false, ...extra,
});

const statuses: SpecStatus[] = [
  {
    spec: "spec:.keel/specs/scores.md", path: ".keel/specs/scores.md", title: "Scores", acs: 3, state: "in_progress",
    thread_id: "t-run", workflow: "feature", flow_title: "Scores flow", status: "waiting", phase: "red", waiting: "AC-2 gate",
    updated_at: "2026-10-10T10:00:00Z", resumable: false, why: null,
    flows: [flow("t-run", "in_progress", "waiting", { waiting: "AC-2 gate" }), flow("t-old", "stopped", "stopped")],
  },
  {
    spec: "spec:.keel/specs/login.md", path: ".keel/specs/login.md", title: "Login", acs: 2, state: "built",
    thread_id: "t-built", workflow: "feature", flow_title: "Login flow", status: "done", phase: "done",
    updated_at: "2026-10-10T10:00:00Z", resumable: false, why: null, flows: [flow("t-built", "built", "done")],
  },
  { spec: "spec:.keel/specs/export.md", path: ".keel/specs/export.md", title: "Export", acs: 2, state: "not_built", flows: [] },
  {
    spec: "spec:.keel/specs/ranks.md", path: ".keel/specs/ranks.md", title: "Ranks", acs: 1, state: "stopped",
    thread_id: "t-stop", workflow: "feature", flow_title: "Ranks flow", status: "stopped", phase: "green",
    updated_at: "2026-10-10T10:00:00Z", resumable: true, why: null, flows: [flow("t-stop", "stopped", "stopped", { resumable: true })],
  },
  {
    spec: "spec:.keel/specs/old.md", path: ".keel/specs/old.md", title: "Old", acs: 4, state: "stopped",
    thread_id: "t-old2", workflow: "feature", flow_title: "Old flow", status: "failed", phase: "red",
    updated_at: "2026-10-10T10:00:00Z", resumable: false,
    why: "A newer flow started after this one: only the last stopped flow can be resumed.", flows: [flow("t-old2", "stopped", "failed")],
  },
];

/** The wiki above, its pages (a spec page has its path and criteria) and the spec status. */
function wiki(status: SpecStatus[] | "error" = statuses) {
  server.use(
    http.get("/api/projects/:pid/wiki", () => HttpResponse.json(tree)),
    http.get("/api/projects/:pid/wiki/page", ({ request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      const item = tree.sections.flatMap((s) => s.items).find((i) => i.id === id);
      const path = id.startsWith("spec:") ? id.slice(5) : undefined;
      return HttpResponse.json({
        id, title: item?.title ?? id, markdown: `# ${item?.title ?? id}\n\n- **AC-1** [API] it works\n`,
        meta: path ? { path, acs: statuses.find((x) => x.path === path)?.acs ?? 1 } : { status: "written" },
      });
    }),
    http.get("/api/projects/:pid/specs/status", () =>
      status === "error" ? HttpResponse.json({ error: "Not found" }, { status: 404 }) : HttpResponse.json(status)),
  );
}

const nav = () => screen.findByRole("navigation", { name: "Wiki pages" });
const section = (n: HTMLElement, name: string) => within(n).getByRole("button", { name: new RegExp(`^${name}`) });
const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);

afterEach(() => {
  vi.restoreAllMocks();
});

describe("Wiki menu sections", () => {
  it("open and close by click, Enter and Space; a closed one shows its page count and stays closed for this project", async () => {
    const user = userEvent.setup();
    wiki();
    localStorage.setItem("keel.wiki.closed.other-project", JSON.stringify(["specs"]));   // another project's choice
    location.hash = "#/wiki/kb%3Aarchitecture";
    const { unmount } = render(<App />);
    const n = await nav();
    const specs = section(n, "Specs");
    expect(specs).toHaveAttribute("aria-expanded", "true");
    const list = document.getElementById(specs.getAttribute("aria-controls")!)!;
    expect(list).toBeVisible();
    expect(within(n).getByRole("link", { name: /^Scores/ })).toBeInTheDocument();

    await user.click(specs);
    expect(specs).toHaveAttribute("aria-expanded", "false");
    expect(list).not.toBeVisible();
    expect(specs).toHaveAccessibleName(/^Specs 5 pages$/);
    expect(within(n).queryByRole("link", { name: /^Scores/ })).not.toBeInTheDocument();
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["specs"]);

    specs.focus();
    await user.keyboard("{Enter}");
    expect(specs).toHaveAttribute("aria-expanded", "true");
    await user.keyboard(" ");
    expect(specs).toHaveAttribute("aria-expanded", "false");
    await user.click(section(n, "Workflows"));
    expect(section(n, "Workflows")).toHaveAccessibleName(/2 pages/);
    expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["specs", "workflows"]);

    // remembered: the page opens again with the same sections closed
    unmount();
    render(<App />);
    const again = await nav();
    expect(section(again, "Specs")).toHaveAttribute("aria-expanded", "false");
    expect(section(again, "Workflows")).toHaveAttribute("aria-expanded", "false");
    expect(section(again, "Project knowledge")).toHaveAttribute("aria-expanded", "true");
  });

  it("keeps the open page's section open, even when it was closed", async () => {
    const user = userEvent.setup();
    wiki();
    localStorage.setItem(KEY, JSON.stringify(["knowledge", "specs"]));
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    const kb = section(n, "Project knowledge");
    expect(kb).toHaveAttribute("aria-expanded", "true");
    expect(kb).toHaveAttribute("aria-disabled", "true");
    await user.click(kb);
    expect(kb).toHaveAttribute("aria-expanded", "true");
    expect(within(n).getByRole("link", { name: /^architecture/ })).toHaveAttribute("aria-current", "page");
    expect(section(n, "Specs")).toHaveAttribute("aria-expanded", "false");
    // searching shows the matches of a closed section
    await user.type(screen.getByRole("searchbox", { name: "Search the wiki" }), "rank");
    // (the match is marked: jsdom, without layout, reads the <mark> as its own word)
    expect(within(n).getByRole("link", { name: /^Rank ?s/ })).toBeVisible();
  });

  it("works without storage (a private window): it toggles and only forgets", async () => {
    const user = userEvent.setup();
    vi.spyOn(Storage.prototype, "getItem").mockImplementation(() => { throw new Error("blocked"); });
    vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => { throw new Error("blocked"); });
    wiki();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    await user.click(section(n, "Specs"));
    expect(section(n, "Specs")).toHaveAttribute("aria-expanded", "false");
    await user.click(section(n, "Specs"));
    expect(section(n, "Specs")).toHaveAttribute("aria-expanded", "true");
  });

  it("on a phone the menu is a dropdown with the same sections, pills and storage", async () => {
    const user = userEvent.setup();
    const had = window.matchMedia;
    window.matchMedia = ((q: string) => ({ matches: q.includes("max-width: 900px"), media: q, addEventListener() {}, removeEventListener() {}, onchange: null })) as unknown as typeof window.matchMedia;
    try {
      wiki();
      location.hash = "#/wiki/kb%3Aarchitecture";
      render(<App />);
      const pick = await screen.findByRole("button", { name: /^Page architecture/ });
      expect(pick).toHaveAttribute("aria-expanded", "false");
      expect(screen.queryByRole("navigation", { name: "Wiki pages" })).not.toBeInTheDocument();
      await user.click(pick);
      expect(pick).toHaveAttribute("aria-expanded", "true");
      expect(document.getElementById(pick.getAttribute("aria-controls")!)).toBeVisible();
      const n = await nav();
      expect(within(n).getByRole("link", { name: /^Login/ })).toHaveTextContent("built");
      await user.click(section(n, "Specs"));
      expect(section(n, "Specs")).toHaveAttribute("aria-expanded", "false");
      expect(JSON.parse(localStorage.getItem(KEY)!)).toEqual(["specs"]);
      await user.keyboard("{Escape}");
      expect(pick).toHaveAttribute("aria-expanded", "false");
      expect(pick).toHaveFocus();
      await user.click(pick);
      await user.click(within(await nav()).getByRole("button", { name: /^Fix/ }));
      await user.click(within(await nav()).getByRole("link", { name: "fix" }));
      await waitFor(() => expect(location.hash).toBe("#/wiki/wf%3Afix"));
      expect(screen.getByRole("button", { name: /^Page fix/ })).toHaveAttribute("aria-expanded", "false");
    } finally {
      window.matchMedia = had;
    }
  });
});

describe("a spec's build status", () => {
  it("shows a pill next to each spec in the menu", async () => {
    wiki();
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const n = await nav();
    // a flow that waits for you says so
    await waitFor(() => expect(within(n).getByRole("link", { name: /^Scores/ })).toHaveTextContent("waiting"));
    expect(within(n).getByRole("link", { name: /^Login/ })).toHaveTextContent("built");
    expect(within(n).getByRole("link", { name: /^Export/ })).toHaveTextContent("not built");
    expect(within(n).getByRole("link", { name: /^Ranks/ })).toHaveTextContent("stopped");
  });

  it("built: the flow that built it, as a link", async () => {
    wiki();
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Flogin.md";
    render(<App />);
    const box = await screen.findByRole("region", { name: "Build status" });
    expect(await within(box).findByText("built")).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: "Login flow" })).toHaveAttribute("href", "#/flow/t-built");
    expect(within(box).queryByRole("button")).not.toBeInTheDocument();
  });

  it("in progress: where it is, what it waits for, Open the flow, and the other flows on the spec", async () => {
    wiki();
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Fscores.md";
    render(<App />);
    const box = await screen.findByRole("region", { name: "Build status" });
    expect(within(box).getByText("in progress")).toBeInTheDocument();
    expect(box).toHaveTextContent("It waits for you: AC-2 gate.");
    expect(within(box).getByRole("link", { name: "Open the flow" })).toHaveAttribute("href", "#/flow/t-run");
    expect(within(box).getByText("Other flows on this spec")).toBeInTheDocument();
    expect(within(box).getByRole("link", { name: "flow t-old" })).toHaveAttribute("href", "#/flow/t-old");
  });

  it("stopped and the last stopped flow: Resume asks for the last saved step, rewinds to it and opens the flow", async () => {
    const user = userEvent.setup();
    wiki();
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Franks.md";
    render(<App />);
    const box = await screen.findByRole("region", { name: "Build status" });
    expect(box).toHaveTextContent("The flow Ranks flow (feature) stopped, in phase green.");
    await user.click(within(box).getByRole("button", { name: "Resume the flow" }));
    await user.click(await within(box).findByRole("button", { name: "Yes, resume" }));
    await waitFor(() => expect(calls("POST", "/api/threads/t-stop/rewind")[0]?.body).toEqual({ checkpoint_id: "cp31" }));
    await waitFor(() => expect(location.hash).toBe("#/flow/t-stop"));
  });

  it("stopped but not the last stopped flow: it says why and offers Start", async () => {
    wiki();
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Fold.md";
    render(<App />);
    const box = await screen.findByRole("region", { name: "Build status" });
    expect(box).toHaveTextContent("failed, in phase red");
    expect(box).toHaveTextContent("only the last stopped flow can be resumed");
    expect(within(box).queryByRole("button", { name: "Resume the flow" })).not.toBeInTheDocument();
    expect(within(box).getByRole("button", { name: "Start a flow from this spec" })).toBeInTheDocument();
  });

  it("not built: Start a flow from this spec, with the feature workflow, the spec as its input and its estimate", async () => {
    const user = userEvent.setup();
    const estimates: string[] = [];
    wiki();
    server.use(http.get("/api/projects/:pid/estimate", ({ request }) => {
      estimates.push(new URL(request.url).search);
      return HttpResponse.json({ tokens: 210000, low: 150000, high: 300000, cost_usd: 3.1, premium_requests: 20, by_provider: {}, per_step: [] });
    }));
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Fexport.md";
    render(<App />);
    const box = await screen.findByRole("region", { name: "Build status" });
    expect(within(box).getByText("not built")).toBeInTheDocument();
    await user.click(within(box).getByRole("button", { name: "Start a flow from this spec" }));
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    expect(within(dlg).getByTestId("sf-spec")).toHaveTextContent("From the spec .keel/specs/export.md");
    await waitFor(() => expect(within(dlg).getByLabelText("Workflow")).toHaveValue("feature"));
    expect(within(dlg).getByLabelText("What to build")).toHaveValue("Export");
    expect(await within(dlg).findByText("210k")).toBeInTheDocument();
    expect(estimates.at(-1)).toContain("workflow_id=feature");
    expect(estimates.at(-1)).toContain("acs=2");
    await user.click(within(dlg).getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(calls("POST", `/api/projects/${PID}/flows`)[0]?.body).toMatchObject({
      workflow_id: "feature", title: "Export", options: { spec: ".keel/specs/export.md" },
    }));
  });

  it("a keel without the status endpoint shows the spec page as before", async () => {
    wiki("error");
    location.hash = "#/wiki/spec%3A.keel%2Fspecs%2Fexport.md";
    render(<App />);
    expect((await screen.findAllByRole("heading", { name: "Export" })).length).toBeGreaterThan(0);
    await waitFor(() => expect(screen.queryByRole("region", { name: "Build status" })).not.toBeInTheDocument());
    const n = await nav();
    expect(within(n).getByRole("link", { name: /^Export/ })).not.toHaveTextContent("not built");
  });
});
