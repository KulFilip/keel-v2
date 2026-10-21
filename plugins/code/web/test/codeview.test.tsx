// The Code page's file view: the file body is the one scroll area (the tabs and the path bar stay), and ⌘/Ctrl+A
// selects the open file's text, not the whole page. Bug: "scroll in code section file is not working correctly and
// command a is select all in the window not in file opened".

import { fireEvent, render, screen } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { CodeView, selectedAll } from "../Editor";

const here = path.dirname(fileURLToPath(import.meta.url));
const css = fs.readFileSync(
  path.join(here, "..", "..", "..", "..", "web", "src", "styles", "repo.css"),
  "utf8",
);

/** The declarations of the first rule whose selector is exactly `sel`. */
const rule = (sel: string) => {
  const esc = sel.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const m = css.match(new RegExp(`(?:^|\\n)${esc} \\{([^}]*)\\}`));
  if (!m) throw new Error(`no rule ${sel}`);
  return m[1].replace(/\/\*[\s\S]*?\*\//g, "");
};

const text = (n: number) =>
  Array.from({ length: n }, (_, i) => `val line${i + 1} = ${i + 1}`).join("\n");

function Ide({ n = 40 }: { n?: number }) {
  return (
    <div>
      <p>Text of the page around the code</p>
      <input aria-label="Filter files" defaultValue="Score" />
      <section className="ide-main">
        <div className="ed-head">
          <div className="ed-tabs" role="tablist">
            <div role="tab" aria-selected="true">
              A.kt
            </div>
          </div>
        </div>
        <div className="ed-bar">
          <nav className="crumbs">api / A.kt</nav>
        </div>
        <div className="ed-body">
          <CodeView
            text={text(n)}
            path="api/A.kt"
            wrap={false}
            target={null}
            cmd={null}
            onCursor={() => undefined}
            onLink={() => undefined}
            scrollKey={`A.kt:${n}`}
          />
        </div>
      </section>
    </div>
  );
}

const code = () => screen.getByRole("region", { name: "Code of api/A.kt" });
const selectAll = (
  target: Element | Window = document.activeElement ?? document.body,
) =>
  fireEvent.keyDown(target, {
    key: "a",
    code: "KeyA",
    ctrlKey: true,
    metaKey: true,
  });

describe("the file view scrolls by itself", () => {
  it("only the file body scrolls, both ways; every box above it can shrink, and the tab strip does not scroll up and down", () => {
    // the chain from the IDE down to the code: each flex/grid child can be smaller than its content (min-height: 0)
    expect(rule(".ide-main")).toMatch(/min-height: 0/);
    expect(rule(".ed-body")).toMatch(/flex: 1; min-height: 0/);
    expect(rule(".cv-wrap")).toMatch(/flex: 1; min-height: 0/);
    const cv = rule(".cv");
    expect(cv).toMatch(/flex: 1; min-height: 0; min-width: 0; overflow: auto/);
    // a long file swaps its rows while it scrolls: no scroll anchoring fighting the wheel
    expect(cv).toMatch(/overflow-anchor: none/);
    // the tab strip scrolls sideways only (its 1px overhang made it a second, vertical, scroll area)
    expect(rule(".ed-tabs")).toMatch(/overflow-x: auto; overflow-y: hidden/);
    // the IDE takes the rest of the window; its floor is low, so a short or narrow window does not make the page scroll
    const ide = rule(".ide");
    expect(ide).toMatch(/flex: 1 1 0/);
    expect(ide).not.toMatch(/--ide-top/);
    expect(ide).toMatch(/min-height: 240px/);
    expect(css).toMatch(
      /@media \(max-width: 720px\), \(max-height: 720px\) \{\s*\.repo-page \.top p \{ display: none; \}/,
    );
  });

  it("the code is one focusable region under the tabs and the path bar, not around them", () => {
    render(<Ide />);
    const region = code();
    expect(region).toHaveClass("cv");
    expect(region).toHaveAttribute("tabindex", "0");
    expect(region.querySelectorAll(".cv-row")).toHaveLength(40);
    expect(region.contains(document.querySelector(".ed-head"))).toBe(false);
    expect(region.contains(document.querySelector(".ed-bar"))).toBe(false);
    expect(region.closest(".ed-body")).not.toBeNull();
  });

  it("a long file keeps the room under its last line, like a short one (40vh), while it renders only the rows on screen", () => {
    render(<Ide n={3000} />);
    const lines = code().querySelector<HTMLElement>(".cv-lines")!;
    expect(code().querySelectorAll(".cv-row").length).toBeLessThan(3000);
    expect(lines.style.paddingBottom).toMatch(/^calc\(\d+px \+ 40vh\)$/);
  });
});

describe("⌘/Ctrl+A in the file view", () => {
  it("selects the open file's text only, not the page", () => {
    render(<Ide />);
    const region = code();
    region.focus();
    const handled = !selectAll(region);
    expect(handled).toBe(true);
    const sel = window.getSelection()!;
    expect(sel.isCollapsed).toBe(false);
    expect(region.contains(sel.anchorNode)).toBe(true);
    expect(region.contains(sel.focusNode)).toBe(true);
    const got = sel.getRangeAt(0).toString();
    expect(got).toContain("val line1 = 1");
    expect(got).toContain("val line40 = 40");
    expect(got).not.toContain("Text of the page");
    expect(got).not.toContain("api / A.kt");
    expect(selectedAll(region)).toBe(text(40));
  });

  it("a copy of it gives the whole file, also when a long file renders only some rows", () => {
    render(<Ide n={3000} />);
    const region = code();
    region.focus();
    selectAll(region);
    const copied: Record<string, string> = {};
    const ev = new Event("copy", { bubbles: true, cancelable: true });
    Object.defineProperty(ev, "clipboardData", {
      value: { setData: (k: string, v: string) => (copied[k] = v) },
    });
    region.dispatchEvent(ev);
    expect(ev.defaultPrevented).toBe(true);
    expect(copied["text/plain"]).toBe(text(3000));
    // a selection the person makes after it is copied as it is
    window.getSelection()!.removeAllRanges();
    const ev2 = new Event("copy", { bubbles: true, cancelable: true });
    region.dispatchEvent(ev2);
    expect(ev2.defaultPrevented).toBe(false);
  });

  it("leaves a text field's own select-all alone", () => {
    render(<Ide />);
    const input = screen.getByRole("textbox", { name: "Filter files" });
    input.focus();
    window.getSelection()!.removeAllRanges();
    expect(selectAll(input)).toBe(true); // not prevented: the browser selects the field's text
    expect(window.getSelection()!.rangeCount).toBe(0);
  });

  it("does nothing when the file view has neither the focus nor the pointer", () => {
    render(<Ide />);
    window.getSelection()!.removeAllRanges();
    (document.activeElement as HTMLElement | null)?.blur();
    expect(selectAll(document.body)).toBe(true);
    expect(window.getSelection()!.rangeCount).toBe(0);
    expect(selectedAll(code())).toBeNull();
  });
});
