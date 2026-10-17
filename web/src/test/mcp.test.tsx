// v0.4: the Tools (MCP) page shows keel v2's own server (built in, read-only) and the optional keel v1 entry, off.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

describe("Tools (MCP)", () => {
  it("lists keel v1 (optional) turned off, and turning it on saves enabled", async () => {
    const user = userEvent.setup();
    location.hash = "#/tools";
    render(<App />);
    const keel = (await screen.findByText("keel v2 (read-only)")).closest("tr")!;
    expect(within(keel).getByText("built in")).toBeInTheDocument();
    expect(within(keel).getByText("/opt/engine/.venv/bin/python -m keel_engine.mcp --read-only")).toBeInTheDocument();
    const v1 = screen.getByText("keel v1 (optional)").closest("tr")!;
    expect(within(v1).getByText("turned off")).toBeInTheDocument();
    expect(screen.getByRole("checkbox", { name: "explorer may use keel-v1" })).toBeDisabled();
    await user.click(within(v1).getByRole("button", { name: "Turn on" }));
    await waitFor(() => expect(db.calls.find((c) => c.method === "PUT" && c.path === "/api/mcp-servers/keel-v1")?.body).toEqual({ enabled: true }));
    expect(await within(screen.getByText("keel v1 (optional)").closest("tr")!).findByRole("button", { name: "Turn off" })).toBeInTheDocument();
  });

  it("Select all lets every agent shown use a server; Select none takes it back (0.18.9)", async () => {
    const user = userEvent.setup();
    location.hash = "#/tools";
    render(<App />);
    const matrix = await screen.findByRole("table", { name: "Who may use what" });
    await user.click(within(matrix).getByRole("button", { name: "Every agent may use keel" }));
    await waitFor(() => {
      const put = db.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/mcp-allow")).at(-1)?.body as Record<string, string[]>;
      expect(put && Object.values(put).every((l) => l.includes("keel"))).toBe(true);
    });
    await user.click(within(matrix).getByRole("button", { name: "No agent may use keel" }));
    await waitFor(() => {
      const put = db.calls.filter((c) => c.method === "PUT" && c.path.endsWith("/mcp-allow")).at(-1)?.body as Record<string, string[]>;
      expect(Object.values(put).some((l) => l.includes("keel"))).toBe(false);
    });
  });
});
