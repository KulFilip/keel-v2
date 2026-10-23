// 0.18.42 KeelBot in a narrow column (the panel beside the code, 300-480 px): nothing in it may be wider than the panel.
// The bug: a grid box with the implicit `auto` column (.hp-msg, .kb-tools) grew to its longest unbreakable line (a nowrap
// chip with a long path, the folded tool call's command), so the message was wider than the panel, the conversation
// scrolled sideways and a swipe cut every line on the left. jsdom has no layout, so the CSS rules that prevent it are
// checked here, and a chat with long unbroken words is rendered to check those words sit in boxes these rules cover.
// The real layout was measured in Chromium at 300-900 px (scrollWidth == clientWidth for the panel and the transcript).

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { render, screen, within } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { HelperSession } from "@keel/web-sdk";
import { App } from "../../../../web/src/App";
import { db } from "../../../../web/src/test/setup";

const css = readFileSync(
  resolve(process.cwd(), "../plugins/keelbot/web/helper.css"),
  "utf8",
);

type Rule = { selectors: string[]; decls: Record<string, string> };
/** The innermost rules of the stylesheet (rules inside @media too), comments removed. */
function rules(text: string): Rule[] {
  const out: Rule[] = [];
  for (const m of text
    .replace(/\/\*[\s\S]*?\*\//g, "")
    .matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decls: Record<string, string> = {};
    for (const d of m[2].split(";")) {
      const i = d.indexOf(":");
      if (i > 0) decls[d.slice(0, i).trim()] = d.slice(i + 1).trim();
    }
    out.push({
      selectors: m[1]
        .split(",")
        .map((s) => s.trim())
        .filter(Boolean),
      decls,
    });
  }
  return out;
}
const all = rules(css);
const declsOf = (sel: string) =>
  Object.assign(
    {},
    ...all.filter((r) => r.selectors.includes(sel)).map((r) => r.decls),
  ) as Record<string, string>;
/** The single-class selectors that make a grid box without saying how wide its columns are. */
const gridBoxes = [
  ...new Set(
    all.filter((r) => r.decls.display === "grid").flatMap((r) => r.selectors),
  ),
]
  .filter((s) => /^\.[\w-]+( li)?$/.test(s))
  .filter(
    (s) =>
      !declsOf(s)["grid-template-columns"] ||
      declsOf(s)["grid-template-columns"] !== "minmax(0, 1fr)",
  )
  .filter(
    (s) =>
      !all.some(
        (r) =>
          r.selectors.includes(s) &&
          (r.decls["grid-template-columns"] || r.decls["grid-template-areas"]),
      ),
  );

describe("KeelBot in a narrow column: the CSS", () => {
  it("gives every grid box one column as wide as the box, so a long unbreakable line cannot widen it", () => {
    expect(gridBoxes).toEqual([]);
    for (const s of [
      ".hp-msg",
      ".kb-tools",
      ".hp-steps",
      ".hp-files",
      ".hp-files li",
      ".kb-card",
      ".hp-changes",
      ".hp-perm",
    ]) {
      expect(declsOf(s)["grid-template-columns"], s).toBe("minmax(0, 1fr)");
    }
  });

  it("aligns the person's message to the right without letting it overflow to the left", () => {
    const user = declsOf(".hp-user");
    expect(user["justify-self"]).toBe("safe end");
    expect(user["max-width"]).toBe("92%");
    expect(user["min-width"]).toBe("0");
    // an end alignment that is not `safe` pushes what does not fit off the left edge, where it cannot be scrolled to
    for (const r of all) {
      for (const p of [
        "justify-content",
        "justify-self",
        "align-self",
        "align-items",
        "justify-items",
      ]) {
        const v = r.decls[p];
        if (v && /(^|\s)(flex-)?end$/.test(v))
          expect(v, `${r.selectors.join(", ")} { ${p} }`).toMatch(/^safe /);
      }
    }
  });

  it("wraps long words in the messages and answers, and shrinks the header rows instead of pushing them out", () => {
    for (const s of [
      ".hp-text",
      ".hp-answer",
      ".hp-thinking-text",
      ".hp-meta",
      ".kb-tools-log",
    ]) {
      expect(declsOf(s)["overflow-wrap"], s).toBe("anywhere");
    }
    for (const s of [
      ".hp-msg",
      ".hp-answer",
      ".kb-tools",
      ".kb-tools-head",
      ".hp-cur",
      ".hp-cur-t",
      ".hp-usage",
      ".hp-mode",
      ".hp-file-name",
    ]) {
      expect(declsOf(s)["min-width"], s).toBe("0");
    }
    expect(declsOf(".hp-head")["flex-wrap"]).toBe("wrap");
    expect(declsOf(".hp-title")["flex-wrap"]).toBe("wrap");
    expect(declsOf(".hp-tools")["flex-wrap"]).toBe("wrap");
    expect(declsOf(".hp-mode")["text-overflow"]).toBe("ellipsis");
    expect(declsOf(".hp-usage")["text-overflow"]).toBe("ellipsis");
    expect(declsOf(".hp-chip")["max-width"]).toBe("100%");
    expect(declsOf(".kb-tools-btn")["max-width"]).toBe("100%");
  });
});

describe("KeelBot in a narrow column: a chat with long unbroken words", () => {
  const PID = "ludus-engine";
  const WORD = "MessengerKeepsStoredTest".repeat(4);
  const PATH = `app/src/test/java/com/example/messenger/storage/${WORD}.kt`;

  function chat(): HelperSession {
    const at = new Date().toISOString();
    return {
      id: "h_1",
      project: PID,
      root: "/workspace",
      mode: "edit",
      title: "what do you think about the failing messenger tests",
      model: {
        provider: "copilot",
        mode: "subscription",
        model: "claude-sonnet-4.5",
      },
      status: "idle",
      tokens_in: 300000,
      tokens_out: 11300,
      tokens_cached: 0,
      cost_usd: 1.76,
      turns: 1,
      created_at: at,
      updated_at: at,
      busy: false,
      folder: null,
      messages: [
        {
          n: 1,
          role: "user",
          text: `Why does ${PATH} fail? see Messenger/${WORD}`,
          at,
          data: {
            selection: { path: PATH, from: 10, to: 20 },
            mentions: [{ kind: "file", value: PATH }],
          } as never,
        },
        {
          n: 2,
          role: "helper",
          call_id: "c-1",
          at,
          text: `● cd app && grep -rn ${WORD} .\n  └ 220 lines...\n\nThe test \`insert(" (tests)\` fails because ${WORD} exists in this repo.`,
          data: {
            status: "done",
            provider: "copilot",
            model: "claude-sonnet-4.5",
            tokens_in: 12000,
            tokens_out: 3000,
            cost_usd: 0.04,
            ms: 4200,
          },
        },
      ],
    } as HelperSession;
  }

  it("keeps every long word whole, inside boxes whose grid columns are bound to the panel", async () => {
    db.helper.sessions = [chat()];
    localStorage.setItem(`keel2.helper.${PID}.session`, "h_1");
    localStorage.setItem("keel2.repo.helper", "true");
    location.hash = "#/repo";
    render(<App />);
    const p = await screen.findByRole("complementary", { name: "KeelBot" });
    await within(p).findByText(/exists in this repo/);

    const bubble = p.querySelector(".hp-msg.hp-user")!;
    expect(bubble.querySelector(".hp-text")).toHaveTextContent(
      `Why does ${PATH} fail? see Messenger/${WORD}`,
    );
    const chips = [...bubble.querySelectorAll(".hp-chip")].map(
      (c) => c.textContent,
    );
    expect(chips).toEqual([`${PATH}:10-20`, `@${PATH}`]);
    expect(p.querySelector(".kb-tools .kb-tools-head")?.textContent).toContain(
      "Ran 1 shell command",
    );
    expect(p.querySelector(".hp-answer")).toHaveTextContent(
      `fails because ${WORD} exists`,
    );

    // every box on the way from the transcript down to a long word is either a grid box bound to the panel, or a box
    // the CSS lets shrink (min-width: 0 / overflow-wrap / ellipsis); none is a grid box with a free `auto` column
    const body = p.querySelector(".hp-body")!;
    const bound = new Set(
      all
        .filter((r) => r.decls["grid-template-columns"] === "minmax(0, 1fr)")
        .flatMap((r) => r.selectors),
    );
    const grids = new Set(
      all.filter((r) => r.decls.display === "grid").flatMap((r) => r.selectors),
    );
    for (const leaf of [
      bubble.querySelector(".hp-text")!,
      ...bubble.querySelectorAll(".hp-chip"),
      p.querySelector(".kb-tools-head")!,
    ]) {
      for (
        let el: Element | null = leaf;
        el && el !== body;
        el = el.parentElement
      ) {
        for (const c of el.classList)
          if (grids.has(`.${c}`))
            expect(bound.has(`.${c}`), `.${c} around "${leaf.className}"`).toBe(
              true,
            );
      }
    }
  }, 20000);
});
