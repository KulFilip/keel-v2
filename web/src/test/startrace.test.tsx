import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { delay, http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db, server } from "./setup";

describe("Start a flow: a slow answer for the old project", () => {
  it("never lands over the project that was picked after it", async () => {
    const user = userEvent.setup();
    const base = db.workflows[0];
    server.use(
      http.get("/api/projects/:pid/workflows", async ({ params }) => {
        if (params.pid === "ludus-engine") {
          await delay(400);
          return HttpResponse.json([{ ...base, id: "feature", name: "Feature of A" }]);
        }
        return HttpResponse.json([{ ...base, id: "quick", name: "Quick of B" }]);
      }),
    );
    location.hash = "#/projects";
    render(<App />);
    await user.click(await screen.findByRole("button", { name: "Start a flow" }));
    await user.selectOptions(await screen.findByLabelText("Project"), "yegi");
    expect(await screen.findByRole("option", { name: "Quick of B" })).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 700));
    expect(screen.queryByRole("option", { name: "Feature of A" })).toBeNull();
    expect(screen.getByRole("option", { name: "Quick of B" })).toBeInTheDocument();
  });
});
