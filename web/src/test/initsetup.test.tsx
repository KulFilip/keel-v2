// keel 0.18.55 adding a project offers to set keel up for it (the init flow): the card after Add projects and the
// first time a project found by itself opens, the Flow page's banner after that, and the ask before another flow
// starts on a project keel does not know yet (Start a flow: Run init first / Start anyway).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import type { Folders, Project } from "../api";
import { App } from "../App";
import { db, server } from "./setup";

const shop = (over: Partial<Project> = {}): Project => ({
  id: "shop",
  name: "shop",
  root: "/workspace/shop",
  branch: "main",
  flow: null,
  phase: "none",
  acs: [0, 0],
  waiting: 0,
  running: 0,
  configured: false,
  ...over,
});

const FOLDERS: Folders = {
  roots: [{ path: "/folders/work", exists: true }],
  repos: [
    {
      path: "/folders/work/shop",
      name: "shop",
      root: "/folders/work",
      project_id: null,
    },
    {
      path: "/folders/work/blog",
      name: "blog",
      root: "/folders/work",
      project_id: null,
    },
  ],
  truncated: false,
};

/** The folder routes; the bulk add adds shop (keel does not know it yet) and blog (it has a .keel/config.yml). */
function folders() {
  server.use(
    http.get("/api/folders", () => HttpResponse.json(FOLDERS)),
    http.post("/api/projects/bulk", async ({ request }) => {
      const body = (await request.json()) as { roots: string[] };
      const added = body.roots.map((r) =>
        r.endsWith("/shop")
          ? shop({ root: r })
          : shop({ id: "blog", name: "blog", root: r, configured: true }),
      );
      db.projects.push(...added);
      return HttpResponse.json({ added, skipped: [] });
    }),
  );
}

const flowStarts = () =>
  db.calls.filter(
    (c) =>
      c.method === "POST" && /^\/api\/projects\/[^/]+\/flows$/.test(c.path),
  );

async function openAdd() {
  location.hash = "#/projects";
  render(<App />);
  await screen.findByText("/workspace/platform");
  await userEvent.click(
    screen.getAllByRole("button", { name: "Add projects" })[0],
  );
  return screen.findByRole("dialog", { name: "Add projects" });
}

describe("init when a project is added", () => {
  it("after Add projects: a card for the project keel does not know, Set up now starts init and opens it", async () => {
    const user = userEvent.setup();
    folders();
    const dlg = await openAdd();
    await user.click(
      await within(dlg).findByRole("checkbox", { name: "shop" }),
    );
    await user.click(within(dlg).getByRole("checkbox", { name: "blog" }));
    await user.click(
      within(dlg).getByRole("button", { name: "Add 2 projects" }),
    );

    const card = await within(dlg).findByRole("region", {
      name: "Set up keel for shop",
    });
    expect(card).toHaveTextContent(
      "finds the stack and the test commands, and writes .keel/config.yml and the project knowledge",
    );
    // blog has a .keel/config.yml: no card for it
    expect(
      within(dlg).queryByRole("region", { name: "Set up keel for blog" }),
    ).not.toBeInTheDocument();

    await user.click(
      within(card).getByRole("button", { name: "Set up now (recommended)" }),
    );
    await waitFor(() => expect(flowStarts()).toHaveLength(1));
    expect(flowStarts()[0]).toMatchObject({
      path: "/api/projects/shop/flows",
      body: { workflow_id: "init", title: "Set up keel for shop" },
    });
    // the drawer closes and the Flow page shows shop's init flow
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Add projects" }),
      ).not.toBeInTheDocument(),
    );
    await waitFor(() => expect(location.hash).toBe("#/flow"));
    expect(localStorage.getItem("keel2.project")).toBe("shop");
  });

  it("Later puts the card away; a project added by path gets the card instead of the drawer closing", async () => {
    const user = userEvent.setup();
    folders();
    server.use(
      http.post("/api/projects", async ({ request }) => {
        const b = (await request.json()) as { root: string };
        const p = shop({ root: b.root });
        db.projects.push(p);
        return HttpResponse.json(p);
      }),
    );
    const dlg = await openAdd();
    await user.click(within(dlg).getByText("Add by path"));
    const root = within(dlg).getByLabelText("Folder inside the container");
    await user.clear(root);
    await user.type(root, "/workspace/shop");
    await user.click(within(dlg).getByRole("button", { name: "Add repo" }));

    const card = await within(dlg).findByRole("region", {
      name: "Set up keel for shop",
    });
    expect(
      screen.getByRole("dialog", { name: "Add projects" }),
    ).toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Later" }));
    expect(
      within(dlg).queryByRole("region", { name: "Set up keel for shop" }),
    ).not.toBeInTheDocument();
    expect(flowStarts()).toHaveLength(0);
    // answered: the Flow page shows the banner, not the card again
    expect(localStorage.getItem("keel2.init-offered.shop")).toBe("true");
  });

  it("a project found by itself: the card the first time it opens, then the banner, whose Run init starts init", async () => {
    const user = userEvent.setup();
    db.projects.push(shop());
    localStorage.setItem("keel2.project", "shop");
    location.hash = "#/flow";
    const first = render(<App />);
    const card = await screen.findByRole("region", {
      name: "Set up keel for shop",
    });
    expect(screen.queryByTestId("init-banner")).not.toBeInTheDocument();
    await user.click(within(card).getByRole("button", { name: "Later" }));
    const banner = await screen.findByRole("region", {
      name: "keel does not know this project yet",
    });
    expect(banner).toHaveTextContent("keel does not know shop yet.");
    first.unmount();

    // opened again: only the banner
    render(<App />);
    const again = await screen.findByTestId("init-banner");
    expect(
      screen.queryByRole("region", { name: "Set up keel for shop" }),
    ).not.toBeInTheDocument();
    await user.click(within(again).getByRole("button", { name: "Run init" }));
    await waitFor(() =>
      expect(flowStarts()[0]).toMatchObject({
        path: "/api/projects/shop/flows",
        body: { workflow_id: "init" },
      }),
    );
  });

  it("a project keel knows, or a keel that does not say: no card, no banner", async () => {
    db.projects.push(shop({ configured: true }));
    localStorage.setItem("keel2.project", "shop");
    location.hash = "#/flow";
    render(<App />);
    expect(
      await screen.findByText("Nothing running here yet"),
    ).toBeInTheDocument();
    expect(screen.queryByTestId("init-card")).not.toBeInTheDocument();
    expect(screen.queryByTestId("init-banner")).not.toBeInTheDocument();
  });
});

describe("Start a flow on a project keel does not know yet", () => {
  async function startFeature(user: ReturnType<typeof userEvent.setup>) {
    localStorage.setItem("keel2.init-offered.shop", "true");
    db.projects.push(shop());
    localStorage.setItem("keel2.project", "shop");
    location.hash = "#/flow";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start a flow" }),
    );
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    await waitFor(() =>
      expect(within(dlg).getByLabelText("Workflow")).toHaveValue("feature"),
    );
    await user.type(
      within(dlg).getByLabelText("What to build"),
      "Rank next to the top 10",
    );
    await user.click(within(dlg).getByRole("button", { name: "Start flow" }));
    return dlg;
  }

  it("asks first; Start anyway starts the flow that was picked, and does not ask again", async () => {
    const user = userEvent.setup();
    const dlg = await startFeature(user);
    const ask = await within(dlg).findByRole("group", {
      name: "keel does not know this project yet",
    });
    expect(ask).toHaveTextContent("shop has no .keel/config.yml.");
    expect(flowStarts()).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "Start anyway" }));
    await waitFor(() => expect(flowStarts()).toHaveLength(1));
    expect(flowStarts()[0].body).toMatchObject({
      workflow_id: "feature",
      title: "Rank next to the top 10",
    });
  });

  it("Run init first starts init instead and opens it", async () => {
    const user = userEvent.setup();
    const dlg = await startFeature(user);
    const ask = await within(dlg).findByRole("group", {
      name: "keel does not know this project yet",
    });
    await user.click(
      within(ask).getByRole("button", { name: "Run init first (recommended)" }),
    );
    await waitFor(() => expect(flowStarts()).toHaveLength(1));
    expect(flowStarts()[0]).toMatchObject({
      path: "/api/projects/shop/flows",
      body: { workflow_id: "init", title: "Set up keel for shop" },
    });
    await waitFor(() =>
      expect(
        screen.queryByRole("dialog", { name: "Start a flow" }),
      ).not.toBeInTheDocument(),
    );
  });

  it("init itself, or a project keel knows, starts without the ask", async () => {
    const user = userEvent.setup();
    db.projects.push(shop({ configured: true }));
    localStorage.setItem("keel2.project", "shop");
    location.hash = "#/flow";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Start a flow" }),
    );
    const dlg = await screen.findByRole("dialog", { name: "Start a flow" });
    await waitFor(() =>
      expect(within(dlg).getByLabelText("Workflow")).toHaveValue("feature"),
    );
    await user.type(
      within(dlg).getByLabelText("What to build"),
      "Rank next to the top 10",
    );
    await user.click(within(dlg).getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(flowStarts()).toHaveLength(1));
    expect(screen.queryByTestId("init-ask")).not.toBeInTheDocument();
  });

  it("the project list marks a project keel does not know yet", async () => {
    db.projects.push(shop());
    location.hash = "#/projects";
    render(<App />);
    const row = (await screen.findAllByTestId("project-row")).find((r) =>
      r.textContent?.includes("/workspace/shop"),
    )!;
    expect(within(row).getByTestId("not-set-up")).toHaveTextContent(
      "not set up",
    );
  });
});
