import { act, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { Notification } from "../api";
import { clip, linesFromBody, noticeView, words } from "../noticeText";
import { playSound, shouldAlert, NOTIFY_DEFAULTS } from "../notify";
import { audioLog, db, FakeEventSource } from "./setup";

const note = (over: Partial<Notification> = {}): Notification => ({
  id: `x${Math.random()}`, type: "review", project_id: "ludus-engine", title: "Fix needs your approval",
  body: "setup-doctor wants to edit conftest.py", link: "#/jobs", at: new Date().toISOString(), read: false, ...over,
});

async function ready() {
  render(<App />);
  await screen.findByText(/AC gate — AC-002/);
  await waitFor(() => expect(FakeEventSource.instances.length).toBeGreaterThan(0));
}

describe("notifications", () => {
  it("a server notification pops up with an action and plays the chime", async () => {
    const user = userEvent.setup();
    await ready();
    act(() => FakeEventSource.emit("notification", note()));
    const pops = await screen.findByTestId("popups");
    expect(pops).toHaveTextContent("Fix needs your approval");
    expect(audioLog).toEqual([660, 880]);
    expect(screen.getByTestId("unread")).toHaveTextContent("2");
    await user.click(screen.getByRole("button", { name: "Review now" }));
    await waitFor(() => expect(location.hash).toBe("#/jobs"));
    expect(screen.queryByTestId("popups")).not.toBeInTheDocument();
  });

  it("a failure plays the lower tone", async () => {
    await ready();
    act(() => FakeEventSource.emit("notification", note({ type: "failed", title: "Guard reverted an edit" })));
    await within(await screen.findByTestId("popups")).findByText("Guard reverted an edit");
    expect(audioLog).toEqual([392, 262]);
  });

  it("do not disturb keeps it in the inbox without sound or pop-up", async () => {
    db.nset.quiet = true;
    const user = userEvent.setup();
    await ready();
    await waitFor(() => expect(document.querySelector(".bell-q")).not.toBeNull());
    act(() => FakeEventSource.emit("notification", note({ title: "Quiet one" })));
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));
    expect(screen.queryByTestId("popups")).not.toBeInTheDocument();
    expect(audioLog).toEqual([]);
    await user.click(screen.getByRole("button", { name: /Notifications, 2 unread/ }));
    expect(await screen.findByText("Quiet one")).toBeInTheDocument();
  });

  it("settings in the bell drawer are saved to the api", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole("button", { name: /Notifications/ }));
    await user.click(screen.getByRole("tab", { name: "Settings" }));
    await user.selectOptions(screen.getByLabelText("Sound"), "off");
    await waitFor(() => expect(db.calls.find((c) => c.path === "/api/notification-settings")?.body).toMatchObject({ tone: "off" }));
    await user.click(screen.getByRole("button", { name: "Send a test notification" }));
    expect(await screen.findByTestId("popups")).toHaveTextContent("Test notification");
    expect(audioLog).toEqual([]); // silent tone
  });

  it("mark all as read clears the badge", async () => {
    const user = userEvent.setup();
    await ready();
    await user.click(screen.getByRole("button", { name: /Notifications, 1 unread/ }));
    await user.click(screen.getByRole("button", { name: "Mark all as read" }));
    expect(screen.queryByTestId("unread")).not.toBeInTheDocument();
    expect(db.calls.some((c) => c.path === "/api/notifications/read-all")).toBe(true);
  });
});

const HAND_OVER_BODY = "Setup ladder: 3 of 12 rungs passed, 9 skipped. The commands that passed are in .keel/RUNNING.md.\n"
  + "Knowledge: wrote architecture, domain, conventions (in .keel/knowledge/).\nLayout: keel — keel's files stay in .keel/, out of git.";

describe("readable notifications (0.18.55)", () => {
  it("the toast shows the title and the short lines, not the long body", async () => {
    await ready();
    act(() => FakeEventSource.emit("notification", note({
      title: "◆ shop is set up — check it", project_id: "shop", body: HAND_OVER_BODY,
      summary: ["✓ 3 setup checks passed · 9 skipped", "✓ Knowledge: architecture, domain, conventions"],
    })));
    const pop = await screen.findByTestId("popups");
    expect(within(pop).getByText("shop is set up — check it")).toBeInTheDocument();
    const lines = within(pop).getByTestId("note-lines");
    expect(within(lines).getAllByRole("listitem").map((li) => li.textContent))
      .toEqual(["✓ 3 setup checks passed · 9 skipped", "✓ Knowledge: architecture, domain, conventions"]);
    expect(pop).not.toHaveTextContent("Layout");
    expect(pop).not.toHaveTextContent(".keel/RUNNING.md");
    expect(within(pop).getByRole("button", { name: "Review now" })).toBeInTheDocument();
  });

  it("an older notification: no snake_case title, at most three lines of whole words from its body", async () => {
    await ready();
    act(() => FakeEventSource.emit("notification", note({ title: "hand_over", body: HAND_OVER_BODY })));
    const pop = await screen.findByTestId("popups");
    const title = pop.querySelector(".note-title")!;
    expect(title.textContent).toContain("hand over");
    expect(title.textContent).not.toMatch(/[a-z]_[a-z]/);
    const items = within(within(pop).getByTestId("note-lines")).getAllByRole("listitem").map((li) => li.textContent ?? "");
    expect(items.length).toBeLessThanOrEqual(3);
    expect(items[items.length - 1]).toMatch(/^\+\d+ more$/);
    expect(pop).not.toHaveTextContent("out of git");
  });

  it("the bell list shows each notification's short lines and its mark", async () => {
    const user = userEvent.setup();
    db.nset.quiet = true;
    await ready();
    act(() => FakeEventSource.emit("notification", note({
      type: "finished", title: "✓ Add CSV export is done", project_id: "shop", body: "A very long close note ".repeat(30),
      summary: ["✓ All steps finished"],
    })));
    await waitFor(() => expect(screen.getByTestId("unread")).toHaveTextContent("2"));
    await user.click(screen.getByRole("button", { name: /Notifications, 2 unread/ }));
    const row = (await screen.findByText("Add CSV export is done")).closest("button")!;
    expect(within(row).getByRole("listitem")).toHaveTextContent("✓ All steps finished");
    expect(row).not.toHaveTextContent("A very long close note");
    expect(row.querySelector(".note-mark")?.textContent).toBe("✓");
  });
});

describe("notice text helpers", () => {
  it("never cuts a word, and too many lines become +N more", () => {
    expect(words("The order export writes every order of the shop as one CSV row with its customer", 40)).toBe("The order export writes every order…");
    expect(clip(["a", "b", "c", "d"])).toEqual(["a", "b", "+2 more"]);
    expect(linesFromBody("## Result\n\n- **one** fact\n- `two` facts")).toEqual(["Result", "one fact", "two facts"]);
  });
  it("a title without a mark gets its type's mark", () => {
    expect(noticeView(note({ type: "failed", title: "Guard reverted an edit" }))).toMatchObject({ mark: "✗", title: "Guard reverted an edit" });
    expect(noticeView(note({ title: "◆ shop: approve the spec?", summary: ["◆ 2 acceptance criteria"] })))
      .toEqual({ mark: "◆", title: "shop: approve the spec?", lines: ["◆ 2 acceptance criteria"] });
  });
});

describe("notify helpers", () => {
  it("soft tone is one note; off is silent", () => {
    expect(playSound("review", { sound: true, tone: "soft", volume: 0.5 })).toBe(true);
    expect(audioLog).toEqual([523]);
    expect(playSound("review", { sound: true, tone: "off", volume: 0.5 })).toBe(false);
    expect(playSound("review", { sound: false, tone: "chime", volume: 0.5 })).toBe(false);
  });
  it("respects kinds and scope", () => {
    expect(shouldAlert(note({ type: "started" }), NOTIFY_DEFAULTS, "ludus-engine")).toBe(false);
    expect(shouldAlert(note({ project_id: "platform" }), { ...NOTIFY_DEFAULTS, scope: "project" }, "ludus-engine")).toBe(false);
    expect(shouldAlert(note(), NOTIFY_DEFAULTS, "ludus-engine")).toBe(true);
  });
});
