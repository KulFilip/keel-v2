// 0.18.61 the checks list under the CI pill (Checks.tsx), the same in the classic and the new Review view.

import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { ChecksList, sortChecks } from "../Checks";

describe("the checks of a pull request", () => {
  it("opens by itself when a check failed, the failed one first, each with a link to the host", () => {
    render(
      <ChecksList
        where="GitLab"
        summary={<span>CI 0/2</span>}
        checks={[
          { name: "build", state: "running", url: "https://gitlab.test/j/1" },
          { name: "test", state: "failed", url: "https://gitlab.test/j/2" },
        ]}
      />,
    );
    const list = screen.getByRole("list", { name: "Checks" });
    expect(list).toBeVisible();
    const rows = within(list).getAllByRole("listitem");
    expect(rows.map((r) => r.textContent)).toEqual([
      "testfailedOpen ↗",
      "buildrunningOpen ↗",
    ]);
    expect(
      within(list).getByRole("link", { name: "Open test on GitLab" }),
    ).toHaveAttribute("href", "https://gitlab.test/j/2");
  });

  it("stays closed while nothing failed, and the CI pill opens it", async () => {
    const { container } = render(
      <ChecksList
        where="GitHub"
        summary={<span>CI 1/2</span>}
        checks={[
          { name: "lint", state: "success", url: null },
          { name: "build", state: "in_progress", url: "https://github.com/x" },
        ]}
      />,
    );
    const details = container.querySelector("details")!;
    expect(details.open).toBe(false);
    await userEvent.click(screen.getByText("CI 1/2"));
    expect(details.open).toBe(true);
    // a check with no link has no Open
    const lint = screen.getByText("lint").closest("li")!;
    expect(within(lint).queryByRole("link")).not.toBeInTheDocument();
  });

  it("shows nothing for a pull request with no checks", () => {
    const { container } = render(
      <ChecksList where="GitHub" summary={<span>CI</span>} checks={[]} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("sorts failed, then running, then green, and keeps the host's order inside each", () => {
    expect(
      sortChecks([
        { name: "a", state: "success" },
        { name: "b", state: "pending" },
        { name: "c", state: "failure" },
        { name: "d", state: "success" },
        { name: "e", state: "cancelled" },
      ]).map((c) => c.name),
    ).toEqual(["c", "e", "b", "a", "d"]);
  });
});
