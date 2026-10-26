// Skills in the marketplace (keel 0.18.6): the kind switch's fourth kind (?kind=skills), keel's own skills ("From keel",
// their agents), the catalogs' cards (Install / Installed here / Update), install with the agents to load it, a skill's
// page (#/settings/plugins/skills/<name>: its text and keel's review), update, remove, keel's own page, and no catalog.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);

function open(hash: string) {
  location.hash = hash;
  render(<App />);
}

const card = (title: string) => screen.findByRole("article", { name: `${title} skill` });

describe("Marketplace › Skills", () => {
  it("the kind switch's Skills: keel's own first, then the catalogs', and the search names the project", async () => {
    const user = userEvent.setup();
    open("#/settings/plugins?tab=market");
    const kinds = await screen.findByRole("group", { name: "What to find" });
    await user.click(within(kinds).getByRole("button", { name: "Skills" }));
    await waitFor(() => expect(location.hash).toBe("#/settings/plugins?tab=market&kind=skills"));
    expect(screen.getByText(/Skills made by keel and the community/)).toBeInTheDocument();
    const mine = await card("Debugging");
    expect(within(screen.getByRole("region", { name: "From keel" })).getByRole("article", { name: "Debugging skill" })).toBeInTheDocument();
    expect(mine).toHaveTextContent("loaded by reproducer");
    expect(mine).toHaveTextContent("2.3k tokens · 7 references");
    const log = await card("Changelog entries");
    expect(log).toHaveTextContent("31 tokens · 2 sections");
    expect(within(screen.getByRole("region", { name: "From keel's catalog" })).getByRole("article", { name: "Changelog entries skill" })).toBeInTheDocument();
    expect(within(screen.getByRole("region", { name: "From the community" })).getByRole("article", { name: "Flaky tests skill" })).toBeInTheDocument();
    expect(db.ms.searches[0]).toEqual({ q: "", category: "", project: "ludus-engine" });
  });

  it("installs a catalog skill for the agents picked, then says Installed here", async () => {
    const user = userEvent.setup();
    open("#/settings/plugins?tab=market&kind=skills");
    await user.click(within(await card("Changelog entries")).getByRole("button", { name: "Install Changelog entries" }));
    const dlg = await screen.findByRole("dialog", { name: "Install Changelog entries 1.1.0?" });
    expect(dlg).toHaveTextContent("31 tokens · 2 sections");
    await user.click(await within(dlg).findByRole("checkbox", { name: /implementer/ }));
    await user.click(within(dlg).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/skills/market/install")[0]?.body)
      .toEqual({ name: "changelog-entries", agents: ["implementer"] }));
    expect(await screen.findByText(/loaded by implementer from their next run/)).toBeInTheDocument();
    expect(await within(await card("Changelog entries")).findByText("Installed here")).toBeInTheDocument();
  });

  it("puts keel's own skill on more agents", async () => {
    const user = userEvent.setup();
    open("#/settings/plugins?tab=market&kind=skills");
    await user.click(within(await card("Debugging")).getByRole("button", { name: "Agents for Debugging" }));
    const dlg = await screen.findByRole("dialog", { name: "Agents for Debugging" });
    await user.click(await within(dlg).findByRole("checkbox", { name: /explorer/ }));
    await user.click(within(dlg).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/skills/debugging")[0]?.body).toEqual({ agents: ["reproducer", "explorer"] }));
  });

  it("no catalog: a note, and keel's own still show", async () => {
    db.ms.down = true;
    open("#/settings/plugins?tab=market&kind=skills");
    expect(await screen.findByRole("note", { name: "No skill catalog" })).toHaveTextContent("No skill catalog answers yet.");
    expect(await card("Debugging")).toBeInTheDocument();
    expect(screen.queryByRole("article", { name: "Changelog entries skill" })).toBeNull();
  });
});

describe("A skill's page", () => {
  it("shows the verified text and keel's review; update asks first, remove takes it away", async () => {
    const user = userEvent.setup();
    db.ms.installed["changelog-entries"] = { version: "1.0.0", edited: true, sid: "changelog-entries", agents: ["reviewer"] };
    open("#/settings/plugins/skills/changelog-entries");
    expect(await screen.findByRole("heading", { name: "Changelog entries" })).toBeInTheDocument();
    expect(screen.getByLabelText("Text of Changelog entries")).toHaveTextContent("One line per change.");
    expect(screen.getByText("When, How")).toBeInTheDocument();
    expect(screen.getByText("reviewer")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Update to 1.1.0" }));
    const upd = await screen.findByRole("dialog", { name: "Update Changelog entries to 1.1.0?" });
    expect(within(upd).getByRole("radio", { name: /Keep my copy/ })).toBeChecked();
    await user.click(within(upd).getByRole("radio", { name: /Replace it with 1.1.0/ }));
    await user.click(within(upd).getByRole("button", { name: "Update to 1.1.0" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/skills/market/install")[0]?.body)
      .toEqual({ name: "changelog-entries", version: "1.1.0", replace: true }));
    await user.click(await screen.findByRole("button", { name: "Remove" }));
    await user.click(within(screen.getByRole("group", { name: "Confirm" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("DELETE", "/api/projects/ludus-engine/skills/changelog-entries")).toHaveLength(1));
  });

  it("keel's own skill: in every project, its text, its references", async () => {
    open("#/settings/plugins/skills/debugging");
    expect(await screen.findByRole("heading", { name: "Debugging" })).toBeInTheDocument();
    expect(screen.getByText("In every project")).toBeInTheDocument();
    expect(screen.getByLabelText("Text of Debugging")).toHaveTextContent("Find the cause first.");
    expect(screen.getByText(/references\/bisect.md/)).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /^Install/ })).toBeNull();
  });

  it("a skill whose signature keel refuses: an alert, and Install is off", async () => {
    db.ms.badSignature = "flaky-tests";
    open("#/settings/plugins/skills/flaky-tests");
    expect(await screen.findByRole("alert")).toHaveTextContent("does not match its publisher's key");
    expect(screen.getByRole("button", { name: /^Install/ })).toBeDisabled();
  });
});
