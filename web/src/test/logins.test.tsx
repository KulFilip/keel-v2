import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import { db, server } from "./setup";

describe("Connections: CLI logins", () => {
  it("saves the Claude login token as its own encrypted secret and shows only the hint", async () => {
    const user = userEvent.setup();
    location.hash = "#/settings/models";
    render(<App />);
    const field = await screen.findByLabelText(/Claude login token/);
    await user.type(field, "sk-ant-oat01-secret-9KQ");
    const save = field.parentElement!.querySelector("button")!;
    await user.click(save);
    await waitFor(() => expect(db.calls.find((c) => c.method === "PUT" && c.path === "/api/secrets/CLAUDE_CODE_OAUTH_TOKEN")?.body)
      .toEqual({ value: "sk-ant-oat01-secret-9KQ" }));
    expect(await screen.findByPlaceholderText("…9KQ (saved)")).toBeInTheDocument();
    expect(screen.queryByDisplayValue("sk-ant-oat01-secret-9KQ")).not.toBeInTheDocument();
  });

  it("a refused token says why and how to copy it again", async () => {
    server.use(http.put("/api/secrets/:name", () => HttpResponse.json({ error: "The Claude login token has characters a token never has (#).",
      hint: "A token shown over two lines is often copied with extra characters. Copy it in one piece and save it again." }, { status: 400 })));
    const user = userEvent.setup();
    location.hash = "#/settings/models";
    render(<App />);
    const field = await screen.findByLabelText(/Claude login token/);
    await user.type(field, "sk-ant-oat01-test_ABC#more");
    await user.click(field.parentElement!.querySelector("button")!);
    expect(await screen.findByText(/characters a token never has \(#\)\. A token shown over two lines .* in one piece/)).toBeInTheDocument();
    expect(screen.queryByText("Saved and encrypted.")).not.toBeInTheDocument();
  });
});
