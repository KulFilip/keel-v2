// keel 0.18.56 the step panel ("What <step> does") is never wider than its column: one long path in the prompt made the
// whole panel wide and it was cut on both sides. Every grid child that holds text may shrink, long words break anywhere,
// the facts stack under their labels in a narrow panel, the title gets an ellipsis, and the prompt sits in a box that
// wraps, scrolls down inside and has a Copy button. The same in the drawer (narrow screens, the init flow).

import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { http, HttpResponse } from "msw";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { StepExplanation } from "../api";
import { App } from "../App";
import { StepInfoBody } from "../components/StepInfo";
import { server } from "./setup";
import { openShopFlow } from "./shopFlow";

const SRC = path.join(path.dirname(fileURLToPath(import.meta.url)), "..");
const css = fs.readFileSync(path.join(SRC, "styles.css"), "utf8");

/** The declarations of the first rule whose selector is exactly `sel`. */
const rule = (sel: string) => {
  const at = css.indexOf(`\n${sel} {`);
  expect(at, `no rule for ${sel}`).toBeGreaterThanOrEqual(0);
  return css.slice(css.indexOf("{", at) + 1, css.indexOf("}", at));
};

/** Every selector of the rules that set `decl` (outside @media / @container). */
const selectorsWith = (decl: string) =>
  [...css.replace(/\/\*[\s\S]*?\*\//g, "").matchAll(/(?<=^|\})\s*([^{}@]+)\{([^{}]*)\}/g)]
    .filter((m) => m[2].includes(decl))
    .flatMap((m) => m[1].split(",").map((s) => s.trim()));

// 400 characters with no space: a path the browser cannot break at a word
const LONG_PATH =
  `/workspace/shop/${"cart-totals-keep-the-discount/".repeat(13)}CartTotals.kt`.slice(
    0,
    400,
  );
const LONG_LINE = `Read ${LONG_PATH} first, then https://docs.example.com/${"shop/".repeat(40)}cart and keep going on one line ${"without a break ".repeat(20)}`;
const PROMPT = `You are the explorer of project shop.\n${LONG_LINE}\n${"Review: a factory may fit here. ".repeat(30)}`;

const shopStep = (
  over: Partial<StepExplanation["agent"]> = {},
): StepExplanation =>
  ({
    id: "spec",
    name: "spec",
    kind: "agent",
    phase: "spec",
    phase_meaning: "the spec is written",
    thread: true,
    rules: { phase: "spec", buckets: [], shell_refused: [] },
    next: [{ label: "next", to: "spec_gate", to_name: "spec approval" }],
    last_runs: {
      count: 1,
      runs: [
        {
          checkpoint: "c1",
          at: "2026-10-17T10:00:00Z",
          note: "wrote the spec",
          ok: true,
          output: LONG_LINE,
        },
      ],
    },
    agent: {
      id: "explorer",
      custom: false,
      about: `Maps ${LONG_PATH} and the code it touches.`,
      instructions: `Write the spec for the cart. Cite ${LONG_PATH}.`,
      model: {
        step: "default",
        rule: "the step's model, else the agent's",
        now: { provider: "claude", model: "claude-sonnet-4-5", effort: "high" },
      },
      max_turns: 40,
      knowledge: {
        sections: [
          "architecture",
          "domain",
          "conventions",
          "data",
          "integrations",
        ],
        code_graph: true,
        memory: true,
      },
      markers: [],
      prompt: PROMPT,
      placeholders: false,
      system: `You map code. ${LONG_PATH}`,
      ...over,
    },
  }) as unknown as StepExplanation;

const setClipboard = (v: unknown) =>
  Object.defineProperty(navigator, "clipboard", {
    value: v,
    configurable: true,
  });
const realMatchMedia = window.matchMedia;

afterEach(() => {
  setClipboard(undefined);
  window.matchMedia = realMatchMedia;
  vi.restoreAllMocks();
});

describe("Step panel overflow: the CSS", () => {
  it("lets every grid child of the side panel, the drawer and the explanation shrink below its longest word", () => {
    expect(rule(".fl-side")).toMatch(/min-width: 0/);
    const shrink = selectorsWith("min-width: 0");
    for (const sel of [
      ".fl-side > *",
      ".fl-side .grid > *",
      ".drawer .body > *",
      ".drawer .body .grid > *",
      ".xbody > *",
      ".xsec > *",
      ".xrun > *",
      ".xprompt > *",
      ".fl-about > *",
      ".panel",
      ".md",
      ".prebox",
    ]) {
      expect(shrink, `${sel} has min-width: 0`).toContain(sel);
    }
  });

  it("breaks long words, paths and URLs anywhere in the explanation and the step's few words", () => {
    const wrap = selectorsWith("overflow-wrap: anywhere");
    for (const sel of [
      ".xbody",
      ".fl-about",
      ".xkv dd",
      "pre.prebox-pre",
      ".md",
    ])
      expect(wrap, `${sel} wraps anywhere`).toContain(sel);
  });

  it("shows the facts as label | value columns that stack only in a very narrow panel", () => {
    expect(rule(".xkv")).toMatch(
      /grid-template-columns: max-content minmax\(0, 1fr\)/,
    );
    expect(rule(".xkv dd")).toMatch(/min-width: 0;.*overflow-wrap: anywhere/);
    // the panel's own width decides (a container query), not the window's
    expect(rule(".xbody")).toMatch(/container-type: inline-size/);
    const narrow = css.match(
      /@container \(max-width: (\d+)px\) \{([\s\S]*?)\n\}/,
    );
    expect(narrow, "a container query for a narrow panel").not.toBeNull();
    // side by side in the desktop side column (320-400px): stack only at 300px or less (a phone, a very narrow drawer)
    expect(Number(narrow![1])).toBe(300);
    // the value column may shrink and its long words wrap, so side by side never widens the panel
    expect(rule(".xkv dd")).toMatch(/min-width: 0/);
    expect(selectorsWith("overflow-wrap: anywhere")).toEqual(expect.arrayContaining([".xkv dd", ".xbody"]));
    expect(narrow![2]).toMatch(
      /\.xkv \{ grid-template-columns: minmax\(0, 1fr\)/,
    );
  });

  it("wraps the prompt box, scrolls it down inside and never sideways", () => {
    const pre = rule("pre.prebox-pre");
    expect(pre).toMatch(/white-space: pre-wrap/);
    expect(pre).toMatch(/overflow-wrap: anywhere/);
    expect(pre).toMatch(/max-height: \d+px/);
    expect(pre).toMatch(/overflow-y: auto/);
    expect(pre).toMatch(/overflow-x: hidden/);
    // still monospace: pre.head gives the font
    expect(rule("pre.head")).toMatch(/var\(--f-mono\)/);
  });

  it("cuts the panel's and the drawer's title with an ellipsis instead of clipping it", () => {
    const title = rule(".step-panel > .panel-head h2, .step-drawer header h2");
    expect(title).toMatch(/min-width: 0/);
    expect(title).toMatch(/overflow: hidden/);
    expect(title).toMatch(/text-overflow: ellipsis/);
    expect(title).toMatch(/white-space: nowrap/);
  });
});

describe("Step panel overflow: the explanation", () => {
  it("puts a 400-character path and a long prompt into wrapping boxes", async () => {
    expect(LONG_PATH).toHaveLength(400);
    const { container } = render(<StepInfoBody x={shopStep()} />);
    const body = container.querySelector(".xbody")!;
    expect(body).not.toBeNull();
    // the long path is in the text of the explanation, which wraps anywhere
    expect(
      within(body as HTMLElement).getAllByText(
        new RegExp(LONG_PATH.slice(0, 60)),
      ).length,
    ).toBeGreaterThan(0);
    const facts = screen.getByTestId("explain-facts");
    expect(facts).toHaveClass("xkv");
    expect([...facts.querySelectorAll("dt")].map((d) => d.textContent)).toEqual(
      ["Agent", "Model", "Turns at most", "Knowledge"],
    );

    const prompt = screen.getByTestId("explain-prompt");
    expect(prompt.tagName).toBe("PRE");
    expect(prompt).toHaveClass("head", "prebox-pre");
    expect(prompt.textContent).toBe(PROMPT);
    expect(prompt).toHaveAccessibleName("The prompt keel sends");
    expect(prompt).toHaveAttribute("tabindex", "0"); // a box that scrolls can be scrolled with the keyboard
    expect(prompt.closest(".prebox")?.parentElement).toHaveClass("xprompt");
    // the system prompt and the last run's output use the same box
    const pres = [...container.querySelectorAll("pre")];
    expect(pres.length).toBe(3);
    for (const p of pres) expect(p).toHaveClass("prebox-pre");
    expect(
      within(container as HTMLElement).getByRole("group", {
        name: "What the step printed",
      }).textContent,
    ).toBe(LONG_LINE);
  });

  it("copies the whole prompt with Copy", async () => {
    const user = userEvent.setup();
    const writeText = vi.fn().mockResolvedValue(undefined);
    setClipboard({ writeText });
    render(<StepInfoBody x={shopStep()} />);
    await user.click(
      screen.getByRole("button", { name: "Copy the prompt keel sends" }),
    );
    expect(writeText).toHaveBeenCalledWith(PROMPT);
    expect(await screen.findByRole("status")).toHaveTextContent("Copied.");
  });
});

describe("Step panel overflow: on the Flow page", () => {
  // "interview" is not the step that runs now, so the panel opens on its details
  const longExplain = () =>
    server.use(
      http.post("/api/projects/shop/workflows/explain-step", () =>
        HttpResponse.json({ ...shopStep(), id: "interview", name: "interview" }),
      ),
    );

  it("the side panel carries step-panel (min-width, ellipsis) and its full title as a tooltip", async () => {
    openShopFlow();
    longExplain();
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /^interview, agent/ }),
    );
    const panel = await screen.findByRole("region", { name: "What interview does" });
    expect(panel).toHaveClass("panel", "step-panel");
    expect(panel.closest(".fl-side")).not.toBeNull();
    const h2 = within(panel).getByRole("heading", { level: 2 });
    expect(h2).toHaveAttribute("title", "What interview does");
    await waitFor(() =>
      expect(within(panel).getByTestId("explain-prompt")).toHaveClass(
        "prebox-pre",
      ),
    );
    expect(panel.querySelector(".xbody")).not.toBeNull();
  });

  it("the drawer on a narrow screen carries step-drawer and the same wrapping prompt box", async () => {
    window.matchMedia = ((q: string) => ({
      matches: q.includes("max-width: 1099px"),
      media: q,
      addEventListener() {},
      removeEventListener() {},
      onchange: null,
    })) as unknown as typeof window.matchMedia;
    openShopFlow();
    longExplain();
    const user = userEvent.setup();
    render(<App />);
    await user.click(
      await screen.findByRole("button", { name: /^interview, agent/ }),
    );
    const dlg = await screen.findByRole("dialog", { name: "What interview does" });
    expect(dlg).toHaveClass("drawer", "step-drawer");
    expect(within(dlg).getByRole("heading", { level: 2 })).toHaveAttribute(
      "title",
      "What interview does",
    );
    await waitFor(() =>
      expect(within(dlg).getByTestId("explain-prompt")).toHaveClass(
        "prebox-pre",
      ),
    );
  });
});
