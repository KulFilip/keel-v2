// v0.15.9 keel's file history: a file's versions with a diff and Restore, missing files, what a flow applied.
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { AppliedPanel, DocHistoryPanel, DocProblems } from "../components/DocHistory";
import { byText, type DocVersion } from "../docHistoryApi";
import { AppProvider } from "../state";
import { server } from "./setup";

const path = ".keel/specs/scores.md";
const v = (n: number, more: Partial<DocVersion> = {}): DocVersion => ({
  id: `dv-${n}`, path, kind: "spec", version: n, sha256: `s${n}`, size: 10 * n, deleted: false, by_kind: "agent", by_name: "explorer",
  at: `2026-10-14T10:0${n}:00Z`, phase: "spec", ...more,
});

describe("file history", () => {
  it("says who changed a version", () => {
    expect(byText(v(1))).toBe("explorer");
    expect(byText(v(1, { by_kind: "outside" }))).toBe("outside keel");
    expect(byText(v(1, { via: "mcp" }))).toBe("explorer · via MCP");
  });

  it("lists the versions, shows a diff and restores an older one", async () => {
    let restored = "";
    server.use(
      http.get("/api/projects/p1/docs/history/versions", () => HttpResponse.json([v(2, { by_kind: "keel", by_name: "spec_freeze", commit_sha: "abc1234ff" }), v(1)])),
      http.get("/api/projects/p1/docs/history/diff", ({ request }) => {
        expect(new URL(request.url).searchParams.get("to")).toBe("file");
        return HttpResponse.json({ diff: "--- a\n+++ b\n-# Old\n+# New\n" });
      }),
      http.post("/api/projects/p1/docs/history/restore", async ({ request }) => {
        restored = ((await request.json()) as { version_id: string }).version_id;
        return HttpResponse.json(v(3, { by_kind: "user" }));
      }),
    );
    vi.spyOn(window, "confirm").mockReturnValue(true);
    render(<AppProvider><DocHistoryPanel pid="p1" path={path} /></AppProvider>);
    expect(await screen.findByText(/commit abc1234/)).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Version 1" }));
    expect(await screen.findByText("+# New")).toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);       // never the newest one
    await userEvent.click(screen.getByRole("button", { name: "Restore" }));
    await waitFor(() => expect(restored).toBe("dv-1"));
  });

  it("shows missing and changed files, and nothing when all is well", async () => {
    server.use(http.get("/api/projects/p1/docs/history", () => HttpResponse.json([
      { path, kind: "spec", versions: 2, at: "x", state: "missing" },
      { path: ".keel/knowledge/data.md", kind: "knowledge", versions: 1, at: "x", state: "changed" },
      { path: ".keel/adr/1.md", kind: "adr", versions: 1, at: "x", state: "ok" },
    ])));
    render(<AppProvider><DocProblems pid="p1" /></AppProvider>);
    expect(await screen.findByText("missing")).toBeInTheDocument();
    expect(screen.getByText("changed outside keel")).toBeInTheDocument();
    expect(screen.queryByText(".keel/adr/1.md")).not.toBeInTheDocument();
    expect(screen.getAllByRole("button", { name: "Restore" })).toHaveLength(1);
  });

  it("offers 'Two versions — pick one' for a conflict, shows the diff and restores the other version", async () => {
    let restored = "";
    server.use(
      http.get("/api/projects/p1/docs/history", () => HttpResponse.json([
        { path, kind: "spec", versions: 3, at: "x", state: "conflict", conflict: ["dv-3", "dv-2"] },
      ])),
      http.get("/api/projects/p1/docs/history/diff", ({ request }) => {
        const q = new URL(request.url).searchParams;
        expect([q.get("from"), q.get("to")]).toEqual(["dv-2", "dv-3"]);
        return HttpResponse.json({ diff: "--- a\n+++ b\n-# From the worktree\n+# From the folder\n" });
      }),
      http.post("/api/projects/p1/docs/history/restore", async ({ request }) => {
        restored = ((await request.json()) as { version_id: string }).version_id;
        return HttpResponse.json(v(4, { by_kind: "user" }));
      }),
    );
    render(<AppProvider><DocProblems pid="p1" /></AppProvider>);
    await userEvent.click(await screen.findByRole("button", { name: "Two versions — pick one" }));
    expect(await screen.findByText("+# From the folder")).toBeInTheDocument();
    expect(screen.getByText("-# From the worktree")).toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "Keep this one (the other flow's)" }));
    await waitFor(() => expect(restored).toBe("dv-2"));
  });

  it("keeping the newest version writes nothing and closes the panel", async () => {
    let posts = 0;
    server.use(
      http.get("/api/projects/p1/docs/history", () => HttpResponse.json([
        { path, kind: "spec", versions: 3, at: "x", state: "conflict", conflict: ["dv-3", "dv-2"] },
      ])),
      http.get("/api/projects/p1/docs/history/diff", () => HttpResponse.json({ diff: "+# New\n" })),
      http.post("/api/projects/p1/docs/history/restore", () => { posts++; return HttpResponse.json(v(4)); }),
    );
    render(<AppProvider><DocProblems pid="p1" /></AppProvider>);
    await userEvent.click(await screen.findByRole("button", { name: "Two versions — pick one" }));
    await userEvent.click(await screen.findByRole("button", { name: "Keep this one (in the file now)" }));
    await waitFor(() => expect(screen.queryByRole("group")).not.toBeInTheDocument());
    expect(posts).toBe(0);
  });

  it("lists what a flow applied", async () => {
    server.use(http.get("/api/threads/t1/applied", () => HttpResponse.json({ thread_id: "t1", items: [
      { kind: "branch", ref: "feat/scores", files: [], at: "x" },
      { kind: "commit", ref: "abc1234ff", subject: "docs: spec", files: [path], at: "y" },
    ] })));
    render(<AppProvider><AppliedPanel tid="t1" /></AppProvider>);
    expect(await screen.findByText("What keel applied (2)")).toBeInTheDocument();
    expect(screen.getByText("abc1234")).toBeInTheDocument();
  });
});
