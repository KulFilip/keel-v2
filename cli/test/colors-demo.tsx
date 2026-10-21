// keel TUI's colours on one example screen: a KeelBot chat about a waiting gate (/status, the person's question with its
// bar, KeelBot's tool calls, one line each and folded, its answer, the footer with the turn's time, its suggestion, a
// question card) and, beside it, the sidebar (context, flow, MCP, files changed), rendered with ink-testing-library in
// a palette. The colours test
// (colors.test.tsx) checks it; run as a script it writes the screen as ANSI text and as HTML on a dark and a light
// terminal background, for `cat` and for a screenshot:
//
//   npx vite-node --config vitest.config.ts test/colors-demo.tsx -- <out dir>
//
// It writes tui-colors-{keel,dark,light}.txt (cat them) and .html (a keel one on a warm near-black terminal).

import React from "react";
import { Box } from "ink";
import { renderAt } from "./wide";
import { BlockView, Picker } from "../src/ui/parts";
import { ThemeProvider } from "../src/ui/theme";
import { applyLevel, makeTheme, type Paint, type Theme } from "../src/core/theme";
import type { Block, Choice } from "../src/core/commands";
import { Sidebar, SIDEBAR_WIDTH } from "../src/ui/sidebar";
import type { Snapshot } from "../src/core/keel";
import type { ToolCall } from "../src/core/tools";
import * as fmt from "../src/core/format";

const project = { id: "shop", name: "shop", branch: "feature/webhooks" };
const thread = {
  thread_id: "3f2c9a1e-7b44-4c1d-9e0a-5d2b8c6f1a20", title: "Webhook retries", workflow_id: "feature", status: "waiting", run_mode: "manual",
  current: "frame_gate", phase: "frame", ac: null, acs: [], error: null, blockers: [],
  usage: { tokens_in: 4000, tokens_out: 1500, cap_tokens: 1_100_000, cost_usd: 0.04 },
  waiting: { step: "frame_gate", kind: "clarify", title: "frame the question has 2 questions", options: ["approve"],
    questions: [{ id: "q1", question: "When a later webhook arrives first, keep it?", options: [{ label: "Yes" }, { label: "No", recommended: true }] },
      { id: "q2", question: "Retry how many times?", options: [{ label: "3" }, { label: "5" }] }],
    detail: "1. When a later webhook arrives before an earlier one, should keel keep the later one?\nwhy it matters: the order decides which price the shop shows" },
};

/** KeelBot's tool calls in the example: a keel tool, a shell command with a long output, one that failed. */
export const TOOLS: ToolCall[] = [
  { n: 1, name: "keel_status", server: "keel", args: "project=shop", shell: false, status: "ok", summary: "12 lines", lines: 12,
    output: "project shop\nflow feature waiting at frame_gate" },
  { n: 2, name: "Bash", args: "git log --oneline -20 -- src/webhooks", shell: true, status: "ok", summary: "20 lines", lines: 20, output: "a1b2c3 retry\n…" },
  { n: 3, name: "keel_search", server: "keel", args: "query=webhook order by arrival time across every retry and every shop", shell: false, status: "error",
    summary: "the code graph is not indexed yet", lines: 1, output: "the code graph is not indexed yet" },
];

/** The sidebar's example: the chat's context and cost, the flow that waits, KeelBot's MCP servers, a changed file. */
export const SIDE = {
  snap: { chat: { session: { ctx_tokens: 82_000, ctx_window: 200_000, cost_usd: 0.42 } }, flow: { thread } } as unknown as Snapshot,
  servers: [{ name: "keel", label: "keel", status: "ok", tools: [] }, { name: "jira", label: "Jira", status: "error", tools: [] }],
  files: [{ path: "src/webhooks/order.ts", status: "modified", added: 12, removed: 3 }],
};

/** The example screen's blocks, in the order they come (/status is painted by its command, as in the app). */
export const blocks = (p: Paint): Block[] => [
  { kind: "text", text: fmt.status(project as never, { thread, workflow: null } as never, p, 100) },
  { kind: "user", text: "what do you mean" },
  { kind: "dim", text: "⋮ Thought for 4s (Ctrl+T to show)" },
  ...TOOLS.map((tool, i): Block => ({ kind: "tool", text: tool.output, tool, ...(i === 1 ? { hint: "Ctrl+O to show" } : {}) })),
  { kind: "markdown", text: "I mean the gate **frame the question** asks you two things before keel writes the spec:\n\n"
    + "- **A** keep the later webhook (`order_id` decides)\n- **B** keep the earlier one\n- **C** keep both and warn\n\n"
    + "See src/webhooks/order.ts:42. I would answer **No** to the first question." },
  { kind: "dim", text: "■ Ask · Claude Sonnet 5.5 · 7.6s" },
  { kind: "dim", text: "  When a later webhook arrives first, keep it? → No" },
  { kind: "dim", text: "  Suggestion not sent: you chose No." },
  { kind: "text", text: "1/1 What should I do next?\n   why it matters: keel waits for this answer before it goes on" },
];

export const SUGGESTION = 'KeelBot suggests this answer for "frame the question". Send it?';
export const OPTIONS: Choice[] = [
  { label: "Answer the gate (recommended)", value: "a", hint: "send No for q1, the default for q2" },
  { label: "Ask KeelBot more", value: "b", hint: "it explains each question first" },
  { label: "Other… (my own words)", value: "o" },
];

/** The screen in a theme, as the terminal gets it (ANSI); `sidebar`: the sidebar beside it, as on a wide terminal. */
export function demoScreen(theme: Theme, width = 100, sidebar = false): string {
  applyLevel(theme);
  const parts = [
    ...blocks(theme.paint).map((b, i, all) => <BlockView key={i} b={b} width={width}
      gap={i > 0 && b.kind !== "user" && !(b.kind === "tool" && all[i - 1].kind === "tool")} />),
    <Box key="s" marginTop={1}><Picker title={SUGGESTION} choices={[{ label: "Yes", value: "y" }, { label: "No", value: "n" }]} index={0} filter="" /></Box>,
    <Box key="q" marginTop={1}><Picker title="What should I do next?" choices={OPTIONS} index={0} filter="" /></Box>,
  ];
  const all = width + (sidebar ? SIDEBAR_WIDTH + 1 : 0);
  const r = renderAt(<ThemeProvider theme={theme}><Box flexDirection="row" width={all}>
    <Box flexDirection="column" width={width} flexShrink={0}>{parts}</Box>
    {sidebar ? <Box marginLeft={1}><Sidebar s={SIDE.snap} servers={SIDE.servers} files={SIDE.files} height={30} /></Box> : null}
  </Box></ThemeProvider>, all);
  const out = r.lastFrame() ?? "";
  r.unmount();
  return out;
}

// ------------------------------------------------------------------ ANSI → HTML, for a screenshot of each background

/** Two common terminal colour sets (VS Code's integrated terminal, Dark+ and Light+), for the HTML only. */
const TERMS = {
  dark: { bg: "#1e1e1e", fg: "#cccccc", ansi: ["#000000", "#cd3131", "#0dbc79", "#e5e510", "#2472c8", "#bc3fbc", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#d670d6", "#29b8db", "#e5e5e5"] },
  // a warm near-black terminal with the blue of a common dark theme
  keel: { bg: "#17150f", fg: "#d8d4ca", ansi: ["#000000", "#e0524d", "#2fa84f", "#f2b84b", "#4a86e8", "#a48bff", "#11a8cd", "#e5e5e5",
    "#666666", "#f14c4c", "#23d18b", "#f5f543", "#3b8eea", "#a48bff", "#29b8db", "#e5e5e5"] },
  light: { bg: "#ffffff", fg: "#333333", ansi: ["#000000", "#cd3131", "#00bc00", "#949800", "#0451a5", "#bc05bc", "#0598bc", "#555555",
    "#666666", "#cd3131", "#14ce14", "#b5ba00", "#0451a5", "#bc05bc", "#0598bc", "#a5a5a5"] },
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

export function ansiToHtml(text: string, term: keyof typeof TERMS, title: string): string {
  const t = TERMS[term];
  let fg: string | null = null;
  let [bold, dim, under] = [false, false, false];
  let html = "";
  for (const m of text.matchAll(/\x1b\[([\d;]*)m|([^\x1b]+)/g)) {
    if (m[2] !== undefined) {
      const style = [fg ? `color:${fg}` : "", bold ? "font-weight:700" : "", dim ? "opacity:.6" : "", under ? "text-decoration:underline" : ""]
        .filter(Boolean).join(";");
      html += style ? `<span style="${style}">${esc(m[2])}</span>` : esc(m[2]);
      continue;
    }
    const codes = (m[1] || "0").split(";").map(Number);
    for (let i = 0; i < codes.length; i++) {
      const c = codes[i];
      if (c === 0) [fg, bold, dim, under] = [null, false, false, false];
      else if (c === 1) bold = true;
      else if (c === 2) dim = true;
      else if (c === 22) [bold, dim] = [false, false];
      else if (c === 4) under = true;
      else if (c === 24) under = false;
      else if (c === 39) fg = null;
      else if (c >= 30 && c <= 37) fg = t.ansi[c - 30];
      else if (c >= 90 && c <= 97) fg = t.ansi[c - 90 + 8];
      else if (c === 38 && codes[i + 1] === 2) {
        fg = `rgb(${codes[i + 2]},${codes[i + 3]},${codes[i + 4]})`;
        i += 4;
      }
    }
  }
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title><style>
body{margin:0;background:${t.bg};color:${t.fg}}
pre{margin:0;padding:20px 24px;font:14px/1.35 Menlo,"SF Mono",Consolas,monospace;white-space:pre}
</style></head><body><pre>${html}</pre></body></html>\n`;
}

async function main(dir: string) {
  const { writeFileSync, mkdirSync } = await import("node:fs");
  const { join } = await import("node:path");
  mkdirSync(dir, { recursive: true });
  for (const name of ["keel", "dark", "light"] as const) {
    const screen = demoScreen(makeTheme({ KEEL_TUI_THEME: name }, 3), 100, true);
    writeFileSync(join(dir, `tui-colors-${name}.txt`), screen + "\n");
    writeFileSync(join(dir, `tui-colors-${name}.html`), ansiToHtml(screen, name, `keel TUI colours (${name})`));
    process.stdout.write(`wrote ${join(dir, `tui-colors-${name}.txt`)} and .html\n`);
  }
}

const out = process.argv.slice(2).filter((a) => a !== "--")[0];
if (out && !process.env.VITEST) void main(out);
