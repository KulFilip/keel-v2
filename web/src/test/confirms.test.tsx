// Destructive or paid actions ask first, in the page (no window.confirm).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { server } from "./setup";

describe("confirms", () => {
  it("deleting a custom agent asks first", async () => {
    const user = userEvent.setup();
    const deleted: string[] = [];
    server.use(http.delete("/api/projects/:pid/agents/:aid", ({ params }) => { deleted.push(String(params.aid)); return HttpResponse.json({}); }));
    location.hash = "#/agents";
    render(<App />);
    await user.click(await screen.findByRole("tab", { name: /Custom/ }));
    await user.click(await screen.findByText("Checks the spec against docs/."));
    const dlg = await screen.findByRole("dialog", { name: "Lit-Check" });
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    expect(deleted).toEqual([]);
    await user.click(within(within(dlg).getByRole("group", { name: "Confirm" })).getByRole("button", { name: "Cancel" }));
    expect(deleted).toEqual([]);
    await user.click(within(dlg).getByRole("button", { name: "Delete" }));
    await user.click(within(within(dlg).getByRole("group", { name: "Confirm" })).getByRole("button", { name: "Delete" }));
    await waitFor(() => expect(deleted).toEqual(["lit-check"]));
  });

  it("Test all asks before it sends paid model calls", async () => {
    const user = userEvent.setup();
    let tests = 0;
    server.use(http.post("/api/agents/:aid/test", () => { tests++; return HttpResponse.json({ ok: true, text: "OK", ms: 10 }); }));
    location.hash = "#/agents";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Test all" }));
    expect(tests).toBe(0);
    await user.click(within(await screen.findByRole("group", { name: "Confirm" })).getByRole("button", { name: "Test all" }));
    await waitFor(() => expect(tests).toBeGreaterThan(0));
  });

  it("removing an MCP server asks first", async () => {
    const user = userEvent.setup();
    const removed: string[] = [];
    server.use(http.delete("/api/mcp-servers/:name", ({ params }) => { removed.push(String(params.name)); return HttpResponse.json({}); }));
    location.hash = "#/tools";
    render(<App />);
    const btn = (await screen.findAllByRole("button", { name: /^Remove / }))[0]!;
    await user.click(btn);
    expect(removed).toEqual([]);
    await user.click(within(await screen.findByRole("group", { name: "Confirm" })).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(removed).toHaveLength(1));
  });
});
