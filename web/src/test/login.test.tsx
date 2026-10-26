import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db, server } from "./setup";

describe("login helper", () => {
  it("logs Claude in from the dashboard: open the page, paste its code, saved and tested", async () => {
    const user = userEvent.setup();
    let polls = 0;
    server.use(
      http.post("/api/logins", () =>
        HttpResponse.json({
          id: "L1",
          provider: "claude",
          status: "code_needed",
          url: "https://claude.com/cai/oauth/authorize?code=true",
          message:
            "Open the link, sign in, then paste the code the page shows.",
        }),
      ),
      http.post("/api/logins/L1/code", async ({ request }) => {
        db.calls.push({
          method: "POST",
          path: "/api/logins/L1/code",
          body: await request.json(),
        });
        return HttpResponse.json({
          id: "L1",
          provider: "claude",
          status: "waiting",
          url: "https://claude.com/cai/oauth/authorize?code=true",
          message: "Checking the code…",
        });
      }),
      http.get("/api/logins/L1", () => {
        polls++;
        return HttpResponse.json({
          id: "L1",
          provider: "claude",
          status: "done",
          message:
            "Logged in. Saved encrypted in keel's database as CLAUDE_CODE_OAUTH_TOKEN.",
          hint: "…gAA",
        });
      }),
    );
    location.hash = "#/settings/models";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Set up login" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Start login" }),
    );
    const dlg = screen.getByRole("dialog", { name: "Set up Claude login" });
    const steps = within(dlg).getByRole("list", { name: "Steps" });
    expect(within(steps).getAllByRole("listitem").map((li) => li.querySelector("b")?.textContent)).toEqual([
      "Start the login",
      "Open claude.com and sign in with your Claude account",
      "Paste the code from that page",
      "Saved",
    ]);
    const link = await within(dlg).findByRole("link", { name: "Open claude.com" });
    expect(link).toHaveAttribute("href", "https://claude.com/cai/oauth/authorize?code=true");
    // step 2 is the one now; the code field comes with step 3, after the page was opened
    expect(link.closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(dlg).queryByLabelText(/the page shows a code/)).toBeNull();
    await user.click(link);
    const code = await within(dlg).findByLabelText(/the page shows a code/);
    expect(code.closest("li")).toHaveAttribute("aria-current", "step");
    await user.type(code, "abc#def");
    await user.click(screen.getByRole("button", { name: "Send" }));
    await waitFor(() =>
      expect(
        db.calls.find((c) => c.path === "/api/logins/L1/code")?.body,
      ).toEqual({ code: "abc#def" }),
    );
    expect(
      await screen.findByText(
        /Logged in\. Saved encrypted/,
        {},
        { timeout: 4000 },
      ),
    ).toBeInTheDocument();
    expect(await screen.findByText(/Test: OK/)).toBeInTheDocument();
    expect(polls).toBeGreaterThan(0);
    // every step is done
    expect(within(steps).getAllByRole("listitem").every((li) => li.classList.contains("s-done"))).toBe(true);
  });

  it("a refused Claude code shows the error in red, the steps, and the new link", async () => {
    const user = userEvent.setup();
    let starts = 0;
    const refused =
      "Claude did not accept that code (OAuth error 400). A code only works with the link from THIS box: press Open claude.com here, sign in again, and paste the new code.";
    server.use(
      http.post("/api/logins", () => (starts++,
        HttpResponse.json({
          id: "L3",
          provider: "claude",
          status: "code_needed",
          url: "https://claude.com/cai/oauth/authorize?state=first",
          message:
            "Open the link, sign in, then paste the code the page shows.",
        })
      )),
      http.post("/api/logins/L3/code", () =>
        HttpResponse.json({
          id: "L3",
          provider: "claude",
          status: "waiting",
          url: "https://claude.com/cai/oauth/authorize?state=first",
          message: "Checking the code…",
        }),
      ),
      http.get("/api/logins/L3", () =>
        HttpResponse.json({
          id: "L3",
          provider: "claude",
          status: "code_needed",
          url: "https://claude.com/cai/oauth/authorize?state=second",
          message: refused,
          error: refused,
        }),
      ),
    );
    location.hash = "#/settings/models";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Set up login" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Start login" }),
    );
    const dlg = await screen.findByRole("dialog", {
      name: "Set up Claude login",
    });
    await user.click(await within(dlg).findByRole("link", { name: "Open claude.com" }));
    expect(
      within(dlg).getByText(
        "Use the link from this box; a code from an older tab will not work.",
      ),
    ).toBeInTheDocument();
    await user.type(
      within(dlg).getByLabelText(/the page shows a code/),
      "old-tab-code",
    );
    await user.click(within(dlg).getByRole("button", { name: "Send" }));
    // the code step turns red with the error and "Start again"; the login still runs
    const err = await within(dlg).findByRole("alert", {}, { timeout: 4000 });
    expect(err).toHaveTextContent(/Claude did not accept that code \(OAuth error 400\)/);
    const step = err.closest("li")!;
    expect(step).toHaveClass("s-failed");
    expect(within(step).getByText("Paste the code from that page")).toBeInTheDocument();
    expect(within(dlg).queryByLabelText(/the page shows a code/)).toBeNull();
    // Start again: back to step 2 with the NEW link, then a fresh, empty code field
    await user.click(within(err).getByRole("button", { name: "Start again" }));
    const link = within(dlg).getByRole("link", { name: "Open claude.com" });
    expect(link).toHaveAttribute("href", "https://claude.com/cai/oauth/authorize?state=second");
    expect(link.closest("li")).toHaveAttribute("aria-current", "step");
    expect(within(dlg).queryByRole("alert")).toBeNull();
    await user.click(link);
    expect(within(dlg).getByLabelText(/the page shows a code/)).toHaveValue("");
    expect(starts).toBe(1); // the same login: no second start
  });

  it("the paste tab explains how to get each token", async () => {
    const user = userEvent.setup();
    location.hash = "#/settings/models";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Set up login" }),
    );
    await user.click(screen.getByRole("button", { name: "Paste a token" }));
    const dlg = screen.getByRole("dialog", { name: "Set up Claude login" });
    expect(
      within(dlg).getByText(/On your computer run `claude setup-token`/),
    ).toBeInTheDocument();
  });
});

describe("login drawer polling", () => {
  it("keeps polling after one poll failed", async () => {
    const user = userEvent.setup();
    let polls = 0;
    server.use(
      http.post("/api/logins", () =>
        HttpResponse.json({
          id: "L2",
          provider: "claude",
          status: "waiting",
          url: "https://claude.com/cai/oauth/authorize?code=true",
          message: "Waiting for you.",
        }),
      ),
      http.get("/api/logins/L2", () => {
        polls++;
        if (polls === 1)
          return HttpResponse.json({ error: "busy" }, { status: 500 });
        return HttpResponse.json({
          id: "L2",
          provider: "claude",
          status: "done",
          message: "Logged in again after a failed poll.",
        });
      }),
    );
    location.hash = "#/settings/models";
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: "Set up login" }),
    );
    await user.click(
      await screen.findByRole("button", { name: "Start login" }),
    );
    expect(
      await screen.findByText(
        /Logged in again after a failed poll/,
        {},
        { timeout: 6000 },
      ),
    ).toBeInTheDocument();
    expect(polls).toBeGreaterThan(1);
  }, 15000);
});
