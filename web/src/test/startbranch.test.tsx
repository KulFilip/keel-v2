// B8 a flow started while the project folder is on another branch (what init left checked out) gets its own branch from
// the base, unless the person picks "Continue <branch>". B13 init and the other flows that build nothing do not ask
// what to build (no description, no acceptance criteria slider).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

const starts = () => db.calls.filter((c) => c.method === "POST" && /^\/api\/projects\/[^/]+\/flows$/.test(c.path));

async function openStart() {
  const yegi = db.projects.find((p) => p.id === "yegi")!;
  yegi.branch = "feat/init-2026-10-25";
  yegi.configured = true;
  localStorage.setItem("keel2.project", "yegi");
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Start a flow" }));
  return screen.findByRole("dialog", { name: "Start a flow" });
}

describe("Start a flow: the branch (B8)", () => {
  it("on another branch it offers a new branch from the base (the default) and sends it", async () => {
    const user = userEvent.setup();
    await openStart();
    const pick = await screen.findByLabelText("Branch");
    expect(pick).toHaveValue("new");
    expect(screen.getByRole("option", { name: "Continue feat/init-2026-10-25" })).toBeInTheDocument();
    await user.type(screen.getByLabelText("What to build"), "Players can see their rank next to the top 10");
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect((starts()[0].body as Record<string, unknown>).branch).toBe("new");
  });

  it("B7 ship (and the other flows that finish the branch) continue it by default", async () => {
    const user = userEvent.setup();
    db.workflows.push({ ...db.workflows[0], id: "ship", name: "ship (keel)" });
    await openStart();
    await user.selectOptions(await screen.findByLabelText("Workflow"), "ship");
    expect(screen.getByLabelText("Branch")).toHaveValue("continue");
    expect(screen.getByRole("option", { name: "Continue feat/init-2026-10-25 (recommended)" })).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect((starts()[0].body as Record<string, unknown>).branch).toBe("continue");
  });

  it("B7 ship can still start on a new branch from the base", async () => {
    const user = userEvent.setup();
    db.workflows.push({ ...db.workflows[0], id: "ship", name: "ship (keel)" });
    await openStart();
    await user.selectOptions(await screen.findByLabelText("Workflow"), "ship");
    await user.selectOptions(screen.getByLabelText("Branch"), "new");
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect((starts()[0].body as Record<string, unknown>).branch).toBe("new");
  });

  it("Continue <branch> sends branch continue", async () => {
    const user = userEvent.setup();
    await openStart();
    await user.selectOptions(await screen.findByLabelText("Branch"), "continue");
    await user.type(screen.getByLabelText("What to build"), "Players can see their rank next to the top 10");
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(starts()).toHaveLength(1));
    expect((starts()[0].body as Record<string, unknown>).branch).toBe("continue");
  });

  it("on the base branch there is nothing to pick", async () => {
    localStorage.setItem("keel2.project", "yegi");
    render(<App />);
    await userEvent.click(await screen.findByRole("button", { name: "Start a flow" }));
    await screen.findByRole("dialog", { name: "Start a flow" });
    await screen.findByLabelText("What to build");
    expect(screen.queryByLabelText("Branch")).toBeNull();
  });
});

describe("Start a flow: init asks nothing to build (B13)", () => {
  it("hides the description and the criteria slider for init, shows them for feature", async () => {
    const user = userEvent.setup();
    db.workflows.push({ ...db.workflows[0], id: "init", name: "init (keel)" });
    await openStart();
    await screen.findByLabelText("Describe it for the agents");
    expect(screen.getByLabelText("About how many acceptance criteria")).toBeInTheDocument();
    await user.selectOptions(screen.getByLabelText("Workflow"), "init");
    expect(screen.queryByLabelText("Describe it for the agents")).toBeNull();
    expect(screen.queryByLabelText("About how many acceptance criteria")).toBeNull();
    expect(screen.getByLabelText("Title (optional)")).toBeInTheDocument();
  });
});
