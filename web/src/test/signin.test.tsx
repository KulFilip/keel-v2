import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { get, post } from "../api";
import { server } from "./setup";

// v0.17.5 keel's api proves every caller (api auth/LocalAuth): the page says it is keel's own, and a 401 "sign-in"
// shows one screen that says how to sign in.
describe("signing in to keel", () => {
  it("every call says it comes from keel's own page and sends the browser's cookie", async () => {
    const seen: { web: string | null; credentials: string }[] = [];
    server.use(
      http.get("/api/sign-in-probe", ({ request }) => {
        seen.push({ web: request.headers.get("x-keel-web"), credentials: request.credentials });
        return HttpResponse.json({ ok: true });
      }),
      http.post("/api/sign-in-probe", ({ request }) => {
        seen.push({ web: request.headers.get("x-keel-web"), credentials: request.credentials });
        return HttpResponse.json({ ok: true });
      }),
    );
    await get("/sign-in-probe");
    await post("/sign-in-probe", { a: 1 });
    expect(seen).toEqual([{ web: "1", credentials: "same-origin" }, { web: "1", credentials: "same-origin" }]);
  });

  it("an error that is not about signing in does not show it", async () => {
    server.use(http.get("/api/sign-in-probe", () => HttpResponse.json({ error: "nope" }, { status: 401 })));
    await expect(get("/sign-in-probe")).rejects.toThrow("nope");
    render(<App />);
    expect(screen.queryByRole("main", { name: "Sign in to keel" })).not.toBeInTheDocument();
  });

  it("shows the sign-in screen when keel says this browser is not signed in, and Try again checks", async () => {
    const user = userEvent.setup();
    const signInNeeded = () =>
      HttpResponse.json({ error: "keel needs you to sign in", hint: "Run keel2 open" }, { status: 401, headers: { "X-Keel-Auth": "sign-in" } });
    server.use(http.get("/api/*", signInNeeded), http.post("/api/*", signInNeeded));
    render(<App />);
    expect(await screen.findByRole("main", { name: "Sign in to keel" })).toBeInTheDocument();
    expect(screen.getByText("keel2 open")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Try again" }));
    expect(await screen.findByRole("status")).toHaveTextContent("still not signed in");
  });

});
