// 0.18.57 what Start a flow says first (real use on a project whose PHP lives only in a docker compose service): a
// container that sees only the project folder keeps flows there with the reason, a stale local base is said, a refused
// start offers "Ignore this path" for untracked paths, and a start on a task someone works on names who (force: anyway).

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db, server } from "./setup";

const starts = () => db.calls.filter((c) => c.method === "POST" && /^\/api\/projects\/[^/]+\/flows$/.test(c.path));

async function openStart() {
  const yegi = db.projects.find((p) => p.id === "yegi")!;
  yegi.configured = true;
  localStorage.setItem("keel2.project", "yegi");
  render(<App />);
  await userEvent.click(await screen.findByRole("button", { name: "Start a flow" }));
  return screen.findByRole("dialog", { name: "Start a flow" });
}

describe("Start a flow: what it checks first (0.18.57)", () => {
  it("a container that sees only the project folder: the reason, and the folder is where it runs", async () => {
    db.startCheck.yegi = { worktree: { ok: false, service: "app", reason: "tests run in the container `app`, which sees only the project folder" },
      base: "main is 2 behind origin/main — keel compares with origin/main" };
    await openStart();
    expect(await screen.findByTestId("sf-container")).toHaveTextContent("tests run in the container `app`, which sees only the project folder");
    expect(screen.getByTestId("sf-base")).toHaveTextContent("main is 2 behind origin/main — keel compares with origin/main");
    expect(screen.getByLabelText("Where it runs")).toHaveValue("folder");
    expect(screen.getByRole("option", { name: /A worktree of its own.*\(its tests cannot run there\)/ })).toBeInTheDocument();
  });

  it("a refused start offers Ignore this path, which adds it to .git/info/exclude", async () => {
    const user = userEvent.setup();
    let refused = false;
    server.use(http.post("/api/projects/:pid/flows", () => {
      if (refused) return undefined;
      refused = true;
      return HttpResponse.json({ error: "This project has uncommitted changes (1 file): meeting/notes.md", hint: "Commit or stash them first.",
        dirty: ["meeting/notes.md"], ignorable: ["meeting/"] }, { status: 409 });
    }));
    await openStart();
    await user.type(screen.getByLabelText("What to build"), "Players can see their rank next to the top 10");
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    const box = await screen.findByTestId("sf-ignorable");
    expect(box).toHaveTextContent("meeting/");
    await user.click(screen.getByRole("button", { name: "Ignore this path" }));
    await waitFor(() => expect(db.excluded).toEqual(["meeting/"]));
    await waitFor(() => expect(screen.queryByTestId("sf-ignorable")).toBeNull());
  });

  it("a start on a task someone works on names who, and Start anyway sends force", async () => {
    const user = userEvent.setup();
    server.use(http.post("/api/projects/:pid/flows", async ({ request }) => {
      const b = await request.clone().json() as Record<string, unknown>;
      if (b.force) return undefined;
      return HttpResponse.json({ error: "Someone already works on this: flow SHOPS-1234: Euro prices at red works on the same ticket SHOPS-1234",
        owners: [{ kind: "flow", id: "t-1", who: "flow SHOPS-1234: Euro prices at red", why: "the same ticket SHOPS-1234" }] }, { status: 409 });
    }));
    await openStart();
    await user.type(screen.getByLabelText("What to build"), "SHOPS-1234 rounding of euro prices in the cart");
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    expect(await screen.findByTestId("sf-owners")).toHaveTextContent("flow SHOPS-1234: Euro prices at red — the same ticket SHOPS-1234");
    await user.click(screen.getByLabelText(/Start anyway — two agents on one task/));
    await user.click(screen.getByRole("button", { name: "Start flow" }));
    await waitFor(() => expect(starts().some((c) => (c.body as Record<string, unknown>).force === true)).toBe(true));
  });
});
