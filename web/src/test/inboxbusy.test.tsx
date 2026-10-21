import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { InboxItem, InboxView } from "../inboxApi";
import { server } from "./setup";

const gate = (since: string): InboxItem => ({
  project_id: "ludus-engine", project_name: "ludus-engine", thread_id: "th_rep", flow: "Repeating", workflow_id: "feature",
  step: "review_gate", kind: "gate", title: "Review gate", detail: "look at it", more: false, options: ["approve", "reject"], id: null, since,
});

function serve(next: (n: number) => InboxItem) {
  let n = 0;
  server.use(
    http.get("/api/inbox", () => {
      const it = next(n);
      return HttpResponse.json({ items: [it], count: 1, kinds: ["gate"], projects: [{ id: it.project_id, name: it.project_name, count: 1 }] } satisfies InboxView);
    }),
    http.post("/api/inbox/:tid/act", () => { n++; return HttpResponse.json({ thread_id: "th_rep", status: "running" }); }),
  );
}

async function approve() {
  const user = userEvent.setup();
  location.hash = "#/inbox";
  render(<App />);
  const btn = await screen.findByRole("button", { name: /^Approve/ });
  await user.click(btn);
  return btn;
}

describe("inbox card busy state", () => {
  it("a gate that comes back with the same step gets a fresh card with enabled buttons", async () => {
    serve((n) => gate(n === 0 ? "2026-01-01T10:00:00Z" : "2026-01-01T10:05:00Z"));
    await approve();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Approve/ })).toBeEnabled());
  });

  it("buttons come back after an answer when the list still shows the item", async () => {
    serve(() => gate("2026-01-01T10:00:00Z"));
    await approve();
    await waitFor(() => expect(screen.getByRole("button", { name: /^Approve/ })).toBeEnabled());
  });
});
