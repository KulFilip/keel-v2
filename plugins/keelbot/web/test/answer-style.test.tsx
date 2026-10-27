// 0.18.38 KeelBot's answers, easier to read: "all text is white, it's hard to read". The answer look of keel's Markdown
// (lead-in headings, verdict chips, the Open items note, dimmer "not verified" lines, nested lists), the tool calls
// folded to one line, next steps as buttons, and the new colours' contrast in both themes.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { AskKeelBot } from "@keel/web-sdk";
import { Markdown } from "../../../../web/src/components/Markdown";
import { ToolFold } from "../HelperPanel";
import { QuestionsCard } from "../QuestionsCard";
import { splitToolLog, toolSummary } from "../toolLog";

const md = (text: string, answer = true) =>
  render(
    <div className="kb-md">
      <Markdown text={text} breaks answer={answer} />
    </div>,
  ).container;

describe("KeelBot's answer look", () => {
  it("a bold lead-in ending in : or ? at the start of a paragraph is a small heading, with its verdict chip", () => {
    const c = md(
      "**Comment 1: keep `vat_updated_at`?** [valid] Keep the column.\n\n**Comment 2: why raw SQL?** [partly]\nIt is atomic.",
    );
    const heads = c.querySelectorAll("h4.md-lead");
    expect(heads).toHaveLength(2);
    expect(heads[0]).toHaveTextContent("Comment 1: keep vat_updated_at? VALID");
    expect(heads[0].querySelector("code")).toHaveTextContent("vat_updated_at");
    expect(heads[0].querySelector(".md-verdict.valid")).toHaveTextContent(
      "VALID",
    );
    expect(heads[1].querySelector(".md-verdict.partly")).toHaveTextContent(
      "PARTLY",
    );
    expect(c.querySelectorAll("p")[0]).toHaveTextContent(/^Keep the column\.$/);
    expect(c.querySelectorAll("p")[1]).toHaveTextContent(/^It is atomic\.$/);
  });

  it("the lead-in is a heading only at the very start of a paragraph, and a trailing colon goes", () => {
    const c = md(
      "Before **this one:** stays bold.\n\n**Two updates:** a read, then a write.\n\n**Plain bold** text.",
    );
    expect(c.querySelectorAll("h4.md-lead")).toHaveLength(1);
    expect(c.querySelector("h4.md-lead")).toHaveTextContent(/^Two updates$/);
    expect(c.querySelectorAll("p")[0].querySelector("b")).toHaveTextContent(
      "this one:",
    );
    expect(c.querySelectorAll("p")[2].querySelector("b")).toHaveTextContent(
      "Plain bold",
    );
  });

  it("every verdict tag is its own chip, an unknown tag stays text, and a heading may carry a tag too", () => {
    const c = md(
      "**A?** [not valid] x\n\n**B?** [optional] y\n\n**C?** [unclear] z\n\n**D?** [maybe] w\n\n### Comment 4 [OPTIONAL]\n\n### Notes [draft]",
    );
    expect(c.querySelector(".md-verdict.bad")).toHaveTextContent("NOT VALID");
    expect(c.querySelector(".md-verdict.optional")).toHaveTextContent(
      "OPTIONAL",
    );
    expect(c.querySelector(".md-verdict.unclear")).toHaveTextContent("UNCLEAR");
    expect(c.querySelectorAll(".md-verdict")).toHaveLength(4);
    expect(screen.getByText("[maybe] w")).toBeInTheDocument();
    expect(
      c.querySelector("h3.md-tagged .md-verdict.optional"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole("heading", { name: "Notes [draft]" }),
    ).toBeInTheDocument();
  });

  it("a paragraph that starts with Open items: is a note box, with a list right under it", () => {
    const c = md(
      "Done.\n\n**Open items:** The author has not replied yet.\n\nOpen items:\n- raw SQL\n- indexes",
    );
    const notes = screen.getAllByRole("note");
    expect(notes).toHaveLength(2);
    expect(notes[0]).toHaveClass("md-callout");
    expect(notes[0]).toHaveTextContent(
      "Open items The author has not replied yet.",
    );
    expect(notes[1].querySelectorAll("li")).toHaveLength(2);
    expect(c.querySelectorAll(".md-lead")).toHaveLength(0);
  });

  it("only the fixed not-checked sentences are dimmer, from where they start", () => {
    const c = md(
      "I checked all 7 comments. I changed no files.\n\nNot verified: the retry rules.\n\nI did not run EXPLAIN.\n\n" +
        "- MySQL runs it once. Not verified: no EXPLAIN run.\n\nThis is not verified at all.\n\nI think it is fine. `a. Not verified: b`",
    );
    const dim = [...c.querySelectorAll(".md-dim")].map((e) => e.textContent);
    expect(dim).toEqual([
      "I changed no files.",
      "Not verified: the retry rules.",
      "I did not run EXPLAIN.",
      "Not verified: no EXPLAIN run.",
    ]);
    expect(c.querySelectorAll("p")[0]).toHaveTextContent(
      "I checked all 7 comments. I changed no files.",
    );
  });

  it("inline code and file:line links keep their own classes (sand chip, lilac link)", () => {
    const c = md(
      "The guard `vat_updated_at < :marker` is at `DoctrineTrackingSubscriptionRepository.php:68`.",
    );
    expect(c.querySelector("code")).toHaveTextContent(
      "vat_updated_at < :marker",
    );
    expect(c.querySelector(".cite")).toHaveTextContent(
      "DoctrineTrackingSubscriptionRepository.php:68",
    );
    const css = readFileSync(
      resolve(process.cwd(), "../plugins/keelbot/web/helper.css"),
      "utf8",
    );
    expect(css).toMatch(
      /\.kb-md code \{[^}]*color: var\(--kb-code-fg\); background: var\(--kb-code-bg\)/,
    );
    expect(css).toMatch(
      /\.kb-md \.cite, \.kb-md \.mono \{[^}]*color: var\(--kb-path\)/,
    );
    expect(css).toMatch(
      /\.kb-md ul > li::before \{[^}]*color: var\(--kb-bullet\)/,
    );
  });

  it("a list indented under an item is a nested list (in every Markdown, not only answers)", () => {
    for (const answer of [true, false]) {
      const { container, unmount } = render(
        <Markdown
          text={
            "- **Indexes:** worth checking\n  - `tracking_id`\n  - `carrier_id`\n    more words\n- Two updates"
          }
          answer={answer}
        />,
      );
      const top = container.querySelector("ul")!;
      expect(top.querySelectorAll(":scope > li")).toHaveLength(2);
      const sub = top.querySelector(":scope > li > ul")!;
      expect(sub.querySelectorAll("li")).toHaveLength(2);
      expect(sub.querySelectorAll("li")[1]).toHaveTextContent(
        "carrier_id more words",
      );
      unmount();
    }
  });

  it("without `answer` nothing changes: no lead-in heading, chip, note or dim line", () => {
    const c = md(
      "**Comment 1: x?** [valid] y\n\nOpen items: z\n\nI changed no files.",
      false,
    );
    expect(
      c.querySelector(".md-lead, .md-verdict, .md-callout, .md-dim"),
    ).toBeNull();
  });
});

describe("the tool calls at the top of an answer", () => {
  const ANSWER = [
    "● Read migrations (shell)",
    "  │ cat -n migrations/Version20261020000100.php",
    "  └ 151 lines…",
    "",
    "I'll read the repository next.",
    "● sed -n 1,90p src/Repo.php",
    "  └ 45 lines…",
    "● grep -n eta tests/T.php",
    "  └ 4 lines…",
    "",
    "I checked all **7 review comments**.",
  ].join("\n");

  it("are split off and summed up in one line", () => {
    const log = splitToolLog(ANSWER)!;
    expect(log.calls.map((c) => c.lines)).toEqual([151, 45, 4]);
    expect(log.rest).toBe("I checked all **7 review comments**.");
    expect(log.log).toContain("I'll read the repository next.");
    expect(toolSummary(log.calls)).toEqual({
      head: "Ran 3 shell commands — Read migrations, sed -n 1,90p src/Repo.php, grep -n eta tests/T.php",
      lines: "151 + 45 + 4 lines",
    });
    expect(
      toolSummary([{ title: "Search (grep) eta", shell: false, lines: null }])
        .head,
    ).toBe("Ran 1 tool call — Search (grep) eta");
  });

  it("count only at the very top; a command for the person, or a log with no answer, stays as it is", () => {
    expect(splitToolLog("Here:\n● sed x\n  └ 4 lines")).toBeNull();
    expect(
      splitToolLog("```bash\n$ git checkout main\n```\nRun it yourself."),
    ).toBeNull();
    expect(splitToolLog("● sed x\n  └ 4 lines")).toBeNull();
    const fence = splitToolLog(
      "```bash\n$ git status --short\n M a.ts\n```\nOne file changed.",
    )!;
    expect(fence.calls).toEqual([
      { title: "git status --short", shell: true, lines: 1 },
    ]);
    expect(fence.rest).toBe("One file changed.");
  });

  it("fold to one button that opens the log and folds it again", () => {
    const log = splitToolLog(ANSWER)!;
    render(<ToolFold calls={log.calls} log={log.log} />);
    const btn = screen.getByRole("button", {
      name: /Ran 3 shell commands — Read migrations/,
    });
    expect(btn).toHaveAttribute("aria-expanded", "false");
    expect(btn).toHaveTextContent("· 151 + 45 + 4 lines ›");
    expect(screen.queryByLabelText("The tool calls as printed")).toBeNull();
    fireEvent.click(btn);
    expect(btn).toHaveAttribute("aria-expanded", "true");
    expect(
      screen.getByLabelText("The tool calls as printed"),
    ).toHaveTextContent("cat -n migrations/Version20261020000100.php");
    fireEvent.click(btn);
    expect(screen.queryByLabelText("The tool calls as printed")).toBeNull();
  });
});

describe("KeelBot's next steps", () => {
  const NEXT = JSON.stringify([
    {
      id: "next",
      question: "What next?",
      options: [
        { label: "Draft the replies", recommended: true },
        { label: "Port to the query builder" },
        { label: "Run EXPLAIN" },
      ],
    },
  ]);

  it("one keel-questions question with the id next is a row of buttons: a press sends the pick", () => {
    const ask = vi.fn();
    render(
      <AskKeelBot.Provider value={ask}>
        <QuestionsCard body={NEXT} />
      </AskKeelBot.Provider>,
    );
    const row = screen.getByRole("region", { name: "Next steps" });
    expect(row).toHaveTextContent("Next — KeelBot can");
    expect(
      screen.getByRole("button", { name: "Draft the replies" }),
    ).toHaveClass("primary");
    fireEvent.click(screen.getByRole("button", { name: "Run EXPLAIN" }));
    expect(ask).toHaveBeenCalledWith(
      "Answers to your questions:\n1. What next?\n   → Run EXPLAIN",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "You picked: Run EXPLAIN",
    );
    expect(
      screen.queryByRole("button", { name: "Draft the replies" }),
    ).toBeNull();
  });

  it("any other questions keep keel's question form", () => {
    render(
      <AskKeelBot.Provider value={vi.fn()}>
        <QuestionsCard body={NEXT.replace('"next"', '"how"')} />
      </AskKeelBot.Provider>,
    );
    expect(screen.queryByRole("region", { name: "Next steps" })).toBeNull();
    expect(screen.getByRole("button", { name: "Send" })).toBeInTheDocument();
  });

  it("0.18.61 one question with one answer: a click on an option sends it, no Send step", () => {
    const ask = vi.fn();
    render(
      <AskKeelBot.Provider value={ask}>
        <QuestionsCard body={NEXT.replace('"next"', '"how"')} />
      </AskKeelBot.Provider>,
    );
    fireEvent.click(screen.getByRole("radio", { name: /Run EXPLAIN/ }));
    expect(ask).toHaveBeenCalledTimes(1);
    expect(ask).toHaveBeenCalledWith(
      "Answers to your questions:\n1. What next?\n   → Run EXPLAIN",
    );
    expect(screen.getByRole("status")).toHaveTextContent(
      "Your answers went to KeelBot:",
    );
  });
});

describe("the new colours", () => {
  const css = readFileSync(
    resolve(process.cwd(), "../plugins/keelbot/web/helper.css"),
    "utf8",
  );
  const core = readFileSync(
    resolve(process.cwd(), "src/styles.css"),
    "utf8",
  );
  const vars = (block: string) =>
    Object.fromEntries(
      [...block.matchAll(/--([\w-]+):\s*(#[0-9a-f]{6})/gi)].map((m) => [
        m[1],
        m[2],
      ]),
    );
  const blocks = (src: string, name: string) => {
    const light = src.match(
      new RegExp(`:root \\{([^}]*--${name}:[^}]*)\\}`),
    )![1];
    const dark = src.match(
      new RegExp(
        `:root:not\\(\\[data-theme="light"\\]\\) \\{([^}]*--${name}:[^}]*)\\}`,
      ),
    )![1];
    const forced = src.match(
      new RegExp(`:root\\[data-theme="dark"\\] \\{([^}]*--${name}:[^}]*)\\}`),
    )![1];
    return { light: vars(light), dark: vars(dark), forced: vars(forced) };
  };
  const lum = (hex: string) => {
    const [r, g, b] = [1, 3, 5]
      .map((i) => parseInt(hex.slice(i, i + 2), 16) / 255)
      .map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p);
    return (x + 0.05) / (y + 0.05);
  };
  const kb = blocks(css, "kb-text");
  const page = blocks(core, "bg");

  it("the dark theme is the same whether the system or the person picks it", () => {
    expect(kb.forced).toEqual(kb.dark);
  });

  for (const theme of ["light", "dark"] as const) {
    it(`every text colour is at least 4.5:1 on its background (${theme})`, () => {
      const t = kb[theme];
      const bgs = [page[theme].bg, page[theme].panel];
      for (const fg of [
        "kb-text",
        "kb-strong",
        "kb-dim",
        "kb-path",
        "kb-bullet",
        "kb-code-fg",
      ]) {
        for (const bg of bgs)
          expect(ratio(t[fg], bg), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
            4.5,
          );
      }
      const pairs: [string, string][] = [
        ["kb-code-fg", "kb-code-bg"],
        ["kb-valid-fg", "kb-valid-bg"],
        ["kb-partly-fg", "kb-partly-bg"],
        ["kb-bad-fg", "kb-bad-bg"],
        ["kb-neutral-fg", "kb-neutral-bg"],
        ["kb-note-fg", "kb-note-bg"],
        ["kb-text", "kb-note-bg"],
        ["kb-text", "kb-code-bg"],
        ["kb-dim", "kb-code-bg"],
      ];
      for (const [fg, bg] of pairs)
        expect(ratio(t[fg], t[bg]), `${fg} on ${bg}`).toBeGreaterThanOrEqual(
          4.5,
        );
      // body text softer than headings, still well readable
      expect(ratio(t["kb-strong"], bgs[0])).toBeGreaterThan(
        ratio(t["kb-text"], bgs[0]),
      );
    });
  }
});
