// P4 an approval keel or a part asks itself (keel Product's send to Jira) is answered at /approvals/{id}/decide, with
// Approve and Deny, and its Open goes where the part says, not to the Flow page ("No flow a_…" before).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { InboxItem, InboxView } from "../inboxApi";
import { db, server } from "./setup";

const ask = (): InboxItem => ({
  project_id: "ludus-engine", project_name: "ludus-engine", thread_id: "a_123", flow: "keelbot", workflow_id: null, step: "approval",
  kind: "product-jira-send", title: "Send 3 tickets of INI-1 to Jira", detail: "- story Rank weekly → SHOP (Story)", more: false,
  options: ["approve", "deny"], id: "a_123", since: new Date().toISOString(),
  payload: { initiative: "INI-1", stories: [], open: { page: "inbox", label: "Open initiative" } },
});

function serve() {
  let list = [ask()];
  server.use(
    http.get("/api/inbox", () => HttpResponse.json({ items: list, count: list.length, kinds: ["product-jira-send"], projects: [] } satisfies InboxView)),
    http.post("/api/approvals/:id/decide", async ({ request, params }) => {
      db.calls.push({ method: "POST", path: `/api/approvals/${params.id}/decide`, body: await request.json() });
      list = [];
      return HttpResponse.json({ id: params.id, status: "decided" });
    }),
  );
}

describe("Inbox: an approval that is no flow (P4)", () => {
  it("Approve decides the approval, never a flow", async () => {
    serve();
    const user = userEvent.setup();
    location.hash = "#/inbox";
    render(<App />);
    const card = await screen.findByRole("article", { name: "Send 3 tickets of INI-1 to Jira" });
    expect(within(card).getByRole("button", { name: "Deny" })).toBeInTheDocument();
    expect(within(card).queryByRole("button", { name: /Open flow/ })).toBeNull();
    expect(within(card).getByRole("button", { name: "Open initiative ▸" })).toBeInTheDocument();
    await user.type(within(card).getByLabelText("Note (optional)"), "looks right");
    await user.click(within(card).getByRole("button", { name: "Approve" }));
    await waitFor(() => expect(db.calls.find((c) => c.path === "/api/approvals/a_123/decide")?.body).toEqual({ decision: "approve", why: "looks right" }));
    expect(db.calls.some((c) => c.path === "/api/inbox/a_123/act")).toBe(false);
  });

  it("Deny says no", async () => {
    serve();
    const user = userEvent.setup();
    location.hash = "#/inbox";
    render(<App />);
    const card = await screen.findByRole("article", { name: "Send 3 tickets of INI-1 to Jira" });
    await user.click(within(card).getByRole("button", { name: "Deny" }));
    await waitFor(() => expect(db.calls.find((c) => c.path === "/api/approvals/a_123/decide")?.body).toEqual({ decision: "deny", why: "" }));
  });
});
