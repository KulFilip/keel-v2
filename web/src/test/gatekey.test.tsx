import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

const resumes = () => db.calls.filter((c) => c.method === "POST" && c.path === "/api/threads/th_7f3a/resume");

async function card() {
  render(<App />);
  const c = await screen.findByRole("region", { name: "Gate waits for you" });
  return { c, approve: within(c).getByRole("button", { name: /^Approve AC-002/ }) };
}

describe("the A shortcut on a gate", () => {
  it("a held key (repeat) does not approve", async () => {
    const { approve } = await card();
    fireEvent.keyDown(approve, { key: "a", repeat: true });
    await new Promise((r) => setTimeout(r, 50));
    expect(resumes()).toHaveLength(0);
  });

  it("typing in a contenteditable does not approve", async () => {
    const { c } = await card();
    const ed = document.createElement("div");
    ed.setAttribute("contenteditable", "true");
    c.appendChild(ed);
    fireEvent.keyDown(ed, { key: "a" });
    await new Promise((r) => setTimeout(r, 50));
    expect(resumes()).toHaveLength(0);
  });

  it("two key presses in the same frame post one resume", async () => {
    const { approve } = await card();
    act(() => {
      fireEvent.keyDown(approve, { key: "a" });
      fireEvent.keyDown(approve, { key: "a" });
    });
    await waitFor(() => expect(resumes().length).toBeGreaterThan(0));
    await new Promise((r) => setTimeout(r, 100));
    expect(resumes()).toHaveLength(1);
  });
});
