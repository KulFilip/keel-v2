// B8a Connections says when a provider is ready but agents still run on the fake model, and fixes it in one click.

import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import * as fx from "./fixtures";
import { db, server } from "./setup";

const loggedIn = () => ({
  ...fx.connections,
  providers: [{ ...fx.connections.providers[0], login_set: true, login_hint: "…9KQ",
    modes: [{ id: "subscription", label: "Subscription", ready: true, detail: "Claude Code" }, { id: "api", label: "API key", ready: false, detail: "ANTHROPIC_API_KEY" }] }],
});

describe("Connections: agents still on the fake model (B8a)", () => {
  it("a logged-in Claude with a fake default model says so and Use Claude for all agents sets the three models", async () => {
    server.use(http.get("/api/connections", () => HttpResponse.json(loggedIn())));
    const user = userEvent.setup();
    location.hash = "#/settings/models";
    render(<App />);
    const note = await screen.findByRole("note");
    expect(note).toHaveTextContent("Claude is logged in, but the default model still uses the fake model");
    await user.click(screen.getByRole("button", { name: "Use Claude for all agents" }));
    await waitFor(() => expect(db.calls.find((c) => c.method === "PUT" && c.path === "/api/settings/general")).toBeTruthy());
    const body = db.calls.find((c) => c.method === "PUT" && c.path === "/api/settings/general")!.body as Record<string, { provider: string }>;
    expect(body.default_model.provider).toBe("claude");
    expect(body.implementer_model.provider).toBe("claude");
    expect(body.reviewer_model.provider).toBe("claude");
    await waitFor(() => expect(screen.queryByRole("note")).toBeNull());
  });

  it("no note while the provider has no login", async () => {
    render(<App />);
    location.hash = "#/settings/models";
    await screen.findByLabelText(/Claude login token/);
    expect(screen.queryByRole("note")).toBeNull();
  });
});
