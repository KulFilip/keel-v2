// keel TUI 0.18.6: a plugin's mode (contributes.tui.modes): the Code Review plugin's review mode, from its own manifest
// (review-tui.json is plugins/review/keel-plugin.yml's contributes.tui; the review plugin's engine tests keep them equal).
import React from "react";
import { describe, expect, it } from "vitest";
import { render } from "ink-testing-library";
import { App, type Probe } from "../src/ui/App";
import { KeelCore } from "../src/core/keel";
import { modeBody, modePath, ModeSession, type TuiMode } from "../src/core/modes";
import { pluginCommands, type TuiPluginView } from "../src/core/plugins";
import { makeTheme } from "../src/core/theme";
import { stripAnsi } from "../src/script";
import { stubKeel, tick, waitFor } from "./stub";
import tui from "./review-tui.json";

const none = makeTheme({ NO_COLOR: "1" }, 0);
const REVIEW = { name: "review", title: "Code Review", version: "1.0.0", ...tui } as unknown as TuiPluginView;
const MODE = REVIEW.modes![0] as TuiMode;

/** A session on the stub keel (the KeelCore sets up the transport the session's calls go through). */
function session(arg = "7") {
  const stub = stubKeel();
  new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
  return { stub, s: new ModeSession(REVIEW, MODE, "demo", arg) };
}
const text = (s: ModeSession, h = 18) => s.lines(100, h).map(stripAnsi).join("\n");

describe("a plugin's mode, UI-free", () => {
  it("fills a path with encoded values, only under the plugin's own routes, and a body with typed values", () => {
    expect(modePath({ method: "GET", path: "/projects/{pid}/review/diff?key={view.key}&path={item.path}" },
      { pid: "my app", view: { key: "pr:7" }, item: { path: "src/a b.kt" } }, "review")).toBe("/projects/my%20app/review/diff?key=pr%3A7&path=src%2Fa%20b.kt");
    expect(() => modePath({ method: "POST", path: "/projects/{pid}/review/threads/{choice.id}/../../db/query" }, { pid: "p", choice: { id: "x" } }, "review"))
      .toThrow(/outside the review plugin/);
    expect(() => modePath({ method: "POST", path: "/projects/{pid}/review/threads/{a}/{b}/x" }, { pid: "p", a: "..", b: ".." }, "review")).toThrow(/refused/);
    expect(modeBody({ key: "{view.key}", line: "{line}", side: "{side}", body: "on {item.path}: {text}", viewed: true, n: [1, "{line}"] },
      { view: { key: "pr:7" }, line: 4, side: null, item: { path: "a.kt" }, text: "hi" }))
      .toEqual({ key: "pr:7", line: 4, side: null, body: "on a.kt: hi", viewed: true, n: [1, 4] });
  });

  it("opens with its state, lists the files, opens a diff with line numbers and the notes under their lines", async () => {
    const { stub, s } = session();
    await s.open();
    expect(stub.calls.map((c) => c.path + c.query)).toEqual(expect.arrayContaining(["/api/projects/demo/review/open?ref=7", "/api/projects/demo/review/ai?key=pr%3A7"]));
    let t = text(s);
    expect(t).toContain("[Code Review] 2 file(s) changed");
    expect(t).toContain("▸ M  src/Prefs.kt  +6 −1");
    expect(t).toContain("  A  src/PrefsTest.kt  +3 −0");
    expect(t).toContain("Save the page size · feat/paging → main · +9 −1 · 0 draft(s) · 1 thread(s)");
    expect(t).toContain("↑↓ move · Enter open · r x v e f o F s p g · ? keys · Esc leave");     // too long with the words: ? lists them
    expect(s.keyHints()).toContain("↑↓ move · Enter open · r reply · x resolve · v viewed · e explain · f findings · o overview");
    await s.press("enter");
    t = text(s, 20);
    expect(t).toContain("src/Prefs.kt  +6 −1  (1/2)");
    expect(t).toContain("▸   2 -    fun pageSize(user: String) = 20");                 // the cursor starts on the first change
    expect(t).toContain("    2 +    private val cache = mutableMapOf<String, Int>()");
    expect(t).toMatch(/ {4}3 \+    fun savePageSize\(user: String, size: Int\) \{\n {6}│ bo: Should 20 come from config\? \(1 comment\(s\), resolved false\)/);
    expect(t).toMatch(/ {4}4 \+        cache\[user\] = size\n {6}│ keel should_fix: the cache is never cleared/);
    expect(t).not.toContain("+++ b/src/Prefs.kt");
    await s.press("]");
    expect(text(s)).toContain("src/PrefsTest.kt  +3 −0  (2/2)");
    await s.press("[");
    await s.press("esc");
    expect(s.view).toBe("list");
    expect(await s.press("esc")).toBe("leave");
  });

  it("a line comment asks for the words and saves a draft on that line; a key that changes something waits for the yes", async () => {
    const { stub, s } = session();
    await s.open();
    await s.press("c");
    expect(text(s)).toContain("c (comment) works in a file: Enter opens one");
    await s.press("enter");
    await s.press("down");
    await s.press("down");                                                     // line 3, the thread's line
    await s.press("c");
    expect(text(s)).toContain("Your comment on src/Prefs.kt:3: █".replace("█", " "));
    for (const ch of "Use a constant") await s.press(ch);
    await s.press("enter");
    const draft = stub.calls.find((c) => c.method === "POST" && c.path.endsWith("/review/drafts"));
    expect(draft?.body).toEqual({ key: "pr:7", path: "src/Prefs.kt", line: 3, side: "RIGHT", body: "Use a constant" });
    expect(draft?.headers["x-keel-tool"]).toBe("/review · comment");                 // keel's audit says which key sent it
    const t = text(s, 20);
    expect(t).toContain("draft saved: it goes with your review (s submits)");
    expect(t).toContain("│ draft: Use a constant");
    expect(t).toContain("· 1 draft(s) ·");
    // viewed: a yes / no first; no says not done and calls nothing
    await s.press("v");
    expect(text(s)).toContain("Mark src/Prefs.kt viewed?  y / n");
    await s.press("n");
    expect(text(s)).toContain("not done");
    expect(stub.calls.some((c) => c.path.endsWith("/review/viewed"))).toBe(false);
    await s.press("v");
    await s.press("y");
    expect(stub.calls.find((c) => c.path.endsWith("/review/viewed"))?.body).toEqual({ key: "pr:7", path: "src/Prefs.kt", viewed: true });
    await s.press("esc");
    expect(text(s)).toContain("M  src/Prefs.kt  +6 −1  ✓ viewed");
  });

  it("reply and resolve pick the file's thread; explain and the overview; submit picks, asks, confirms and sends", async () => {
    const { stub, s } = session();
    await s.open();
    await s.press("r");
    expect(text(s)).toContain("? Reply to which thread?");
    expect(text(s)).toContain("▸ 1. line 3 · bo: Should 20 come from config?");
    await s.press("enter");
    for (const ch of "It will") await s.press(ch);
    await s.press("enter");
    expect(stub.calls.find((c) => c.path.endsWith("/threads/th1/reply"))?.body).toEqual({ key: "pr:7", body: "It will" });
    await s.press("x");
    await s.press("1");
    expect(text(s)).toContain("Resolve the thread on src/Prefs.kt:3?");
    await s.press("y");
    expect(stub.calls.some((c) => c.path.endsWith("/threads/th1/resolve"))).toBe(true);
    await s.press("x");
    expect(text(s)).toContain("nothing to pick: Resolve which thread?");          // none open any more
    await s.press("e");
    await s.press("y");
    expect(stub.calls.find((c) => c.path.endsWith("/review/ai/overview"))?.body).toEqual({ key: "pr:7" });
    expect(text(s)).toContain("keel is reading the change: o shows its overview when it is done");
    await s.press("o");
    let t = text(s);
    expect(t).toContain("keel's overview · done · risk low");
    expect(t).toContain("Saves the page size per user.");
    expect(t).toContain("src/Prefs.kt  keeps the size in a map");
    await s.press("esc");
    await s.press("s");
    expect(text(s)).toContain("? Submit your review as");
    await s.press("down");
    await s.press("enter");                                                    // Request changes
    for (const ch of "Clear the cache") await s.press(ch);
    await s.press("enter");
    expect(text(s)).toContain('Send "Request changes" on #7 with 0 line comment(s)?  y / n');
    expect(stub.state.review.submitted).toBeNull();
    await s.press("y");
    expect(stub.state.review.submitted).toEqual({ key: "pr:7", event: "REQUEST_CHANGES", body: "Clear the cache" });
    t = text(s);
    expect(t).toContain("sent: 0 line comment(s) · https://github.com/acme/shop/pull/7#review-1");
    // the pull requests: pick one and the mode opens it
    await s.press("p");
    await s.press("2");
    await waitFor(() => text(s).includes("Mine · feat/paging"));
    expect(s.arg).toBe("8");
    await s.press("?");
    expect(text(s, 30)).toMatch(/s {10}submit\n.*p {10}pull requests/s);
  });

  it("a mode that cannot open says why, and the plugin's commands still run outside it", async () => {
    const { s } = session("404");
    await expect(s.open()).rejects.toThrow("No pull request #404");
    const cmds = pluginCommands([REVIEW], new Set());
    expect(cmds.map((c) => c.name)).toEqual(["review"]);
    expect(cmds[0].args).toBe("[prs|branch|<pr number>]");
    expect(pluginCommands([REVIEW], new Set(["review"]))).toEqual([]);           // keel's own name wins
  });
});

describe("the review mode in keel TUI", () => {
  function setup(rows?: number) {
    const stub = stubKeel();
    stub.state.plugins = { plugins: [REVIEW], problems: [] };
    const core = new KeelCore({ url: "http://keel.test", fetch: stub.fetch, noLive: true });
    const probe: Probe = { started: false, busy: false, pick: false, ask: false, chatBusy: false, answers: 0 };
    const r = render(<App core={core} probe={probe} width={90} rows={rows} theme={none} />);
    const frame = () => stripAnsi(r.lastFrame() ?? "");
    const key = async (s: string) => {
      r.stdin.write(s);
      await tick(40);
    };
    const run = async (s: string) => {
      await key(s);
      await key("\r");
      await waitFor(() => !probe.busy);
      await tick(40);
    };
    return { stub, core, probe, r, frame, key, run };
  }

  it("takes the full screen between keel's header and status line, moves with the keys, and Esc gives the screen back", async () => {
    const t = setup(24);
    await waitFor(() => t.probe.started);
    await tick(50);
    await t.run("/review prs");
    await waitFor(() => t.frame().includes("acme/shop · 2 open · 1 ask you"));
    expect(t.frame()).toContain("#7  Save the page size · ana · feat/paging → main");
    await t.run("/review 7");
    await waitFor(() => t.frame().includes("[Code Review] 2 file(s) changed"));
    let lines = t.frame().split("\n");
    expect(lines[0]).toContain("[ keel ]");                                    // keel's header stays
    expect(lines[2]).toContain("[Code Review] 2 file(s) changed");
    expect(lines[3]).toContain("▸ M  src/Prefs.kt  +6 −1");
    expect(lines.at(-1)).toMatch(/demo/);                                      // and its status line
    expect(lines.length).toBeLessThanOrEqual(24);
    await t.key("\r");
    await waitFor(() => t.frame().includes("src/Prefs.kt  +6 −1  (1/2)"));
    expect(t.frame()).toContain("│ bo: Should 20 come from config?");
    await t.key("\x1b[B");
    await t.key("\x1b[B");                                                     // ↓ to line 3
    await t.key("c");
    await waitFor(() => t.frame().includes("Your comment on src/Prefs.kt:3:"));
    await t.key("Looks fine");
    await t.key("\r");
    await waitFor(() => t.frame().includes("│ draft: Looks fine"));
    await t.key("\x1b");
    await waitFor(() => t.frame().includes("▸ M  src/Prefs.kt"));
    await t.key("\x1b");
    await waitFor(() => !t.frame().includes("[Code Review]"));
    lines = t.frame().split("\n");
    expect(t.frame()).toContain("left Code Review");
    expect(t.frame()).toContain("A gate waits for you: /approve");             // the prompt is back
    t.r.unmount();
  });

  it("works inline too, and a review that cannot open stays in the transcript as an error", async () => {
    const t = setup();
    await waitFor(() => t.probe.started);
    await tick(50);
    await t.run("/review 404");
    await waitFor(() => t.frame().includes("No pull request #404"));
    await t.run("/review");
    await waitFor(() => t.frame().includes("[Code Review] 2 file(s) changed"));
    expect(t.frame()).toContain("Code Review (the Code Review plugin) · ? its keys · Esc leaves");
    await t.key("q");
    await waitFor(() => t.frame().includes("left Code Review"));
    t.r.unmount();
  });
});
