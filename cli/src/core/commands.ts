// keel TUI's slash commands: names, arguments, help text, what each one does and how its answer reads. No UI here:
// a command returns a Reply (blocks of text, and maybe a choice to pick or a question to answer next), so keel TUI's
// Ink app, an xal plugin or an OpenTUI front end run the very same commands.

import { api, ApiError, errorParts, get, post, type HelperSession, type Job, type JobStep, type Model, type Project,
  type ThreadState, type Workflow } from "./sdk";
import { inboxApi, type InboxItem } from "../../../web/src/inboxApi";
import { rulesApi } from "../../../web/src/rulesApi";
import * as fmt from "./format";
import { setCommand } from "./transport";
import type { KeelCore } from "./keel";

// ------------------------------------------------------------------ replies

export type BlockKind = "text" | "markdown" | "diagram" | "error" | "notice" | "user" | "ok" | "dim";
export type Block = { kind: BlockKind; text: string };
export type Choice = { label: string; value: string; hint?: string };
/** Pick one of these; `then` runs with the chosen value. */
export type Pick = { title: string; choices: Choice[]; then: (value: string) => Promise<Reply> | Reply };
/** The next line the person types answers this; `then` runs with it. */
export type Ask = { prompt: string; then: (text: string) => Promise<Reply> | Reply };
export type PanelName = "flow" | "agents" | "inbox";
export type Reply = { blocks: Block[]; pick?: Pick; ask?: Ask; quit?: boolean; clear?: boolean; panel?: PanelName | "off"; chat?: string };

export const text = (t: string): Reply => ({ blocks: [{ kind: "text", text: t }] });
export const ok = (t: string): Reply => ({ blocks: [{ kind: "ok", text: t }] });
export const fail = (t: string): Reply => ({ blocks: [{ kind: "error", text: t }] });
export const diagram = (t: string): Reply => ({ blocks: [{ kind: "diagram", text: t.replace(/\n+$/, "") }] });
const join = (...rs: Reply[]): Reply => ({ ...Object.assign({}, ...rs), blocks: rs.flatMap((r) => r.blocks) });

export function errorReply(e: unknown): Reply {
  const p = errorParts(e);
  return fail(p.message + (p.hint ? `\n${p.hint}` : "") + (p.details?.length ? "\n" + p.details.map((d) => "  " + d).join("\n") : ""));
}

// ------------------------------------------------------------------ the registry

export type Ctx = { core: KeelCore; width: number };
export type Command = {
  name: string;
  args?: string;
  summary: string;
  /** the words after the name; "" when none */
  run: (ctx: Ctx, args: string) => Promise<Reply> | Reply;
  /** completions for the argument being typed */
  complete?: (ctx: Ctx, arg: string) => string[];
  aliases?: string[];
};

const needProject = (ctx: Ctx): Project => {
  const p = ctx.core.snapshot.project;
  if (!p) throw new ApiError("No project yet.", 0, "Add one in the dashboard (All projects › Add projects), then /project.");
  return p;
};
const flowNow = (ctx: Ctx): ThreadState | null => ctx.core.snapshot.flow?.thread ?? null;

const DIAGRAM_KINDS = ["flow", "workflow", "map-er", "map-system", "map-modules", "graph"] as const;
const PANELS = ["flow", "agents", "inbox", "off"] as const;

let workflowCache: { pid: string; rows: Workflow[] } | null = null;
async function workflows(ctx: Ctx): Promise<Workflow[]> {
  const pid = needProject(ctx).id;
  if (workflowCache?.pid !== pid) workflowCache = { pid, rows: await api.workflows(pid) };
  return workflowCache.rows;
}
const cachedWorkflowIds = (ctx: Ctx) => (workflowCache?.pid === ctx.core.pid ? workflowCache.rows.map((w) => w.id) : []);

/** keel's ASCII renderer (engine diagrams.py through POST /api/diagrams/ascii). */
export async function draw(ctx: Ctx, kind: string, data: unknown, zoom?: string, maxLines = 60): Promise<string> {
  const r = await post<{ text: string }>("/diagrams/ascii", { kind, data, width: Math.max(60, Math.min(ctx.width - 2, 160)), max_lines: maxLines,
    ...(zoom ? { zoom } : {}) });
  return r.text;
}

async function startFlow(ctx: Ctx, wid: string, idea: string, flags: { fake?: boolean; dirty?: boolean } = {}): Promise<Reply> {
  const p = needProject(ctx);
  const first = idea.split("\n")[0].trim();
  const title = first.length <= 72 ? first : first.slice(0, 71).trimEnd() + "…";
  try {
    const t = await api.startFlow(p.id, { workflow_id: wid, title, request: idea, options: { started_via: "tui" },
      ...(flags.fake ? { allow_fake: true } : {}), ...(flags.dirty ? { allow_dirty: true } : {}) });
    await ctx.core.refresh();
    const lines = [`started ${wid} "${title}" on ${p.id} (thread ${t.thread_id}), recorded as started via keel TUI.`,
      `It is ${t.status} at ${t.current || "-"} (phase ${t.phase || "none"}); it runs until its first gate for you.`];
    if (t.cap_note) lines.push(t.cap_note);
    lines.push("Follow it: Ctrl+F (flow rail), /live (agents), /next.");
    return ok(lines.join("\n"));
  } catch (e) {
    if (e instanceof ApiError && e.status === 409) {
      const m = (e.message + " " + (e.hint ?? "")).toLowerCase();
      const why = m.includes("fake model") && !flags.fake ? "fake" : (m.includes("uncommitted") || m.includes("dirty")) && !flags.dirty ? "dirty" : null;
      if (why) {
        return { blocks: errorReply(e).blocks, pick: { title: why === "fake" ? "Run with the fake model anyway?" : "Start with the uncommitted work in the folder?",
          choices: [{ label: "Yes, start it", value: "yes" }, { label: "No", value: "no" }],
          then: (v) => (v === "yes" ? startFlow(ctx, wid, idea, { ...flags, [why]: true }) : text("Not started.")) } };
      }
    }
    return errorReply(e);
  }
}

async function decide(ctx: Ctx, decision: "approve" | "reject", rest: string): Promise<Reply> {
  const m = /^#?(\d+)\b\s*(.*)$/s.exec(rest.trim());
  if (m) {
    // /approve 2 — the inbox's second item, in any project
    const items = ctx.core.snapshot.inbox.length ? ctx.core.snapshot.inbox : (await inboxApi.list()).items;
    const item = items[Number(m[1]) - 1];
    if (!item) return fail(`The inbox has no item ${m[1]} (it has ${items.length}). /inbox lists them.`);
    return decideItem(ctx, item, decision, m[2].trim());
  }
  const t = flowNow(ctx);
  if (!t || t.status !== "waiting" || !t.waiting) {
    const n = ctx.core.snapshot.inbox.length;
    return fail(`Nothing waits on ${ctx.core.snapshot.project?.id ?? "this project"}.` + (n ? ` The inbox has ${n}: /inbox, then /${decision} <n>.` : ""));
  }
  const w = t.waiting;
  if (!(w.options ?? ["approve", "reject"]).includes(decision)) return fail(`${w.title} takes only: ${(w.options ?? []).join(", ")}`);
  if (w.kind === "clarify" && decision === "approve") return fail(`${w.title} asks questions: /answer goes through them.`);
  if (decision === "reject" && !rest.trim()) return fail("Say why: /reject <why>. The reason goes back to the agent.");
  return actOnFlow(ctx, t, decision, rest.trim());
}

async function actOnFlow(ctx: Ctx, t: ThreadState, decision: "approve" | "reject", why: string, payload?: Record<string, unknown>): Promise<Reply> {
  const before = t.waiting?.title ?? "the gate";
  try {
    const s = await inboxApi.act(t.thread_id, { decision, ...(why ? { why } : {}), ...(payload ? { payload } : {}), id: t.waiting?.id ?? null });
    await ctx.core.refresh();
    const after = `${s.status} at ${s.current || "-"} (phase ${s.phase || "none"})` + (s.waiting ? `; now waiting: ${s.waiting.title}` : "");
    return ok(`${decision === "approve" ? "approved" : "sent back"} ${before}. The flow is ${after}.`);
  } catch (e) {
    return errorReply(e);
  }
}

async function decideItem(ctx: Ctx, item: InboxItem, decision: "approve" | "reject", why: string): Promise<Reply> {
  try {
    if (item.permission) {
      const d = decision === "approve" ? "once" : "deny";
      await inboxApi.decide(item.permission.id, d, why);
      await ctx.core.refresh();
      return ok(`${d === "once" ? "allowed once" : "refused"}: ${item.permission.command}`);
    }
    if (item.kind === "clarify" && decision === "approve") return fail("That one asks questions: /project " + item.project_id + ", then /answer.");
    if (decision === "reject" && !why) return fail(`Say why: /reject ${ctx.core.snapshot.inbox.indexOf(item) + 1} <why>.`);
    const s = await inboxApi.act(item.thread_id, { decision, ...(why ? { why } : {}), id: item.id ?? null });
    await ctx.core.refresh();
    return ok(`${decision === "approve" ? "approved" : "sent back"} ${item.title} (${item.project_name}). The flow is ${s.status} at ${s.current || "-"}.`);
  } catch (e) {
    return errorReply(e);
  }
}

/** /answer for a clarify gate: one pick per question (recommended first; "Other…" asks for own words). */
function askQuestions(ctx: Ctx, t: ThreadState, k: number, answers: Record<string, string>): Promise<Reply> | Reply {
  const qs = t.waiting?.questions ?? [];
  if (k >= qs.length) return actOnFlow(ctx, t, "approve", "", { answers });
  const q = qs[k];
  const opts = [...q.options].sort((a, b) => Number(!!b.recommended) - Number(!!a.recommended));
  return {
    blocks: [{ kind: "text", text: `${k + 1}/${qs.length} ${q.question}` + (q.why ? `\n   ${q.why}` : "") }],
    pick: {
      title: q.question,
      choices: [...opts.map((o) => ({ label: o.label + (o.recommended ? " (recommended)" : ""), value: o.label, hint: o.description })),
        { label: "Other… (my own words)", value: "\u0000other" }],
      then: (v) => v === "\u0000other"
        ? { blocks: [], ask: { prompt: q.question, then: (own) => askQuestions(ctx, t, k + 1, { ...answers, [q.id]: own }) } }
        : askQuestions(ctx, t, k + 1, { ...answers, [q.id]: v }),
    },
  };
}

function pickWorkflowThen(ctx: Ctx, rows: Workflow[], then: (w: Workflow) => Promise<Reply> | Reply, title: string): Reply {
  return { blocks: [], pick: { title, choices: rows.map((w) => ({ label: w.id, value: w.id, hint: `${w.name} · ${w.steps.length} steps` })),
    then: (v) => then(rows.find((w) => w.id === v)!) } };
}

async function flowDiagram(ctx: Ctx, zoom?: string): Promise<Reply> {
  const p = needProject(ctx);
  const view = await api.flow(p.id);
  if (!view.thread || !view.workflow) return text("No flow on this project: /flow starts one, /workflows shows them.");
  const hist = await api.history(view.thread.thread_id).catch(() => []);
  return diagram(await draw(ctx, "flow", { workflow: view.workflow, thread: view.thread, visited: hist.map((c) => c.step) }, zoom, 400));
}

type MapView = { missing?: string; schema?: unknown; levels?: Record<string, unknown> };

export const COMMANDS: Command[] = [
  { name: "help", summary: "what keel TUI can do", run: () => text(helpText()) , aliases: ["?"] },
  {
    name: "project", args: "[name]", summary: "pick the project (or switch to one by name)",
    complete: (ctx, a) => ctx.core.snapshot.projects.map((p) => p.id).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const name = a.trim();
      if (name) return (await ctx.core.useProject(name)) ? ok(`project ${ctx.core.snapshot.project?.id} · branch ${ctx.core.snapshot.project?.branch || "-"}`)
        : fail(`No project "${name}". keel knows: ${ctx.core.snapshot.projects.map((p) => p.id).join(", ") || "none"}`);
      const ps = ctx.core.snapshot.projects;
      if (!ps.length) return fail("keel has no project yet. Add one in the dashboard (All projects › Add projects).");
      return { blocks: [], pick: { title: "Project", choices: ps.map((p) => ({ label: p.id, value: p.id,
        hint: `${p.branch || "-"} · ${p.flow ? `${p.flow} ${p.phase}` : "no flow"}${p.waiting ? ` · ${p.waiting} waiting` : ""}` })),
        then: async (v) => ((await ctx.core.useProject(v)) ? ok(`project ${v}`) : fail(`No project ${v}`)) } };
    },
  },
  {
    name: "flow", args: "[workflow] [idea…]", summary: "start a flow: pick the workflow, then say the idea",
    complete: (ctx, a) => cachedWorkflowIds(ctx).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const rows = await workflows(ctx);
      const flags = { fake: /(^|\s)--fake(\s|$)/.test(a), dirty: /(^|\s)--dirty(\s|$)/.test(a) };
      const rest = a.replace(/(^|\s)--(fake|dirty)(?=\s|$)/g, " ").trim();
      const [first, ...more] = rest.split(/\s+/);
      const wf = rows.find((w) => w.id === first);
      const idea = wf ? more.join(" ").trim() : "";
      const ask = (w: Workflow): Reply => ({ blocks: [], ask: { prompt: `What should the ${w.id} flow do? (one or two sentences)`,
        then: (t) => (t.trim() ? startFlow(ctx, w.id, t.trim(), flags) : text("Not started: the idea was empty.")) } });
      if (wf && idea) return startFlow(ctx, wf.id, idea, flags);
      if (wf) return ask(wf);
      if (first) return fail(`No workflow "${first}". This project has: ${rows.map((w) => w.id).join(", ")}`);
      return pickWorkflowThen(ctx, rows, ask, "Which flow?");
    },
  },
  { name: "flows", summary: "this project's flows, newest first", run: async (ctx) => text(fmt.flows(await api.runs(needProject(ctx).id, undefined, 20))) },
  {
    name: "resume", summary: "go on with a stopped or failed flow from its last saved step",
    run: async (ctx) => {
      const t = flowNow(ctx);
      if (!t) return fail("No flow on this project.");
      if (t.status === "waiting" || t.status === "running") return text(`The flow is ${t.status}: nothing to resume. ${t.status === "waiting" ? "/approve or /reject <why>." : ""}`);
      if (t.status === "done") return text("The flow is done: start a new one with /flow.");
      const h = await api.history(t.thread_id);
      const last = [...h].sort((a, b) => b.n - a.n)[0];
      if (!last) return fail("This flow has no saved step yet: start it again with /flow.");
      await api.rewind(t.thread_id, last.id);
      await ctx.core.refresh();
      return ok(`Resumed after "${last.step}". The next step runs now.`);
    },
  },
  {
    name: "stop", summary: "stop the project's flow (every finished step stays saved)",
    run: (ctx) => {
      const t = flowNow(ctx);
      if (!t || !["running", "waiting"].includes(t.status)) return text("No running flow to stop.");
      return { blocks: [], pick: { title: `Stop "${t.title}"? Agents at work stop; /resume goes on later.`,
        choices: [{ label: "Yes, stop it", value: "yes" }, { label: "No", value: "no" }],
        then: async (v) => {
          if (v !== "yes") return text("Not stopped.");
          await api.stopThread(t.thread_id);
          await ctx.core.refresh();
          return ok("Stopped. Every finished step is saved: /resume goes on from there.");
        } } };
    },
  },
  { name: "status", summary: "the flow: step, phase, criteria, what waits, tokens", run: async (ctx) => {
    await ctx.core.refresh();
    return text(fmt.status(needProject(ctx), ctx.core.snapshot.flow));
  } },
  { name: "next", summary: "what to do next", run: async (ctx) => {
    await ctx.core.refresh();
    return text(fmt.next(ctx.core.snapshot.project, ctx.core.snapshot.flow));
  } },
  { name: "inbox", summary: "everything that waits for you, in every project", run: async (ctx) => {
    await ctx.core.refresh();
    const items = ctx.core.snapshot.inbox;
    return text(fmt.inbox(items) + (items.length ? "\n\n/approve <n> or /reject <n> <why> answers one; Ctrl+B keeps the inbox on screen." : ""));
  } },
  { name: "approve", args: "[n]", summary: "approve what waits (or inbox item n)", run: (ctx, a) => decide(ctx, "approve", a) },
  { name: "reject", args: "[n] <why>", summary: "send back what waits, with the reason", run: (ctx, a) => decide(ctx, "reject", a) },
  {
    name: "answer", args: "[choice | q1=answer …]", summary: "answer a gate's questions or choose one of its exits",
    run: async (ctx, a) => {
      await ctx.core.refresh();
      const t = flowNow(ctx);
      const w = t?.waiting;
      if (!t || !w) return fail("Nothing waits for an answer here.");
      const arg = a.trim();
      if (w.kind === "clarify") {
        const pairs = [...arg.matchAll(/(\w[\w-]*)=("[^"]*"|\S+)/g)];
        if (pairs.length) return actOnFlow(ctx, t, "approve", "", { answers: Object.fromEntries(pairs.map((m) => [m[1], m[2].replace(/^"|"$/g, "")])) });
        return askQuestions(ctx, t, 0, {});
      }
      if (w.choices?.length) {
        if (arg) return w.choices.includes(arg) ? actOnFlow(ctx, t, "approve", "", { choice: arg }) : fail(`Choose one of: ${w.choices.join(", ")}`);
        return { blocks: [], pick: { title: w.title, choices: w.choices.map((c) => ({ label: c, value: c })),
          then: (v) => actOnFlow(ctx, t, "approve", "", { choice: v }) } };
      }
      return text(`${w.title}: /approve or /reject <why>.`);
    },
  },
  { name: "jobs", summary: "the project's agent calls, newest first", run: async (ctx) => text(fmt.jobs(await api.jobs({ project: needProject(ctx).id, limit: 20 }))) },
  {
    name: "live", summary: "the agents at work now and their last step", run: async (ctx) => {
      const running = await api.jobs({ status: "running", limit: 50 });
      const last: Record<string, JobStep | undefined> = {};
      await Promise.all(running.map(async (j: Job) => {
        const s = await api.jobSteps(j.id).catch(() => ({ steps: [] as JobStep[] }));
        last[j.id] = s.steps[s.steps.length - 1];
      }));
      return { ...text(fmt.live(running, last) + (running.length ? "\n\nCtrl+A keeps the agents on screen." : "")) };
    },
  },
  {
    name: "steps", args: "[job]", summary: "the flow's steps with their state (or one agent call's steps)",
    run: async (ctx, a) => {
      const id = a.trim();
      if (!id) return flowDiagram(ctx);
      const r = await api.jobSteps(id);
      return text(r.steps.length ? r.steps.map((s) => `${String(s.n).padStart(3)} ${fmt.stepLine(s, Math.max(60, ctx.width - 6))}`).join("\n") + (r.running ? "\n… still running" : "")
        : "no steps yet.");
    },
  },
  {
    name: "timeline", summary: "what happened: steps and agent runs, newest first",
    run: async (ctx) => {
      const p = needProject(ctx);
      const t = flowNow(ctx);
      const [hist, jobs] = await Promise.all([t ? api.history(t.thread_id) : Promise.resolve([]), api.jobs({ project: p.id, limit: 20 })]);
      return text(fmt.timeline(hist, jobs, 20, t));
    },
  },
  {
    name: "workflows", args: "[workflow]", summary: "the project's workflows, and a workflow as a diagram",
    complete: (ctx, a) => cachedWorkflowIds(ctx).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const rows = await workflows(ctx);
      const [id, zoom] = a.trim().split(/\s+/);
      if (id) {
        const w = rows.find((x) => x.id === id);
        if (!w) return fail(`No workflow "${id}". This project has: ${rows.map((x) => x.id).join(", ")}`);
        return diagram(await draw(ctx, "workflow", { workflow: w }, zoom));
      }
      return join(text(fmt.workflowsList(rows)), pickWorkflowThen(ctx, rows, async (w) => diagram(await draw(ctx, "workflow", { workflow: w })), "Draw which workflow?"));
    },
  },
  {
    name: "diagram", args: "<flow|workflow <id>|map-er [table]|map-system|map-modules|graph <symbol>> [zoom]", summary: "keel's diagrams in ASCII",
    complete: (ctx, a) => {
      const [k, rest] = a.split(/\s+/, 2);
      if (rest === undefined) return DIAGRAM_KINDS.filter((x) => x.startsWith(k));
      return k === "workflow" ? cachedWorkflowIds(ctx).filter((x) => x.startsWith(rest)).map((x) => `${k} ${x}`) : [];
    },
    run: async (ctx, a) => {
      const [kind, arg, zoom] = a.trim().split(/\s+/);
      const p = needProject(ctx);
      if (!kind) return { blocks: [], pick: { title: "Which diagram?", choices: DIAGRAM_KINDS.map((k) => ({ label: k, value: k })),
        then: (v) => (v === "workflow" || v === "graph" ? text(`/diagram ${v} <${v === "graph" ? "symbol" : "id"}>`) : COMMANDS_BY_NAME.diagram.run(ctx, v)) } };
      if (kind === "flow") return flowDiagram(ctx, arg);
      if (kind === "workflow") {
        if (!arg) return COMMANDS_BY_NAME.workflows.run(ctx, "");
        return COMMANDS_BY_NAME.workflows.run(ctx, [arg, zoom].filter(Boolean).join(" "));
      }
      if (kind === "map-er" || kind === "map-system" || kind === "map-modules") {
        const m = await get<MapView>(`/projects/${encodeURIComponent(p.id)}/map`);
        if (m.missing) return fail(`No map yet: ${m.missing}. The Map page in the dashboard builds it.`);
        if (kind === "map-er") return diagram(await draw(ctx, "map-er", { schema: m.schema ?? { tables: [], relations: [] }, ...(arg ? { focus: arg } : {}) }));
        const level = m.levels?.[kind === "map-system" ? "system" : "modules"];
        if (!level) return fail(`The map has no ${kind.slice(4)} level.`);
        return diagram(await draw(ctx, kind, { level }, arg));
      }
      if (kind === "graph") {
        if (!arg) return fail("Which symbol? /diagram graph <name>");
        const hits = await api.graphSearch(p.id, arg);
        if (!hits.available) return fail(`The code graph is not ready: ${hits.reason ?? "build it in the dashboard (Code › Graph)"}`);
        const hit = hits.results.find((h) => h.name === arg) ?? hits.results[0];
        if (!hit) return fail(`No symbol "${arg}" in the code graph.`);
        const focus = await get<Record<string, unknown>>(`/projects/${encodeURIComponent(p.id)}/graph/node?id=${encodeURIComponent(hit.id)}&depth=2`);
        return diagram(await draw(ctx, "graph", focus));
      }
      return fail(`No diagram "${kind}". keel draws: ${DIAGRAM_KINDS.join(", ")}`);
    },
  },
  {
    name: "rules", summary: "keel's rules for this project, and what agents may change right now",
    run: async (ctx) => {
      const p = needProject(ctx);
      const t = flowNow(ctx);
      const [v, now] = await Promise.all([rulesApi.view(p.id), t ? rulesApi.now(t.thread_id).catch(() => null) : Promise.resolve(null)]);
      return text(fmt.rules(p, v as never, now as never));
    },
  },
  {
    name: "plugins", summary: "the plugins keel has, and which are on here",
    run: async (ctx) => {
      const body = await get<unknown>("/plugins/installed");
      const rows = (Array.isArray(body) ? body : ((body as { plugins?: unknown[] })?.plugins ?? [])) as never[];
      const here = ctx.core.pid ? await api.plugins(ctx.core.pid).catch(() => []) : [];
      return text(fmt.plugins(rows, here.map((x) => ({ name: x.name, enabled: !!(x as { enabled?: boolean }).enabled }))));
    },
  },
  { name: "budget", summary: "tokens and money today, this month, per flow, and the caps", run: async (ctx) => text(fmt.budget(await api.budgetNow(needProject(ctx).id))) },
  {
    name: "dashboard", args: "[flow|map|er|keelbot|inbox]", summary: "the dashboard's link for this project",
    complete: (_c, a) => ["flow", "map", "er", "keelbot", "inbox"].filter((x) => x.startsWith(a)),
    run: (ctx, a) => text(dashboardUrl(ctx, a.trim() || "flow") + "\nOpen it in your browser: the same keel, the same flows and chats."),
  },
  {
    name: "model", summary: "KeelBot's model (from keel's catalog)",
    run: async (ctx) => {
      const raw = (await api.providerModels()) as Record<string, { label?: string; modes?: Record<string, { id: string; label: string }[]>; default?: Model }>;
      const choices: Choice[] = [];
      for (const [prov, c] of Object.entries(raw ?? {})) {
        for (const [mode, models] of Object.entries(c?.modes ?? {})) {
          for (const m of models ?? []) choices.push({ label: `${prov}/${m.id}`, value: JSON.stringify({ provider: prov, mode, model: m.id }), hint: `${c.label ?? prov} · ${mode} · ${m.label}` });
        }
      }
      if (!choices.length) return fail("keel's model catalog is empty.");
      return { blocks: [], pick: { title: "KeelBot's model", choices, then: async (v) => {
        const m = JSON.parse(v) as Model;
        await ctx.core.setChatModel(m);
        return ok(`KeelBot answers with ${m.provider}/${m.model} (${m.mode}).`);
      } } };
    },
  },
  {
    name: "chats", summary: "earlier KeelBot chats of this project: open one",
    run: async (ctx) => {
      const rows = await ctx.core.chats();
      if (!rows.length) return text("No chats yet: type a question.");
      return { blocks: [], pick: { title: "Open which chat?", choices: rows.slice(0, 30).map((s: HelperSession) => ({ label: s.title || s.id, value: s.id,
        hint: `${s.mode} · ${s.turns} turns · ${fmt.clock(s.updated_at)}` })),
        then: async (v) => {
          const s = await ctx.core.openChat(v);
          const blocks: Block[] = [{ kind: "dim", text: `chat "${s.title}" · ${s.mode} · ${s.turns} turns` }];
          (s.messages ?? []).slice(-6).forEach((m) => blocks.push(m.role === "user" ? { kind: "user", text: m.text } : { kind: m.role === "note" ? "dim" : "markdown", text: m.text }));
          return { blocks };
        } } };
    },
  },
  { name: "new", summary: "a new KeelBot chat", run: (ctx) => { ctx.core.newChat(); return ok("New chat: the next message starts it."); } },
  {
    name: "mode", args: "<ask|fix>", summary: "KeelBot's mode: ask (reads, changes nothing) or fix (keel's rules apply)",
    complete: (_c, a) => ["ask", "fix"].filter((x) => x.startsWith(a)),
    run: (ctx, a) => {
      const m = a.trim();
      if (m !== "ask" && m !== "fix") return text(`KeelBot is in ${ctx.core.snapshot.chat.mode} mode. /mode ask or /mode fix.`);
      ctx.core.setChatMode(m);
      return ok(`KeelBot: ${m} mode (a new chat starts with the next message).`);
    },
  },
  {
    name: "panel", args: "<flow|agents|inbox|off>", summary: "show a panel, or none (keys: Ctrl+F, Ctrl+A, Ctrl+B toggle them)",
    complete: (_c, a) => PANELS.filter((x) => x.startsWith(a)),
    run: (_c, a) => {
      const p = a.trim() as PanelName | "off";
      if (!PANELS.includes(p)) return text("/panel flow, /panel agents, /panel inbox or /panel off");
      return { blocks: [], panel: p };
    },
  },
  { name: "clear", summary: "clear the screen", run: () => ({ blocks: [], clear: true }) },
  { name: "quit", summary: "leave keel TUI (keel keeps running)", run: () => ({ blocks: [], quit: true }), aliases: ["exit", "q"] },
];

export const COMMANDS_BY_NAME: Record<string, Command> = Object.fromEntries(COMMANDS.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c])]));

export function dashboardUrl(ctx: Ctx, view: string): string {
  const base = ctx.core.snapshot.publicUrl;
  const pid = ctx.core.pid;
  if (view === "inbox") return `${base}/#/inbox`;
  if (!pid) return base;
  const path = { flow: "flow", map: "map", er: "map/er", keelbot: "keelbot" }[view] ?? view;
  return `${base}/#/projects/${encodeURIComponent(pid)}/${path}`;
}

export function helpText(): string {
  const w = Math.max(...COMMANDS.map((c) => (c.name + (c.args ? " " + c.args : "")).length));
  const cut = Math.min(w, 34);
  return ["Type a question for KeelBot, or a command:", "",
    ...COMMANDS.map((c) => {
      const head = `/${c.name}${c.args ? " " + c.args : ""}`;
      return head.length > cut + 1 ? `  ${head}\n  ${" ".repeat(cut + 3)}${c.summary}` : `  ${head.padEnd(cut + 3)}${c.summary}`;
    }),
    "", "Keys: Tab completes · ↑/↓ history · Ctrl+F flow rail · Ctrl+A agents · Ctrl+B inbox · Esc stops KeelBot's answer · Ctrl+C twice quits",
    "KeelBot's own commands (/gate, /where …) go to KeelBot as they are."].join("\n");
}

// ------------------------------------------------------------------ parse, complete, run

export type Parsed = { kind: "command"; name: string; args: string; command: Command | null } | { kind: "chat"; text: string } | { kind: "empty" };

export function parse(input: string): Parsed {
  const t = input.trim();
  if (!t) return { kind: "empty" };
  if (!t.startsWith("/") || t.startsWith("//")) return { kind: "chat", text: t.startsWith("//") ? t.slice(1) : t };
  const m = /^\/([\w?-]*)\s*([\s\S]*)$/.exec(t)!;
  const name = m[1].toLowerCase();
  return { kind: "command", name, args: m[2] ?? "", command: COMMANDS_BY_NAME[name] ?? null };
}

export type Completion = { value: string; label: string; hint?: string };

/** What Tab offers for the line typed so far: command names, then each command's argument. */
export function complete(ctx: Ctx, input: string, extra: { name: string; description: string }[] = []): Completion[] {
  if (!input.startsWith("/")) return [];
  const m = /^\/([\w?-]*)(\s+([\s\S]*))?$/.exec(input);
  if (!m) return [];
  const [, name, space, arg] = m;
  if (space === undefined) {
    const mine = COMMANDS.filter((c) => c.name.startsWith(name.toLowerCase()))
      .map((c) => ({ value: `/${c.name}${c.args ? " " : ""}`, label: `/${c.name}${c.args ? " " + c.args : ""}`, hint: c.summary }));
    const bot = extra.filter((c) => c.name.startsWith(name) && !COMMANDS_BY_NAME[c.name])
      .map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, hint: `KeelBot · ${c.description}` }));
    return [...mine, ...bot];
  }
  const cmd = COMMANDS_BY_NAME[name.toLowerCase()];
  if (!cmd?.complete) return [];
  return cmd.complete(ctx, arg ?? "").map((v) => ({ value: `/${cmd.name} ${v}`, label: v }));
}

/** Run one line the person typed. Plain text (and KeelBot's own commands) asks KeelBot: the Reply says so in `chat`. */
export async function run(ctx: Ctx, input: string, keelbot: { name: string }[] = []): Promise<Reply> {
  const p = parse(input);
  if (p.kind === "empty") return { blocks: [] };
  if (p.kind === "chat") return { blocks: [], chat: p.text };
  if (!p.command) {
    if (keelbot.some((c) => c.name === p.name)) return { blocks: [], chat: input.trim() };
    return fail(`No command /${p.name}. /help lists them.`);
  }
  setCommand(`/${p.command.name}`);
  try {
    return await p.command.run(ctx, p.args);
  } catch (e) {
    return errorReply(e);
  } finally {
    setCommand("");
  }
}

/** Run what a Pick or an Ask hands back, with the command's name still on its requests. */
export async function follow(name: string, fn: () => Promise<Reply> | Reply): Promise<Reply> {
  setCommand(name);
  try {
    return await fn();
  } catch (e) {
    return errorReply(e);
  } finally {
    setCommand("");
  }
}
