// A plugin's mode in keel TUI (docs/plugins/25-tui-plugins.md, contributes.tui.modes, keel 0.18.6): a full-screen view
// of its own, declared as data, that takes keel TUI's screen between keel's header and its status line until Esc.
//
//   /review 12 ──▶ state: GET each state call in order (view, then ai: a later one may use an earlier answer)
//                  list:   the items at list.items, one line each (↑↓, Enter opens one)
//                  detail: GET detail.call for the open item: a diff with line numbers (or a text), notes under lines
//                  keys:   pick → ask → confirm → call → show / reload / open / done, as each key says
//
// No UI here and no plugin code: a ModeSession holds the mode's state, takes key names (press) and gives the lines to
// show (lines), so keel TUI's Ink app (ui/ModeView.tsx) and the tests drive the very same thing. Every call is one of the
// plugin's own api routes (checked by keel's api, and again here after the values are filled in); one that changes
// something has asked first (a yes/no, or the person's own words).

import stringWidth from "string-width";
import wrapAnsi from "wrap-ansi";
import { errorParts, get, post } from "./sdk";
import { classifyDiff, type DiffKind } from "./diff";
import { fill, pick, render, type TuiCall, type TuiShow, type TuiPluginView } from "./plugins";
import { PLAIN, type Paint } from "./theme";
import { setCommand } from "./transport";

export type ModeMark = { list: string; field: string; text: string };
export type ModeList = { title?: string | null; items: string; line: string; mark?: ModeMark | null; empty?: string | null };
export type ModeNote = { items: string; path?: string | null; line?: string | null; side?: string | null; text: string; tone?: string | null };
export type ModeDetail = { title?: string | null; call: TuiCall; diff?: string | null; text?: string | null; notes?: ModeNote[] | null };
export type ModeChoice = { label: string; value: string };
export type ModePick = { title: string; call?: TuiCall | null; items?: string | null; line?: string | null; match?: Record<string, string> | null;
  choices?: ModeChoice[] | null };
export type ModeKey = { key: string; label: string; view?: "list" | "detail" | "both" | null; pick?: ModePick | null; ask?: string | null;
  confirm?: string | null; call?: TuiCall | null; show?: TuiShow | null; reload?: boolean | null; open?: string | null; done?: string | null };
export type TuiMode = { name: string; title: string; args?: string | null; summary: string; state: Record<string, TuiCall>; status?: string | null;
  list: ModeList; detail?: ModeDetail | null; keys: ModeKey[] };

type Tone = "accent" | "dim" | "warn" | "bad" | "ok";
/** A row of the detail: a diff line (its number on the side it is on), or a note under one. */
export type Row = { text: string; kind: DiffKind | "note"; number?: number; side?: "RIGHT" | "LEFT"; tone?: Tone };
export type Prompt =
  | { kind: "pick"; title: string; choices: { label: string; value: unknown }[]; index: number }
  | { kind: "ask"; prompt: string; text: string }
  | { kind: "confirm"; question: string };
type Vars = Record<string, unknown>;

const TONES = new Set(["accent", "dim", "warn", "bad", "ok"]);
const FILE_HEADER = /^(diff |index |--- |\+\+\+ )/;

/** A call's path with the values filled in, each one URL-encoded; "." or ".." as a value, or a path that is no longer
 *  under the plugin's own routes, is refused (a plugin's answer cannot steer a call elsewhere). */
export function modePath(call: TuiCall, vars: Vars, plugin: string): string {
  const path = call.path.replace(/\{([\w.]+)\}/g, (_, k: string) => {
    const v = pick(vars, k);
    const s = v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
    if (s === "." || s === "..") throw new Error(`keel TUI refused a call: ${k} is "${s}"`);
    return encodeURIComponent(s);
  });
  const pid = encodeURIComponent(String(vars.pid ?? ""));
  const bare = path.split("?")[0];
  if (!(bare.startsWith(`/projects/${pid}/${plugin}/`) || bare === `/projects/${pid}/${plugin}` || bare.startsWith(`/${plugin}/`)) || bare.includes("//")
    || bare.split("/").some((x) => x === "." || x === "..")) {
    throw new Error(`keel TUI refused a call outside the ${plugin} plugin's routes: ${bare}`);
  }
  return path;
}

/** A call's body with the values filled in: a text that is one {name} keeps the value as it is (a number, a list…). */
export function modeBody(body: unknown, vars: Vars): unknown {
  if (typeof body === "string") {
    const one = /^\{([\w.]+)\}$/.exec(body);
    if (one) return pick(vars, one[1]) ?? null;
    return fill(body, vars);
  }
  if (Array.isArray(body)) return body.map((x) => modeBody(x, vars));
  if (body && typeof body === "object") return Object.fromEntries(Object.entries(body).map(([k, v]) => [k, modeBody(v, vars)]));
  return body;
}

/** The list at `path` of `data` (a list, else none). */
const listAt = (data: unknown, path: string | null | undefined): unknown[] => {
  const v = pick(data, path || ".");
  return Array.isArray(v) ? v : [];
};

/** The text of a value as templates write it. */
const str = (v: unknown) => (v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v));

/** One line cut (or padded) to `width` columns, colours kept. */
export function fit(s: string, width: number, pad = false): string {
  const w = Math.max(1, width);
  const line = s.replace(/\n/g, " ");
  const cut = stringWidth(line) <= w ? line : wrapAnsi(line, w - 1, { hard: true, trim: false }).split("\n")[0] + "…";
  return pad ? cut + " ".repeat(Math.max(0, w - stringWidth(cut))) : cut;
}

/** An error's words and keel's hint after them. */
const why = (e: unknown) => {
  const p = errorParts(e);
  return p.hint ? `${p.message} (${p.hint})` : p.message;
};

/** The templates a key fills, to see if it needs a line of the diff ({line}, {side}). */
const usesLine = (k: ModeKey) => /\{(line|side)\}/.test([k.ask, k.confirm, k.call?.path, JSON.stringify(k.call?.body ?? null)].join(" "));

export class ModeSession {
  view: "list" | "detail" | "show" = "list";
  state: Vars = {};
  items: unknown[] = [];
  index = 0;
  rows: Row[] = [];
  row = 0;
  scroll = 0;
  show: { title: string; lines: string[]; back: "list" | "detail"; scroll: number } | null = null;
  message: { text: string; tone: Tone } | null = null;
  prompt: Prompt | null = null;
  busy: string | null = null;
  /** the rows the body had at the last lines(): how far PgUp / PgDn go */
  private bodyRows = 10;
  private going: { key: ModeKey; vars: Vars; stage: number } | null = null;
  private listeners = new Set<() => void>();

  constructor(readonly plugin: TuiPluginView, readonly mode: TuiMode, readonly pid: string, public arg: string, private paint: Paint = PLAIN) {}

  /** Called after every change (the UI draws again). */
  onChange(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  }

  private changed() {
    for (const fn of this.listeners) fn();
  }

  setPaint(p: Paint) {
    this.paint = p;
  }

  get item(): unknown {
    return this.items[this.index];
  }

  /** What templates read: the project, the words after the command, the state, the item, the diff's line, … */
  vars(extra: Vars = {}): Vars {
    const r = this.view === "detail" ? this.lineRow() : null;
    return { pid: this.pid, arg: this.arg, ...this.state, item: this.item ?? null, line: r?.number ?? null, side: r?.side ?? null, ...extra };
  }

  // ---------------------------------------------------------------- reading

  /** One of the plugin's routes; keel's audit says which key of which mode sent it ("/review · comment"). */
  private async call(c: TuiCall, vars: Vars, what = ""): Promise<unknown> {
    const path = modePath(c, vars, this.plugin.name);
    setCommand(`/${this.mode.name}${what ? ` · ${what}` : ""}`);
    try {
      return c.method === "POST" ? await post<unknown>(path, modeBody(c.body ?? {}, vars)) : await get<unknown>(path);
    } finally {
      setCommand("");
    }
  }

  /** Read the state calls in order: the first must answer; a later one that fails is empty (said in the message). */
  async load(): Promise<void> {
    const state: Vars = {};
    const missed: string[] = [];
    let first = true;
    for (const [name, c] of Object.entries(this.mode.state)) {
      try {
        state[name] = await this.call(c, { pid: this.pid, arg: this.arg, ...state });
      } catch (e) {
        if (first) throw e;
        state[name] = null;
        missed.push(`${name}: ${why(e)}`);
      }
      first = false;
    }
    this.state = state;
    this.items = listAt(state, this.mode.list.items);
    this.index = Math.min(this.index, Math.max(0, this.items.length - 1));
    if (missed.length) this.message = { text: `could not read ${missed.join("; ")}`, tone: "warn" };
  }

  /** Open the mode: its state, then its list. Throws when its first state call fails (the mode does not open). */
  async open(): Promise<void> {
    this.view = "list";
    this.index = 0;
    this.scroll = 0;
    await this.load();
  }

  /** Read the state again (and the open item), keeping the place. */
  async reload(): Promise<void> {
    await this.load();
    if (this.view === "detail") await this.openDetail(true);
  }

  /** The open item's detail: its diff (or text) and the notes under its lines. */
  async openDetail(keep = false): Promise<void> {
    const d = this.mode.detail;
    if (!d || !this.items.length) return;
    const data = await this.call(d.call, { ...this.vars(), line: null, side: null });
    const rows: Row[] = d.diff
      ? classifyDiff(str(pick(data, d.diff)).replace(/\n$/, "").split("\n")).filter((l) => !(l.kind === "faint" && FILE_HEADER.test(l.text)))
        .map((l) => ({ text: l.text, kind: l.kind, number: l.number ? Number(l.number) : undefined,
          side: l.kind === "removed" ? "LEFT" as const : l.number ? "RIGHT" as const : undefined }))
      : fill(d.text ?? "", data).split("\n").map((t) => ({ text: t, kind: "plain" as const }));
    const before = keep ? this.lineRow() : null;
    this.rows = this.withNotes(rows.length && rows.some((r) => r.text) ? rows : [{ text: "(nothing to show)", kind: "faint" }]);
    this.view = "detail";
    if (before) {
      const same = this.rows.findIndex((r) => r.number === before.number && r.side === before.side);
      this.row = same >= 0 ? same : Math.min(this.row, this.rows.length - 1);
    } else {
      const change = this.rows.findIndex((r) => r.kind === "added" || r.kind === "removed");
      this.row = change >= 0 ? change : 0;
      this.scroll = Math.max(0, this.row - 2);
    }
  }

  /** The detail's rows with each note under its line (a note on a line the diff does not show goes on top). */
  private withNotes(rows: Row[]): Row[] {
    const notes = this.mode.detail?.notes ?? [];
    if (!notes.length) return rows;
    const path = str(pick(this.item, "path"));
    const under = new Map<number, Row[]>();
    const top: Row[] = [];
    for (const n of notes) {
      const tone = (n.tone && TONES.has(n.tone) ? n.tone : "accent") as Tone;
      for (const x of listAt(this.vars(), n.items)) {
        if (str(pick(x, n.path || "path")) !== path) continue;
        const line = Number(pick(x, n.line || "line"));
        const side = n.side ? (str(pick(x, n.side)) || "RIGHT") : "RIGHT";
        const text = fill(n.text, x);
        const at = rows.findIndex((r) => r.number === line && r.side === side);
        const note: Row = { text, kind: "note", tone };
        if (at >= 0) under.set(at, [...(under.get(at) ?? []), note]);
        else top.push({ ...note, text: `${line ? `line ${line}` : "the file"}: ${text}` });
      }
    }
    return [...top, ...rows.flatMap((r, i) => [r, ...(under.get(i) ?? [])])];
  }

  /** The diff line the cursor is on (a note belongs to the line above it). */
  private lineRow(): Row | null {
    for (let i = this.row; i >= 0; i--) {
      const r = this.rows[i];
      if (r && r.kind !== "note") return r.number ? r : null;
    }
    return null;
  }

  // ---------------------------------------------------------------- keys

  /** A key: "up", "down", "pgup", "pgdn", "home", "end", "enter", "esc", "left", "right", "tab", "backspace", or the
   *  character typed. "leave" means the person left the mode. */
  async press(name: string): Promise<"leave" | void> {
    if (this.busy) return;
    if (this.prompt) return this.answer(name);
    this.message = null;
    if (this.view === "show") return this.inShow(name);
    if (name === "q") return "leave";
    if (name === "?") return this.help();
    if (this.view === "list") {
      if (name === "esc") return "leave";
      if (name === "up" || name === "k") this.move(-1);
      else if (name === "down" || name === "j") this.move(1);
      else if (name === "pgup") this.move(-this.bodyRows);
      else if (name === "pgdn") this.move(this.bodyRows);
      else if (name === "home") this.move(-this.items.length);
      else if (name === "end") this.move(this.items.length);
      else if (name === "enter" || name === "right") await this.guard("opening", () => this.openDetail());
      else await this.keyed(name);
    } else {
      if (name === "esc" || name === "left") {
        this.view = "list";
        this.scroll = Math.max(0, this.index - Math.floor(this.bodyRows / 2));
      } else if (name === "up" || name === "k") this.moveRow(-1);
      else if (name === "down" || name === "j") this.moveRow(1);
      else if (name === "pgup") this.moveRow(-this.bodyRows);
      else if (name === "pgdn") this.moveRow(this.bodyRows);
      else if (name === "home") this.moveRow(-this.rows.length);
      else if (name === "end") this.moveRow(this.rows.length);
      else if (name === "]" || name === "tab") await this.nextFile(1);
      else if (name === "[") await this.nextFile(-1);
      else if (name === "}") this.nextChange(1);
      else if (name === "{") this.nextChange(-1);
      else await this.keyed(name);
    }
    this.changed();
  }

  /** The wheel: a few lines at a time. */
  wheel(by: number) {
    if (this.prompt || this.busy) return;
    if (this.view === "show" && this.show) this.show.scroll = Math.max(0, Math.min(this.show.scroll - by, this.show.lines.length - 1));
    else if (this.view === "detail") this.moveRow(-by);
    else this.move(-by);
    this.changed();
  }

  /** A click on the body's n-th row: the list opens that item, the detail moves to that line. */
  async click(n: number) {
    if (this.prompt || this.busy || this.view === "show") return;
    const at = this.scroll + n;
    if (this.view === "list" && at < this.items.length) {
      this.index = at;
      await this.guard("opening", () => this.openDetail());
    } else if (this.view === "detail" && at < this.rows.length) this.row = at;
    this.changed();
  }

  private move(by: number) {
    this.index = Math.max(0, Math.min(this.index + by, this.items.length - 1));
  }

  private moveRow(by: number) {
    let i = Math.max(0, Math.min(this.row + by, this.rows.length - 1));
    // the cursor stays on the diff's lines: a note is read under its line
    while (this.rows[i]?.kind === "note" && i > 0 && i < this.rows.length - 1) i += by < 0 ? -1 : 1;
    this.row = i;
  }

  private async nextFile(by: number) {
    const i = this.index + by;
    if (i < 0 || i >= this.items.length) {
      this.message = { text: by > 0 ? "the last file" : "the first file", tone: "dim" };
      return;
    }
    this.index = i;
    await this.guard("opening", () => this.openDetail());
  }

  private nextChange(by: number) {
    const isChange = (r?: Row) => r?.kind === "added" || r?.kind === "removed";
    let i = this.row;
    while (isChange(this.rows[i]) && i >= 0 && i < this.rows.length) i += by;     // out of this change
    while (i >= 0 && i < this.rows.length && !isChange(this.rows[i])) i += by;    // to the next one
    if (i >= 0 && i < this.rows.length) this.row = i;
    else this.message = { text: by > 0 ? "no change below" : "no change above", tone: "dim" };
  }

  private inShow(name: string) {
    const s = this.show!;
    if (name === "esc" || name === "left" || name === "enter" || name === "q") {
      this.view = s.back;
      this.show = null;
    } else if (name === "up" || name === "k") s.scroll = Math.max(0, s.scroll - 1);
    else if (name === "down" || name === "j") s.scroll = Math.min(Math.max(0, s.lines.length - 1), s.scroll + 1);
    else if (name === "pgup") s.scroll = Math.max(0, s.scroll - this.bodyRows);
    else if (name === "pgdn") s.scroll = Math.min(Math.max(0, s.lines.length - 1), s.scroll + this.bodyRows);
    this.changed();
  }

  private help() {
    const where = (k: ModeKey) => (k.view === "list" ? " (in the list)" : k.view === "detail" ? " (in a file)" : "");
    const own = ["↑ ↓  j k   move", "Enter →    open the item", "← Esc      back (Esc in the list leaves the mode)", "] [  Tab   the next / previous item, in a file",
      "} {        the next / previous change", "PgUp PgDn  a page", "q          leave the mode", ""];
    this.openShow(`${this.mode.title}: the keys`, [...own, ...this.mode.keys.map((k) => `${k.key.padEnd(11)}${k.label}${where(k)}`)]);
    this.changed();
  }

  private openShow(title: string, lines: string[]) {
    this.show = { title, lines, back: this.view === "show" ? (this.show?.back ?? "list") : this.view, scroll: 0 };
    this.view = "show";
  }

  private async guard(what: string, fn: () => Promise<void>) {
    this.busy = what;
    this.changed();
    try {
      await fn();
    } catch (e) {
      this.message = { text: why(e), tone: "bad" };
    } finally {
      this.busy = null;
    }
  }

  // ---------------------------------------------------------------- the plugin's keys

  /** The keys that work where the person is. */
  keysHere(): ModeKey[] {
    return this.mode.keys.filter((k) => !k.view || k.view === "both" || k.view === this.view);
  }

  private async keyed(ch: string) {
    if (ch.length !== 1) return;
    const k = this.mode.keys.find((x) => x.key === ch);
    if (!k) return;
    if (!this.keysHere().includes(k)) {
      this.message = { text: `${k.key} (${k.label}) works ${k.view === "list" ? "in the list" : "in a file: Enter opens one"}`, tone: "dim" };
      return;
    }
    if (!this.items.length && /\{item\./.test(JSON.stringify(k))) {
      this.message = { text: `nothing to ${k.label} here`, tone: "dim" };
      return;
    }
    if (usesLine(k) && this.view === "detail" && !this.lineRow()) {
      this.message = { text: `move to a line of the diff first (↑ ↓), then ${k.key}`, tone: "warn" };
      return;
    }
    this.going = { key: k, vars: this.vars(), stage: 0 };
    await this.step();
  }

  /** The key's next stage: pick, ask, confirm, then the call and what comes after it. */
  private async step(): Promise<void> {
    const g = this.going;
    if (!g) return;
    const k = g.key;
    const stage = g.stage++;
    if (stage === 0 && k.pick) {
      const p = k.pick;
      let choices: { label: string; value: unknown }[];
      try {
        if (p.choices?.length) choices = p.choices.map((c) => ({ label: c.label, value: c }));
        else {
          this.busy = p.title;
          this.changed();
          const src = p.call ? await this.call(p.call, g.vars) : g.vars;
          const want = Object.entries(p.match ?? {}).map(([f, t]) => [f, fill(t, g.vars)] as const);
          choices = listAt(src, p.items).filter((x) => want.every(([f, v]) => str(pick(x, f)) === v))
            .map((x) => ({ label: fill(p.line ?? "", x) || str(x), value: x }));
        }
      } catch (e) {
        return this.stop(why(e), "bad");
      } finally {
        this.busy = null;
      }
      if (!choices.length) return this.stop(`nothing to pick: ${fill(p.title, g.vars)}`, "dim");
      this.prompt = { kind: "pick", title: fill(p.title, g.vars), choices, index: 0 };
      return;
    }
    if (stage <= 1 && k.ask) {
      g.stage = 2;
      this.prompt = { kind: "ask", prompt: fill(k.ask, g.vars), text: "" };
      return;
    }
    if (stage <= 2 && k.confirm) {
      g.stage = 3;
      this.prompt = { kind: "confirm", question: fill(k.confirm, g.vars) };
      return;
    }
    await this.finish(g);
  }

  private stop(text: string, tone: Tone) {
    this.going = null;
    this.prompt = null;
    this.message = { text, tone };
  }

  private async answer(name: string): Promise<void> {
    const p = this.prompt!;
    const g = this.going;
    if (p.kind === "pick") {
      if (name === "esc") this.stop("cancelled", "dim");
      else if (name === "up" || name === "k") p.index = Math.max(0, p.index - 1);
      else if (name === "down" || name === "j") p.index = Math.min(p.choices.length - 1, p.index + 1);
      else if (name === "enter" || (/^[1-9]$/.test(name) && Number(name) <= p.choices.length)) {
        const c = p.choices[name === "enter" ? p.index : Number(name) - 1];
        this.prompt = null;
        if (g) g.vars = { ...g.vars, choice: c.value };
        await this.step();
      }
    } else if (p.kind === "ask") {
      if (name === "esc") this.stop("cancelled", "dim");
      else if (name === "enter") {
        this.prompt = null;
        if (g) g.vars = { ...g.vars, text: p.text.trim() };
        await this.step();
      } else if (name === "backspace") p.text = p.text.slice(0, -1);
      else if (name.length >= 1 && !["up", "down", "left", "right", "tab", "pgup", "pgdn", "home", "end"].includes(name)) p.text += name.replace(/\r\n?|\n/g, " ");
    } else {
      if (name === "y" || name === "Y" || name === "enter") {
        this.prompt = null;
        await this.step();
      } else if (name === "n" || name === "N" || name === "esc") this.stop("not done", "dim");
    }
    this.changed();
  }

  private async finish(g: { key: ModeKey; vars: Vars }) {
    const k = g.key;
    this.going = null;
    await this.guard(k.label, async () => {
      let answer: unknown = undefined;
      if (k.call) answer = await this.call(k.call, g.vars, k.label);
      const after = { ...g.vars, answer };
      if (k.open) {
        const was = this.arg;
        this.arg = fill(k.open, after);
        try {
          await this.open();
        } catch (e) {
          this.arg = was;
          throw e;
        }
      } else if (k.reload) await this.reload();
      if (k.show) {
        const data = k.call ? answer : after;
        const text = render(data, { ...k.show, title: null }, this.paint, 400);
        this.openShow(fill(k.show.title ?? k.label, data), text.split("\n"));
      }
      if (k.done) this.message = { text: fill(k.done, after), tone: "ok" };
      else if (k.call && k.call.method === "POST") this.message = { text: `${k.label}: done`, tone: "ok" };
    });
  }

  // ---------------------------------------------------------------- what to show

  /** The mode's screen as `height` lines no wider than `width`: its title, the list, a file or a text, then its status
   *  line, the keys and the message (or what it asks). */
  lines(width: number, height: number): string[] {
    const p = this.paint;
    const v = this.vars();
    const foot = 3;
    const bodyH = Math.max(1, height - 1 - foot);
    this.bodyRows = bodyH;
    const out: string[] = [];
    const where = this.view === "list" ? fill(this.mode.list.title ?? "", v)
      : this.view === "detail" ? fill(this.mode.detail?.title ?? "", v) + p.faint(`  (${this.index + 1}/${this.items.length})`)
        : this.show?.title ?? "";
    const head = ` ${this.mode.title} `;
    out.push(fit((p.colored ? p.bold(p.inverse(p.accent(head))) : `[${head.trim()}]`) + " " + p.bold(where), width, true));
    const body = this.prompt?.kind === "pick" ? this.pickLines(width, bodyH) : this.view === "list" ? this.listLines(width, bodyH)
      : this.view === "detail" ? this.detailLines(width, bodyH) : this.showLines(width, bodyH);
    out.push(...body.slice(0, bodyH));
    while (out.length < 1 + bodyH) out.push("");
    out.push(fit(p.dim(this.mode.status ? fill(this.mode.status, v) : this.mode.summary), width));
    out.push(fit(this.keyHints(width), width));
    out.push(fit(this.bottom(), width));
    return out;
  }

  private listLines(width: number, h: number): string[] {
    const p = this.paint;
    const l = this.mode.list;
    if (!this.items.length) return [p.dim("  " + fill(l.empty ?? "nothing here", this.vars()))];
    this.scroll = Math.max(Math.min(this.scroll, this.index), this.index - h + 1, 0);
    const marked = l.mark ? new Set(listAt(this.state, l.mark.list).map((x) => (typeof x === "object" ? str(pick(x, l.mark!.field)) : str(x)))) : null;
    return this.items.slice(this.scroll, this.scroll + h).map((it, i) => {
      const at = this.scroll + i === this.index;
      const mark = marked && l.mark && marked.has(str(pick(it, l.mark.field))) ? "  " + p.ok(l.mark.text) : "";
      const text = fill(l.line, it);
      return fit((at ? p.accent("▸ ") + p.bold(text) : "  " + text) + mark, width);
    });
  }

  private detailLines(width: number, h: number): string[] {
    const p = this.paint;
    if (this.row < this.scroll) this.scroll = this.row;
    if (this.row >= this.scroll + h) this.scroll = this.row - h + 1;
    // the notes under the cursor's line stay in sight
    let end = this.row + 1;
    while (this.rows[end]?.kind === "note" && end - this.scroll < h) end++;
    if (end > this.scroll + h) this.scroll = end - h;
    const gutter = this.rows.some((r) => r.number);
    return this.rows.slice(this.scroll, this.scroll + h).map((r, i) => {
      const at = this.scroll + i === this.row;
      if (r.kind === "note") return fit("      " + p.faint("│ ") + p[r.tone ?? "accent"](r.text), width);
      const n = gutter ? (r.number ? String(r.number) : "").padStart(4) + " " : "";
      const body = r.kind === "added" ? p.add(r.text) : r.kind === "removed" ? p.del(r.text) : r.kind === "hunk" ? p.warn(r.text)
        : r.kind === "faint" ? p.faint(r.text) : r.text;
      return fit((at ? p.accent("▸") : " ") + (at ? p.bold(n) : p.faint(n)) + body, width);
    });
  }

  private showLines(width: number, h: number): string[] {
    const s = this.show;
    if (!s) return [];
    s.scroll = Math.min(s.scroll, Math.max(0, s.lines.length - h));
    return s.lines.flatMap((l) => (stringWidth(l) > width - 2 ? wrapAnsi(l, width - 2, { hard: true, trim: false }).split("\n") : [l]))
      .slice(s.scroll, s.scroll + h).map((l) => " " + l);
  }

  private pickLines(width: number, h: number): string[] {
    const p = this.paint;
    const q = this.prompt as Extract<Prompt, { kind: "pick" }>;
    const top = Math.max(0, Math.min(q.index - Math.floor((h - 2) / 2), q.choices.length - (h - 2)));
    return [p.bold(p.gate("? " + q.title)) + p.dim("  ↑↓ Enter · 1-9 · Esc cancels"), "",
      ...q.choices.slice(top, top + h - 2).map((c, i) => {
        const n = top + i;
        const label = `${n < 9 ? `${n + 1}. ` : "   "}${c.label}`;
        return fit(n === q.index ? p.accent("▸ ") + p.bold(label) : "  " + label, width);
      })];
  }

  /** The keys that work here, keel's own first; when they do not fit, the plugin's keys without their words (? lists them). */
  keyHints(width = 1000): string {
    const p = this.paint;
    const k = (key: string, does: string) => p.accent(key) + " " + p.dim(does);
    const own = this.view === "list" ? [k("↑↓", "move"), k("Enter", "open")] : this.view === "detail" ? [k("↑↓", "line"), k("][", "file"), k("}{", "change")]
      : [k("↑↓", "scroll"), k("Esc", "back")];
    const here = this.view === "show" ? [] : this.keysHere();
    const tail = this.view === "show" ? [] : [k("?", "keys"), k("Esc", this.view === "list" ? "leave" : "back")];
    const full = [...own, ...here.map((x) => k(x.key, x.label)), ...tail].join(p.faint(" · "));
    if (stringWidth(full) <= width || !here.length) return full;
    return [...own, here.map((x) => p.accent(x.key)).join(" "), ...tail].join(p.faint(" · "));
  }

  private bottom(): string {
    const p = this.paint;
    const q = this.prompt;
    if (q?.kind === "ask") return p.bold(p.accent(q.prompt + ": ")) + q.text + p.inverse(" ") + p.dim("  Enter sends · Esc cancels");
    if (q?.kind === "confirm") return p.bold(p.gate(q.question.endsWith("?") ? q.question : q.question + "?")) + p.dim("  y / n");
    if (this.busy) return p.dim(`… ${this.busy}`);
    if (this.message) return p[this.message.tone](this.message.tone === "bad" ? "✗ " + this.message.text : this.message.text);
    return "";
  }
}

/** Open a plugin's mode: its state first; an error means it does not open. */
export async function openMode(v: TuiPluginView, mode: TuiMode, pid: string, arg: string, paint: Paint = PLAIN): Promise<ModeSession> {
  const s = new ModeSession(v, mode, pid, arg, paint);
  await s.open();
  return s;
}
