// 0.18.38 Source control's redesign, the Code plugin's side: the ticket key and the dimmed prefix of the branch name,
// the side bar's own width for Source control (drag or keys, remembered), and the branch list with the Git plugin
// (Mine and Stale, Switch, Check out a branch only origin has, Clean up merged branches). Its small rules too.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import * as fx from "../../../../web/src/test/fixtures";
import { db, server } from "../../../../web/src/test/setup";
import {
  ageOf,
  branchMatches,
  clampSide,
  isStale,
  SCM_DEFAULT,
  SCM_MIN,
  splitBranch,
  ticketKey,
} from "../scmModel";

const calls = (method: string, path: string) =>
  db.calls.filter((c) => c.method === method && c.path === path);
const DAY = 86_400_000;
const daysAgo = (n: number) => new Date(Date.now() - n * DAY).toISOString();

async function openScm() {
  const user = userEvent.setup();
  location.hash = "#/repo";
  const r = render(<App />);
  await user.click(
    await screen.findByRole("button", { name: "Source control" }),
  );
  return {
    user,
    view: screen.getByRole("complementary", { name: "Source control" }),
    ...r,
  };
}

describe("Source control's rules", () => {
  it("finds a ticket key in a branch name: the generic pattern, or a team's", () => {
    expect(ticketKey("feature/ERPDM-1769-parcelperform-webhook-eta-v2")).toBe(
      "ERPDM-1769",
    );
    expect(ticketKey("fix/AB2-7")).toBe("AB2-7");
    expect(ticketKey("fix-2-lowercase")).toBeNull();
    expect(ticketKey("feat/scores")).toBeNull();
    expect(ticketKey("abcERPDM-12x")).toBeNull(); // not inside another word
    expect(ticketKey("feature/shop-42-cart", "SHOP-\\d+")).toBe("SHOP-42"); // a team's pattern ignores case
    expect(ticketKey("feature/ERPDM-1-x", "([")).toBe("ERPDM-1"); // a pattern that does not compile: the generic one
  });

  it("splits a branch name into its folder prefix and the rest", () => {
    expect(splitBranch("feature/ERPDM-1-x")).toEqual({
      prefix: "feature/",
      rest: "ERPDM-1-x",
    });
    expect(splitBranch("feat/deep/one")).toEqual({
      prefix: "feat/deep/",
      rest: "one",
    });
    expect(splitBranch("main")).toEqual({ prefix: "", rest: "main" });
  });

  it("matches a branch by name, by name without dashes, or by the ticket key in its last commit", () => {
    expect(branchMatches("feature/ERPDM-1769-eta", "", "erpdm-1769")).toBe(
      true,
    );
    expect(branchMatches("feature/ERPDM-1769-eta", "", "erpdm1769")).toBe(true);
    expect(branchMatches("feat/eta", "ERPDM-1769 Map the ranges", "1769")).toBe(
      true,
    );
    expect(branchMatches("feat/eta", "fix the rounding", "1769")).toBe(false);
    expect(branchMatches("fix/login", "", "FIX")).toBe(true);
  });

  it("says when a branch is stale and how old it is", () => {
    const now = Date.parse("2026-10-22T12:00:00Z");
    expect(isStale("2026-10-01T12:00:00Z", now)).toBe(true);
    expect(isStale("2026-10-15T12:00:00Z", now)).toBe(false);
    expect(isStale("not a date", now)).toBe(false);
    expect(ageOf("2026-10-20T12:00:00Z", now)).toBe("2 days ago");
    expect(ageOf("2026-10-01T12:00:00Z", now)).toBe("3 weeks ago");
  });

  it("keeps the side bar between its minimum and the window minus 320 px", () => {
    expect(clampSide(100, SCM_MIN, 1400)).toBe(SCM_MIN);
    expect(clampSide(500, SCM_MIN, 1400)).toBe(500);
    expect(clampSide(2000, SCM_MIN, 1400)).toBe(900);
    expect(clampSide(700, SCM_MIN, 900)).toBe(580);
    expect(clampSide(700, SCM_MIN, 500)).toBe(SCM_MIN); // a tiny window: the minimum still holds
  });
});

describe("Source control's head", () => {
  it("shows the ticket key as a chip and the branch name with its prefix dimmed", async () => {
    server.use(
      http.get("/api/projects/:pid/repo", () =>
        HttpResponse.json({
          ...fx.repo,
          branch: "feature/ERPDM-1769-parcelperform-webhook-eta-v2",
          ahead: 51,
          behind: 3,
        }),
      ),
    );
    const { view } = await openScm();
    const head = await within(view).findByRole("region", { name: "Branch" });
    expect(within(head).getByText("ERPDM-1769")).toHaveClass("scm-ticket");
    const name = head.querySelector(".scm-name")!;
    expect(name).toHaveTextContent(
      "feature/ERPDM-1769-parcelperform-webhook-eta-v2",
    );
    expect(name.querySelector(".scm-prefix")).toHaveTextContent(/^feature\/$/);
    expect(within(head).getByText("↑ 51 ahead")).toHaveClass("tone-ok");
    expect(within(head).getByText("↓ 3 behind main")).toHaveClass("tone-warn");
    expect(head.querySelector(".scm-pill")).toHaveTextContent("from main");
  });

  it("has no chip when the branch has no ticket key", async () => {
    const { view } = await openScm();
    const head = await within(view).findByRole("region", { name: "Branch" });
    expect(head.querySelector(".scm-ticket")).toBeNull();
    expect(head.querySelector(".scm-prefix")).toHaveTextContent("feat/");
  });
});

describe("Source control's width", () => {
  it("has its own width: wider by default, changed with the keys, remembered, and the other views keep theirs", async () => {
    const { user, view, unmount } = await openScm();
    expect(view).toBeInTheDocument();
    const split = screen.getByRole("separator", {
      name: "Resize the side bar",
    });
    expect(split).toHaveAttribute("aria-valuenow", String(SCM_DEFAULT));
    expect(split).toHaveAttribute("aria-valuemin", String(SCM_MIN));
    split.focus();
    await user.keyboard("{ArrowRight}");
    expect(split).toHaveAttribute("aria-valuenow", String(SCM_DEFAULT + 16));
    await user.keyboard("{Shift>}{ArrowRight}{/Shift}");
    expect(split).toHaveAttribute("aria-valuenow", String(SCM_DEFAULT + 80));
    await waitFor(() =>
      expect(localStorage.getItem("keel2.repo.side.scm")).toBe(
        String(SCM_DEFAULT + 80),
      ),
    );
    expect(split).toHaveAttribute(
      "aria-valuetext",
      `${SCM_DEFAULT + 80} pixels wide`,
    );
    await user.keyboard("{Home}");
    expect(split).toHaveAttribute("aria-valuenow", String(SCM_MIN));
    await user.keyboard("{End}");
    expect(Number(split.getAttribute("aria-valuenow"))).toBe(
      Number(split.getAttribute("aria-valuemax")),
    );
    await user.keyboard("{Enter}");
    expect(split).toHaveAttribute("aria-valuenow", String(SCM_DEFAULT));
    await user.keyboard("{ArrowLeft}");
    // the Explorer keeps the shared width
    await user.click(screen.getByRole("button", { name: "Explorer" }));
    expect(
      screen.getByRole("separator", { name: "Resize the side bar" }),
    ).toHaveAttribute("aria-valuenow", "280");
    // and Source control's comes back on the next visit
    unmount();
    await openScm();
    expect(
      screen.getByRole("separator", { name: "Resize the side bar" }),
    ).toHaveAttribute("aria-valuenow", String(SCM_DEFAULT - 16));
  });
});

describe("Source control's branches with the Git plugin", () => {
  const setup = (info: object[], extra: object = {}) => {
    db.plugins.git = true;
    server.use(
      http.get("/api/projects/:pid/repo", () =>
        HttpResponse.json({
          ...fx.repo,
          branches: [
            "main",
            "feat/scores",
            "feat/old",
            "feat/mate",
            "feat/done",
          ].map((name) => ({ name, note: `${name}: last commit` })),
          remote_branches: [
            { name: "origin/feat/scores", note: "" },
            { name: "origin/feature/ERPDM-1810-sonar-fixes", note: "sonar" },
          ],
          ...extra,
        }),
      ),
      http.get("/api/projects/:pid/git/branches", () =>
        HttpResponse.json(info),
      ),
    );
  };
  const INFO = [
    {
      name: "feat/scores",
      current: true,
      ahead: 6,
      behind: 0,
      date: daysAgo(0),
      subject: "s",
      author: "Me",
      mine: true,
    },
    {
      name: "main",
      current: false,
      ahead: 0,
      behind: 0,
      date: daysAgo(1),
      subject: "m",
      author: "Ann",
      mine: false,
    },
    {
      name: "feat/old",
      current: false,
      ahead: 2,
      behind: 63,
      date: daysAgo(30),
      subject: "o",
      author: "Me",
      mine: true,
    },
    {
      name: "feat/mate",
      current: false,
      ahead: 4,
      behind: 0,
      date: daysAgo(2),
      subject: "x",
      author: "Ann",
      mine: false,
    },
    {
      name: "feat/done",
      current: false,
      ahead: 0,
      behind: 5,
      date: daysAgo(3),
      subject: "d",
      author: "Me",
      mine: true,
    },
  ];
  const names = (view: HTMLElement) =>
    [...view.querySelectorAll(".scm-br .scm-msg")].map((n) => n.textContent);
  const openFolder = async (
    user: ReturnType<typeof userEvent.setup>,
    view: HTMLElement,
    label: RegExp,
  ) => {
    const f = within(view).getByRole("button", { name: label });
    if (f.getAttribute("aria-expanded") === "false") await user.click(f);
  };

  it("Mine and Stale filter the local branches (the current one stays), with each branch's facts", async () => {
    setup(INFO);
    const { user, view } = await openScm();
    const chips = await within(view).findByRole("group", {
      name: "Show branches",
    });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "Mine", "Stale"]);
    expect(within(chips).getByRole("button", { name: "All" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await openFolder(user, view, /^feat\/ /);
    expect(names(view)).toEqual(
      expect.arrayContaining(["feat/old", "feat/mate", "feat/done"]),
    );
    const old = view.querySelector(
      ".scm-brow:has([aria-label='Open the branch feat/old']) .scm-facts",
    )!;
    expect(old).toHaveTextContent("↑2 · ↓63 · 4 weeks ago");
    expect(old).toHaveClass("old");
    expect(
      view.querySelector(
        ".scm-brow:has([aria-label='Open the branch feat/mate']) .scm-facts",
      ),
    ).toHaveTextContent("by Ann");

    await user.click(within(chips).getByRole("button", { name: "Mine" }));
    expect(within(chips).getByRole("button", { name: "Mine" })).toHaveAttribute(
      "aria-pressed",
      "true",
    );
    await openFolder(user, view, /^feat\/ /);
    expect(names(view)).toContain("feat/old");
    expect(names(view)).not.toContain("feat/mate");
    expect(names(view)[0]).toBe("feat/scores");
    expect(
      within(view).queryByRole("button", { name: /^On origin only/ }),
    ).toBeNull(); // remotes only under All

    await user.click(within(chips).getByRole("button", { name: "Stale" }));
    await openFolder(user, view, /^feat\/ /);
    expect(names(view).filter((n) => n !== "feat/scores")).toEqual([
      "feat/old",
    ]);
  });

  it("no Mine chip when git has no user (the branches carry no mine)", async () => {
    setup(INFO.map(({ mine: _mine, ...b }) => b));
    const { view } = await openScm();
    const chips = await within(view).findByRole("group", {
      name: "Show branches",
    });
    expect(
      within(chips)
        .getAllByRole("button")
        .map((b) => b.textContent),
    ).toEqual(["All", "Stale"]);
  });

  it("switches to a branch, checks out a branch only origin has, and cleans up the merged ones after a yes", async () => {
    setup(INFO);
    server.use(
      http.post("/api/projects/:pid/git/cleanup", async ({ request }) => {
        db.calls.push({
          method: "POST",
          path: new URL(request.url).pathname,
          body: null,
        });
        return HttpResponse.json({ deleted: ["feat/done"], base: "main" });
      }),
    );
    const { user, view } = await openScm();
    await within(view).findByRole("group", { name: "Show branches" });
    await openFolder(user, view, /^feat\/ /);
    await user.click(
      within(view).getByRole("button", { name: "Switch to feat/mate" }),
    );
    await waitFor(() =>
      expect(
        calls("POST", "/api/projects/ludus-engine/git/switch").at(-1)?.body,
      ).toEqual({ branch: "feat/mate", create: false }),
    );
    expect(
      within(view).queryByRole("button", { name: "Switch to feat/scores" }),
    ).toBeNull(); // not the current one

    // the remote list holds only what is not here: origin/feat/scores has a local twin
    const remote = within(view).getByRole("button", {
      name: "On origin only 1",
    });
    await user.click(remote);
    await user.click(within(view).getByRole("button", { name: "feature/ 1" }));
    await user.click(
      within(view).getByRole("button", {
        name: "Check out origin/feature/ERPDM-1810-sonar-fixes",
      }),
    );
    await waitFor(() =>
      expect(
        calls("POST", "/api/projects/ludus-engine/git/switch").at(-1)?.body,
      ).toEqual({ branch: "feature/ERPDM-1810-sonar-fixes", create: false }),
    );

    // merged: no commit main lacks, not the current branch, not main
    await user.click(
      within(view).getByRole("button", {
        name: "Clean up merged branches (1)",
      }),
    );
    const ask = within(view).getByRole("group", {
      name: "Clean up merged branches",
    });
    expect(ask).toHaveTextContent("Delete 1 merged branch?");
    expect(
      calls("POST", "/api/projects/ludus-engine/git/cleanup"),
    ).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "Delete" }));
    await waitFor(() =>
      expect(
        calls("POST", "/api/projects/ludus-engine/git/cleanup"),
      ).toHaveLength(1),
    );
    expect(
      await screen.findByText("Deleted 1 merged branch: feat/done."),
    ).toBeInTheDocument();
  });

  it("without the Git plugin: no chips, no Switch, no clean up", async () => {
    server.use(
      http.get("/api/projects/:pid/repo", () =>
        HttpResponse.json({
          ...fx.repo,
          branches: ["main", "feat/scores", "feat/old"].map((name) => ({
            name,
            note: name,
          })),
        }),
      ),
    );
    const { user, view } = await openScm();
    await user.click(
      await within(view).findByRole("button", { name: /^Branches/ }),
    );
    expect(
      within(view).queryByRole("group", { name: "Show branches" }),
    ).toBeNull();
    expect(
      within(view).queryByRole("button", { name: /^Switch to/ }),
    ).toBeNull();
    expect(
      within(view).queryByRole("button", { name: /Clean up merged/ }),
    ).toBeNull();
  });
});
