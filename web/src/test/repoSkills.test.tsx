// keel 0.18.57 Skill hub › Found in the repo: the instructions and skills the repo keeps for coding agents (AGENTS.md,
// .claude/skills, .opencode/skills), found at init and at a knowledge refresh. It says how many, which agents load them,
// and turns them off and on; a repo skill's text is changed in the repo, so its drawer shows it read-only.

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { http, HttpResponse } from "msw";
import { describe, expect, it } from "vitest";
import { App } from "../App";
import type { RepoSkills, Skill } from "../api";
import * as fx from "./fixtures";
import { db, server } from "./setup";

const main = () => within(document.getElementById("main")!);
const fixtures: Skill = {
  id: "shop-fixtures",
  kind: "testing",
  source: "repo",
  stack: "any",
  version: "repo",
  tokens: 120,
  agents: ["test-author", "implementer"],
  when: "tests",
  enabled: true,
  about: "How shop builds its test data.",
};
const glossary: Skill = {
  ...fixtures,
  id: "shop-glossary",
  kind: "knowledge",
  agents: [],
  when: "on demand",
  about: "The words the shop team uses.",
};
const found = (on: boolean): RepoSkills => ({
  on,
  found_at: "2026-10-26T10:00:00Z",
  docs: [
    { path: "AGENTS.md", title: "Agent guide for shop" },
    { path: "CLAUDE.md", title: "Read AGENTS.md first." },
  ],
  skills: [
    {
      id: "shop-fixtures",
      name: "shop-fixtures",
      path: ".claude/skills/shop-fixtures/SKILL.md",
      about: fixtures.about!,
      use: "tests",
      why: 'AGENTS.md: "Load the skill shop-fixtures when writing tests."',
      agents: ["test-author", "implementer"],
    },
    {
      id: "shop-glossary",
      name: "shop-glossary",
      path: ".opencode/skills/shop-glossary/SKILL.md",
      about: glossary.about!,
      use: null,
      why: "",
      agents: [],
    },
  ],
  attached: on ? ["test-author", "implementer"] : [],
});

function repoApi() {
  let on = true;
  const seen: string[] = [];
  server.use(
    http.get("/api/projects/:pid/skills", () =>
      HttpResponse.json(on ? [...fx.skills, fixtures, glossary] : fx.skills),
    ),
    http.get("/api/projects/:pid/skills/repo", () =>
      HttpResponse.json(found(on)),
    ),
    http.put("/api/projects/:pid/skills/repo", async ({ request }) => {
      const b = (await request.json()) as { on: boolean };
      db.calls.push({
        method: "PUT",
        path: new URL(request.url).pathname,
        body: b,
      });
      on = b.on;
      return HttpResponse.json(found(on));
    }),
    http.get("/api/skills/:sid", ({ request, params }) => {
      seen.push(new URL(request.url).search);
      return HttpResponse.json({
        ...fixtures,
        id: String(params.sid),
        body: "---\nname: shop-fixtures\n---\n# Fixtures\n- Build orders with OrderFactory.",
        refs: [],
      });
    }),
  );
  return seen;
}

describe("Skill hub › Found in the repo", () => {
  it("says what the repo keeps for coding agents and which agents load its skills", async () => {
    repoApi();
    location.hash = "#/skills";
    render(<App />);
    const box = await main().findByRole("region", {
      name: "Found in the repo",
    });
    await waitFor(() =>
      expect(box).toHaveTextContent(
        "Found in the repo: 2 skills, 2 docs · attached to: test-author, implementer",
      ),
    );
    expect(box).toHaveTextContent("shop-fixtures");
    expect(box).toHaveTextContent("for tests");
    expect(box).toHaveTextContent(".claude/skills/shop-fixtures/SKILL.md");
    expect(box).toHaveTextContent("shop-glossary");
    expect(box).toHaveTextContent("on no agent");
    expect(box).toHaveTextContent("AGENTS.md");
    // the table lists them under their own source
    await userEvent.click(main().getByRole("tab", { name: /from the repo/ }));
    const table = main().getByRole("table", { name: "Skills" });
    expect(
      within(table).getByRole("button", { name: "shop-fixtures" }),
    ).toBeInTheDocument();
    expect(
      within(table).queryByRole("button", { name: "web-testing" }),
    ).toBeNull();
  });

  it("turns them off and on", async () => {
    repoApi();
    location.hash = "#/skills";
    render(<App />);
    const box = await main().findByRole("region", {
      name: "Found in the repo",
    });
    const sw = await within(box).findByRole("checkbox", {
      name: "Load the repo's skills for their agents",
    });
    expect(sw).toBeChecked();
    await userEvent.click(sw);
    await waitFor(() =>
      expect(
        db.calls
          .filter(
            (c) =>
              c.method === "PUT" &&
              c.path === "/api/projects/ludus-engine/skills/repo",
          )
          .at(-1)?.body,
      ).toEqual({ on: false }),
    );
    await waitFor(() =>
      expect(box).toHaveTextContent("Off: listed here, loaded by no agent."),
    );
    expect(
      within(box).getByRole("checkbox", {
        name: "Load the repo's skills for their agents",
      }),
    ).not.toBeChecked();
    await waitFor(() =>
      expect(
        main().queryByRole("button", { name: "shop-fixtures" }),
      ).toBeNull(),
    );
  });

  it("a repo skill's text is shown read-only, read from the repo", async () => {
    const seen = repoApi();
    location.hash = "#/skills";
    render(<App />);
    await userEvent.click(
      await main().findByRole("button", { name: "shop-fixtures" }),
    );
    const drawer = await screen.findByRole("dialog", { name: "shop-fixtures" });
    const body = await within(drawer).findByLabelText("SKILL.md");
    expect(body).toHaveAttribute("readonly");
    expect(drawer).toHaveTextContent(
      "This skill lives in the repo: change it there.",
    );
    expect(seen.at(-1)).toBe("?project=ludus-engine");
  });
});
