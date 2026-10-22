// Small dashboard fixes: focus stays put in a dialog, an import refreshes the list however its drawer closes.

import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it, vi } from "vitest";
import { App } from "../App";
import { Canvas } from "../components/er/Canvas";
import { CodeEditor } from "../components/CodeEditor";
import { Markdown } from "../components/Markdown";
import { StepView } from "../components/StepView";
import { DeleteWorkflow } from "../components/WorkflowMarket";
import { ConfirmStop } from "../pages/Flow";
import { AppProvider } from "../state";
import * as fx from "./fixtures";
import { db, server } from "./setup";

describe("dialog focus", () => {
  it("Stop flow: a parent render does not pull focus back to Keep it running", () => {
    const view = render(<ConfirmStop title="t" busy={false} onCancel={() => {}} onStop={() => {}} />);
    const keep = screen.getByRole("button", { name: "Keep it running" });
    expect(keep).toHaveFocus();
    screen.getByRole("button", { name: "Stop the flow" }).focus();
    view.rerender(<ConfirmStop title="t" busy={false} onCancel={() => {}} onStop={() => {}} />);
    expect(screen.getByRole("button", { name: "Stop the flow" })).toHaveFocus();
  });

  it("Stop flow: Esc calls the latest onCancel", async () => {
    const user = userEvent.setup();
    const first = vi.fn(), second = vi.fn();
    const view = render(<ConfirmStop title="t" busy={false} onCancel={first} onStop={() => {}} />);
    view.rerender(<ConfirmStop title="t" busy={false} onCancel={second} onStop={() => {}} />);
    await user.keyboard("{Escape}");
    expect(first).not.toHaveBeenCalled();
    expect(second).toHaveBeenCalledTimes(1);
  });

  it("Delete workflow: a parent render does not pull focus back", () => {
    const w = { ...fx.fixWorkflow, id: "mine", name: "Mine" };
    const wrap = (n: number) => <AppProvider><DeleteWorkflow w={w} onDone={() => {}} onNo={() => void n} /></AppProvider>;
    const view = render(wrap(1));
    expect(screen.getByRole("button", { name: "Keep it" })).toHaveFocus();
    screen.getByRole("button", { name: "Delete" }).focus();
    view.rerender(wrap(2));
    expect(screen.getByRole("button", { name: "Delete" })).toHaveFocus();
  });
});

describe("workflow import", () => {
  it("closing the drawer with Esc after a good import still refreshes the list", async () => {
    const user = userEvent.setup();
    let lists = 0;
    server.use(
      http.get("/api/projects/:pid/workflows", () => (lists++, HttpResponse.json(db.workflows))),
      http.post("/api/projects/:pid/workflows/import", () => HttpResponse.json({
        workflow: { ...fx.fixWorkflow, id: "imp", name: "Imported one" },
        review: { agents: [], mcp: [], gates: 1, est_tokens: 1000, edits_files: false },
      })),
    );
    location.hash = "#/workflows/feature";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Import" }));
    const dlg = await screen.findByRole("dialog", { name: "Import a workflow" });
    await user.click(within(dlg).getByLabelText("Or paste it"));
    await user.paste("name: Imported one\nsteps: []\n");
    await user.click(within(dlg).getByRole("button", { name: "Import" }));
    await screen.findByRole("dialog", { name: "Imported Imported one" });
    const before = lists;
    await user.keyboard("{Escape}");
    await waitFor(() => expect(lists).toBeGreaterThan(before));
  });
});

describe("CodeEditor Tab", () => {
  const setup = (value: string) => {
    const onChange = vi.fn();
    render(<><CodeEditor id="ce" value={value} onChange={onChange} label="code" /><button type="button">after</button></>);
    return { area: screen.getByLabelText("code") as HTMLTextAreaElement, onChange };
  };

  it("with several lines selected, Tab indents each line and keeps the text", async () => {
    const user = userEvent.setup();
    const { area, onChange } = setup("a\nb\nc\n");
    area.focus();
    area.setSelectionRange(0, 5); // "a\nb\nc"
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenLastCalledWith("  a\n  b\n  c\n");
    expect(area.selectionStart).toBe(2);
    expect(area.selectionEnd).toBe(11);
  });

  it("does not indent a last line the selection only reaches the start of", async () => {
    const user = userEvent.setup();
    const { area, onChange } = setup("a\nb\nc");
    area.focus();
    area.setSelectionRange(0, 4); // "a\nb\n"
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenLastCalledWith("  a\n  b\nc");
  });

  it("a caret gets two spaces", async () => {
    const user = userEvent.setup();
    const { area, onChange } = setup("ab");
    area.focus();
    area.setSelectionRange(1, 1);
    await user.keyboard("{Tab}");
    expect(onChange).toHaveBeenLastCalledWith("a  b");
  });

  it("Escape then Tab leaves the editor", async () => {
    const user = userEvent.setup();
    const { area, onChange } = setup("ab");
    area.focus();
    await user.keyboard("{Escape}{Tab}");
    expect(onChange).not.toHaveBeenCalled();
    expect(screen.getByRole("button", { name: "after" })).toHaveFocus();
  });
});

describe("diagram canvas wheel", () => {
  const wheel = (el: Element, init: WheelEventInit) => {
    const e = new WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: 40, ...init });
    el.dispatchEvent(e);
    return e.defaultPrevented;
  };
  const draw = () => {
    render(<Canvas world={{ w: 400, h: 300 }} label="d"><rect width="10" height="10" /></Canvas>);
    return screen.getByRole("application", { name: "d" });
  };

  it("a plain wheel scrolls the page; Ctrl or Cmd zooms the diagram", () => {
    const c = draw();
    expect(wheel(c, {})).toBe(false);
    expect(wheel(c, { ctrlKey: true })).toBe(true);
    expect(wheel(c, { metaKey: true })).toBe(true);
  });

  it("with Space held the wheel pans, and a window blur lets go of Space", () => {
    const c = draw();
    c.focus();
    fireEvent.keyDown(c, { code: "Space", key: " " });
    expect(c).toHaveClass("space");
    expect(wheel(c, {})).toBe(true);
    act(() => { window.dispatchEvent(new Event("blur")); });
    expect(c).not.toHaveClass("space");
    expect(wheel(c, {})).toBe(false);
  });
});

describe("Markdown links", () => {
  it("a //host link opens like an outside link, a /path link stays in the tab", () => {
    render(<Markdown text={"[out](//evil.example/x) [in](/plugins) [web](https://a.example)"} />);
    expect(screen.getByRole("link", { name: "out" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "web" })).toHaveAttribute("target", "_blank");
    expect(screen.getByRole("link", { name: "in" })).not.toHaveAttribute("target");
  });
});

describe("clipboard in the pages", () => {
  it("Copy Markdown says when the browser did not allow copying", async () => {
    // outputKind picks "md" for a cat of a .md file
    const user = userEvent.setup(); // (it installs its own clipboard: remove it after)
    Object.defineProperty(navigator, "clipboard", { value: undefined, configurable: true });
    document.execCommand = vi.fn(() => false);
    render(<StepView s={{ n: 1, at: "2026-01-01T00:00:00Z", kind: "tool", tool: "Bash", text: "cat docs/a.md", ok: true,
      output: "# Title\n\n- one\n- two\n\n**bold** text\n" }} />);
    await user.click(screen.getByRole("button", { name: "Copy Markdown" }));
    expect(await screen.findByRole("status")).toHaveTextContent("The browser did not allow copying.");
  });
});
