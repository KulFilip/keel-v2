// A Product-only keel has no Flow page: the start page and a link to Flow open the Inbox (or Product's first page),
// not the Flow page (an e2e run of the product edition still opened #/flow).

import { render, screen, waitFor } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db } from "./setup";

describe("Product-only start page", () => {
  it("an empty link and #/flow go to the Inbox when Dev is off", async () => {
    db.features = { mode: "product", modes: ["dev", "product", "both"], parts: { dev: false, product: true }, addons: [], screens: [], plugins: [] };
    location.hash = "";
    render(<App />);
    await waitFor(() => expect(location.hash).toBe("#/inbox"));
    expect(await screen.findByRole("heading", { name: "Inbox" })).toBeInTheDocument();
  });

  it("a keel with Dev keeps the Flow page", async () => {
    location.hash = "#/flow";
    render(<App />);
    await screen.findByRole("navigation", { name: "Screens" });
    expect(location.hash).toBe("#/flow");
  });
});
