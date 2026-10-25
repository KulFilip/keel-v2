// keel 0.18.54 the Flow page's header wraps instead of squeezing the title: the title block takes at least 360px and
// the stats and buttons go under it when there is no room; a long branch name is cut with an ellipsis (its title has it
// all); "Jump to live" takes its own row above the steps instead of floating over the first block.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { openShopFlow, SHOP_BRANCH } from "./shopFlow";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");
const runCss = fs.readFileSync(path.join(SRC, "styles/run.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `sel` (outside media queries: the first one). */
const rule = (text: string, sel: string) => {
  const at = text.indexOf(`\n${sel} {`);
  expect(at, `no rule for ${sel}`).toBeGreaterThanOrEqual(0);
  return text.slice(text.indexOf("{", at) + 1, text.indexOf("}", at));
};

describe("Flow header", () => {
  it("has a title block, stats and actions as wrapping parts, and cuts a long branch name", async () => {
    openShopFlow();
    render(<App />);
    const bar = await screen.findByRole("region", { name: "This flow" });
    const main = bar.querySelector(".fl-bar-main")!;
    expect(within(main as HTMLElement).getByRole("heading", { level: 1 })).toHaveTextContent("SHOPS-1234 cart totals keep the discount");
    expect(bar.querySelector(".fl-stats")).not.toBeNull();
    expect(bar.querySelector(":scope > .actions")).not.toBeNull();
    const branch = main.querySelector(".fl-branch")!;
    expect(branch).toHaveTextContent(SHOP_BRANCH);
    expect(branch).toHaveAttribute("title", SHOP_BRANCH);
  });

  it("wraps (flex) with a title block of at least 360px that may shrink, and an ellipsis on the branch", () => {
    expect(rule(css, ".fl-bar")).toMatch(/display: flex;.*flex-wrap: wrap/);
    expect(rule(css, ".fl-bar-main")).toMatch(/flex: 1 1 360px;.*min-width: 0/);
    expect(rule(css, ".fl-stats")).toMatch(/flex-wrap: wrap/);
    expect(rule(css, ".fl-bar > .actions")).toMatch(/flex-wrap: wrap/);
    expect(rule(css, ".fl-branch")).toMatch(/text-overflow: ellipsis/);
    // no fixed grid columns left that squeeze the title
    expect(rule(css, ".fl-bar")).not.toMatch(/grid-template-columns/);
    // a phone: the stats and the buttons take a full row each
    expect(runCss).toMatch(/\.fl-stats \{[^}]*flex: 1 1 100%/);
  });

  it("gives Jump to live a row of its own and the label column of a key / value list its width", () => {
    expect(rule(css, ".fl-live")).not.toMatch(/height: 0/);
    expect(rule(css, ".kv")).toMatch(/grid-template-columns: minmax\(min-content, 1fr\) minmax\(0, auto\)/);
    expect(rule(css, ".xkv")).toMatch(/grid-template-columns: max-content minmax\(0, 1fr\)/);
  });
});
