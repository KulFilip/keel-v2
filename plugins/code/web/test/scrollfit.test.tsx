// The Code page fits the window by CSS alone, only the real scroll areas keep the wheel, nothing scrolls the window by
// code, and ⌘/Ctrl+A is wired in every pane. jsdom has no layout, so these read the style sheet and the sources.

import { fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ImagePane, MarkdownPane } from "../Editor";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..", "..", "..", "..");
const read = (...p: string[]) => fs.readFileSync(path.join(root, ...p), "utf8");
const css = read("web", "src", "styles", "repo.css");
const strip = (s: string) => s.replace(/\/\*[\s\S]*?\*\//g, "");

describe("the code page layout is pure CSS", () => {
  it("the app is one window high on this page and every box down to the IDE is a shrinkable flex column", () => {
    const c = strip(css);
    expect(c).toMatch(/\.app:has\(\.repo-page\) \{[^}]*height: 100dvh/);
    expect(c).toMatch(/\.app:has\(\.repo-page\) > \.app-col \{[^}]*min-height: 0/);
    expect(c).toMatch(/main:has\(> \.repo-page\) \{[^}]*flex: 1 1 0; min-height: 0; display: flex; flex-direction: column/);
    expect(c).toMatch(/\.repo-page \{[^}]*flex: 1 1 auto; min-height: 0; display: flex; flex-direction: column/);
    expect(c).toMatch(/\n\.ide \{[^}]*flex: 1 1 0; min-height: 240px/);
    // other pages keep their layout: the window-high rules are all scoped to the repo page
    expect(c).not.toMatch(/(^|\n)\.app \{[^}]*100dvh/);
  });

  it("no JS measures the IDE's top any more", () => {
    expect(read("plugins", "code", "web", "Ide.tsx")).not.toMatch(/--ide-top/);
    expect(css).not.toMatch(/var\(--ide-top/);
  });
});

describe("the wheel", () => {
  it("is trapped only by the boxes that scroll, not by every box in the IDE", () => {
    const c = strip(css);
    expect(c).not.toMatch(/\.ide \*\s*\{[^}]*overscroll-behavior/);
    expect(c).not.toMatch(/\.ide, \.ide \* \{/);
    const m = c.match(/([^{}]*)\{\s*overscroll-behavior: contain;\s*\}/g) ?? [];
    const list = m.join(" ");
    for (const sel of [".cv", ".dv-body", ".ex-list", ".sv-scroll", ".scm-scroll", ".lg-list", ".md-pane"]) {
      expect(list).toContain(`.ide ${sel}`);
    }
    // a tab strip, the path bar and a short file are not in the list
    expect(list).not.toMatch(/\.ed-tabs|\.ed-bar|\.crumbs|\.ed-head/);
  });
});

describe("code never scrolls the window", () => {
  it.each([
    ["plugins/code/web/Editor.tsx"],
    ["plugins/review/web/ReviewDiff.tsx"],
  ])("%s sets the scroller's scrollTop instead of scrollIntoView", (file) => {
    const src = read(...file.split("/"));
    expect(src).not.toMatch(/scrollIntoView/);
    expect(src).toMatch(/scrollToCenter/);
  });

  it("the code view measures its window once per frame, not on every scroll event", () => {
    const src = read("plugins", "code", "web", "Editor.tsx");
    expect(src).toMatch(/requestAnimationFrame/);
    expect(src).toMatch(/onScroll=\{virtual \? measureSoon : undefined\}/);
  });
});

describe("⌘/Ctrl+A selects the pane under the pointer or focus", () => {
  it.each([
    ["plugins/code/web/Editor.tsx", 4], // code, diff, image, Markdown
    ["plugins/code/web/KeelView.tsx", 2], // keel files, memory
    ["plugins/review/web/ReviewDiff.tsx", 2], // review diff, review file
  ])("%s has a handler on each pane", (file, n) => {
    const src = read(...file.split("/"));
    expect((src.match(/useSelectAll\(/g) ?? []).length).toBeGreaterThanOrEqual(n);
  });

  it("the Markdown pane selects its own text and leaves the rest of the page alone", () => {
    render(
      <div>
        <p>around the pane</p>
        <MarkdownPane text={"# Title\n\nSome body text"} />
      </div>,
    );
    const pane = screen.getByRole("region", { name: "Rendered Markdown" });
    pane.tabIndex = 0;
    pane.focus();
    const ev = fireEvent.keyDown(pane, { key: "a", metaKey: true });
    expect(ev).toBe(false); // preventDefault: the browser does not select the window
    const sel = window.getSelection()!;
    expect(sel.toString()).toContain("Some body text");
    expect(sel.toString()).not.toContain("around the pane");
  });

  it("the image pane takes ⌘A too", () => {
    render(
      <div>
        <p>around the pane</p>
        <ImagePane pid="p" path="a.png" size={10} onDims={() => {}} />
      </div>,
    );
    const pane = document.querySelector<HTMLElement>(".img-pane")!;
    pane.tabIndex = 0;
    pane.focus();
    expect(fireEvent.keyDown(pane, { key: "a", ctrlKey: true })).toBe(false);
    expect(window.getSelection()!.toString()).not.toContain("around the pane");
  });
});
