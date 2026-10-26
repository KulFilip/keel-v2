// 0.18.57 A KeelBot answer's file:line links open the file as the answer's source has it: the branch it was made on
// (a side session's, the branch the folder was on then) or the ref KeelBot read that file from (`git show <ref>:<path>`,
// a PR head). Bug: the link opened the current checkout and said "file not found".

import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import type { AnswerSource } from "../../../../web/src/api";
import { codeHref } from "../../../../web/src/format";
import { db, FakeEventSource, server } from "../../../../web/src/test/setup";

const FILE = "src/Orders/ExportService.php";
const BR = "feature/SHOPS-1234-export";
const panel = () => screen.findByRole("complementary", { name: "KeelBot" });

/** The engine answers with what the answer was made from. */
function answer(text: string, source: AnswerSource) {
  const sess = db.helper.sessions[0];
  const n = (sess.messages?.length ?? 0) + 1;
  const call = `call-${sess.id}-${n - 1}`;
  sess.messages = [
    ...(sess.messages ?? []),
    {
      n,
      role: "helper",
      text,
      call_id: call,
      data: {
        status: "done",
        provider: "claude",
        model: "sonnet",
        tokens_in: 10,
        tokens_out: 5,
        cost_usd: 0,
        ms: 100,
        source,
      },
      at: new Date().toISOString(),
    },
  ];
  sess.status = "idle";
  sess.busy = false;
  act(() => {
    FakeEventSource.emit("helper.finished", {
      type: "helper.finished",
      thread_id: sess.id,
      project_id: "ludus-engine",
      call_id: call,
      step: "helper",
      at: new Date().toISOString(),
      data: { status: "done", tokens_in: 10, tokens_out: 5 },
    });
  });
}

function stubFileAt() {
  const refs: (string | null)[] = [];
  server.use(
    http.get("/api/projects/:pid/repo/file-at", ({ request }) => {
      const q = new URL(request.url).searchParams;
      refs.push(q.get("ref"));
      return HttpResponse.json({
        path: q.get("path"),
        ref: q.get("ref"),
        sha: "3f2a9c1e5b7d",
        kind: "branch",
        branch: q.get("ref"),
        current: false,
        checked_out: "feat/scores",
        worktree: null,
        source: "ref",
        size: 40,
        binary: false,
        text: "<?php\n// the export\n",
        dirty: 0,
      });
    }),
  );
  return refs;
}

describe("KeelBot's file links carry the ref the answer was made from", () => {
  it("in the Code page: a link opens the file at the answer's branch, or at the ref KeelBot read it from", async () => {
    const user = userEvent.setup();
    const refs = stubFileAt();
    location.hash = "#/repo/api/ScoreController.kt:3";
    render(<App />);
    await screen.findByRole("region", {
      name: "Code of api/ScoreController.kt",
    });
    fireEvent.keyDown(window, { key: "i", metaKey: true });
    const p = await panel();
    await user.type(
      within(p).getByRole("textbox", { name: "Ask KeelBot" }),
      "What does the export do?{Enter}",
    );
    await within(p).findByText("What does the export do?", {
      selector: ".hp-text",
    });
    // made on the folder's branch then (feat/scores, still checked out); one file read from the PR's head
    answer(
      `The export is in \`${FILE}:13\`; it is called from \`api/ScoreController.kt:9\`.`,
      {
        ref: "feat/scores",
        sha: "77b1e02",
        paths: { [FILE]: "refs/keel/review-pr/7" },
      },
    );
    const pr = await within(p).findByRole("link", { name: `${FILE}:13` });
    expect(pr).toHaveAttribute(
      "title",
      `Open ${FILE}:13 as refs/keel/review-pr/7 has it in the editor`,
    );
    await user.click(pr);
    const banner = await screen.findByRole("status", {
      name: "Not the checked-out branch",
    });
    expect(banner).toHaveTextContent("Showing PR #7 — not checked out.");
    expect(refs).toContain("refs/keel/review-pr/7");
    // the checked-out branch: the work tree's file, at that line (no read at a ref)
    const n = refs.length;
    await user.click(
      within(p).getByRole("link", { name: "api/ScoreController.kt:9" }),
    );
    await waitFor(() =>
      expect(document.querySelector('.cv-row[data-line="9"]')).toHaveClass(
        "tgt",
      ),
    );
    expect(refs).toHaveLength(n);
  });

  it("on KeelBot's own page: the link to the Code page names the ref", async () => {
    const user = userEvent.setup();
    location.hash = "#/keelbot";
    render(<App />);
    const box = await screen.findByRole("textbox", { name: "Ask KeelBot" });
    await user.type(box, "Where is the export?{Enter}");
    await screen.findByText("Where is the export?", { selector: ".hp-text" });
    answer(`In \`${FILE}:13\`.`, {
      ref: BR,
      sha: "3f2a9c1",
      worktree: "/workspace/ludus-engine/.keel/worktrees/abc",
    });
    await user.click(await screen.findByRole("link", { name: `${FILE}:13` }));
    await waitFor(() => expect(location.hash).toBe(codeHref(FILE, 13, BR)));
  });
});
