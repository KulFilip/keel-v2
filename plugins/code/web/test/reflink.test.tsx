// 0.18.57 A file:line link made while looking at another branch (a KeelBot answer about a PR head, a side session, a
// flow's worktree) opens the file as that branch has it, read-only, with a banner; a link without a ref to a file the
// project folder does not have offers the branch keel found it on. Bug: such a link opened the Code page on the current
// checkout and said "file not found".

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import { codeHref } from "../../../../web/src/format";
import { server } from "../../../../web/src/test/setup";
import { refLabel, refOfQuery, repoHash } from "../model";

const FILE = "src/Orders/ExportService.php";
const BR = "feature/SHOPS-1234-export";
const SHA = "3f2a9c1e5b7d4a0f9e8c7b6a5d4c3b2a1f0e9d8c";
const TEXT =
  Array.from({ length: 20 }, (_, i) =>
    i === 12 ? "// line 13: the export of the orders" : `// line ${i + 1}`,
  ).join("\n") + "\n";

type Seen = {
  fileAt: URLSearchParams[];
  find: string[];
  switched: unknown[];
  file: string[];
};

function stub(
  over: Record<string, unknown> = {},
  opts: { changes?: unknown[]; refs?: unknown[] } = {},
): Seen {
  const seen: Seen = { fileAt: [], find: [], switched: [], file: [] };
  server.use(
    http.get("/api/projects/:pid/repo/file-at", ({ request }) => {
      const q = new URL(request.url).searchParams;
      seen.fileAt.push(q);
      const fromTree = q.get("from") === "worktree";
      return HttpResponse.json({
        path: FILE,
        ref: q.get("ref"),
        sha: SHA,
        kind: "branch",
        branch: BR,
        current: false,
        checked_out: "feat/scores",
        worktree: null,
        source: fromTree ? "worktree" : "ref",
        size: TEXT.length,
        binary: false,
        text: fromTree ? "<?php // not committed yet\n" : TEXT,
        dirty: 0,
        ...over,
      });
    }),
    http.get("/api/projects/:pid/repo/find", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      seen.find.push(path);
      return HttpResponse.json({
        path,
        in_work_tree: false,
        checked_out: "feat/scores",
        refs: opts.refs ?? [
          {
            ref: BR,
            label: BR,
            kind: "branch",
            sha: SHA,
            at: "2026-10-20T10:00:00Z",
          },
          {
            ref: "refs/keel/review-pr/7",
            label: "PR #7 (review)",
            kind: "review",
            sha: "abc1234",
            at: "2026-10-19T10:00:00Z",
          },
        ],
      });
    }),
    http.get("/api/projects/:pid/repo/file", ({ request }) => {
      const path = new URL(request.url).searchParams.get("path") ?? "";
      seen.file.push(path);
      if (path === FILE)
        return HttpResponse.json(
          { error: `No file at ${path}` },
          { status: 404 },
        );
      return undefined;
    }),
    ...(opts.changes
      ? [
          http.get("/api/projects/:pid/repo/changes", () =>
            HttpResponse.json(opts.changes),
          ),
        ]
      : []),
    http.post("/api/projects/:pid/git/switch", async ({ request }) => {
      const body = await request.json();
      seen.switched.push(body);
      return HttpResponse.json({ branch: (body as { branch: string }).branch });
    }),
  );
  return seen;
}

describe("a link with a ref", () => {
  it("carries the ref in the Code page's link, and the link reads it back", () => {
    expect(codeHref(FILE, 13, BR)).toBe(
      `#/repo/src/Orders/ExportService.php:13?ref=${encodeURIComponent(BR)}`,
    );
    expect(repoHash(FILE, 13, BR)).toBe(codeHref(FILE, 13, BR));
    expect(codeHref(FILE, 13)).toBe("#/repo/src/Orders/ExportService.php:13");
    expect(refOfQuery(`ref=${encodeURIComponent(BR)}`)).toBe(BR);
    expect(refOfQuery("")).toBeNull();
    expect(refLabel("refs/keel/review-pr/7")).toBe("PR #7");
    expect(refLabel("refs/keel/review/pr-12")).toBe("PR #12");
    expect(refLabel(SHA)).toBe("3f2a9c1");
    expect(refLabel(BR)).toBe(BR);
  });

  it("opens the file as that branch has it, read-only, under a banner, without asking the work tree", async () => {
    const seen = stub();
    location.hash = codeHref(FILE, 13, BR);
    render(<App />);
    const banner = await screen.findByRole("status", {
      name: "Not the checked-out branch",
    });
    expect(banner).toHaveTextContent(`Showing ${BR} — not checked out.`);
    expect(banner).toHaveTextContent("The project folder is on feat/scores.");
    expect(
      await screen.findByText(/line 13: the export of the orders/),
    ).toBeInTheDocument();
    expect(seen.fileAt[0].get("path")).toBe(FILE);
    expect(seen.fileAt[0].get("ref")).toBe(BR);
    expect(seen.file).not.toContain(FILE);
    expect(
      screen.getByRole("tab", {
        name: new RegExp(`ExportService\\.php @ ${BR.replace(/\//g, "\\/")}`),
      }),
    ).toBeInTheDocument();
    // the URL keeps the ref (a reload opens the same thing)
    await waitFor(() =>
      expect(location.hash).toContain(`?ref=${encodeURIComponent(BR)}`),
    );
  });

  it("Check out refuses while the folder has uncommitted changes, and asks first when it has none", async () => {
    const user = userEvent.setup();
    const seen = stub({}, { changes: [{ path: "README.md", unstaged: "M" }] });
    location.hash = codeHref(FILE, 13, BR);
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Check out this branch" }),
    );
    const alert = await screen.findByRole("alert");
    expect(alert).toHaveTextContent(
      "Not checked out: the project folder has 1 uncommitted change.",
    );
    expect(alert).toHaveTextContent(`then check out ${BR}`);
    expect(seen.switched).toHaveLength(0);

    server.use(
      http.get("/api/projects/:pid/repo/changes", () => HttpResponse.json([])),
    );
    await user.click(
      screen.getByRole("button", { name: "Check out this branch" }),
    );
    const ask = await screen.findByRole("group", { name: "Check out" });
    expect(ask).toHaveTextContent(
      `Check out ${BR} in the project folder (now on feat/scores)?`,
    );
    expect(seen.switched).toHaveLength(0);
    await user.click(within(ask).getByRole("button", { name: "Check out" }));
    await waitFor(() =>
      expect(seen.switched).toEqual([{ branch: BR, create: false }]),
    );
  });

  it("a branch a side session has out opens in its worktree, with what is not committed there", async () => {
    const user = userEvent.setup();
    const seen = stub({
      branch: "keel/helper/abc",
      worktree: {
        branch: "keel/helper/abc",
        path: "/workspace/ludus-engine/.keel/worktrees/abc",
      },
    });
    location.hash = codeHref(FILE, 13, "keel/helper/abc");
    render(<App />);
    await screen.findByText(/line 13: the export of the orders/);
    // git refuses to check out a branch twice: no Check out, the worktree instead
    expect(
      screen.queryByRole("button", { name: "Check out this branch" }),
    ).toBeNull();
    await user.click(
      screen.getByRole("button", {
        name: "Open in the side session's worktree",
      }),
    );
    expect(await screen.findByText(/not committed yet/)).toBeInTheDocument();
    expect(seen.fileAt.at(-1)?.get("from")).toBe("worktree");
    expect(
      screen.getByRole("status", { name: "Not the checked-out branch" }),
    ).toHaveTextContent("Showing keel/helper/abc in its worktree");
  });

  it("the checked-out branch opens the work tree's file", async () => {
    const seen = stub({
      current: true,
      ref: "feat/scores",
      branch: "feat/scores",
    });
    location.hash = codeHref("api/ScoreController.kt", 3, "feat/scores");
    render(<App />);
    await waitFor(() => expect(seen.file).toContain("api/ScoreController.kt"));
    expect(
      screen.queryByRole("status", { name: "Not the checked-out branch" }),
    ).toBeNull();
  });
});

describe("a link to a file the project folder does not have", () => {
  it("looks for it on the branches and reviews keel knows, and opens it there", async () => {
    const user = userEvent.setup();
    const seen = stub();
    location.hash = codeHref(FILE, 13);
    render(<App />);
    const box = await screen.findByRole("region", {
      name: "File not in the project folder",
    });
    expect(box).toHaveTextContent(
      `${FILE} is not in the project folder (on feat/scores).`,
    );
    expect(seen.find).toEqual([FILE]);
    expect(
      within(box).getByRole("button", { name: "PR #7 (review)" }),
    ).toBeInTheDocument();
    await user.click(
      within(box).getByRole("button", { name: `Found on ${BR} — open it` }),
    );
    expect(
      await screen.findByText(/line 13: the export of the orders/),
    ).toBeInTheDocument();
    expect(seen.fileAt.at(-1)?.get("ref")).toBe(BR);
    expect(
      screen.getByRole("status", { name: "Not the checked-out branch" }),
    ).toHaveTextContent(`Showing ${BR} — not checked out.`);
  });

  it("says so plainly when no branch has it", async () => {
    stub({}, { refs: [] });
    location.hash = codeHref(FILE, 13);
    render(<App />);
    const box = await screen.findByRole("region", {
      name: "File not in the project folder",
    });
    expect(box).toHaveTextContent(
      "keel found it on no branch or review it knows.",
    );
  });
});
