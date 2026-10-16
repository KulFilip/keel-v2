// What keel's plugins add to keel TUI (docs/plugins/25-tui-plugins.md): commands and a panel, declared as data in a
// plugin's manifest (contributes.tui) and listed by GET /api/tui/plugins. No plugin code runs here: a command calls the
// plugin's own api route and shows the answer as the manifest says (a title, a list of lines, a diff). A call that
// changes something (POST) asks first.

import { get, post } from "./sdk";
import { renderDiff } from "./diff";
import { PLAIN, type Paint } from "./theme";
import type { Command, Ctx, Reply } from "./commands";

export type TuiCall = { method: "GET" | "POST"; path: string; body?: Record<string, unknown> | null };
export type TuiShow = { title?: string | null; items?: string | null; line?: string | null; diff?: string | null; empty?: string | null; max?: number | null };
export type TuiAction = { summary: string; call: TuiCall; show: TuiShow; confirm?: string | null };
export type TuiCommand = { name: string; args?: string | null; summary: string; sub?: Record<string, TuiAction> | null; call?: TuiCall | null;
  show?: TuiShow | null; confirm?: string | null };
export type TuiPanel = { title: string; key?: string | null; every: number; call: TuiCall; show: TuiShow };
export type TuiPluginView = { name: string; title: string; version: string; commands: TuiCommand[]; panel?: TuiPanel | null };
export type TuiPlugins = { plugins: TuiPluginView[]; problems: { plugin: string; error: string }[] };

export async function loadPlugins(pid: string | null): Promise<TuiPlugins> {
  return get<TuiPlugins>(`/tui/plugins${pid ? `?project=${encodeURIComponent(pid)}` : ""}`).catch(() => ({ plugins: [], problems: [] }));
}

/** a.b.c of a JSON value ("." is the value itself). */
export function pick(data: unknown, path: string): unknown {
  if (path === "." || path === "") return data;
  return path.split(".").reduce<unknown>((v, k) => (v && typeof v === "object" ? (v as Record<string, unknown>)[k] : undefined), data);
}

/** "{branch} · ahead {ahead}" with the answer's fields; a missing one is empty. */
export function fill(template: string, data: unknown): string {
  return template.replace(/\{([\w.]+)\}/g, (_, k: string) => {
    const v = pick(data, k);
    return v === undefined || v === null ? "" : typeof v === "object" ? JSON.stringify(v) : String(v);
  });
}

/** The call's path with the project and the person's words ({pid}, {arg}), each part encoded. */
export function pathOf(call: TuiCall, pid: string, arg: string): string {
  return call.path.replace(/\{pid\}/g, encodeURIComponent(pid)).replace(/\{args?\}/g, encodeURIComponent(arg));
}

/** An answer as the manifest says it reads. */
export function render(data: unknown, show: TuiShow | null | undefined, c: Paint = PLAIN, width = 100): string {
  if (!show || (!show.title && !show.items && !show.diff)) return JSON.stringify(data, null, 2);
  const out: string[] = [];
  if (show.title) out.push(c.bold(c.accent(fill(show.title, data))));
  if (show.diff) {
    const d = String(pick(data, show.diff) ?? "");
    if (d.trim()) out.push(...renderDiff(d.replace(/\n$/, ""), c).slice(0, show.max ?? 400));
    else if (show.empty) out.push(c.dim(show.empty));
  }
  if (show.items) {
    const list = pick(data, show.items);
    const rows = Array.isArray(list) ? list : [];
    const max = show.max ?? 50;
    if (!rows.length && show.empty) out.push(c.dim(show.empty));
    for (const row of rows.slice(0, max)) {
      const text = show.line ? fill(show.line, row) : typeof row === "string" ? row : JSON.stringify(row);
      out.push(text.length > width ? text.slice(0, width - 1) + "…" : text);
    }
    if (rows.length > max) out.push(c.faint(`… ${rows.length - max} more`));
  }
  return out.join("\n");
}

async function callIt(call: TuiCall, pid: string, arg: string): Promise<unknown> {
  const path = pathOf(call, pid, arg);
  return call.method === "POST" ? post<unknown>(path, call.body ?? {}) : get<unknown>(path);
}

/** keel TUI commands from what the plugins declare; a name keel already has is left out. */
export function pluginCommands(views: TuiPluginView[], taken: Set<string>): Command[] {
  const out: Command[] = [];
  for (const v of views) {
    for (const cmd of v.commands) {
      if (taken.has(cmd.name)) continue;
      const subs = cmd.sub ?? null;
      out.push({
        name: cmd.name, args: cmd.args ?? (subs ? `<${Object.keys(subs).join("|")}>` : undefined), summary: cmd.summary, group: `Plugins`,
        writes: !!(cmd.call?.method === "POST" || Object.values(subs ?? {}).some((a) => a.call.method === "POST")),
        complete: subs ? (_ctx, a) => Object.keys(subs).filter((w) => w.startsWith(a.trim())) : undefined,
        run: (ctx, args) => {
          const [word, ...rest] = args.trim().split(/\s+/);
          const action: TuiAction | null = subs ? subs[word ?? ""] ?? null
            : { summary: cmd.summary, call: cmd.call!, show: cmd.show ?? {}, confirm: cmd.confirm };
          if (!action) return { blocks: [{ kind: "text", text: `/${cmd.name} ${Object.keys(subs ?? {}).join(" | ")} (the ${v.title} plugin)` }] };
          const arg = subs ? rest.join(" ") : args.trim();
          return runAction(ctx, v, action, arg);
        },
      });
    }
  }
  return out;
}

async function runAction(ctx: Ctx, v: TuiPluginView, a: TuiAction, arg: string): Promise<Reply> {
  const pid = ctx.core.pid;
  if (!pid) return { blocks: [{ kind: "error", text: "No project: /project picks one." }] };
  const go = async (): Promise<Reply> => {
    const data = await callIt(a.call, pid, arg);
    return { blocks: [{ kind: "text", text: render(data, a.show, ctx.paint ?? PLAIN, ctx.width - 2) }] };
  };
  if (a.call.method === "POST") {
    return { blocks: [], pick: { title: a.confirm || `${a.summary}?`, choices: [{ label: "Yes", value: "yes", hint: `the ${v.title} plugin` },
      { label: "No", value: "no" }], then: (x) => (x === "yes" ? go() : { blocks: [{ kind: "dim", text: "  not done" }] }) } };
  }
  return go();
}

/** A plugin panel's text, read again every `every` seconds by the app. */
export async function panelText(panel: TuiPanel, pid: string, c: Paint, width: number): Promise<string> {
  try {
    return render(await callIt(panel.call, pid, ""), panel.show, c, width);
  } catch (e) {
    return c.bad(e instanceof Error ? e.message : String(e));
  }
}
