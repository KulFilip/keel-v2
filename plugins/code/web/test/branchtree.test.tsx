// Source control's branches as a tree: Local (current on top, main, prefix folders, "other") and one group per remote;
// the filter, the remembered folders and the panel's scroll.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import * as fx from "../../../../web/src/test/fixtures";
import { server } from "../../../../web/src/test/setup";
import { buildBranchTree, filterTree, loadOpen, saveOpen, type TreeFolder, type TreeLeaf } from "../branchTree";

const b = (name: string) => ({ name, note: `${name}: subject` });
const local = ["main", "pre-clean-branch-backup", "feature/ERPDM-1652-add-thing", "feature/ERPDM-1653-other", "fix/login", "feat/scores", "tmp-rebase-check", "feat/deep/er/one"].map(b);
const remotes = ["origin/main", "origin/feature/ERPDM-1652-add-thing", "github/fix/login"].map(b);

describe("branch tree", () => {
  it("groups feature/, fix/ and prefix-less branches, the current one on top then main", () => {
    const [loc] = buildBranchTree(local, [], "feat/scores");
    expect(loc.title).toBe("Local");
    expect(loc.count).toBe(8);
    const top = loc.nodes.slice(0, 2).map((n) => (n as TreeLeaf).branch.name);
    expect(top).toEqual(["feat/scores", "main"]);
    const folders = loc.nodes.filter((n): n is TreeFolder => n.type === "folder");
    const feature = folders.find((f) => f.label === "feature/")!;
    expect(feature.count).toBe(2);
    expect(feature.children.every((c) => c.type === "leaf")).toBe(true);   // feature/ERPDM-… stays a leaf
    expect(folders.find((f) => f.label === "fix/")!.count).toBe(1);
    const deep = folders.find((f) => f.label === "feat/")!;
    expect(deep.children.map((c) => c.type)).toEqual(["folder"]);        // feat/deep/… nests
    const other = folders.find((f) => f.label === "other")!;
    expect(other.children.map((c) => (c as TreeLeaf).branch.name)).toEqual(["pre-clean-branch-backup", "tmp-rebase-check"]);
  });

  it("splits the remotes by name, each with its own folders", () => {
    const groups = buildBranchTree(local, remotes, "main");
    expect(groups.map((g) => g.title)).toEqual(["Local", "github", "origin"]);
    const origin = groups[2];
    expect(origin.count).toBe(2);
    expect(origin.nodes.map((n) => n.label)).toEqual(["feature/", "main"]);
    expect(groups[1].nodes.map((n) => n.label)).toEqual(["fix/"]);
  });

  it("the filter keeps only the matches across all groups, with counts", () => {
    const groups = buildBranchTree(local, remotes, "main");
    const r = filterTree(groups, "ERPDM-1652");
    expect(r.matches).toBe(2);
    expect(r.groups.map((g) => g.title)).toEqual(["Local", "origin"]);
    expect(filterTree(groups, "nothing-like-this").groups).toEqual([]);
  });

  it("remembers the folders per project and survives a blocked storage", () => {
    saveOpen("p1", { "local/feature/": true });
    expect(loadOpen("p1")).toEqual({ "local/feature/": true });
    expect(loadOpen("p2")).toEqual({});
    localStorage.setItem("keel.scm.branches.bad", "{not json");
    expect(loadOpen("bad")).toEqual({});
    const orig = Storage.prototype.setItem;
    Storage.prototype.setItem = () => { throw new Error("blocked"); };
    try { expect(() => saveOpen("p1", {})).not.toThrow(); } finally { Storage.prototype.setItem = orig; }
  });
});

describe("branches in Source control", () => {
  const setup = async () => {
    server.use(http.get("/api/projects/:pid/repo", () => HttpResponse.json({
      ...fx.repo, branch: "feat/scores", branches: [...local, b("feat/scores")], remote_branches: remotes,
    })));
    location.hash = "#/repo";
    const user = userEvent.setup();
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Source control" }));
    return { user, view: screen.getByRole("complementary", { name: "Source control" }) };
  };

  it("shows Local and the remotes as folders; the filter opens the folders with matches and counts them", async () => {
    const { user, view } = await setup();
    const branches = await within(view).findByRole("button", { name: /^Branches/ });
    if (branches.getAttribute("aria-expanded") === "false") await user.click(branches);
    expect(within(view).getByRole("button", { name: "Local 9" })).toBeInTheDocument();
    expect(within(view).getByRole("button", { name: "origin (remote) 2" })).toHaveAttribute("aria-expanded", "false");
    expect(within(view).getByRole("button", { name: "feature/ 2" })).toHaveAttribute("aria-expanded", "false");
    expect(within(view).queryByRole("button", { name: "Show the log of feature/ERPDM-1652-add-thing" })).toBeNull();

    await user.type(within(view).getByRole("searchbox", { name: "Filter the branches" }), "ERPDM-1652");
    expect(within(view).getByRole("status")).toHaveTextContent("2 matches");
    expect(within(view).getByRole("button", { name: "Show the log of feature/ERPDM-1652-add-thing" })).toBeInTheDocument();
    expect(within(view).getByRole("button", { name: "Show the log of origin/feature/ERPDM-1652-add-thing" })).toBeInTheDocument();
  });

  it("remembers a folder the person opened", async () => {
    const { user, view } = await setup();
    const branches = await within(view).findByRole("button", { name: /^Branches/ });
    if (branches.getAttribute("aria-expanded") === "false") await user.click(branches);
    await user.click(within(view).getByRole("button", { name: "fix/ 1" }));
    expect(within(view).getByRole("button", { name: "Show the log of fix/login" })).toBeInTheDocument();
    expect(Object.values(JSON.parse(localStorage.getItem(`keel.scm.branches.${fx.projects[0].id}`) ?? "{}"))).toContain(true);
  });

  it("scrolls as one with the wheel: one scroll container under a fixed header, nothing stops the wheel", async () => {
    const { view } = await setup();
    const scroll = within(view).getByTestId("scm-scroll");
    expect(scroll).toHaveClass("scm-scroll");
    const css = readFileSync(resolve(__dirname, "../../../../web/src/styles/repo.css"), "utf8");
    expect(css).toMatch(/\.scm-scroll\s*\{[^}]*overflow-y:\s*auto/);
    expect(css).toMatch(/\.scm-scroll\s*\{[^}]*min-height:\s*0/);
    expect(css).toMatch(/\.sv\s*\{[^}]*min-height:\s*0/);
    expect(within(view).getByRole("heading", { name: "Source control" }).closest("[data-testid=scm-scroll]")).toBeNull();
    // the wheel is not prevented by the panel, the IDE or the page
    const ev = new WheelEvent("wheel", { deltaY: 120, bubbles: true, cancelable: true });
    fireEvent(scroll, ev);
    expect(ev.defaultPrevented).toBe(false);
  });
});
