// 0.18.38 the redesigned Source control with the Git plugin on: the pull request card (open, none yet), GitHub not
// answering in time (the amber card, Try again now, the raw error, a new try every 30 s), a real error, Push only when
// there is something to push, Update from the base with how far behind it is, the line counts and the commit box.

import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import { App } from "../../../../web/src/App";
import * as fx from "../../../../web/src/test/fixtures";
import { db, server } from "../../../../web/src/test/setup";
import { PR_RETRY_MS, prState } from "../GitPanel";

const calls = (method: string, path: string) =>
  db.calls.filter((c) => c.method === method && c.path === path);

/** GET /git/pr answers `answer()` and counts the reads. */
function servePr(answer: () => object, status = 200) {
  const reads = { n: 0 };
  server.use(
    http.get("/api/projects/:pid/git/pr", () => {
      reads.n += 1;
      return HttpResponse.json(answer(), { status });
    }),
  );
  return reads;
}

const PR = {
  number: 7,
  title: "Euro prices",
  url: "https://github.com/o/r/pull/7",
  state: "OPEN",
  base: "main",
  checks: [
    { name: "ci / web", state: "success", url: "" },
    { name: "ci / api", state: "success", url: "" },
    { name: "ci / e2e", state: "in_progress", url: "" },
  ],
  checks_done: 2,
  checks_failed: 0,
  review: "REVIEW_REQUIRED",
  review_requests: ["ann", "bob"],
  comments: [
    { author: "ann", body: "round half up", path: "src/money.ts", line: 14 },
    { author: "bob", body: "and a test", path: null, line: null },
    { author: "ann", body: "nit: name", path: "src/money.ts", line: 3 },
  ],
  comments_total: 3,
};
const TLS =
  'GitHub did not answer in time: Post "https://api.github.com/graphql": net/http: TLS handshake timeout';

async function openScm(fakeTimers = false) {
  const user = userEvent.setup(fakeTimers ? { advanceTimers: vi.advanceTimersByTime } : {});
  location.hash = "#/repo";
  render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Source control" }),
  );
  return {
    user,
    view: screen.getByRole("complementary", { name: "Source control" }),
  };
}

afterEach(() => vi.useRealTimers());

describe("Source control with the Git plugin (0.18.38)", () => {
  it("names the pull request's state", () => {
    expect(prState({ state: "OPEN" }).label).toBe("Open");
    expect(prState({ state: "OPEN", draft: true }).label).toBe("Draft");
    expect(prState({ state: "MERGED", draft: false }).label).toBe("Merged");
    expect(prState({ state: "CLOSED" }).label).toBe("Closed");
  });

  it("an open pull request: state, number, title, target, checks, reviews, new comments, Open review and On GitHub", async () => {
    db.plugins.git = true;
    db.plugins.review = true;
    db.pr = PR as never;
    const { user, view } = await openScm();
    const pr = await within(view).findByRole("group", {
      name: "Pull request #7",
    });
    expect(
      within(view).getByRole("heading", { name: "Pull request" }),
    ).toBeInTheDocument();
    expect(pr).toHaveTextContent("Open");
    expect(pr).toHaveTextContent("#7");
    expect(pr).toHaveTextContent("Euro prices");
    expect(pr).toHaveTextContent("into main");
    expect(pr).toHaveTextContent("Checks: 2 of 3 passed");
    expect(pr).toHaveTextContent("1 running");
    expect(pr).toHaveTextContent("Review: waiting for 2 people");
    expect(pr).toHaveTextContent("3 new comments");
    expect(
      within(pr).getByRole("link", { name: "Open review" }),
    ).toHaveAttribute("href", "#/repo/@review/pr:7");
    const gh = within(pr).getByRole("link", {
      name: "On GitHub (opens a new tab)",
    });
    expect(gh).toHaveAttribute("href", PR.url);
    expect(gh).toHaveAttribute("target", "_blank");
    // asking KeelBot about them counts them as seen
    await user.click(
      within(pr).getByRole("button", {
        name: "Ask KeelBot to address the comments",
      }),
    );
    await waitFor(() => expect(pr).toHaveTextContent("3 comments"));
    expect(pr).not.toHaveTextContent("new comment");
    expect(localStorage.getItem("keel.scm.pr-seen.ludus-engine.7")).toBe("3");
    expect(
      within(view).getByRole("button", {
        name: "Ask KeelBot about this pull request",
      }),
    ).toBeInTheDocument();
  });

  it("without the Code Review plugin there is no Open review", async () => {
    db.plugins.git = true;
    db.pr = PR as never;
    const { view } = await openScm();
    const pr = await within(view).findByRole("group", {
      name: "Pull request #7",
    });
    expect(within(pr).queryByRole("link", { name: "Open review" })).toBeNull();
    expect(
      within(pr).getByRole("link", { name: "On GitHub (opens a new tab)" }),
    ).toBeInTheDocument();
  });

  it("no pull request yet: KeelBot drafts it once the branch is pushed; before that, push first", async () => {
    db.plugins.git = true;
    const { view } = await openScm();
    expect(
      await within(view).findByRole("button", {
        name: "Ask KeelBot to draft the pull request",
      }),
    ).toBeInTheDocument();
    expect(
      within(view).queryByRole("group", { name: /Pull request #/ }),
    ).toBeNull();
  });

  it("a branch never pushed: Push is the primary button and the pull request waits for it", async () => {
    db.plugins.git = true;
    db.gitStatus = { ...db.gitStatus, upstream: null, pushed: false };
    const { view } = await openScm();
    expect(
      await within(view).findByText(
        "No pull request yet: push the branch first.",
      ),
    ).toBeInTheDocument();
    expect(within(view).getByText("not pushed yet")).toBeInTheDocument();
    expect(within(view).getByRole("button", { name: "Push" })).toHaveClass(
      "primary",
    );
  });

  it("nothing to push: a disabled Nothing to push and the pushed pill", async () => {
    db.plugins.git = true;
    db.gitStatus = { ...db.gitStatus, ahead: 0 };
    const { view } = await openScm();
    const none = await within(view).findByRole("button", {
      name: "Nothing to push",
    });
    expect(none).toBeDisabled();
    expect(within(view).queryByRole("button", { name: "Push" })).toBeNull();
    expect(within(view).getByText("pushed")).toHaveClass("scm-pill");
  });

  it("behind main: the pill says how far, Update from main shows the count and merges", async () => {
    db.plugins.git = true;
    db.gitStatus = { ...db.gitStatus, base_behind: 3 };
    // Update waits for a clean tree: no uncommitted file here
    server.use(
      http.get("/api/projects/:pid/repo", () => HttpResponse.json({ ...fx.repo, behind: 3 })),
      http.get("/api/projects/:pid/repo/changes", () => HttpResponse.json([])),
    );
    const { user, view } = await openScm();
    expect(await within(view).findByText("↓ 3 behind main")).toHaveClass("tone-warn");
    expect(within(view).getByText("Nothing to commit. The working tree is clean.")).toBeInTheDocument();
    const update = await within(view).findByRole("button", { name: "Update from main (3)" });
    expect(update).toBeEnabled();
    await user.click(update);
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/git/sync")).toHaveLength(1));
  });

  it("GitHub did not answer in time: the amber card, the raw error on demand, and Try again now", async () => {
    db.plugins.git = true;
    let answer: object = { pr: null, error: { message: TLS, hint: "The branch and its commits are fine.", transient: true } };
    const reads = servePr(() => answer);
    const { user, view } = await openScm();
    expect(await within(view).findByText("GitHub did not answer in time")).toBeInTheDocument();
    expect(within(view).getByText(/Your branch and commits are fine/)).toBeInTheDocument();
    expect(within(view).queryByText(/^Pull request: /)).toBeNull();
    const show = within(view).getByRole("button", { name: "Show details" });
    expect(show).toHaveAttribute("aria-expanded", "false");
    expect(within(view).getByText(/TLS handshake timeout/)).not.toBeVisible();
    await user.click(show);
    expect(within(view).getByRole("button", { name: "Hide details" })).toHaveAttribute("aria-expanded", "true");
    expect(within(view).getByText(/TLS handshake timeout/)).toBeVisible();
    // GitHub answers again
    answer = { pr: PR };
    const before = reads.n;
    await user.click(within(view).getByRole("button", { name: "Try again now" }));
    expect(await within(view).findByRole("group", { name: "Pull request #7" })).toBeInTheDocument();
    expect(reads.n).toBe(before + 1);
    expect(within(view).queryByText("GitHub did not answer in time")).toBeNull();
  });

  it("GitHub did not answer in time: it tries again by itself every 30 s while the panel is open", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    db.plugins.git = true;
    const reads = servePr(() => ({ pr: null, error: { message: TLS, transient: true } }));
    const { user, view } = await openScm(true);
    expect(await within(view).findByText("GitHub did not answer in time")).toBeInTheDocument();
    const before = reads.n;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_RETRY_MS);
    });
    await waitFor(() => expect(reads.n).toBe(before + 1));
    // another view in the side bar hides Source control: no more tries
    await user.click(screen.getByRole("button", { name: "Explorer" }));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(PR_RETRY_MS * 2);
    });
    expect(reads.n).toBe(before + 1);
  });

  it("a real error (bad credentials) is a red card with GitHub's words and Try again, not the amber one", async () => {
    db.plugins.git = true;
    servePr(() => ({ error: "gh could not read the pull request: HTTP 401: Bad credentials", hint: "Check the token in Connections › GitHub." }), 502);
    const { view } = await openScm();
    const alert = await within(view).findByRole("alert");
    expect(alert).toHaveTextContent("Pull request: gh could not read the pull request: HTTP 401: Bad credentials");
    expect(alert).toHaveTextContent("Check the token in Connections › GitHub.");
    expect(within(alert).getByRole("button", { name: "Try again" })).toBeInTheDocument();
    expect(within(view).queryByText("GitHub did not answer in time")).toBeNull();
  });

  it("the changes with their letters and line counts, and the commit box: Write it for me, Commit 3 files", async () => {
    db.plugins.git = true;
    db.gitStatus = {
      ...db.gitStatus,
      changes: [{ path: "api/ScoreController.kt", status: "M", added: 42, deleted: 9 } as never, { path: "notes.txt", status: "??" }],
    };
    const { user, view } = await openScm();
    const row = await within(view).findByRole("button", { name: "Open the changes of api/ScoreController.kt" });
    await waitFor(() => expect(row).toHaveTextContent("+42"));
    expect(row).toHaveTextContent("−9");
    expect(row.querySelector(".scm-letter")).toHaveTextContent("M");
    expect(within(view).getByRole("button", { name: "Open the changes of notes.txt" }).querySelector(".scm-letter")).toHaveTextContent("U");
    expect(within(view).getByText("3 files")).toHaveClass("scm-count");
    expect(within(view).getByRole("button", { name: /Write it for me/ })).toBeInTheDocument();
    const commit = within(view).getByRole("button", { name: "Commit 3 files" });
    expect(commit).toBeDisabled();
    await user.type(within(view).getByRole("textbox", { name: "Commit message" }), "feat: euro prices");
    expect(commit).toBeEnabled();
    await user.click(commit);
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/git/commit")[0]?.body).toEqual({ message: "feat: euro prices" }));
  });

  it("Refresh reads the pull request again", async () => {
    db.plugins.git = true;
    const reads = servePr(() => ({ pr: PR }));
    const { user, view } = await openScm();
    await within(view).findByRole("group", { name: "Pull request #7" });
    const before = reads.n;
    await user.click(within(view).getByRole("button", { name: "Refresh" }));
    await waitFor(() => expect(reads.n).toBe(before + 1));
  });
});
