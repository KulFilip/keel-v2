// Session and shell commands: the project, budget and dashboard, the screen (panel, sidebar, mouse, theme), `!command`.

import { api, type Project } from "../sdk";
import * as fmt from "../format";
import { parseThemeName } from "../theme";
import { P, errorReply, fail, join, needProject, ok, text } from "./base";
import type { Ctx, Impl, PanelName, Reply } from "./base";

const PANELS = ["flow", "agents", "inbox", "off"] as const;

export const THEME_HELP = [
  "/theme keel (the default), /theme dark, /theme light or /theme auto (follow the background) sets the palette (KEEL_TUI_THEME sets it at the start).",
  "Your own colours stay on top of any palette: KEEL_TUI_COLORS=\"ok=#3cc463,gate=ansi:yellow\" or a `colors` object in",
  "~/.config/keel2/tui.json (the env wins). Values: #rgb, #rrggbb, an ANSI colour name or ansi:<name>, with flags: ok=#3cc463+bold (+underline +italic +dim; ok=+bold keeps the colour; +nobold). Roles: person, keelbot,",
  "heading, accent, gate (waiting), question, option, recommended, chosen, suggest, hint, detail, meta, border, ok (success),",
  "warn (warning), bad (error), code, path, link, run, add, del. NO_COLOR turns all colour off.",
];

export function dashboardUrl(ctx: Ctx, view: string): string {
  const base = ctx.core.snapshot.publicUrl;
  const pid = ctx.core.pid;
  if (view === "inbox") return `${base}/#/inbox`;
  if (!pid) return base;
  const path = { flow: "flow", map: "map", er: "map/er", keelbot: "keelbot" }[view] ?? view;
  return `${base}/#/projects/${encodeURIComponent(pid)}/${path}`;
}


/** The most of a `!command`'s output the transcript shows (KeelBot gets up to 8,000 characters of it). */
const SHELL_LINES = 200;

/** 0.18.18 `!command`: keel runs it in the chat's folder through its guard; the output is a block, kept for the next
 *  question to KeelBot. `!` alone drops a kept output. */
export async function shellRun(ctx: Ctx, command: string): Promise<Reply> {
  const p = P(ctx);
  if (!command) {
    if (!ctx.core.shell) return text("!<command> runs a shell command in the project folder through keel's guard, for example !git status.");
    const was = ctx.core.shell.command;
    ctx.core.shell = null;
    return { blocks: [{ kind: "dim", text: `  the output of !${was} is dropped: your next question goes without it` }] };
  }
  try {
    const r = await ctx.core.runShell(command);
    if (r.refused) return { blocks: [{ kind: "error", text: `refused: ${command}\n${r.refused}` }] };
    const lines = r.output.replace(/\n+$/, "").split("\n");
    const shown = lines.length > SHELL_LINES ? [`… ${lines.length - SHELL_LINES} lines above`, ...lines.slice(-SHELL_LINES)] : lines;
    return { blocks: [
      { kind: "text", text: [`${p.bold(`$ ${command}`)}`, ...(r.output.trim() ? shown : [p.dim("(no output)")]),
        r.exit === 0 ? p.ok("exit 0") : p.warn(`exit ${r.exit}`)].join("\n") },
      { kind: "dim", text: "  your next question to KeelBot gets this output (! alone drops it)" },
    ] };
  } catch (e) {
    return errorReply(e);
  }
}


export const SESSION_IMPLS: Impl[] = [
  {
    name: "project",
    complete: (ctx, a) => ctx.core.snapshot.projects.map((p) => p.id).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const name = a.trim();
      // 0.18.14 a short card of the project, not keel's whole start box again (the logo printed once per switch)
      const switched = (id: string): Reply => {
        const { project: p, flow, inbox } = ctx.core.snapshot;
        const t = flow?.thread;
        return { blocks: [
          { kind: "ok", text: `now on project ${p?.name || id}${p?.branch ? ` · branch ${p.branch}` : ""}` },
          { kind: "dim", text: [
            ...(t ? [`  flow     ${t.workflow_id} "${t.title}" · ${t.status}${t.current ? ` at ${t.current}` : ""}`] : []),
            // keel 0.18.55 a project keel does not know yet (with no flow, the next line says it)
            ...(t && fmt.initHint(p, t) ? [`  setup    ${fmt.initHint(p, t)}`] : []),
            `  waiting  ${fmt.waitingBrief(inbox, p)}`,
            `  next     ${fmt.next(p, flow).split("\n")[0]}`,
          ].join("\n") },
        ] };
      };
      if (name) return (await ctx.core.useProject(name)) ? switched(ctx.core.snapshot.project!.id)
        : fail(`No project "${name}". keel knows: ${ctx.core.snapshot.projects.map((p) => p.id).join(", ") || "none"}`);
      await ctx.core.loadProjects().catch(() => undefined);
      const ps = ctx.core.snapshot.projects;
      if (!ps.length) return fail("keel has no project yet. Add one in the dashboard (All projects › Add projects).");
      const cur = ctx.core.snapshot.project?.id;
      // the cursor starts on the project you are in, so Enter keeps it and one ↓ is the next one
      return { blocks: [], pick: { title: "Project (Enter keeps the one marked now)", index: Math.max(0, ps.findIndex((p) => p.id === cur)),
        choices: ps.map((p) => ({ label: p.id + (p.id === cur ? " (now)" : ""), value: p.id,
          hint: `${p.branch || "-"} · ${p.flow ? `${p.flow} ${p.phase}` : "no flow"}${p.waiting ? ` · ${p.waiting} waiting` : ""}` })),
        then: async (v) => (v === cur ? text(`Still on ${v}.`) : (await ctx.core.useProject(v)) ? switched(v) : fail(`No project ${v}`)) } };
    },
  },
  { name: "budget", run: async (ctx) => text(fmt.budget(await api.budgetNow(needProject(ctx).id), P(ctx))) },
  {
    name: "dashboard",
    complete: (_c, a) => ["flow", "map", "er", "keelbot", "inbox"].filter((x) => x.startsWith(a)),
    run: (ctx, a) => text(dashboardUrl(ctx, a.trim() || "flow") + "\nOpen it in your browser: the same keel, the same flows and chats."),
  },
  {
    name: "panel",
    complete: (_c, a) => PANELS.filter((x) => x.startsWith(a)),
    run: (_c, a) => {
      const p = a.trim() as PanelName | "off";
      if (!PANELS.includes(p)) return text("/panel flow, /panel agents, /panel inbox or /panel off");
      return { blocks: [], panel: p };
    },
  },
  { name: "clear", run: () => ({ blocks: [], clear: true }) },
  { name: "copy", run: (_ctx, a) => {
    const n = a.trim() ? Number(a.trim()) : 1;
    if (!Number.isInteger(n) || n < 1) return fail("/copy copies the last answer; /copy 2 the block before it, and so on.");
    return { blocks: [], copy: n };
  } },
  { name: "thinking", run: () => ({ blocks: [], thinking: true }) },
  { name: "sidebar", run: (_ctx, a) => {
    const w = a.trim().toLowerCase();
    if (w && w !== "on" && w !== "off") return fail("/sidebar on or /sidebar off (no word switches it, as Ctrl+B).");
    return { blocks: [], sidebar: w ? w === "on" : "toggle" };
  } },
  { name: "mouse", run: (_ctx, a) => {
    const w = a.trim().toLowerCase();
    if (w && w !== "on" && w !== "off") return fail("/mouse on or /mouse off (no word switches it).");
    return { blocks: [], mouse: w ? w === "on" : "toggle" };
  } },
  { name: "theme", run: (_ctx, a) => {
    // 0.18.26 no word (or "colors"): the palette and the per-role overrides (KEEL_TUI_COLORS) that are active, with the help
    if (!a.trim() || a.trim().toLowerCase() === "colors") return { blocks: [], themeInfo: true };
    const name = parseThemeName(a);
    if (!name) return fail("/theme keel, /theme dark, /theme light, /theme auto or /theme colors.");
    return { blocks: [], theme: name };
  } },
  // 0.18.18 write the prompt in the person's own editor: the words after /editor (or nothing) open in it, what they
  // save comes back into the prompt to read and send (Ctrl+X E opens the prompt as it is)
  { name: "editor", run: (_ctx, a) => ({ blocks: [], editor: a }) },
  { name: "quit", run: () => ({ blocks: [], quit: true }) },
];
