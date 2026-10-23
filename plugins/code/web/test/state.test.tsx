// The Code page looks the same when you leave it and come back: the side view that was open (Source control, Review…),
// whether the side bar was hidden, and the open tabs, per project for this browser tab. A view that is not there any
// more (its plugin is off) shows the Explorer instead.

import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
// keel's own app and test harness: this test runs the Code page inside keel's web, as keel loads it
import { App } from "../../../../web/src/App";
import { db } from "../../../../web/src/test/setup";

const PID = "ludus-engine";
const go = (hash: string) =>
  act(() => {
    location.hash = hash;
    window.dispatchEvent(new HashChangeEvent("hashchange"));
  });
const view = (name: string) => screen.getByRole("button", { name });

async function leaveAndComeBack() {
  go("#/flow");
  await waitFor(() => expect(screen.queryByRole("navigation", { name: "Repo views" })).toBeNull());
  go("#/repo");
  await screen.findByRole("navigation", { name: "Repo views" });
}

describe("Code: coming back to the page", () => {
  it("shows the side view you had open, and the open file", async () => {
    const user = userEvent.setup();
    go("#/repo/api/ScoreController.kt");
    render(<App />);
    await screen.findByRole("tab", { name: /ScoreController\.kt/ });
    await user.click(await screen.findByRole("button", { name: "Source control" }));
    expect(view("Source control")).toHaveAttribute("aria-pressed", "true");

    await leaveAndComeBack();
    expect(view("Source control")).toHaveAttribute("aria-pressed", "true");
    expect(screen.getByRole("complementary", { name: "Source control" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: /ScoreController\.kt/ })).toHaveAttribute("aria-selected", "true");
    expect(JSON.parse(sessionStorage.getItem(`keel2.repo.activity.${PID}`)!)).toBe("scm");
  });

  it("keeps the side bar hidden when you hid it", async () => {
    const user = userEvent.setup();
    go("#/repo");
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Search" }));
    // the same view's button again hides the side bar
    await user.click(view("Search"));
    expect(document.querySelector(".ide")).toHaveClass("side-closed");

    await leaveAndComeBack();
    expect(document.querySelector(".ide")).toHaveClass("side-closed");
    await user.click(view("Search"));
    expect(document.querySelector(".ide")).not.toHaveClass("side-closed");
    expect(view("Search")).toHaveAttribute("aria-pressed", "true");
  });

  it("shows the Explorer when the remembered view is not there any more", async () => {
    db.plugins.review = false;
    sessionStorage.setItem(`keel2.repo.activity.${PID}`, '"review"');
    go("#/repo");
    render(<App />);
    await waitFor(() => expect(view("Explorer")).toHaveAttribute("aria-pressed", "true"));
    expect(screen.queryByRole("button", { name: "Review" })).toBeNull();
  });

  it("shows the Explorer when the stored value is broken", async () => {
    sessionStorage.setItem(`keel2.repo.activity.${PID}`, "{not json");
    sessionStorage.setItem(`keel2.repo.sideOpen.${PID}`, '"yes"');
    go("#/repo");
    render(<App />);
    await waitFor(() => expect(view("Explorer")).toHaveAttribute("aria-pressed", "true"));
    expect(document.querySelector(".ide")).not.toHaveClass("side-closed");
  });
});
