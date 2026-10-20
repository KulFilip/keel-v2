// 0.18.23 KeelBot's thinking in keel TUI, as opencode shows it: while the model thinks, a "⋮ Thinking" block with its
// words (helper.thinking.delta, quieter than the answer); once the answer starts it folds to one line, "⋮ Thought for
// 12s (Ctrl+T to show)"; Ctrl+T or /thinking opens and closes it. Under the answer: "■ Ask · Claude Sonnet 5.5 · 7.6s".

import type { HelperMode } from "./sdk";

export const THINKING_HEAD = "⋮ Thinking";
/** How many of the thinking's last lines the open block shows while KeelBot works. */
export const THINKING_ROWS = 6;

/** The folded line: how long KeelBot thought (whole seconds, at least 1). */
export function thoughtLine(ms: number): string {
  return `⋮ Thought for ${Math.max(1, Math.round(ms / 1000))}s (Ctrl+T to show)`;
}

/** The open block's lines: the head, then the thinking's last `rows` lines, each cut to the width and indented. */
export function thinkingLines(
  text: string,
  width: number,
  rows = THINKING_ROWS,
): string[] {
  const w = Math.max(10, width - 4);
  const lines = text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .flatMap((l) => {
      const out: string[] = [];
      let rest = l.trimEnd();
      while (rest.length > w) {
        const at = rest.lastIndexOf(" ", w);
        const cut = at > w * 0.5 ? at : w;
        out.push(rest.slice(0, cut));
        rest = rest.slice(cut).trimStart();
      }
      out.push(rest);
      return out;
    })
    .filter((l, i, all) => l || (i > 0 && all[i - 1]));
  return [THINKING_HEAD, ...lines.slice(-rows).map((l) => "  " + l)];
}

const MODE_NAME: Record<HelperMode, string> = {
  ask: "Ask",
  edit: "Edit",
  fix: "Fix",
  side: "Side",
};

/** How long a turn took: "7.6s", "2m 05s". */
export function took(ms: number): string {
  const s = Math.max(0, ms) / 1000;
  if (s < 60) return `${s.toFixed(1)}s`;
  const whole = Math.round(s);
  return `${Math.floor(whole / 60)}m ${String(whole % 60).padStart(2, "0")}s`;
}

/** The line under an answer: the mode it ran in, the model and how long the turn took, "■ Ask · Claude Sonnet 5.5 · 7.6s". */
export function answeredBy(
  mode: string | null | undefined,
  model: string,
  ms?: number | null,
): string {
  const m =
    MODE_NAME[(mode ?? "") as HelperMode] ??
    (mode ? mode[0].toUpperCase() + mode.slice(1) : "KeelBot");
  return `■ ${m}${model ? ` · ${model}` : ""}${typeof ms === "number" && ms > 0 ? ` · ${took(ms)}` : ""}`;
}
