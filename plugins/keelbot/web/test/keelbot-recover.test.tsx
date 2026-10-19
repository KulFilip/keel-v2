// keel 0.18.18 the dashboard's permission card: the warning (the command throws work away, a flow works in this
// folder) and what Always keeps (the command's family); no Always for a command that is asked every time.

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { PermissionCard } from "../FixParts";

const q = { id: "p1", session: "h_1", project: "demo", kind: "command", title: "chat", at: "x" };

describe("KeelBot's permission card", () => {
  it("names the family Always keeps", () => {
    render(<PermissionCard pid="demo" q={{ ...q, command: "git checkout main", always: "git checkout *" }} onAnswered={() => {}} />);
    expect(screen.getByRole("button", { name: "Always: git checkout *" })).toBeTruthy();
    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("warns, and has no Always, for a command that throws work away", () => {
    render(<PermissionCard pid="demo" q={{ ...q, command: "git reset --hard", always: "",
      warning: "git reset --hard throws away every uncommitted change in the folder; it cannot be undone." }} onAnswered={() => {}} />);
    expect(screen.getByRole("alert").textContent).toContain("cannot be undone");
    expect(screen.queryByRole("button", { name: /Always/ })).toBeNull();
    expect(screen.getByRole("button", { name: "Deny" })).toBeTruthy();
  });
});
