// keel 0.18.6: the dashboard and keel TUI on the same project and KeelBot chat (the shared focus, api ui/UiFocus.kt).
import { act, render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { FOCUS_CLIENT } from "../state";
import { db, FakeEventSource } from "./setup";

const shown = () => screen.getAllByText(/ludus-engine|platform|yegi/).map((e) => e.textContent).join(" ");

describe("the shared focus", () => {
  it("opens on the project keel TUI is on", async () => {
    db.focus = { project: "platform", chats: {}, by: "tui", client: "tui-1" };
    location.hash = "#/flow";
    render(<App />);
    await waitFor(() => expect(localStorage.getItem("keel2.project")).toBe("platform"));
    expect(shown()).toContain("platform");
  });

  it("follows keel TUI to another project, and never its own change", async () => {
    location.hash = "#/flow";
    render(<App />);
    await screen.findAllByText(/ludus-engine/);
    act(() => FakeEventSource.emit("ui.focus", { project: "yegi", chats: {}, by: "tui", client: "tui-1" }));
    await waitFor(() => expect(localStorage.getItem("keel2.project")).toBe("yegi"));
    act(() => FakeEventSource.emit("ui.focus", { project: "platform", chats: {}, by: "web", client: FOCUS_CLIENT }));
    await new Promise((r) => setTimeout(r, 50));
    expect(localStorage.getItem("keel2.project")).toBe("yegi");
  });

  it("follows keel TUI to the KeelBot chat it opened", async () => {
    location.hash = "#/keelbot";
    render(<App />);
    await screen.findAllByText(/ludus-engine/);
    act(() => FakeEventSource.emit("ui.focus", { project: "ludus-engine", chats: { "ludus-engine": "h-tui" }, by: "tui", client: "tui-1" }));
    await waitFor(() => expect(localStorage.getItem("keel2.helper.ludus-engine.session")).toBe("h-tui"));
  });
});
