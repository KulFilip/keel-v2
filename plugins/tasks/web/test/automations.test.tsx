// 0.18.52 task automations in keel's web (docs/plans/task-automations.md): Tasks › Automations, the task drawer's
// "Pick a flow for me" and "Review it", and keel's proposal and review-comment cards in the Inbox.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import type { InboxItem, InboxView } from "../../../../web/src/inboxApi";
import { db, server } from "../../../../web/src/test/setup";

const calls = (method: string, path: string) =>
  db.calls.filter((c) => c.method === method && c.path === path);
const main = () => within(document.getElementById("main")!);

async function openTasks(hash = "#/tasks") {
  location.hash = hash;
  render(<App />);
  return main().findByRole("heading", { name: "Tasks", level: 1 });
}

const view = {
  settings: {
    rules: { in_progress: { mode: "propose" }, in_review: { mode: "propose" } },
    keelbot: { account: null, label: null },
    allow_reply: false,
    daily_auto_starts: 5,
    pick_cap_tokens: 8000,
  },
  statuses: ["in_progress", "in_review", "blocked"],
  modes: ["off", "propose", "start"],
  review_watch: true,
  tracker: true,
  auto_starts_today: 1,
};

/** The task with its open items (as GET /api/tasks/{id} answers). */
const withWaiting = (id: string) => {
  const t = db.tk.tasks.find((x) => x.id === id)!;
  return {
    ...t,
    waiting: db.tk.items.filter((i) => i.task_id === id && !i.done_at),
  };
};

describe("Tasks › Automations", () => {
  it("shows the rules and KeelBot's account, finds a Jira user and saves", async () => {
    const user = userEvent.setup();
    server.use(
      http.get("/api/projects/:pid/tasks/automations", () =>
        HttpResponse.json(view),
      ),
      http.put(
        "/api/projects/:pid/tasks/automations",
        async ({ request, params }) => {
          const body = await request.json();
          db.calls.push({
            method: "PUT",
            path: `/api/projects/${params.pid}/tasks/automations`,
            body,
          });
          return HttpResponse.json({ ...view, settings: body });
        },
      ),
      http.get("/api/projects/:pid/jira/users", () =>
        HttpResponse.json([
          {
            name: "KeelBot",
            account_id: "acc-keelbot-1",
            email: "bot@example.com",
          },
        ]),
      ),
    );
    await openTasks();
    await user.click(main().getByRole("button", { name: "Automations" }));
    const d = await screen.findByRole("dialog", { name: "Automations" });
    const progress = await within(d).findByLabelText("In progress");
    expect(progress).toHaveValue("propose");
    await user.selectOptions(progress, "start");
    expect(
      within(screen.getByTestId("rule-in_progress")).getByLabelText(
        "Token cap",
      ),
    ).toBeInTheDocument();
    await user.type(
      within(screen.getByTestId("rule-in_progress")).getByLabelText(
        "Token cap",
      ),
      "40000",
    );
    expect(within(d).getByText(/1 today/)).toBeInTheDocument();

    await user.type(within(d).getByLabelText("Find a Jira user"), "keel");
    await user.click(within(d).getByRole("button", { name: "Find" }));
    await user.click(
      await within(d).findByRole("button", {
        name: "KeelBot · bot@example.com",
      }),
    );
    expect(within(d).getByLabelText("KeelBot's Jira account")).toHaveValue(
      "acc-keelbot-1",
    );
    await user.click(
      within(d).getByRole("checkbox", {
        name: /post its reply on the pull request without asking/,
      }),
    );
    await user.click(within(d).getByRole("button", { name: "Save" }));

    await waitFor(() =>
      expect(
        calls("PUT", "/api/projects/ludus-engine/tasks/automations"),
      ).toHaveLength(1),
    );
    const body = calls("PUT", "/api/projects/ludus-engine/tasks/automations")[0]
      .body as Record<string, any>;
    expect(body.rules.in_progress).toEqual({
      mode: "start",
      cap_tokens: 40000,
    });
    expect(body.keelbot.account).toBe("acc-keelbot-1");
    expect(body.allow_reply).toBe(true);
    expect(await screen.findByText("Automations saved.")).toBeInTheDocument();
  });
});

describe("Task drawer: keel's help", () => {
  it("Pick a flow for me opens keel's proposal, and Start answers it", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/tasks/:id/pick", async ({ params }) => {
        db.calls.push({
          method: "POST",
          path: `/api/tasks/${params.id}/pick`,
          body: null,
        });
        db.tk.items.push({
          id: 300,
          task_id: String(params.id),
          project_id: "ludus-engine",
          kind: "task-proposal",
          stage: "flow",
          title: "I want to run the small flow on ABC-1",
          detail: "Why: a small change.",
          created_at: "",
          done_at: null,
          data: {
            kind: "flow",
            workflow_id: "small",
            why: "a small change.",
            title: "Rank players",
            questions: [],
          },
        } as never);
        return HttpResponse.json(withWaiting(String(params.id)));
      }),
    );
    await openTasks();
    await user.click(
      await screen.findByRole("button", { name: "ABC-1: Rank players weekly" }),
    );
    const d = await screen.findByRole("dialog", {
      name: "ABC-1 · Rank players weekly",
    });
    expect(within(d).queryByRole("button", { name: "Review it" })).toBeNull(); // no PR yet
    await user.click(
      within(d).getByRole("button", { name: "Pick a flow for me" }),
    );
    const p = await within(d).findByRole("region", {
      name: "I want to run the small flow on ABC-1",
    });
    expect(p).toHaveTextContent("small");
    await user.click(within(p).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(calls("POST", "/api/inbox/tasks/300/act")[0]?.body).toEqual({
        action: "start",
      }),
    );
  });

  it("Pick a flow for me says keel is picking, then links its proposal in the Inbox (B2)", async () => {
    const user = userEvent.setup();
    let answer: () => void = () => undefined;
    server.use(
      http.post("/api/tasks/:id/pick", async ({ params }) => {
        await new Promise<void>((done) => { answer = done; });      // the model takes its time
        db.tk.items.push({
          id: 301, task_id: String(params.id), project_id: "ludus-engine", kind: "task-proposal", stage: "flow",
          title: "I want to run the small flow on ABC-1", detail: "Why: a small change.", created_at: "", done_at: null,
          data: { kind: "flow", workflow_id: "small", why: "a small change.", title: "Rank players", questions: [] },
        } as never);
        return HttpResponse.json(withWaiting(String(params.id)));
      }),
    );
    await openTasks();
    await user.click(await screen.findByRole("button", { name: "ABC-1: Rank players weekly" }));
    const d = await screen.findByRole("dialog", { name: "ABC-1 · Rank players weekly" });
    await user.click(within(d).getByRole("button", { name: "Pick a flow for me" }));
    const status = await within(d).findByTestId("pick-status");
    expect(status).toHaveTextContent("keel is picking a flow… the proposal will be in your Inbox.");
    expect(within(d).getByRole("button", { name: "Picking…" })).toBeDisabled();
    answer();
    await waitFor(() => expect(within(d).getByTestId("pick-status")).toHaveTextContent("I want to run the small flow on ABC-1"));
    expect(within(d).getByRole("link", { name: "Open it in the Inbox ▸" })).toHaveAttribute("href", "#/inbox/ludus-engine?item=task-item-301");
    expect(await screen.findByText("keel picked a flow: I want to run the small flow on ABC-1. It waits in your Inbox.")).toBeInTheDocument();
  });

  it("Review it asks keel for a review of the task's pull request", async () => {
    const user = userEvent.setup();
    server.use(
      http.post("/api/tasks/:id/review", async ({ params }) => {
        db.calls.push({
          method: "POST",
          path: `/api/tasks/${params.id}/review`,
          body: null,
        });
        return HttpResponse.json(withWaiting(String(params.id)));
      }),
    );
    await openTasks();
    await user.click(
      await screen.findByRole("button", { name: "ABC-2: Fix the tally queue" }),
    );
    const d = await screen.findByRole("dialog", {
      name: "ABC-2 · Fix the tally queue",
    });
    expect(
      within(d).queryByRole("button", { name: "Pick a flow for me" }),
    ).toBeNull(); // in review: no new flow
    await user.click(within(d).getByRole("button", { name: "Review it" }));
    await waitFor(() =>
      expect(calls("POST", "/api/tasks/tk_2/review")).toHaveLength(1),
    );
  });
});

describe("Inbox: keel's proposals and review comments", () => {
  const base = {
    project_id: "ludus-engine",
    project_name: "ludus-engine",
    thread_id: "",
    flow: "Empty cart crashes",
    workflow_id: "fix",
    step: null,
    more: false,
    options: [],
    since: new Date().toISOString(),
  };
  const items = (): InboxItem[] => [
    {
      ...base,
      kind: "task-proposal",
      title: "I want to run the fix flow on SHOPS-1234",
      detail: "Why: the cart crashes. 1 question(s) first.",
      id: "task-item-200",
      questions: [
        {
          id: "q1",
          question: "Mobile too?",
          options: [{ label: "yes" }, { label: "no" }],
        },
      ],
      payload: {
        kind: "flow",
        workflow_id: "fix",
        why: "the cart crashes.",
        title: "Empty cart",
        trigger: "Jira moved SHOPS-1234 to In Progress",
      },
      task: {
        id: "tk_2",
        item_id: 200,
        key: "SHOPS-1234",
        url: null,
        title: "Empty cart crashes",
        status: "in_progress",
        stage: "flow",
        pr_url: null,
        actions: [
          { id: "start", label: "Start", needs_note: false },
          { id: "other", label: "Use another flow", needs_note: false },
          { id: "later", label: "Not now", needs_note: false },
        ],
      },
    },
    {
      ...base,
      kind: "task-review",
      title:
        "ana commented on SHOPS-1234's pull request: the reviewer is right",
      detail: '"This returns null."',
      id: "task-item-201",
      payload: {
        thread_id: "th2",
        author: "ana",
        said: "This returns null.",
        where: "src/cart.kt:12",
        verdict: "reviewer_right",
        why: "no empty check",
        reply: "Good catch.",
      },
      task: {
        id: "tk_2",
        item_id: 201,
        key: "SHOPS-1234",
        url: null,
        title: "Empty cart crashes",
        status: "in_review",
        stage: "th2",
        pr_url: null,
        actions: [
          { id: "reply", label: "Use keel's reply", needs_note: false },
          {
            id: "address",
            label: "Address it (small flow)",
            needs_note: false,
          },
          { id: "handle", label: "I'll handle it", needs_note: false },
        ],
      },
    },
  ];

  it("answers keel's questions, starts the flow or another one, and replies with the edited text", async () => {
    const user = userEvent.setup();
    let list = items();
    server.use(
      http.get("/api/inbox", () =>
        HttpResponse.json({
          items: list,
          count: list.length,
          kinds: ["task-proposal", "task-review"],
          projects: [
            { id: "ludus-engine", name: "ludus-engine", count: list.length },
          ],
        } satisfies InboxView),
      ),
      http.post("/api/inbox/tasks/:id/act", async ({ request, params }) => {
        db.calls.push({
          method: "POST",
          path: `/api/inbox/tasks/${params.id}/act`,
          body: await request.json(),
        });
        list = list.filter((i) => i.task?.item_id !== Number(params.id));
        return HttpResponse.json({ id: "tk_2" });
      }),
    );
    location.hash = "#/inbox";
    render(<App />);
    const p = await screen.findByRole("article", {
      name: "I want to run the fix flow on SHOPS-1234",
    });
    expect(p).toHaveTextContent("keel proposes");
    expect(p).toHaveTextContent("Jira moved SHOPS-1234 to In Progress");
    await user.click(
      within(p).getByRole("button", { name: "Use another flow" }),
    ); // first: pick the flow
    expect(calls("POST", "/api/inbox/tasks/200/act")).toHaveLength(0);
    expect(await within(p).findByLabelText("Another flow")).toBeInTheDocument();
    await user.click(within(p).getByRole("radio", { name: /yes/ }));
    await user.click(within(p).getByRole("button", { name: "Start" }));
    await waitFor(() =>
      expect(calls("POST", "/api/inbox/tasks/200/act")[0]?.body).toEqual({
        action: "start",
        answers: { q1: "yes" },
      }),
    );

    const r = await screen.findByRole("article", {
      name: /ana commented on SHOPS-1234's pull request/,
    });
    expect(r).toHaveTextContent("review comment");
    expect(r).toHaveTextContent("the reviewer is right");
    const box = within(r).getByLabelText(/keel's reply/);
    expect(box).toHaveValue("Good catch.");
    await user.clear(box);
    await user.type(box, "Good catch, fixed in the next commit.");
    await user.click(
      within(r).getByRole("button", { name: "Use keel's reply" }),
    );
    await waitFor(() =>
      expect(calls("POST", "/api/inbox/tasks/201/act")[0]?.body).toEqual({
        action: "reply",
        note: "Good catch, fixed in the next commit.",
      }),
    );
  });
});
