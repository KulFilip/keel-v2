// 0.18.57 A flow's (or a review's) file:line citations link to the Code page at the ref the flow looked at — its
// worktree's branch, the reviewed PR's head — not the project folder's checkout. Without CiteLinks a chip stays a chip.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { CiteLinks, Markdown } from "../components/Markdown";
import { codeHref } from "../format";

const TEXT = "Blocking: `src/Orders/ExportService.php:13` drops the last page; see `README.md`.";

describe("CiteLinks", () => {
  it("makes a citation a link that carries the ref", () => {
    render(<CiteLinks.Provider value={{ ref: "refs/keel/review-pr/7" }}><Markdown text={TEXT} /></CiteLinks.Provider>);
    const a = screen.getByRole("link", { name: "src/Orders/ExportService.php:13" });
    expect(a).toHaveAttribute("href", "#/repo/src/Orders/ExportService.php:13?ref=refs%2Fkeel%2Freview-pr%2F7");
    expect(a).toHaveAttribute("href", codeHref("src/Orders/ExportService.php", 13, "refs/keel/review-pr/7"));
    expect(a).toHaveClass("cite");
    expect(screen.queryByRole("link", { name: "README.md" })).toBeNull();          // not a file:line: plain code
  });

  it("without a ref the link opens the work tree; without CiteLinks it is a plain chip", () => {
    const { unmount } = render(<CiteLinks.Provider value={{ ref: null }}><Markdown text={TEXT} /></CiteLinks.Provider>);
    expect(screen.getByRole("link", { name: "src/Orders/ExportService.php:13" })).toHaveAttribute("href", "#/repo/src/Orders/ExportService.php:13");
    unmount();
    render(<Markdown text={TEXT} />);
    expect(screen.queryByRole("link")).toBeNull();
    expect(screen.getByText("src/Orders/ExportService.php:13")).toHaveClass("cite");
  });
});
