// B9 a skip menu in the Inbox: each ticked step gets its own reason field (payload.reasons), the answer waits for the
// reason, and there is no "own words" box (words there were read as one more step's name).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { InboxItem, InboxView } from "../inboxApi";
import { db, server } from "./setup";

const menu = (): InboxItem => ({
  project_id: "ludus-engine", project_name: "ludus-engine", thread_id: "th_skip", flow: "Scores for players", workflow_id: "feature",
  step: "options", kind: "gate", title: "Optional phases", detail: "Which steps run this time?", more: false, options: ["approve"],
  labels: { approve: "Run these steps" }, id: "q-skip", since: new Date().toISOString(),
  questions: [{ id: "skip", question: "Which steps should keel skip this time?", multiple: true, own_words: false,
    options: [{ label: "security", description: "Optional", why: "required" }, { label: "cover", description: "Deferred", why: "required" }] }],
});

describe("Inbox: a skip menu's reasons (B9)", () => {
  it("asks a reason per ticked step and sends them as payload.reasons", async () => {
    let list = [menu()];
    server.use(
      http.get("/api/inbox", () => HttpResponse.json({ items: list, count: list.length, kinds: ["gate"], projects: [] } satisfies InboxView)),
      http.post("/api/inbox/:tid/act", async ({ request, params }) => {
        db.calls.push({ method: "POST", path: `/api/inbox/${params.tid}/act`, body: await request.json() });
        list = [];
        return HttpResponse.json({ thread_id: params.tid, status: "running" });
      }),
    );
    const user = userEvent.setup();
    location.hash = "#/inbox";
    render(<App />);
    const card = await screen.findByRole("article", { name: "Optional phases" });
    expect(within(card).queryByLabelText(/Your own answer/)).toBeNull();
    await user.click(within(card).getByRole("checkbox", { name: /security/ }));
    await user.click(within(card).getByRole("button", { name: "Run these steps" }));
    expect(await within(card).findByText("Write why for “security” first: it needs a reason.")).toBeInTheDocument();
    expect(db.calls.filter((c) => c.path === "/api/inbox/th_skip/act")).toHaveLength(0);
    await user.type(within(card).getByLabelText(/Why “security”/), "no new endpoint");
    await user.click(within(card).getByRole("button", { name: "Run these steps" }));
    await waitFor(() => expect(db.calls.find((c) => c.path === "/api/inbox/th_skip/act")).toBeTruthy());
    const body = db.calls.find((c) => c.path === "/api/inbox/th_skip/act")!.body as { payload: Record<string, unknown> };
    expect(body.payload.answers).toEqual({ skip: ["security"] });
    expect(body.payload.reasons).toEqual({ security: "no new endpoint" });
  });
});
