// keel TUI's full screen: the transcript as lines of styled text, so the middle of the screen can scroll while keel's
// name stays at the top and the prompt at the bottom. No UI here: a block (and the start screen) becomes lines no
// wider than the screen; App.tsx shows the part that fits and moves it with PgUp / PgDn, Shift+↑↓ and the wheel.

import { Chalk } from "chalk";
import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import type { Block } from "./commands";
import type { Snapshot } from "./keel";
import { colorDiagram } from "./colorize";
import { renderMarkdown } from "./markdown";
import { LOGO } from "./logo";
import * as fmt from "./format";
import type { Paint, Role } from "./theme";
import { VERSION } from "./version";

/** A notice's colour: what waits for you amber, a failure red, a finished flow green, the rest the accent. */
export function noticeRole(text: string): "gate" | "bad" | "ok" | "accent" | "dim" {
  if (/^(waiting for you|budget)/.test(text)) return "gate";
  if (/^(flow failed|keel refused|agent .* (failed|guard))/.test(text)) return "bad";
  if (/^flow done| approved/.test(text)) return "ok";
  if (/^via /.test(text)) return "dim";
  return "accent";
}

const plain = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, "");

/** Text as lines no wider than `width` (long words broken), each line's colours closed and opened again. A folded
 *  line goes on under its own text: under the second column of a two-column line (/help), else under its first word. */
export function wrap(text: string, width: number): string[] {
  const w = Math.max(10, width);
  return text.split("\n").flatMap((line) => {
    if (stringWidth(line) <= w) return [line];
    const raw = plain(line);
    const col = /^(\s*\S.*?\s{2,})\S/.exec(raw)?.[1].length ?? 0;
    const hang = col && col <= w * 0.6 ? col : Math.min(raw.length - raw.trimStart().length, Math.floor(w / 2));
    const [first, ...rest] = wrapAnsi(line, w, { hard: true, trim: false }).split("\n");
    if (!hang || !rest.length) return [first, ...rest];
    const more = wrapAnsi(rest.map((r) => r.replace(/^\s+/, "")).join(" "), w - hang, { hard: true, trim: false }).split("\n");
    return [first.replace(/ +((?:\x1b\[[0-9;]*m)*)$/, "$1"), ...more.map((r) => " ".repeat(hang) + r)];
  });
}

const indent = (lines: string[], n: number) => lines.map((l) => " ".repeat(n) + l);

/** One block of the transcript as lines; `tint` is the background of the person's own messages (none without colour). */
export function blockLines(b: Block, width: number, p: Paint, tint?: string, level: 0 | 1 | 2 | 3 = 3): string[] {
  const role = (r: Role, s: string) => p[r](s);
  switch (b.kind) {
    case "markdown": return indent(wrap(renderMarkdown(b.text, p, width - 2), width - 2), 2);
    // a diagram keeps its lines whole: a line wider than the screen is cut by the view, never folded
    case "diagram": return indent(colorDiagram(b.text, p).split("\n"), 1);
    case "error": return wrap(role("bad", "✗ " + b.text), width);
    case "ok": return wrap(role("ok", "✓ " + b.text), width);
    case "notice": {
      const r = noticeRole(b.text);
      const s = role(r, "◆ " + b.text);
      return wrap(r === "gate" ? p.bold(s) : s, width);
    }
    case "user": {
      const rows = wrap(b.text, width - 3);
      const head = p.bold(p.accent(" › "));
      const out = rows.map((r, i) => (i ? "   " : head) + p.bold(r));
      if (!tint || !level) return ["", ...out];
      const bg = new Chalk({ level }).bgHex(tint);
      return ["", ...out.map((l) => bg(l + " ".repeat(Math.max(0, width - stringWidth(l)))))];
    }
    case "dim": return wrap(role("dim", b.text), width);
    default: return wrap(b.text, width);
  }
}

/** The start screen as lines: keel's logo in a round box, the keel, the project, the flow, what waits and what next. */
export function startLines(s: Snapshot, width: number, p: Paint): string[] {
  const w = Math.max(40, width);
  const inner = w - 4;
  const fit = (x: string) => {
    const cut = wrapAnsi(x, inner, { hard: true, trim: false }).split("\n")[0];
    return cut + " ".repeat(Math.max(0, inner - stringWidth(cut)));
  };
  const row = (x: string) => p.accent("│ ") + fit(x) + p.accent(" │");
  const label = (x: string) => p.dim(x);
  const t = s.flow?.thread ?? null;
  const pr = s.project;
  const body = [...LOGO.map((l) => p.accent(l)), "",
    p.bold(`keel v2 ${s.health?.version ?? VERSION}`) + p.dim(` · keel TUI ${VERSION}`),
    label("keel     ") + p.run(s.publicUrl) + p.dim(fmt.which(s.publicUrl, s.health).slice(s.publicUrl.length))];
  if (s.error) body.push(p.bad(`keel is not reachable: ${s.error}`), p.bad("Start it: keel2 start (or pass --url)."));
  else {
    body.push(label("project  ") + (pr ? p.bold(pr.name || pr.id) + p.dim(" · branch ") + p.run(pr.branch || "-") : "none yet: add one in the dashboard"));
    if (t) body.push(label("flow     ") + p.accent(t.workflow_id) + ` "${t.title}" · ` + fmt.badge(t.status, p) + (t.current ? p.dim(` at ${t.current}`) : ""));
    const waits = fmt.waitingBrief(s.inbox, pr);
    body.push(label("waiting  ") + (s.inbox.length ? p.bold(p.gate(waits)) : p.ok(waits)));
    body.push(label("next     ") + fmt.next(pr, s.flow, p).split("\n")[0]);
  }
  const k = (x: string) => p.accent(x);
  return [
    p.accent("╭" + "─".repeat(w - 2) + "╮"), ...body.map(row), p.accent("╰" + "─".repeat(w - 2) + "╯"),
    p.dim("  Ask KeelBot anything · ") + k("/help") + p.dim(" · ") + k("PgUp") + p.dim("/") + k("PgDn") + p.dim(" or the wheel scroll · ")
      + k("Ctrl+F") + p.dim(" flow · ") + k("Ctrl+A") + p.dim(" agents · ") + k("Ctrl+B") + p.dim(" inbox"),
    "",
  ];
}

/** The line that stays at the top: keel's name, its version, the project and branch, and the flow. */
export function headerLine(s: Snapshot, width: number, p: Paint): string {
  const pr = s.project;
  const t = s.flow?.thread;
  const parts = [
    p.dim(`v2 ${s.health?.version ?? VERSION}`),
    pr ? p.bold(pr.name || pr.id) + (pr.branch ? p.dim(" · ") + p.run(pr.branch) : "") : p.dim("no project"),
    t ? p.accent(t.workflow_id) + ` "${t.title}" ` + fmt.badge(t.status, p) + (t.current ? p.dim(` at ${t.current}`) : "") : "",
  ].filter(Boolean);
  const name = p.colored ? p.bold(p.inverse(p.accent(" keel "))) : "[ keel ]";
  return wrapAnsi(`${name} ${parts.join(p.faint(" · "))}`, width, { hard: true, trim: false }).split("\n")[0];
}

/** Where the view is: `offset` lines up from the newest, never past the oldest. */
export function view(lines: string[], height: number, offset: number): { shown: string[]; offset: number; above: number; below: number } {
  const h = Math.max(1, height);
  const max = Math.max(0, lines.length - h);
  const off = Math.max(0, Math.min(offset, max));
  const end = lines.length - off;
  const start = Math.max(0, end - h);
  return { shown: lines.slice(start, end), offset: off, above: start, below: off };
}

/** The mouse's wheel in a chunk of input (SGR mode: ESC [ < 64 ; x ; y M is up, 65 down): +1 per notch up, -1 down. */
export function wheel(chunk: string): number {
  let n = 0;
  for (const m of chunk.matchAll(/\x1b?\[<(\d+);\d+;\d+[Mm]/g)) {
    const b = Number(m[1]);
    if ((b & 64) === 64) n += (b & 1) ? -1 : 1;
  }
  return n;
}

/** A chunk that is only the mouse's reports (clicks and the wheel): the prompt never takes them as text. */
export const isMouse = (chunk: string) => /^(\x1b?\[<\d+;\d+;\d+[Mm])+$/.test(chunk);

/** The wheel's reports (DECSET 1000 and 1006, SGR), and the terminal's own screen for the app (1049). */
export const MOUSE = { on: "\x1b[?1000h\x1b[?1006h", off: "\x1b[?1006l\x1b[?1000l" };
export const SCREEN = { on: "\x1b[?1049h\x1b[H\x1b[2J", off: "\x1b[?1049l" };
