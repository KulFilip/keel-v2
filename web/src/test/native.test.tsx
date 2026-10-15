// v0.16.1 the header says when keel runs natively (keel2 start --native): its agents run as the person.
import { render, screen } from "@testing-library/react";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { health } from "./fixtures";
import { server } from "./setup";

describe("native mode badge", () => {
  it("shows 'native' with its tooltip when health says native", async () => {
    server.use(http.get("/api/health", () => HttpResponse.json({ ...health, native: true })));
    location.hash = "#/projects";
    render(<App />);
    const badges = await screen.findAllByTestId("native");
    expect(badges[0]).toHaveTextContent("native");
    expect(badges[0]).toHaveAttribute("title", "Native mode: keel's agents run as you and can read what you can.");
  });

  it("shows no badge otherwise", async () => {
    location.hash = "#/projects";
    render(<App />);
    expect((await screen.findAllByTestId("engine")).length).toBeGreaterThan(0);
    expect(screen.queryByTestId("native")).not.toBeInTheDocument();
  });
});
