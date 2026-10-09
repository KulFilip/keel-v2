// Step 6 (docs/plugins/16-steps5-7-contract.md): keel with only its core (the core image, or KEEL_PLUGINS=off) is clean.
// No core page links to a page that is not there, and none calls a plugin's api: hasPage(id) in the SDK says which pages
// this keel has. Each place has two checks: core only (no link, no request) and the full keel (the link as before).

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { App } from "../App";
import type { Notification, ThreadState } from "../api";
import { ErDiagram } from "../components/er/ErDiagram";
import { BoxDiagram, type GBox } from "../components/er/BoxDiagram";
import { RefreshStaleButton } from "../components/RefreshStale";
import { GoButton } from "../components/ui";
import type { InboxItem } from "../inboxApi";
import { canOpen } from "../routes";
import { hasPage, registerPage, useHasPage } from "../sdk/registry";
import { AppProvider } from "../state";
import { coreOnly, restorePlugins, withoutPages } from "./coreOnly";
import * as fx from "./fixtures";
import shop from "./fixtures/er-shop.json";
import { db, FakeEventSource, server } from "./setup";
import type { DbSchema } from "../api";

afterEach(() => restorePlugins());

// jsdom has no PointerEvent (the diagrams select a box on pointerdown/up), as in er.test.tsx
class FakePointerEvent extends MouseEvent {
  pointerId: number;
  pointerType: string;
  constructor(type: string, init: PointerEventInit = {}) {
    super(type, init);
    this.pointerId = init.pointerId ?? 1;
    this.pointerType = init.pointerType ?? "mouse";
  }
}
beforeAll(() => vi.stubGlobal("PointerEvent", FakePointerEvent));

/** The paths of every request the page made while a test ran. */
const requests: string[] = [];
const onRequest = ({ request }: { request: Request }) =>
  void requests.push(`${request.method} ${new URL(request.url).pathname}`);
beforeEach(() => {
  requests.length = 0;
  server.events.on("request:start", onRequest);
  // the launcher reads the Inbox (a test that needs items answers with its own)
  server.use(http.get("/api/inbox", () => HttpResponse.json({ items: [], count: 0, kinds: [], projects: [] })));
});
afterEach(() => server.events.removeListener("request:start", onRequest));
const PLUGIN_ROUTE =
  /\/api\/projects\/[^/]+\/(repo|helper|graph|index|wiki|map|tasks|ci|db|git|review)(\/|$)/;
const pluginRequests = () =>
  requests.filter((r) => PLUGIN_ROUTE.test(r.split(" ")[1]));

describe("hasPage: the pages this keel has", () => {
  it("knows a page by its id or an alias, and useHasPage follows a page that comes and goes", () => {
    expect(hasPage("repo")).toBe(true);
    expect(hasPage("code")).toBe(true); // the Code page's alias
    expect(hasPage("keelbot")).toBe(true);
    expect(hasPage("nope")).toBe(false);
    function Probe() {
      return <span>{useHasPage("later") ? "there" : "not there"}</span>;
    }
    render(<Probe />);
    expect(screen.getByText("not there")).toBeInTheDocument();
    let off = () => {};
    act(() => {
      off = registerPage({
        id: "later",
        label: "Later",
        group: "know",
        order: 99,
        component: () => null,
      });
    });
    expect(screen.getByText("there")).toBeInTheDocument();
    act(() => off());
    expect(screen.getByText("not there")).toBeInTheDocument();
  });

  it("core only: keel's own screens can always be opened, a plugin's page cannot", () => {
    coreOnly();
    expect(hasPage("wiki")).toBe(false);
    expect(hasPage("code")).toBe(false);
    for (const id of ["projects", "flow", "inbox", "jobs", "plugins"])
      expect(canOpen(id)).toBe(true);
    for (const id of ["tasks", "repo", "helper", "map", "graph", "wiki"])
      expect(canOpen(id)).toBe(false);
  });

  it("GoButton links to a page this keel has, and to nothing else", () => {
    const view = () =>
      render(
        <>
          <GoButton to="wiki">Open wiki</GoButton>
          <GoButton to="projects">All projects</GoButton>
        </>,
      );
    const full = view();
    expect(screen.getByRole("link", { name: "Open wiki" })).toHaveAttribute(
      "href",
      "#/wiki",
    );
    full.unmount();
    coreOnly();
    view();
    expect(screen.queryByRole("link", { name: "Open wiki" })).toBeNull();
    expect(screen.getByRole("link", { name: "All projects" })).toHaveAttribute(
      "href",
      "#/projects",
    );
  });
});

describe("Flow: the init flow's Wiki links", () => {
  const initFlow = () => {
    const t = db.flows["ludus-engine"].thread!;
    db.flows["ludus-engine"] = {
      workflow: fx.initWorkflow,
      thread: {
        ...t,
        workflow_id: "init",
        status: "running",
        waiting: undefined,
        current: "i3",
        ladder: [],
      } as ThreadState,
    };
  };

  it("full: Open wiki and Read what is written so far", async () => {
    initFlow();
    render(<App />);
    expect(
      await screen.findByRole("link", { name: "Open wiki" }),
    ).toHaveAttribute("href", "#/wiki");
    expect(
      screen.getByRole("link", { name: "Read what is written so far" }),
    ).toHaveAttribute("href", "#/wiki");
  });

  it("core only: the same flow, without a link to the Wiki", async () => {
    coreOnly();
    initFlow();
    render(<App />);
    expect(await screen.findByText("Knowledge build")).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "Open wiki" })).toBeNull();
    expect(
      screen.queryByRole("link", { name: "Read what is written so far" }),
    ).toBeNull();
    expect(pluginRequests()).toEqual([]);
  });
});

describe("the launcher (⌘K)", () => {
  const open = async () => {
    fireEvent.keyDown(window, { key: "k", code: "KeyK", ctrlKey: true });
    return screen.findByRole("dialog", { name: "Launcher" });
  };
  const scopes = (dlg: HTMLElement) =>
    within(within(dlg).getByRole("tablist", { name: "Scope" }))
      .getAllByRole("tab")
      .map((t) => t.textContent);

  it("full: every scope, KeelBot, files and tasks, as before", async () => {
    render(<App />);
    const dlg = await open();
    expect(scopes(dlg)).toEqual([
      "All",
      "Files",
      "Code",
      "Pull requests",
      "Tasks",
      "Flows",
      "Actions",
    ]);
    const box = within(dlg).getByRole("combobox");
    expect(box).toHaveAttribute(
      "placeholder",
      "Search files, code, pull requests, tasks, actions…",
    );
    expect(
      await within(dlg).findByRole("group", { name: "Quick actions" }),
    ).toHaveTextContent("Ask KeelBot…");
    await userEvent.type(box, ">");
    const actions = await within(dlg).findByRole("group", { name: "Actions" });
    expect(actions).toHaveTextContent("Add a task");
    expect(actions).toHaveTextContent("Go to file…");
    expect(dlg.querySelector(".lx-foot")).toHaveTextContent("ask KeelBot");
    expect(dlg.querySelector(".lx-foot")).toHaveTextContent(
      "Prefixes > @ # ! ?",
    );
  });

  it("core only: keel's own scopes and actions, no question to KeelBot, no request to a plugin", async () => {
    coreOnly();
    let searched = 0;
    server.use(
      http.get("/api/projects/:pid/graph/search", () => {
        searched++;
        return HttpResponse.json({ available: true, results: [] });
      }),
    );
    render(<App />);
    const dlg = await open();
    expect(scopes(dlg)).toEqual(["All", "Flows", "Actions"]);
    const box = within(dlg).getByRole("combobox");
    expect(box).toHaveAttribute(
      "placeholder",
      "Search flows, pages and actions…",
    );
    const quick = await within(dlg).findByRole("group", {
      name: "Quick actions",
    });
    expect(quick).not.toHaveTextContent("Ask KeelBot");
    expect(quick).not.toHaveTextContent("Go to file");
    expect(quick).toHaveTextContent("Start a new flow");
    // a word: no code graph search (the Graph plugin's)
    await userEvent.type(box, "settings");
    await new Promise((r) => setTimeout(r, 400));
    expect(searched).toBe(0);
    // the actions: keel's own
    await userEvent.clear(box);
    await userEvent.type(box, ">");
    const actions = await within(dlg).findByRole("group", { name: "Actions" });
    expect(actions).toHaveTextContent("Start a new flow");
    expect(actions).not.toHaveTextContent("Add a task");
    expect(actions).not.toHaveTextContent("Go to file");
    expect(actions).not.toHaveTextContent("Ask KeelBot");
    expect(actions).not.toHaveTextContent("Focus mode in Code");
    // ⌘↩ asks nobody; the footer offers no KeelBot and only the prefixes that find something
    fireEvent.keyDown(box, { key: "Enter", code: "Enter", ctrlKey: true });
    expect(box).toHaveAccessibleName("Search keel");
    const foot = dlg.querySelector(".lx-foot")!;
    expect(foot).not.toHaveTextContent("KeelBot");
    expect(foot).toHaveTextContent("Prefixes > !");
    expect(foot).not.toHaveTextContent("?");
    // "?" is a plain character: no Ask mode, no KeelBot session
    await userEvent.clear(box);
    await userEvent.keyboard("{Backspace}");
    await userEvent.type(box, "?why is it slow{Enter}");
    expect(within(dlg).getByRole("combobox")).toHaveAccessibleName(
      "Search keel",
    );
    expect(within(dlg).queryByText(/KeelBot reads this project/)).toBeNull();
    await new Promise((r) => setTimeout(r, 100));
    expect(pluginRequests()).toEqual([]);
  });
});

describe("the Inbox: Open KeelBot", () => {
  const ask: InboxItem = {
    project_id: "ludus-engine",
    project_name: "ludus-engine",
    thread_id: "h_9",
    flow: "Raise the limit",
    workflow_id: null,
    step: "permission",
    kind: "permission",
    title: "KeelBot asks to run a command",
    detail: "rm -rf build",
    more: false,
    options: ["once", "always", "deny"],
    id: "q_7",
    since: new Date().toISOString(),
    permission: {
      id: "q_7",
      session: "h_9",
      command: "rm -rf build",
      path: null,
    },
  };
  const card = async () => {
    server.use(
      http.get("/api/inbox", () =>
        HttpResponse.json({ items: [ask], count: 1, kinds: [], projects: [] }),
      ),
    );
    location.hash = "#/inbox";
    render(<App />);
    return screen.findByRole("article", {
      name: "KeelBot asks to run a command",
    });
  };

  it("full: opens KeelBot's column in the Code page, as before", async () => {
    const user = userEvent.setup();
    await user.click(
      within(await card()).getByRole("button", {
        name: "Open KeelBot in ludus-engine",
      }),
    );
    await waitFor(() => expect(location.hash).toBe("#/repo"));
  });

  it("without the Code page it opens KeelBot's own page; with neither there is no button", async () => {
    const user = userEvent.setup();
    withoutPages("repo");
    const c = await card();
    await user.click(
      within(c).getByRole("button", { name: "Open KeelBot in ludus-engine" }),
    );
    await waitFor(() => expect(location.hash).toBe("#/helper"));
    restorePlugins();
    document.body.innerHTML = "";
    coreOnly();
    const again = await card();
    expect(
      within(again).getByRole("button", { name: "Deny" }),
    ).toBeInTheDocument();
    expect(
      within(again).queryByRole("button", { name: /Open KeelBot/ }),
    ).toBeNull();
  });
});

describe("the key cheat sheet", () => {
  const sheet = async () => {
    location.hash = "#/flow";
    render(<App />);
    await screen.findByRole("button", { name: "Hide the menu" });
    fireEvent.keyDown(window, { key: "/", code: "Slash", ctrlKey: true });
    const dlg = await screen.findByRole("dialog", { name: "Keyboard keys" });
    await userEvent.click(
      within(dlg).getByRole("checkbox", { name: "Every page" }),
    );
    return dlg;
  };

  it("full: KeelBot's launcher keys and the Map and Graph diagrams", async () => {
    const dlg = await sheet();
    expect(within(dlg).getByText("Ask KeelBot a question")).toBeInTheDocument();
    expect(within(dlg).getByText("Ask KeelBot about it")).toBeInTheDocument();
    expect(within(dlg).getByText("Map and Graph diagrams")).toBeInTheDocument();
  });

  it("core only: no KeelBot key and no diagram keys", async () => {
    coreOnly();
    const dlg = await sheet();
    expect(within(dlg).getByText("Everywhere")).toBeInTheDocument();
    expect(within(dlg).queryByText(/KeelBot/)).toBeNull();
    expect(within(dlg).queryByText("Map and Graph diagrams")).toBeNull();
  });
});

describe("the diagrams' file links (Map, Graph): to the Code page only when this keel has it", () => {
  const schema = shop as unknown as DbSchema;
  const openStructure = () => {
    const { container } = render(
      <ErDiagram schema={schema} pid="shop" name="shop" />,
    );
    const box = container.querySelector(
      '[data-tid="customer_order"]',
    ) as HTMLElement;
    fireEvent.pointerDown(box, { button: 0, pointerId: 1 });
    fireEvent.pointerUp(box, { button: 0, pointerId: 1 });
    fireEvent.keyDown(screen.getByRole("application"), { key: "Enter" });
    return screen.getByRole("complementary", {
      name: "Structure of customer_order",
    });
  };

  it("full: the migration is a link, Open migration too", () => {
    const st = openStructure();
    expect(
      within(st).getByRole("link", { name: "db/migration/V3__orders.sql" }),
    ).toHaveAttribute("href", expect.stringContaining("#/repo/"));
    expect(
      screen.getByRole("link", { name: /Open migration/ }),
    ).toBeInTheDocument();
  });

  it("without the Code page: the same places as text, Open migration is off", () => {
    withoutPages("repo");
    const st = openStructure();
    expect(
      within(st).queryByRole("link", { name: "db/migration/V3__orders.sql" }),
    ).toBeNull();
    expect(
      within(st).getByText("db/migration/V3__orders.sql"),
    ).toBeInTheDocument();
    expect(screen.queryByRole("link", { name: /Open migration/ })).toBeNull();
    expect(
      screen.getByRole("button", { name: /Open migration/ }),
    ).toBeDisabled();
  });

  it("a box's file: a link with the Code page, text without it", () => {
    const boxes: GBox[] = [
      {
        id: "api",
        kind: "api",
        icon: "api",
        title: "api",
        rows: [],
        cite: { rel: "api/App.kt", line: 3 },
      } as GBox,
    ];
    const draw = () => {
      const r = render(
        <BoxDiagram
          pid="shop"
          level="system"
          name="shop"
          boxes={boxes}
          onDrill={() => {}}
        />,
      );
      const box = r.container.querySelector('[data-tid="api"]') as HTMLElement;
      fireEvent.pointerDown(box, { button: 0, pointerId: 1 });
      fireEvent.pointerUp(box, { button: 0, pointerId: 1 });
      return r;
    };
    const full = draw();
    expect(screen.getByRole("link", { name: "api/App.kt:3" })).toHaveAttribute(
      "href",
      expect.stringContaining("#/repo/"),
    );
    full.unmount();
    withoutPages("repo");
    draw();
    expect(screen.queryByRole("link", { name: "api/App.kt:3" })).toBeNull();
    expect(screen.getByText("api/App.kt:3")).toBeInTheDocument();
  });
});

describe("Refresh stale (the Wiki plugin's api)", () => {
  it("is there with the Wiki, and not without it (the Developer set has no Wiki)", () => {
    const view = () =>
      render(
        <AppProvider>
          <RefreshStaleButton pid="ludus-engine" sections={["domain"]} />
        </AppProvider>,
      );
    const full = view();
    expect(
      screen.getByRole("button", { name: "Refresh stale" }),
    ).toBeInTheDocument();
    full.unmount();
    withoutPages("wiki");
    view();
    expect(screen.queryByRole("button", { name: "Refresh stale" })).toBeNull();
  });
});

describe("a notification whose page this keel does not have", () => {
  const note = (link: string): Notification =>
    ({
      id: `n${Math.random()}`,
      type: "finished",
      project_id: "ludus-engine",
      title: "Index ready: 9 files, 40 symbols",
      body: "",
      link,
      at: new Date().toISOString(),
      read: false,
    }) as Notification;

  it("core only: the Graph's 'Index ready' (a link to the Code page) opens the project's Flow, no plugin page", async () => {
    const user = userEvent.setup();
    coreOnly();
    localStorage.setItem("keel2.mascot", "1");
    render(<App />);
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() =>
      FakeEventSource.emit("notification", note("/projects/ludus-engine/repo")),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Open notification: Index ready: 9 files, 40 symbols",
      }),
    );
    await waitFor(() => expect(location.hash).toBe("#/repo"));
    expect(
      await screen.findByRole("button", { name: "Stop flow" }),
    ).toBeInTheDocument();
    expect(pluginRequests()).toEqual([]);
  });

  it("an add-on's page (keel Product's #/initiatives) keeps its own link", async () => {
    const user = userEvent.setup();
    localStorage.setItem("keel2.mascot", "1");
    render(<App />);
    await waitFor(() =>
      expect(FakeEventSource.instances.length).toBeGreaterThan(0),
    );
    act(() =>
      FakeEventSource.emit("notification", {
        ...note("/initiatives/INI-3"),
        title: "A question on INI-3",
      }),
    );
    await user.click(
      await screen.findByRole("button", {
        name: "Open notification: A question on INI-3",
      }),
    );
    await waitFor(() => expect(location.hash).toBe("#/initiatives/INI-3"));
  });
});
