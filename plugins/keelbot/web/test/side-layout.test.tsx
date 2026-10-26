// A Side chat's marks never use keel's own layout classes. KeelBot marked a Side chat with a bare `side` class (the mode
// badge "Side · <id>", the side bar with Make a task / Start a flow on the branch / Throw away, the chat list's "Side"
// tag), and `.side` is keel's menu column (web/src/styles.css: display flex, position sticky, height 100vh). So the badge
// was a window-high bar, the chat row grew to the list's height and the three buttons were ~300 px tall boxes. Measured in
// Chromium at 1440x900: the badge and the chat tag 900 px high, the side bar 344 px; with .hp-side 14, 12 and 87 px.
// jsdom has no layout, so the rules are checked here: keel's classes that size or place a box are never on KeelBot's
// elements, and helper.css styles a Side chat with its own .hp-side.

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { App } from "../../../../web/src/App";
import { db } from "../../../../web/src/test/setup";

const WEB = join(process.cwd(), "src");
const read = (...p: string[]) => readFileSync(join(...p), "utf8");
const cssIn = (dir: string) =>
  readdirSync(dir)
    .filter((f) => f.endsWith(".css"))
    .map((f) => read(dir, f));
/** keel's own stylesheets (not the plugins'). */
const coreCss = [
  read(WEB, "styles.css"),
  ...cssIn(join(WEB, "styles")),
  ...cssIn(join(WEB, "components")),
].join("\n");
const helperCss = read(process.cwd(), "../plugins/keelbot/web/helper.css");

type Rule = { selectors: string[]; decls: Record<string, string> };
/** The innermost rules (those inside @media too), comments removed. */
function rules(text: string): Rule[] {
  return [
    ...text.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/([^{}]+)\{([^{}]*)\}/g),
  ].map((m) => ({
    selectors: m[1]
      .split(",")
      .map((s) => s.trim())
      .filter(Boolean),
    decls: Object.fromEntries(
      m[2]
        .split(";")
        .map((d) => [
          d.slice(0, d.indexOf(":")).trim(),
          d.slice(d.indexOf(":") + 1).trim(),
        ])
        .filter(([k]) => k),
    ),
  }));
}

/** keel's classes whose bare rule (`.x { … }`) sizes the box to the window or pins it: a page part, never a modifier. */
const layoutClasses = new Set(
  rules(coreCss)
    .filter(
      (r) =>
        /\b\d+(d|s|l)?vh\b/.test(
          `${r.decls.height ?? ""} ${r.decls["min-height"] ?? ""}`,
        ) || /^(sticky|fixed)$/.test(r.decls.position ?? ""),
    )
    .flatMap((r) => r.selectors)
    .map((s) => /^\.([\w-]+)$/.exec(s)?.[1])
    .filter((c): c is string => !!c),
);

const panel = () => screen.findByRole("complementary", { name: "KeelBot" });
const usedClasses = (root: Element) =>
  [root, ...root.querySelectorAll("*")].flatMap((e) => [...e.classList]);

describe("KeelBot's Side chat keeps its own size (no keel layout class on it)", () => {
  it("helper.css marks a Side chat with .hp-side, never keel's .side", () => {
    expect(layoutClasses.has("side")).toBe(true); // keel's menu column: height 100vh, sticky
    const selectors = rules(helperCss).flatMap((r) => r.selectors);
    for (const cls of layoutClasses) {
      expect(
        selectors.filter((s) => new RegExp(`\\.${cls}(?![\\w-])`).test(s)),
        `helper.css uses .${cls}`,
      ).toEqual([]);
    }
    expect(selectors).toEqual(
      expect.arrayContaining([
        ".hp-mode.hp-side",
        ".hp-fixbar.hp-side",
        ".hp-chat-mode.hp-side",
      ]),
    );
    // none of these may grow: no height, no flex grow, no stretch
    for (const sel of [
      ".hp-mode",
      ".hp-fixbar",
      ".hp-perm-btns",
      ".hp-chat-mode",
      ".hp-chat-row",
    ]) {
      const d = Object.assign(
        {},
        ...rules(helperCss)
          .filter((r) => r.selectors.includes(sel))
          .map((r) => r.decls),
      ) as Record<string, string>;
      expect(d.height, sel).toBeUndefined();
      expect(d.flex ?? "", sel).not.toMatch(/^1\b/);
      expect(d["align-self"] ?? "", sel).not.toBe("stretch");
    }
  });

  it("the side bar, its three buttons, the mode badge and the chat list's tag carry no keel layout class", async () => {
    const user = userEvent.setup();
    db.flows["ludus-engine"].thread!.status = "done"; // no flow waits: Side needs none
    location.hash = "#/repo";
    localStorage.setItem("keel2.repo.helper", "true");
    render(<App />);
    const p = await panel();
    await user.click(within(p).getByRole("button", { name: "Side" }));
    await user.type(
      within(p).getByRole("textbox", { name: "Ask KeelBot" }),
      "Try a cart discount{Enter}",
    );
    await waitFor(() => expect(db.helper.sessions).toHaveLength(1));

    const badge = await within(p).findByText("Side · 1");
    expect([...badge.classList]).toEqual(["hp-mode", "hp-side"]);
    const intro = await within(p).findByText(/in its own copy of the project/);
    expect(within(intro).getByText("keel/helper/1")).toBeInTheDocument();
    const bar = intro.closest(".hp-fixbar")!;
    expect([...bar.classList]).toEqual(["hp-fixbar", "hp-side"]);
    const btns = within(bar as HTMLElement)
      .getAllByRole("button")
      .map((b) => b.textContent);
    expect(btns).toEqual([
      "Make a task",
      "Start a flow on the branch",
      "Throw away",
    ]);

    await user.click(within(p).getByRole("button", { name: /^Chats/ }));
    const tag = await within(p).findByText("Side", {
      selector: ".hp-chat-mode",
    });
    expect([...tag.classList]).toEqual(["hp-chat-mode", "hp-side"]);

    const clash = usedClasses(p).filter((c) => layoutClasses.has(c));
    expect(clash).toEqual([]);
  });
});
