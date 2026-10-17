// keel 0.18.9 Build › Stacks: a stack the project added is removed after a yes; keel's own cannot be removed and is
// turned off for the project instead; the YAML view; New stack as a guided form filled from keel's suggestions, checked
// by keel (nothing saved) and then saved; and the Marketplace's Stacks tab (keel's own, the catalogs', a stack's page,
// install, update).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { Stack } from "../api";
import { db } from "./setup";

const calls = (method: string, path: string) => db.calls.filter((c) => c.method === method && c.path === path);
const open = (hash: string) => {
  location.hash = hash;
  render(<App />);
};

const keelStack: Stack = { name: "go", lane: "api", source: "keel", origin: "keel", detected: true, detect: "go.mod", layers: ["unit"],
  commands: [{ name: "api_test_module", cmd: "go test ./..." }], tools: [], skills: [], removable: false, off: false,
  why: "It ships with keel and other projects may use it. Turn it off for this project instead." };
const mine: Stack = { name: "zig-api", lane: "api", source: "project", origin: "project", detected: true, detect: "build.zig", layers: ["unit"],
  commands: [], tools: [], skills: [], removable: true, off: false, why: null, file: ".keel/stacks/zig-api.yml" };

describe("Build › Stacks", () => {
  it("removes the project's own stack after a yes; keel's own says why it cannot and turns off instead", async () => {
    db.stacks = [keelStack, mine];
    const user = userEvent.setup();
    open("#/stacks");
    await user.click(await screen.findByRole("button", { name: "zig-api" }));
    const acts = await screen.findByRole("group", { name: "What to do with zig-api" });
    await user.click(within(acts).getByRole("button", { name: "Remove" }));
    const yes = await screen.findByRole("group", { name: "Confirm" });
    expect(yes).toHaveTextContent("Remove zig-api from");
    expect(yes).toHaveTextContent(".keel/stacks/zig-api.yml");
    await user.click(within(yes).getByRole("button", { name: "Remove" }));
    await waitFor(() => expect(calls("DELETE", "/api/projects/ludus-engine/stacks/zig-api")).toHaveLength(1));
    await waitFor(() => expect(screen.queryByRole("button", { name: "zig-api" })).not.toBeInTheDocument());

    await user.click(screen.getByRole("button", { name: "go" }));
    const goActs = await screen.findByRole("group", { name: "What to do with go" });
    expect(within(goActs).queryByRole("button", { name: "Remove" })).not.toBeInTheDocument();
    expect(goActs).toHaveTextContent("Ships with keel: it cannot be removed.");
    await user.click(within(goActs).getByRole("button", { name: "Turn off for this project" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/stacks/go/off")[0]?.body).toEqual({ off: true }));
    expect(await screen.findByText(/Turned off for/)).toBeInTheDocument();
    expect(within(screen.getByRole("table", { name: "Stacks" })).getByText("turned off")).toBeInTheDocument();
    await user.click(within(screen.getByRole("group", { name: "What to do with go" })).getByRole("button", { name: "Turn on for this project" }));
    await waitFor(() => expect(calls("PUT", "/api/projects/ludus-engine/stacks/go/off")[1]?.body).toEqual({ off: false }));
    // the YAML of a stack
    await user.click(within(screen.getByRole("group", { name: "What to do with go" })).getByRole("button", { name: "Show YAML" }));
    expect(await screen.findByLabelText("YAML of go")).toHaveTextContent("name: go");
  });

  it("New stack: filled from keel's suggestions, checked (nothing saved), then saved", async () => {
    const user = userEvent.setup();
    open("#/stacks");
    await user.click(await screen.findByRole("button", { name: "New stack" }));
    const dlg = await screen.findByRole("dialog", { name: "New stack" });
    expect(await within(dlg).findByText(/keel read build.zig, Makefile/)).toBeInTheDocument();
    const name = within(dlg).getByLabelText("Name") as HTMLInputElement;
    expect(name.value).toBe("ludus-api");
    await user.clear(name);
    await user.type(name, "zig-api");
    await user.click(within(dlg).getByRole("button", { name: "Next" }));
    expect((within(dlg).getByLabelText("Files (in the root or one folder down)") as HTMLInputElement).value).toBe("build.zig");
    await user.click(within(dlg).getByRole("button", { name: "Next" }));
    expect((within(dlg).getByLabelText("id") as HTMLInputElement).value).toBe("unit");
    await user.click(within(dlg).getByRole("button", { name: "Next" }));
    // the first command keel found is filled in; another one it found is a chip to pick
    const mod = within(dlg).getByLabelText(/run every test of the module/) as HTMLInputElement;
    expect(mod.value).toBe("zig build test");
    await user.click(within(dlg).getByRole("button", { name: /make test/ }));
    expect(mod.value).toBe("make test");
    await user.type(within(dlg).getByLabelText(/test one acceptance criterion/), "zig build test -Dfilter={{AC_ID}");
    await user.click(within(dlg).getByRole("button", { name: "Next" }));
    await user.click(within(dlg).getByRole("checkbox", { name: /pre-commit/ }));
    await user.click(within(dlg).getByRole("button", { name: "Next" }));
    // keel's check: nothing is saved yet
    expect(await within(dlg).findByText("keel can save it")).toBeInTheDocument();
    const sent = calls("POST", "/api/projects/ludus-engine/stacks/check")[0]?.body as { form: Record<string, unknown> };
    expect(sent.form).toMatchObject({ name: "zig-api", lane: "api", detect: { files: ["build.zig"] },
      commands: { api_test_module: "make test", api_test_ac: "zig build test -Dfilter={AC_ID}" } });
    expect((sent.form.tools as Record<string, { on: string }>)["pre-commit"].on).toBe("pre-commit");
    expect(within(dlg).getByText(/warning: there is no api_test_ac/)).toBeInTheDocument();
    expect(calls("POST", "/api/projects/ludus-engine/stacks/save")).toHaveLength(0);
    // a change to the YAML is checked again before it can be saved
    const yaml = within(dlg).getByLabelText(/The stack's YAML/) as HTMLTextAreaElement;
    await user.type(yaml, "# mine\n");
    expect(within(dlg).queryByRole("button", { name: "Save the stack" })).not.toBeInTheDocument();
    await user.click(within(dlg).getByRole("button", { name: "Check again" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/stacks/check")[1]?.body).toMatchObject({ yaml: expect.stringContaining("# mine") }));
    await user.click(await within(dlg).findByRole("button", { name: "Save the stack" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/stacks/save")[0]?.body).toMatchObject({ yaml: expect.stringContaining("name: zig-api") }));
    expect(await screen.findByRole("heading", { name: "zig-api" })).toBeInTheDocument();
  });

  it("a name keel refuses: the check says so and Save stays off", async () => {
    const user = userEvent.setup();
    open("#/stacks");
    await user.click(await screen.findByRole("button", { name: "New stack" }));
    const dlg = await screen.findByRole("dialog", { name: "New stack" });
    const name = await within(dlg).findByLabelText("Name");
    await user.clear(name);
    await user.type(name, "Bad Name");
    await user.click(within(dlg).getByRole("button", { name: "6. Check" }));
    expect(await within(dlg).findByText("keel cannot save it yet")).toBeInTheDocument();
    expect(within(dlg).getByRole("alert")).toHaveTextContent("is not an id");
    expect(within(dlg).getByRole("button", { name: "Save the stack" })).toBeDisabled();
  });
});

describe("Marketplace › Stacks", () => {
  it("lists keel's own and the catalogs', opens one, installs it, then it is a stack of the project", async () => {
    const user = userEvent.setup();
    open("#/plugins?tab=market");
    const kinds = await screen.findByRole("group", { name: "What to find" });
    await user.click(within(kinds).getByRole("button", { name: "Stacks" }));
    await waitFor(() => expect(location.hash).toBe("#/plugins?tab=market&kind=stacks"));
    expect(screen.getByText(/Stacks made by keel and the community/)).toBeInTheDocument();
    const go = await screen.findByRole("article", { name: "go stack" });
    expect(within(screen.getByRole("region", { name: "From keel" })).getByRole("article", { name: "go stack" })).toBe(go);
    const zig = await screen.findByRole("article", { name: "Zig stack" });
    expect(zig).toHaveTextContent("api · 1 layer · 1 command · 1 tool");
    await user.click(within(zig).getByRole("link", { name: "Zig" }));
    await waitFor(() => expect(location.hash).toBe("#/plugins/stacks/zig"));
    expect(await screen.findByLabelText("YAML of Zig")).toHaveTextContent("name: zig");
    expect(screen.getByLabelText("keel's check")).toHaveTextContent("warning: there is no api_test_ac");
    expect(screen.getByText("zig build test")).toBeInTheDocument();
    await user.click(screen.getByRole("button", { name: "Install 1.1.0" }));
    const dlg = await screen.findByRole("dialog", { name: "Install Zig 1.1.0?" });
    expect(dlg).toHaveTextContent(".keel/stacks/zig.yml");
    await user.click(within(dlg).getByRole("button", { name: "Install" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/stacks/market/install")[0]?.body).toEqual({ name: "zig" }));
    expect(await screen.findByText("Installed here 1.1.0")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "Remove" })).toBeInTheDocument();
  });

  it("an older install offers the update, which replaces the copy", async () => {
    db.st.installed.zig = { version: "1.0.0", edited: false };
    const user = userEvent.setup();
    open("#/plugins/stacks/zig");
    await user.click(await screen.findByRole("button", { name: "Update to 1.1.0" }));
    const dlg = await screen.findByRole("dialog", { name: "Update Zig to 1.1.0?" });
    await user.click(within(dlg).getByRole("button", { name: "Update to 1.1.0" }));
    await waitFor(() => expect(calls("POST", "/api/projects/ludus-engine/stacks/market/install")[0]?.body).toEqual({ name: "zig", version: "1.1.0", replace: true }));
  });
});
