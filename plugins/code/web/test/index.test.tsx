// Plan 5b: the Code page shows the project's code graph index and can rebuild it. Moved from web/src/test with the
// plugin: it runs inside keel's web, as the full image has it.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it } from "vitest";
// keel's own app and test harness
import { App } from "../../../../web/src/App";
import { restorePlugins, withoutPages } from "../../../../web/src/test/coreOnly";
import { db, server } from "../../../../web/src/test/setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);

describe("Repo index badge", () => {
  it("shows ready with counts and age, and Rebuild starts indexing", async () => {
    const user = userEvent.setup();
    location.hash = "#/repo";
    render(<App />);
    const badge = await screen.findByText(/^Index: ready/);
    expect(badge).toHaveTextContent("Index: ready · 412 files · 3100 symbols · 5 min ago");
    await user.click(screen.getByRole("button", { name: "Rebuild" }));
    expect(await screen.findByText("Index: indexing…")).toBeInTheDocument();
    expect(calls("POST", "/api/projects/ludus-engine/index/rebuild")).toHaveLength(1);
    await waitFor(() => expect(screen.getByRole("button", { name: "Rebuild" })).toBeDisabled());
  });

  it("shows why the index failed", async () => {
    db.index = { project: "ludus-engine", status: "failed", files: 0, symbols: 0, error: "CodeGraph is not installed" };
    location.hash = "#/repo";
    render(<App />);
    const badge = await screen.findByText("Index: failed: CodeGraph is not installed");
    expect(badge).toHaveAttribute("title", "CodeGraph is not installed");
  });
});

// Step 6: the index is the Graph plugin's api; a keel without the Graph (the Review set) shows no index row and asks
// nothing.
describe("Repo index badge without the Graph plugin", () => {
  afterEach(() => restorePlugins());

  it("shows no index row and does not ask /index", async () => {
    const asked: string[] = [];
    const on = ({ request }: { request: Request }) => void asked.push(new URL(request.url).pathname);
    server.events.on("request:start", on);
    try {
      withoutPages("graph");
      location.hash = "#/repo";
      render(<App />);
      expect(await screen.findByRole("button", { name: "Update from main" })).toBeInTheDocument();
      expect(screen.queryByText(/^Index:/)).toBeNull();
      expect(screen.queryByRole("button", { name: "Rebuild" })).toBeNull();
      expect(asked.filter((p) => /\/index(\/|$)/.test(p))).toEqual([]);
    } finally {
      server.events.removeListener("request:start", on);
    }
  });
});
