// Build › Workflows: Delete a workflow (the person's own, from the header or a row of the list) with an in-page
// confirm; keel's templates have no Delete but a hint with Make a copy; a marketplace workflow goes the marketplace's
// way; a 409 (a flow of it runs) shows in the confirm. The YAML tab: YAML of another workflow (another id) is not saved
// over this one; Import adds it as a new workflow.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { Workflow } from "../api";
import { otherWorkflowId, yamlId } from "../pages/Workflows";
import * as fx from "./fixtures";
import { fromMarket } from "./marketWorkflowHandlers";
import { db, server } from "./setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);
const mine = (): Workflow => ({ ...fx.fixWorkflow, id: "mine", name: "My flow", based_on: "keel/fix", source: "yours", yaml: "name: My flow\nbased_on: keel/fix\n" });

function open(hash: string) {
  location.hash = hash;
  render(<App />);
}

describe("Build › Workflows: Delete", () => {
  it("the person's own workflow: Delete asks in the page, deletes, toasts and goes back to the list", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("button", { name: "Delete" }));
    const dlg = screen.getByRole("alertdialog", { name: "Delete My flow?" });
    expect(dlg).toHaveTextContent("Flows that ran with it keep their history.");
    expect(within(dlg).getByRole("button", { name: "Keep it" })).toHaveFocus();
    // Keep it closes without a call
    await user.click(within(dlg).getByRole("button", { name: "Keep it" }));
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(calls("DELETE", "/api/workflows/mine")).toHaveLength(0);

    await user.click(within(top).getByRole("button", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog")).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("DELETE", "/api/workflows/mine")).toHaveLength(1));
    expect(await screen.findByText("My flow is deleted. Flows that ran with it keep their history.")).toBeInTheDocument();
    await waitFor(() => expect(location.hash).toBe("#/workflows"));
    await waitFor(() => expect(screen.queryByRole("button", { name: /^My flow/ })).toBeNull());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });

  it("the list row's menu has Delete for the person's own; templates have no row menu", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/feature");
    const rail = await screen.findByRole("navigation", { name: "Workflows" });
    await within(rail).findByRole("button", { name: /^My flow/ });
    expect(within(rail).queryByRole("button", { name: /Actions for feature/ })).toBeNull();
    await user.click(within(rail).getByRole("button", { name: "Actions for My flow" }));
    const menu = within(rail).getByRole("menu", { name: "My flow actions" });
    expect(within(menu).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Delete"]);
    await user.click(within(menu).getByRole("menuitem", { name: "Delete" }));
    await user.click(within(screen.getByRole("alertdialog", { name: "Delete My flow?" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("DELETE", "/api/workflows/mine")).toHaveLength(1));
    await waitFor(() => expect(within(rail).queryByRole("button", { name: /^My flow/ })).toBeNull());
    // the open workflow (feature) stays open
    expect(location.hash).toBe("#/workflows/feature");
  });

  it("the header menu of the person's own workflow has Publish and Delete", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("button", { name: "More for My flow" }));
    expect(within(top).getAllByRole("menuitem").map((b) => b.textContent)).toEqual(["Publish to marketplace", "Delete"]);
    await user.click(within(top).getByRole("menuitem", { name: "Delete" }));
    expect(screen.getByRole("alertdialog", { name: "Delete My flow?" })).toBeInTheDocument();
  });

  it("keel's own workflow: no Delete, a hint, and make a copy opens New workflow with it picked", async () => {
    const user = userEvent.setup();
    open("#/workflows/feature");
    const top = await screen.findByRole("region", { name: "This workflow" });
    expect(await within(top).findByText(/keel's own workflow: it can't be deleted/)).toHaveTextContent(
      "keel's own workflow: it can't be deleted (make a copy).");
    expect(within(top).queryByRole("button", { name: "Delete" })).toBeNull();
    await user.click(within(top).getByRole("button", { name: "make a copy" }));
    const dlg = await screen.findByRole("dialog", { name: "New workflow" });
    expect(within(dlg).getByLabelText("Name")).toHaveValue("feature (keel) (copy)");
    expect(within(dlg).getByRole("combobox", { name: "keel flow to copy" })).toHaveValue("feature");
    await user.click(within(dlg).getByRole("button", { name: "Create and open builder" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/workflows")[0]?.body).toMatchObject({ from: "template:feature", name: "feature (keel) (copy)" }));
  });

  it("a workflow from the marketplace: Delete goes the marketplace's way and says it can be installed again", async () => {
    const user = userEvent.setup();
    db.workflows.push(fromMarket());
    open("#/workflows/pr-tidy");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("button", { name: "Delete" }));
    const dlg = screen.getByRole("alertdialog", { name: "Delete PR tidy?" });
    expect(dlg).toHaveTextContent("you can install it again there");
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(calls("DELETE", "/api/workflows/pr-tidy")).toHaveLength(1));
    expect(await screen.findByText("PR tidy is deleted. Flows that ran with it keep their history. You can install it again from the marketplace.")).toBeInTheDocument();
    await waitFor(() => expect(db.workflows.some((w) => w.id === "pr-tidy")).toBe(false));
  });

  it("a 409 (a flow of it runs) shows in the confirm and nothing goes", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    server.use(http.delete("/api/workflows/:wid", () =>
      HttpResponse.json({ error: "My flow has a flow running (Add login): stop it or let it finish first." }, { status: 409 })));
    open("#/workflows/mine");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("button", { name: "Delete" }));
    const dlg = screen.getByRole("alertdialog", { name: "Delete My flow?" });
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    expect(await within(dlg).findByText("My flow has a flow running (Add login): stop it or let it finish first.")).toBeInTheDocument();
    expect(location.hash).toBe("#/workflows/mine");
    expect(within(dlg).getByRole("button", { name: "Delete" })).toBeEnabled();
  });
});

describe("Build › Workflows › YAML: another workflow's YAML", () => {
  it("reads the top-level id and tells another workflow from this one", () => {
    expect(yamlId("# head\nid: feature\nname: x\n")).toBe("feature");
    expect(yamlId("id: 'hot-fix'  # mine\n")).toBe("hot-fix");
    expect(yamlId("name: x\nsteps:\n  - id: s1\n")).toBeNull();
    expect(otherWorkflowId("id: feature\nname: x\n", "mine")).toBe("feature");
    expect(otherWorkflowId("id: mine\nname: x\n", "mine")).toBeNull();
    // an imported file keeps its own id: line, which is not another workflow
    expect(otherWorkflowId("id: hotfix\nname: x\n", "p-hotfix", "id: hotfix\nname: Hotfix\n")).toBeNull();
    // no id: a rename at most
    expect(otherWorkflowId("name: Something else\n", "mine")).toBeNull();
  });

  it("says it is a different workflow (not the locked steps error), blocks Save, and Import adds it and opens it", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    const imported: Workflow = { ...fx.featureWorkflow, id: "ludus-engine-feature", name: "feature (keel)", source: "yours", based_on: "keel/feature" };
    db.importAs = imported;
    open("#/workflows/mine");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("tab", { name: "YAML" }));
    const box = screen.getByLabelText(/Edit the workflow as text/);
    const other = "id: feature\nname: feature (keel)\nkeel_rules: true\nsteps: []\n";
    await user.clear(box);
    await user.click(box);
    await user.paste(other);
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent("This YAML is a different workflow (id feature). Use Import to add it as a new workflow.");
    expect(screen.queryByText(/Locked steps cannot be removed/)).toBeNull();
    expect(within(top).getByRole("button", { name: "Save" })).toBeDisabled();

    await user.click(within(alert).getByRole("button", { name: "Import" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/workflows/import")[0]?.body).toEqual({ yaml: other }));
    expect(calls("PUT", "/api/workflows/mine")).toHaveLength(0);
    await waitFor(() => expect(location.hash).toBe("#/workflows/ludus-engine-feature"));
    expect(await screen.findByText("Imported feature (keel) as a new workflow. My flow did not change.")).toBeInTheDocument();
  });

  it("YAML with this workflow's own id (or none) saves as before", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    const top = await screen.findByRole("region", { name: "This workflow" });
    await user.click(await within(top).findByRole("tab", { name: "YAML" }));
    const box = screen.getByLabelText(/Edit the workflow as text/);
    await user.clear(box);
    await user.click(box);
    await user.paste("id: mine\nname: My flow renamed\nkeel_rules: false\nsteps: []\n");
    expect(screen.queryByText(/is a different workflow/)).toBeNull();
    await user.click(within(top).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT", "/api/workflows/mine")).toHaveLength(1));
  });
});
