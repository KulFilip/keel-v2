// keel 0.18.22 the dashboard's setup line: what keel installs for the projects' stacks (setup.apt), or what is missing.
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { stackSetup } from "./fixtures";
import { server } from "./setup";

describe("stack setup line", () => {
  it("says what keel installs while it runs", async () => {
    server.use(
      http.get("/api/setup", () =>
        HttpResponse.json({
          ...stackSetup,
          state: "running",
          mode: "container",
          busy: true,
          line: "installing php8.3-cli for carrier-router…",
        }),
      ),
    );
    location.hash = "#/projects";
    render(<App />);
    const lines = await screen.findAllByTestId("stack-setup");
    expect(lines[0]).toHaveTextContent(
      "setup: installing php8.3-cli for carrier-router…",
    );
  });

  it("says what is missing in native mode", async () => {
    server.use(
      http.get("/api/setup", () =>
        HttpResponse.json({
          ...stackSetup,
          state: "missing",
          mode: "native",
          line: "carrier-router: php, composer not found (stack php-symfony).",
        }),
      ),
    );
    location.hash = "#/projects";
    render(<App />);
    const lines = await screen.findAllByTestId("stack-setup");
    expect(lines[0]).toHaveTextContent("php, composer not found");
    expect(lines[0].getAttribute("title")).toContain(
      "Native mode installs nothing",
    );
  });

  it("shows nothing when the stacks are set up", async () => {
    location.hash = "#/projects";
    render(<App />);
    expect((await screen.findAllByTestId("engine")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("stack-setup")).not.toBeInTheDocument();
  });
});
