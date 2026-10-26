// keel 0.18.57 the project notes are opt-in. While they are off the Wiki says "Project notes are off" with Build them
// (and the expected cost) instead of a "not written" row with Write them and a Refresh stale button; Build them starts
// the knowledge-refresh flow for the five sections. Notes that exist but were turned off get Turn on; notes that are
// on get Turn notes off.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import type { Notes, WikiTree } from "../../../../web/src/api";
import { notesCostLabel } from "../../../../web/src/components/ProjectNotes";
import { db, server } from "../../../../web/src/test/setup";

const PID = "ludus-engine";

const tree = (
  notes: Notes,
  status: "missing" | "written" = "missing",
): WikiTree => ({
  sections: [
    {
      id: "knowledge",
      title: "Knowledge",
      items: ["architecture", "domain", "data"].map((s) => ({
        id: `kb:${s}`,
        title: s,
        status,
        kind: "knowledge",
        label: s,
      })),
    },
    {
      id: "workflows",
      title: "Workflows",
      items: [
        {
          id: "wf:init",
          title: "init (keel)",
          kind: "workflow",
          source: "keel",
        },
      ],
    },
  ],
  notes,
});

const puts: unknown[] = [];

function serve(t: WikiTree) {
  puts.length = 0;
  server.use(
    http.get("/api/projects/:pid/wiki", () => HttpResponse.json(t)),
    http.get("/api/projects/:pid/specs/status", () => HttpResponse.json([])),
    http.get("/api/projects/:pid/estimate", () =>
      HttpResponse.json({
        tokens: 1_500_000,
        low: 1_050_000,
        high: 2_400_000,
        cost_usd: 4.6,
        premium_requests: 0,
        by_provider: {},
        per_step: [],
      }),
    ),
    http.get("/api/projects/:pid/wiki/page", ({ request }) => {
      const id = new URL(request.url).searchParams.get("id") ?? "";
      return HttpResponse.json({
        id,
        title: id,
        markdown: "Project notes are off.",
        meta: { status: "off" },
      });
    }),
    http.put("/api/projects/:pid/rules/config", async ({ request }) => {
      puts.push(await request.json());
      return HttpResponse.json({});
    }),
  );
}

describe("project notes off", () => {
  it("the Wiki offers Build them with its cost, not Write them or Refresh stale", async () => {
    const user = userEvent.setup();
    serve(tree({ on: false, setting: null, written: 0 }));
    location.hash = "#/wiki/wf%3Ainit";
    render(<App />);
    const banner = await screen.findByTestId("notes-off");
    expect(banner).toHaveTextContent("Project notes are off");
    const build = await within(banner).findByRole("button", {
      name: "Build them (≈$3–7)",
    });
    expect(screen.queryByRole("button", { name: "Write them" })).toBeNull();
    expect(screen.queryByRole("button", { name: "Refresh stale" })).toBeNull();
    await user.click(build);
    await waitFor(() =>
      expect(
        db.calls.find(
          (c) =>
            c.method === "POST" &&
            c.path === `/api/projects/${PID}/wiki/refresh`,
        )?.body,
      ).toEqual({
        sections: [
          "architecture",
          "domain",
          "conventions",
          "data",
          "integrations",
        ],
      }),
    );
  });

  it("notes that exist but were turned off get Turn on", async () => {
    const user = userEvent.setup();
    serve(tree({ on: false, setting: "off", written: 3 }, "written"));
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    const banner = await screen.findByTestId("notes-off");
    await user.click(within(banner).getByRole("button", { name: "Turn on" }));
    await waitFor(() =>
      expect(puts).toEqual([{ knowledge: { build: "on" } }]),
    );
  });

  it("notes that are on can be turned off", async () => {
    const user = userEvent.setup();
    serve(tree({ on: true, setting: "on", written: 3 }, "written"));
    location.hash = "#/wiki/kb%3Aarchitecture";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Turn notes off" }),
    );
    await waitFor(() =>
      expect(puts).toEqual([{ knowledge: { build: "off" } }]),
    );
  });

  it("the cost reads like the engine's", () => {
    expect(notesCostLabel({ cost_usd: 4.6, low: 0, high: 0 })).toBe("≈$3–7");
    expect(notesCostLabel({ cost_usd: 0, low: 900_000, high: 2_100_000 })).toBe(
      "≈900k–2.1M tokens",
    );
  });
});
