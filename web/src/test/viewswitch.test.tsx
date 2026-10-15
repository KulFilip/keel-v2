// v0.17.1 the menu's All / Product / Dev switch (Shell.tsx ViewSwitch) stays inside the menu: .side-head is a
// two-column grid (brand | side tools), so the switch spans both columns, like the project picker, and its three
// buttons share the width (docs/plugins/22-one-plugins-page.md). jsdom draws no CSS, so the rule is read as text.

import { render, screen, within } from "@testing-library/react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

const css = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "styles.css"), "utf8");
const rule = (selector: string) => {
  const at = css.indexOf(`\n${selector} {`);
  return at < 0 ? "" : css.slice(at, css.indexOf("}", at));
};

describe("the menu's view switch", () => {
  it("shows All, Product and Dev when keel has both parts", async () => {
    db.features = { mode: "both", modes: ["dev", "product", "both"], parts: { dev: true, product: true }, addons: [], screens: [], plugins: [] };
    location.hash = "#/flow";
    render(<App />);
    const view = await screen.findByRole("group", { name: "View" });
    expect(within(view).getAllByRole("button").map((b) => b.textContent)).toEqual(["All", "Product", "Dev"]);
  });

  it("spans the menu head's two columns and splits it in three equal parts that may shrink", () => {
    expect(rule(".view-switch")).toContain("grid-column: 1 / -1");
    expect(rule(".view-switch")).toContain("grid-template-columns: repeat(3, minmax(0, 1fr))");
    expect(rule(".view-switch button")).toContain("min-width: 0");
    // the focus ring stays inside the switch's frame
    expect(rule(".view-switch button:focus-visible")).toContain("outline-offset: -2px");
  });
});
