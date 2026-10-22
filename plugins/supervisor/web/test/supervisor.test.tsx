// The Supervisor plugin's Jobs › Supervisor inside keel's web (web/src/test/setup.ts runs every plugin's setup()): the
// audit log with each row's result and reason, the waiting flow's switch and mode, and the empty state.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import { slotItems, SLOTS } from "../../../../web/src/sdk";
import { server } from "../../../../web/src/test/setup";
import plugin from "../index";
import { outcomeText, type Decision } from "../Supervisor";

const row = (over: Partial<Decision>): Decision => ({
  id: "d1", thread_id: "t-sup", step: "g1", ac: "AC-1", kind: "ac", action: "answer", decision: "approve", choice: null,
  why: "supervisor: the test passes", confidence: "high", evidence: ["src/a.ts:3"], code: null,
  summary: "Test and review are clean.", tokens: 1234, outcome: "applied", at: new Date().toISOString(), ...over,
});

function api(decisions: Decision[], posted: unknown[] = []) {
  let settings = { on: false, mode: "shadow", cap_tokens: 150000 };
  server.use(
    // the plugin is on for the project (per project, Control › Plugins): Jobs shows its tab
    http.get("/api/projects/:pid/plugins", () =>
      HttpResponse.json([{ name: "supervisor", title: "Supervisor", description: "", needs: [], tools: {}, actions: [],
        shows_in: ["jobs"], commands: [], enabled: true, scope: "project" }])),
    http.get("/api/projects/:pid/supervisor/decisions", () => HttpResponse.json({ decisions })),
    http.get("/api/projects/:pid/flow", () =>
      HttpResponse.json({ thread: { thread_id: "t-sup", title: "Player ranks", status: "waiting" } })),
    http.get("/api/projects/:pid/flows/:tid/supervisor", () => HttpResponse.json({ settings, used: { tokens: 1234 } })),
    http.post("/api/projects/:pid/flows/:tid/supervisor", async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      posted.push(body);
      settings = { ...settings, ...body };
      return HttpResponse.json({ settings, used: { tokens: 1234 } });
    }),
  );
}

describe("the Supervisor plugin's web part", () => {
  it("is the plugin supervisor, with a tab in Jobs", () => {
    expect(plugin.name).toBe("supervisor");
    const tabs = slotItems<{ id: string; plugin?: string }>(SLOTS.jobsTab);
    expect(tabs.find((t) => t.id === "supervisor")?.plugin).toBe("supervisor");
  });

  it("says each result in plain words", () => {
    expect(outcomeText(row({}))).toBe("answered approve");
    expect(outcomeText(row({ action: "send_back", decision: "reject" }))).toBe("sent back");
    expect(outcomeText(row({ outcome: "escalated" }))).toBe("asked you");
    expect(outcomeText(row({ outcome: "suggested" }))).toBe("suggested");
    expect(outcomeText(row({ outcome: "stale" }))).toBe("too late (you answered)");
  });

  it("lists its decisions and turns it on for the waiting flow", async () => {
    const posted: unknown[] = [];
    api([row({}), row({ id: "d2", outcome: "escalated", code: "low-confidence", summary: "Spec says 410, test 404." })], posted);
    const user = userEvent.setup();
    location.hash = "#/jobs/supervisor";
    render(<App />);
    const table = await screen.findByRole("table", { name: "Supervisor decisions" });
    expect(within(table).getByText("answered approve")).toBeInTheDocument();
    expect(within(table).getByText("Spec says 410, test 404.")).toBeInTheDocument();
    const box = await screen.findByRole("region", { name: "Supervisor for this flow" });
    await user.click(await within(box).findByRole("checkbox", { name: "Supervisor on" }));
    await waitFor(() => expect(posted).toEqual([{ on: true }]));
    await user.selectOptions(within(box).getByRole("combobox", { name: "Mode" }), "act");
    await waitFor(() => expect(posted).toEqual([{ on: true }, { mode: "act" }]));
  });

  it("says what it does when it has not looked at anything yet", async () => {
    api([]);
    location.hash = "#/jobs/supervisor";
    render(<App />);
    expect(await screen.findByText("The Supervisor has not looked at anything yet.")).toBeInTheDocument();
  });
});
