// v0.10.0 the Database and Git plugins in the web: install on Tools, Connections › GitHub, the Code page's branch tab,
// KeelBot's blocks of theirs as their cards, and Claude Code's question in the Inbox. Their own pieces are tested with
// them: plugins/db/web/test (Connections › Databases, Code › Database, KeelBot's query button, a db: block's settings on
// the Workflows page; Map › Query: plugins/map/web/test) and plugins/git/web/test (Code › Git, KeelBot's git buttons).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);

function chatWith(text: string) {
  db.helper.sessions.push({ id: "h1", project: "ludus-engine", root: "/w", mode: "ask", title: "Data", status: "idle", busy: false,
    model: { provider: "claude", mode: "subscription", model: "sonnet" }, tokens_in: 0, tokens_out: 0, tokens_cached: 0, cost_usd: 0, turns: 1,
    created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
    messages: [{ n: 1, role: "user", text: "q", data: {}, at: new Date().toISOString() },
      { n: 2, role: "helper", text, call_id: "c1", data: { status: "done", provider: "claude", model: "sonnet", tokens_in: 1, tokens_out: 1, cost_usd: 0, ms: 1 },
        at: new Date().toISOString() }] } as never);
  localStorage.setItem("keel2.helper.ludus-engine.session", "h1");
  location.hash = "#/keelbot";
  render(<App />);
  return screen.findByRole("complementary", { name: "KeelBot" });
}

// v0.17.1 plugins are switched only in Control › Plugins (docs/plugins/22-one-plugins-page.md): the Tools page has no
// Plugins section any more; a plugin that is on still brings its server to "Who may use what".
describe("Tools: no Plugins section", () => {
  it("shows servers, recent calls and who may use what, and no plugin cards or switches", async () => {
    location.hash = "#/tools";
    render(<App />);
    expect(await screen.findByRole("heading", { name: "Servers" })).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Recent tool calls" })).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Plugins" })).toBeNull();
    expect(screen.queryByRole("article", { name: "Database plugin" })).toBeNull();
    expect(screen.queryByRole("button", { name: /^Install for / })).toBeNull();
    expect(screen.queryByText(/Plugins keel adds/)).toBeNull();
    expect(screen.getByText(/Plugins are turned on in Control › Plugins/)).toBeInTheDocument();
    expect(screen.queryByRole("checkbox", { name: "explorer may use keel-db" })).toBeNull();
  });

  it("a plugin that is on for this project still brings its server to who may use what", async () => {
    db.projectPlugins["ludus-engine"] = { db: true };
    location.hash = "#/tools";
    render(<App />);
    expect(await screen.findByRole("checkbox", { name: "explorer may use keel-db" })).toBeEnabled();
  });
});

describe("Control › Plugins: a plugin each project turns on", () => {
  function installDbGit() {
    db.market.installed = [
      { name: "db", title: "Database", version: "1.4.0", from: "image", on: true, parts: ["engine", "api", "web"], status: "loaded", can_remove: false },
      { name: "git", title: "Git", version: "1.0.0", from: "image", on: true, parts: ["engine", "api", "web"], status: "loaded", can_remove: false },
      { name: "wiki", title: "Wiki", version: "1.1.0", from: "image", on: true, parts: ["web"], status: "loaded", can_remove: false },
    ];
  }

  it("Installed: 'This project' under the keel-wide switch, and For every project", async () => {
    const user = userEvent.setup();
    installDbGit();
    location.hash = "#/plugins";
    render(<App />);
    const row = await screen.findByTestId("plugin-db");
    const mine = await within(row).findByRole("switch", { name: "Database on for ludus-engine" });
    expect(mine).not.toBeChecked();
    expect(row).toHaveTextContent("This project: Off");
    expect(within(row).getByRole("switch", { name: "Database on" })).toBeChecked(); // the keel-wide one stays
    // a plugin no project switches has only the keel-wide switch
    expect(within(screen.getByTestId("plugin-wiki")).getAllByRole("switch")).toHaveLength(1);

    await user.click(mine);
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/plugins/db")[0]?.body).toEqual({ enabled: true, scope: "project" }));
    await waitFor(() => expect(within(row).getByRole("switch", { name: "Database on for ludus-engine" })).toBeChecked());
    expect(row).toHaveTextContent("This project: On");
    expect(calls("PUT", "/api/plugins/db")).toHaveLength(0); // the keel-wide switch is not touched

    const git = screen.getByTestId("plugin-git");
    await user.click(within(git).getByRole("button", { name: "Turn Git on for every project" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/plugins/git")[0]?.body).toEqual({ enabled: true, scope: "all" }));
    expect(await within(git).findByText("every project")).toBeInTheDocument();
  });

  it("the plugin's page: what it adds, and Projects with a switch per project", async () => {
    const user = userEvent.setup();
    installDbGit();
    db.projectPlugins.platform = { db: true };
    location.hash = "#/plugins/db";
    render(<App />);
    const about = await screen.findByRole("region", { name: "About" });
    await waitFor(() => expect(about).toHaveTextContent("KeelBot toolsdb_connections, db_schema, db_query"));
    expect(about).toHaveTextContent("Workflow blocksdb:check, db:query");
    expect(about).toHaveTextContent("Commands/sql");
    expect(about).toHaveTextContent("Shows inConnections · Map › Query · Workflows blocks · KeelBot · Inbox");

    const projects = await screen.findByRole("region", { name: "Projects" });
    const list = await within(projects).findByRole("list", { name: "Projects with Database" });
    expect(within(list).getAllByRole("switch").map((s) => s.getAttribute("aria-label"))).toEqual([
      "Database on for ludus-engine", "Database on for platform", "Database on for YegiResearcher"]);
    expect(within(list).getByRole("switch", { name: "Database on for platform" })).toBeChecked();
    expect(list).toHaveTextContent("on: its own choice");

    await user.click(within(list).getByRole("switch", { name: "Database on for YegiResearcher" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/yegi/plugins/db")[0]?.body).toEqual({ enabled: true, scope: "project" }));
    await waitFor(() => expect(within(list).getByRole("switch", { name: "Database on for YegiResearcher" })).toBeChecked());

    await user.click(within(projects).getByRole("button", { name: "On for every project" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/plugins/db")[0]?.body).toEqual({ enabled: true, scope: "all" }));
    await waitFor(() => expect(within(list).getByRole("switch", { name: "Database on for ludus-engine" })).toBeChecked());
    expect(list).toHaveTextContent("on: follows every project");
  });

  it("a plugin no project switches has no Projects section", async () => {
    installDbGit();
    location.hash = "#/plugins/wiki";
    render(<App />);
    expect(await screen.findByRole("region", { name: "About" })).toBeInTheDocument();
    // the projects' lists are read; wiki is in none of them
    await waitFor(() => expect(db.calls.length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 50));
    expect(screen.queryByRole("region", { name: "Projects" })).toBeNull();
  });
});

describe("Workflows: a block of a plugin that is off", () => {
  it("says to turn it on in Control › Plugins, with a link to the plugin's page", async () => {
    const user = userEvent.setup();
    location.hash = "#/workflows/feature";
    render(<App />);
    await user.click((await screen.findAllByRole("button", { name: /^verify_red, plain code/ }))[0]);
    const act = await screen.findByLabelText("What it runs");
    await user.clear(act);
    await user.type(act, "db:check");
    expect(await screen.findByText(/This block belongs to a plugin that is off for this project/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "Control › Plugins" })).toHaveAttribute("href", "#/plugins/db");
  });
});

describe("Connections › GitHub", () => {
  it("keeps the GitHub token", async () => {
    const user = userEvent.setup();
    location.hash = "#/connections";
    render(<App />);
    await user.type(await screen.findByLabelText("GitHub token"), "ghp_123456789");
    await user.click(within(screen.getByLabelText("GitHub token").closest(".gh-row") as HTMLElement).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT", "/api/secrets/GITHUB_REPO_TOKEN")[0]?.body).toEqual({ value: "ghp_123456789" }));
    expect(await screen.findByText("token set …789")).toBeInTheDocument();
  });
});

describe("Code › Source control › a branch", () => {
  it("opens a branch as a tab with its changed files, a file's diff, its commits, and switches to another", async () => {
    const user = userEvent.setup();
    location.hash = "#/repo";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Source control" }));
    // without the Git plugin a branch is only a line
    await user.click(await screen.findByRole("button", { name: /^Branches/ }));
    expect(await screen.findByText("this flow")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Open the branch feat/scores" })).not.toBeInTheDocument();
  });

  it("with the Git plugin: a click on a branch shows what it changed and lets the person switch", async () => {
    const user = userEvent.setup();
    db.plugins.git = true;
    location.hash = "#/repo";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Source control" }));
    await user.click(await screen.findByRole("button", { name: "Open the branch feat/scores" }));
    const tab = await screen.findByRole("region", { name: "Branch feat/scores" });
    expect(within(tab).getByText("current")).toBeInTheDocument();
    expect(within(tab).queryByRole("button", { name: /Switch to/ })).not.toBeInTheDocument();
    const files = within(tab).getByRole("region", { name: "Changed files" });
    expect(within(files).getAllByRole("button").map((b) => b.getAttribute("aria-label"))).toEqual([
      "Show the changes of api/ScoreController.kt on feat/scores", "Show the changes of api/Euro.kt on feat/scores"]);
    // the first file's diff shows at once, against base...branch; another file on a click
    expect(await within(tab).findByText("main…feat/scores")).toBeInTheDocument();
    await user.click(within(files).getByRole("button", { name: "Show the changes of api/Euro.kt on feat/scores" }));
    expect(within(files).getByRole("button", { name: "Show the changes of api/Euro.kt on feat/scores" })).toHaveAttribute("aria-pressed", "true");
    expect(within(tab).getByRole("region", { name: "Commits" })).toHaveTextContent("feat(AC-002): refuse a negative score");

    // main: the base, and Switch
    await user.click(screen.getByRole("button", { name: "Open the branch main" }));
    const main = await screen.findByRole("region", { name: "Branch main" });
    expect(main).toHaveTextContent("the base branch");
    await user.click(within(main).getByRole("button", { name: "Switch to main" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/git/switch").at(-1)?.body).toEqual({ branch: "main", create: false }));
    expect(await screen.findByText("On main now.")).toBeInTheDocument();
  });
});

describe("KeelBot's query and git buttons", () => {
  // KeelBot reads them among its other blocks: plugins/keelbot/web/test (keelbot-cards.test.tsx)
  it("a plugin's block shows its card (slot keelbot.card; their buttons: plugins/db/web/test, plugins/git/web/test)", async () => {
    const p = await chatWith('Zero them:\n```keel-query\n{"sql": "update scores set value = 0", "connection": "local"}\n```\n'
      + '```keel-git\n{"op": "commit", "message": "fix: zero scores"}\n```');
    expect(await within(p).findByRole("region", { name: "Query on local" })).toBeInTheDocument();
    expect(within(p).getByRole("region", { name: "Git: Commit" })).toBeInTheDocument();
  });

  it("a keel block of a kind keel does not know shows as code", async () => {
    const p = await chatWith('Look:\n```keel-nope\n{"op": "x"}\n```\nDone.');
    expect(await within(p).findByText('{"op": "x"}')).toBeInTheDocument();
    expect(within(p).getByText("Done.")).toBeInTheDocument();
  });
});
