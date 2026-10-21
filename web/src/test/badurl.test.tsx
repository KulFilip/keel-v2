import { act, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { App } from "../App";
import { parseHash, routeFromLink } from "../routes";

afterEach(() => {
  location.hash = "";
});

describe("a bad link must not blank the app", () => {
  it("parseHash keeps the raw segment when it is not valid percent-encoding", () => {
    expect(parseHash("#/jobs/100%").arg).toBe("100%");
    expect(parseHash("#/projects/a%zz/flow").project).toBe("a%zz");
    expect(parseHash("#/jobs/a%20b").arg).toBe("a b");
  });

  it("routeFromLink does not throw on a bad project id", () => {
    expect(routeFromLink("/projects/50%/flow").project).toBe("50%");
  });

  it("the app still renders its shell on #/jobs/100%", async () => {
    location.hash = "#/jobs/100%";
    render(<App />);
    expect(await screen.findByRole("navigation", { name: "Screens" })).toBeInTheDocument();
    await act(async () => {
      location.hash = "#/flow";
      window.dispatchEvent(new HashChangeEvent("hashchange"));
    });
    expect(await screen.findByRole("navigation", { name: "Screens" })).toBeInTheDocument();
  });
});
