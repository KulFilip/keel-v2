// Build › Workflows: the workflow YAML in keel's code editor (highlighting, line numbers, Tab = 2 spaces) in the YAML
// tab, Import and New workflow, and read-only on the marketplace workflow page. Errors sit at their line (keel's check
// as you type, a refused save or import); a click jumps there; Save waits while a line is marked. A new workflow starts
// from a small valid example; "The fields of a workflow" explains each key; a save shows the YAML as keel wrote it.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { Workflow } from "../api";
import * as fx from "./fixtures";
import { db, server } from "./setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);
const mine = (): Workflow => ({ ...fx.fixWorkflow, id: "mine", name: "My flow", based_on: "keel/fix", source: "yours", keel_rules: false,
  yaml: "name: My flow\nkeel_rules: false\nsteps:\n  - { id: f1, kind: agent, name: bug-repro, agent: reproducer }\n" });

function open(hash: string) {
  location.hash = hash;
  render(<App />);
}

async function yamlTab(user: ReturnType<typeof userEvent.setup>) {
  const top = await screen.findByRole("region", { name: "This workflow" });
  await user.click(await within(top).findByRole("tab", { name: "YAML" }));
  return { top, box: screen.getByLabelText(/Edit the workflow as text/) as HTMLTextAreaElement };
}

async function replace(user: ReturnType<typeof userEvent.setup>, box: HTMLElement, text: string) {
  await user.clear(box);
  await user.click(box);
  await user.paste(text);
}

describe("Build › Workflows › YAML: keel's editor, errors at their line", () => {
  it("is the code editor: highlighted, numbered lines, Tab writes two spaces", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    const { box } = await yamlTab(user);
    const panel = screen.getByRole("region", { name: "YAML" });
    expect(box).toHaveClass("ce-input");
    expect(panel.querySelector(".ce-gutter")).toHaveTextContent("1234");
    expect(panel.querySelector(".ce-pre .hljs-attr")).not.toBeNull();
    await replace(user, box, "name: My flow\n");
    await user.keyboard("{Tab}");
    await waitFor(() => expect(box.value).toBe("name: My flow\n  "));
  });

  it("marks the line keel's check names, lists it, jumps there on a click, and Save waits until it is fixed", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    const { top, box } = await yamlTab(user);
    const bad = "name: My flow\nkeel_rules: false\nsteps:\n  - { id: a, kind: agent, name: a, agent: explorer }\n  - { id: look, kind: INVALID, name: look }\n";
    await replace(user, box, bad);
    const list = await screen.findByRole("alert", { name: "Errors" }, { timeout: 3000 });
    expect(list).toHaveTextContent("line 5 Step 'look': INVALID is not a step kind.");
    expect(screen.getByRole("region", { name: "YAML" }).querySelector(".ce-gutter .ce-bad")).toHaveTextContent("5");
    expect(within(top).getByRole("button", { name: "Save" })).toBeDisabled();
    expect(screen.getByText("Save waits until the marked lines are fixed.")).toBeInTheDocument();
    // the click puts the caret at the start of line 5
    await user.click(within(list).getByRole("button", { name: "line 5" }));
    expect(box).toHaveFocus();
    expect(box.selectionStart).toBe(bad.split("\n").slice(0, 4).join("\n").length + 1);
    // fixed: the mark goes and Save works
    await replace(user, box, bad.replace("INVALID", "gate"));
    await waitFor(() => expect(screen.queryByRole("alert", { name: "Errors" })).toBeNull(), { timeout: 3000 });
    expect(within(top).getByRole("button", { name: "Save" })).toBeEnabled();
    await user.click(within(top).getByRole("button", { name: "Save" }));
    await waitFor(() => expect(calls("PUT", "/api/workflows/mine")).toHaveLength(1));
  });

  it("a refused save marks the lines it names and keeps its message", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    server.use(http.put("/api/workflows/:wid", () => HttpResponse.json({
      error: "The workflow is not valid", hint: "Step 'a': an agent step needs an agent.",
      lines: [{ line: 4, message: "Step 'a': an agent step needs an agent." }],
    }, { status: 422 })));
    open("#/workflows/mine");
    const { top } = await yamlTab(user);
    // a change in the blocks, saved from the YAML tab
    await user.click(within(top).getByRole("checkbox", { name: /keel rules/ }));
    await user.click(within(top).getByRole("button", { name: "Save" }));
    const list = await screen.findByRole("alert", { name: "Errors" });
    expect(list).toHaveTextContent("line 4 Step 'a': an agent step needs an agent.");
    expect(screen.getByText("The workflow is not valid")).toBeInTheDocument();
    expect(within(top).getByRole("button", { name: "Save" })).toBeDisabled();
  });

  it("after a save the tab shows the YAML as keel wrote it", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    const tidy = "# mine\n\nname: My flow\nkeel_rules: false\n\nsteps:\n\n  - id: f1\n    kind: agent\n    name: bug-repro\n    agent: reproducer\n";
    server.use(http.put("/api/workflows/:wid", async ({ request }) => {
      const b = (await request.json()) as Workflow;
      return HttpResponse.json({ ...b, version: 2, yaml: tidy });
    }));
    open("#/workflows/mine");
    const { top, box } = await yamlTab(user);
    await replace(user, box, "# mine\nsteps:\n- {agent: reproducer, name: bug-repro, kind: agent, id: f1}\nkeel_rules: false\nname: My flow\n");
    await waitFor(() => expect(within(top).getByRole("button", { name: "Save" })).toBeEnabled(), { timeout: 3000 });
    await user.click(within(top).getByRole("button", { name: "Save" }));
    await waitFor(() => expect((screen.getByLabelText(/Edit the workflow as text/) as HTMLTextAreaElement).value).toBe(tidy));
  });

  it("has the help: The fields of a workflow, with each kind and the docs", async () => {
    const user = userEvent.setup();
    db.workflows.push(mine());
    open("#/workflows/mine");
    await yamlTab(user);
    const help = screen.getByText("The fields of a workflow").closest("details")!;
    for (const kind of ["agent", "code", "gate", "branch", "parallel", "include"]) {
      expect(within(help).getByText(kind, { selector: "code" })).toBeInTheDocument();
    }
    for (const key of ["per_ac", "phase", "back", "lock", "markers", "rounds · after_rounds", "when", "then"]) {
      expect(within(help).getByText(key, { selector: "code" })).toBeInTheDocument();
    }
    expect(within(help).getByRole("link", { name: /docs\/CONTRACT\.md/ })).toHaveAttribute("href", expect.stringContaining("docs/CONTRACT.md#workflow-keys"));
  });
});

describe("New workflow and Import: the same editor", () => {
  it("a small example: shows the YAML it makes (its name in it) and the help, then makes it", async () => {
    const user = userEvent.setup();
    open("#/workflows/feature");
    await user.click(await screen.findByRole("button", { name: "New workflow" }));
    const dlg = await screen.findByRole("dialog", { name: "New workflow" });
    await user.type(within(dlg).getByLabelText("Name"), "Hotfix");
    await user.click(within(dlg).getByRole("radio", { name: /A small example/ }));
    const yaml = (await within(dlg).findByLabelText("The workflow it makes", undefined, { timeout: 3000 })) as HTMLTextAreaElement;
    await waitFor(() => expect(yaml.value).toContain("name: Hotfix\n"));
    expect(yaml).toHaveAttribute("readonly");
    expect(yaml.value).toContain("kind: gate");
    expect(within(dlg).getByText("The fields of a workflow")).toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Create and open builder" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/workflows")[0]?.body).toMatchObject({ name: "Hotfix", from: "blank", keel_rules: true }));
  });

  it("Import: paste the YAML in the editor; a refused import marks its lines", async () => {
    const user = userEvent.setup();
    let sent: unknown = null;
    server.use(http.post("/api/projects/:pid/workflows/import", async ({ request }) => (sent = await request.json(), HttpResponse.json({
      error: "The workflow is not valid", hint: "Step 'g': back target 'nowhere' does not exist.",
      lines: [{ line: 6, message: "Step 'g': back target 'nowhere' does not exist." }],
    }, { status: 422 }))));
    open("#/workflows/feature");
    await user.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog", { name: "Import a workflow" });
    const box = within(dlg).getByLabelText("Or paste it") as HTMLTextAreaElement;
    expect(box).toHaveClass("ce-input");
    await user.click(box);
    await user.paste("name: Mine\nkeel_rules: false\nsteps:\n  - id: g\n    kind: gate\n    back: nowhere\n");
    await user.click(within(dlg).getByRole("button", { name: "Import" }));
    const list = await within(dlg).findByRole("alert", { name: "Errors" });
    expect(list).toHaveTextContent("line 6 Step 'g': back target 'nowhere' does not exist.");
    expect(dlg.querySelector(".ce-gutter .ce-bad")).toHaveTextContent("6");
    expect(sent).toEqual({ yaml: "name: Mine\nkeel_rules: false\nsteps:\n  - id: g\n    kind: gate\n    back: nowhere\n" });
    expect(within(dlg).getByText("The fields of a workflow")).toBeInTheDocument();
  });
});
