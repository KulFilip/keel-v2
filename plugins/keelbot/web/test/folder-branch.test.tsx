// keel 0.18.57 a flow on its own branch checks it out in the project folder an Ask or Edit chat reads: the chat shows
// a banner ("a flow switched this folder to <branch> at <time>"), from the switch the engine stored with the answer, or
// live when the folder's branch (the session's folder_branch) differs from the one the last answer read.

import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HelperMessage, HelperSession } from "@keel/web-sdk";
import { App } from "../../../../web/src/App";
import { db } from "../../../../web/src/test/setup";
import { folderBanner } from "../model";

const PID = "ludus-engine";
const at = new Date().toISOString();

function chat(
  messages: HelperMessage[],
  extra: Partial<HelperSession> = {},
): HelperSession {
  return {
    id: "h_b",
    project: PID,
    root: "/workspace",
    mode: "ask",
    title: "Cart total",
    model: { provider: "claude", mode: "subscription", model: "sonnet" },
    status: "idle",
    tokens_in: 0,
    tokens_out: 0,
    tokens_cached: 0,
    cost_usd: 0,
    turns: 1,
    created_at: at,
    updated_at: at,
    busy: false,
    messages,
    folder: null,
    ...extra,
  };
}
const q = (n: number): HelperMessage => ({
  n,
  role: "user",
  text: "Where is the total?",
  data: {},
  at,
});
const a = (n: number, data: HelperMessage["data"]): HelperMessage => ({
  n,
  role: "helper",
  text: "In cart.js.",
  data: { status: "done", ...data },
  at,
});

describe("the folder's branch in a KeelBot chat", () => {
  it("knows a switch before the answer, during it, and one that came after it", () => {
    const sw = { from: "main", to: "feat/euro-prices", at, by: "Euro prices" };
    expect(
      folderBanner({ folder_branch: "main" }, [
        q(1),
        a(2, { folder_branch: "main" }),
      ]),
    ).toBeNull();
    expect(
      folderBanner({ folder_branch: "feat/euro-prices" }, [
        q(1),
        a(2, { folder_branch: "feat/euro-prices", branch_switch: sw }),
      ]),
    ).toEqual({
      kind: "switched",
      to: "feat/euro-prices",
      from: "main",
      at,
      by: "Euro prices",
    });
    expect(
      folderBanner({}, [
        q(1),
        a(2, { folder_branch: "main", branch_switch: { ...sw, during: true } }),
      ])?.kind,
    ).toBe("during");
    expect(
      folderBanner({ folder_branch: "feat/euro-prices" }, [
        q(1),
        a(2, { folder_branch: "main" }),
      ]),
    ).toEqual({ kind: "live", to: "feat/euro-prices", from: "main" });
    expect(folderBanner({ folder_branch: "x" }, [q(1)])).toBeNull();
  });

  it("shows the banner in the chat", async () => {
    db.helper.sessions = [
      chat(
        [
          q(1),
          a(2, {
            folder_branch: "feat/euro-prices",
            branch_switch: {
              from: "main",
              to: "feat/euro-prices",
              at,
              by: "Euro prices",
            },
          }),
        ],
        { folder_branch: "feat/euro-prices" },
      ),
    ];
    localStorage.setItem(`keel2.helper.${PID}.session`, "h_b");
    location.hash = "#/keelbot";
    render(<App />);
    const banner = await screen.findByTestId("hp-branch");
    expect(banner).toHaveTextContent(
      /A flow switched this folder to feat\/euro-prices at .*\(“Euro prices”\)/,
    );
    expect(within(banner).getByText("feat/euro-prices")).toBeInTheDocument();
  });
});
