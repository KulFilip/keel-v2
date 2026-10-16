// keel TUI's slash commands: names, arguments, help text, what each one does and how its answer reads. No UI here:
// a command returns a Reply (blocks of text, and maybe a choice to pick or a question to answer next), so keel TUI's
// Ink app, an xal plugin or an OpenTUI front end run the very same commands.

import { api, ApiError, errorParts, get, post, type HelperSession, type Job, type JobStep, type Model, type Project,
  type HelperMode, type RunMode, type ThreadState, type Workflow } from "./sdk";
import { inboxApi, type InboxItem } from "../../../web/src/inboxApi";
import { rulesApi } from "../../../web/src/rulesApi";
import * as fmt from "./format";
import { setCommand } from "./transport";
import type { KeelCore } from "./keel";
import { PLAIN, type Paint } from "./theme";
import table from "../../../content/agent-clients/commands.json";
import { pressButton, RUN_MODE_ABOUT, RUN_MODES } from "./buttons";

// ------------------------------------------------------------------ replies

export type BlockKind = "text" | "markdown" | "diagram" | "error" | "notice" | "user" | "ok" | "dim";
export type Block = { kind: BlockKind; text: string };
export type Choice = { label: string; value: string; hint?: string };
/** Pick one of these; `then` runs with the chosen value. */
/** `index`: the choice the cursor starts on (the current one), else the first */
export type Pick = { title: string; choices: Choice[]; then: (value: string) => Promise<Reply> | Reply; index?: number };
/** The next line the person types answers this; `then` runs with it. */
export type Ask = { prompt: string; then: (text: string) => Promise<Reply> | Reply };
export type PanelName = "flow" | "agents" | "inbox";
export type Reply = { blocks: Block[]; pick?: Pick; ask?: Ask; quit?: boolean; clear?: boolean; mouse?: boolean | "toggle"; panel?: PanelName | "off"; chat?: string;
  /** an agent of a flow (its job id) to follow on screen: its steps and the text it writes, live */
  follow?: string;
  /** the start box again (keel, the project, its flow, what waits): after a switch to another project */
  start?: boolean };

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

/** What a command runs with: keel, the terminal's width, and the colours to write in (PLAIN: none). */
export type Ctx = { core: KeelCore; width: number; paint?: Paint };
const P = (ctx: Ctx): Paint => ctx.paint ?? PLAIN;

/** One row of content/agent-clients/commands.json, the command table keel's terminal clients share. */
export type CommandSpec = { name: string; args?: string; summary: string; aliases?: string[]; writes: boolean; complete?: string; local?: boolean;
  group?: string };
export const TABLE = table as { version: number; commands: CommandSpec[]; keys: { key: string; does: string }[]; diagrams: string[];
  groups?: string[] };
type Impl = { name: string; run: Command["run"]; complete?: Command["complete"] };

export type Command = Omit<CommandSpec, "complete" | "writes"> & {
  writes?: boolean;
  /** the words after the name; "" when none */
  run: (ctx: Ctx, args: string) => Promise<Reply> | Reply;
  /** completions for the argument being typed */
  complete?: (ctx: Ctx, arg: string) => string[];
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
    const answered = await inboxApi.act(t.thread_id, { decision, ...(why ? { why } : {}), ...(payload ? { payload } : {}), id: t.waiting?.id ?? null });
    await ctx.core.refresh();
    // the flow moves on at once: say where it is now (the answer above is from the moment of the decision)
    const now = ctx.core.snapshot.flow?.thread;
    const s = now && now.thread_id === t.thread_id ? now : answered;
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

/** /agent new: an agent of its own (a KeelBot chat in its own worktree, or one that only reads) works on the task. */
async function spawn(ctx: Ctx, task: string, mode: HelperMode): Promise<Reply> {
  if (!task.trim()) return text("No task: nothing started.");
  try {
    const s = await ctx.core.spawnAgent(task.trim(), mode);
    return ok(`agent "${s.title}" started (${mode === "side" ? "its own worktree and branch: this folder stays as it is" : "it only reads"}). `
      + "Go on working: a notice says when it is finished. /agent shows it and opens it.");
  } catch (e) {
    return errorReply(e);
  }
}

/** Open an agent the person started: its chat comes on screen, with its last messages; at work, it is followed live. */
async function openAgent(ctx: Ctx, sid: string): Promise<Reply> {
  const s = await ctx.core.openChat(sid);
  const busy = s.busy || s.status === "running";
  const blocks: Block[] = [{ kind: "dim", text: `agent "${s.title}" · ${s.mode}${s.branch ? ` · branch ${s.branch}` : ""} · ${busy ? "at work: you see it live" : s.status}` }];
  (s.messages ?? []).slice(-4).forEach((m) => blocks.push(m.role === "user" ? { kind: "user", text: m.text } : { kind: m.role === "note" ? "dim" : "markdown", text: m.text }));
  if (!busy && s.mode === "side") blocks.push({ kind: "dim", text: "  Its changes: /changes · /keep keeps them · /undo · or ask it more here." });
  return { blocks };
}

/** What each command does; its name, arguments, help text and aliases are in the shared table (TABLE). */
const IMPLS: Impl[] = [
  { name: "help", run: (ctx) => text(helpText(P(ctx))) },
  {
    name: "project",
    complete: (ctx, a) => ctx.core.snapshot.projects.map((p) => p.id).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const name = a.trim();
      const switched = (id: string): Reply => ({ blocks: [{ kind: "ok", text: `now on project ${id}` }], start: true });
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
  {
    name: "flow",
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
  { name: "flows", run: async (ctx) => text(fmt.flows(await api.runs(needProject(ctx).id, undefined, 20), P(ctx))) },
  {
    name: "resume",
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
    name: "stop",
    run: async (ctx, a) => {
      // /stop all, /stop <n> (/flows numbers them), /stop <flow id>: the project's flows, after one yes
      const arg = a.trim();
      if (arg) {
        const rows = await api.runs(needProject(ctx).id, undefined, 20);
        const open = rows.filter((r) => r.status === "running" || r.status === "waiting");
        const n = /^#?(\d+)$/.exec(arg);
        const chosen = arg === "all" ? open : n ? [rows[Number(n[1]) - 1]].filter(Boolean) : rows.filter((r) => arg.length >= 6 && r.thread_id.startsWith(arg));
        if (!chosen.length) return arg === "all" ? text("No running or waiting flow to stop.") : fail(`No flow ${arg}: /flows lists them, numbered.`);
        const shut = chosen.filter((r) => r.status !== "running" && r.status !== "waiting");
        if (shut.length === chosen.length) return text(`"${chosen[0].title}" is ${chosen[0].status} already.`);
        const b = { kind: "stop" as const, flows: chosen.filter((r) => !shut.includes(r)).map((r) => r.thread_id) };
        const name = (tid: string) => `"${rows.find((r) => r.thread_id === tid)?.title ?? tid}"`;
        return { blocks: [], pick: { title: b.flows.length === 1 ? `Stop ${name(b.flows[0])}?` : `Stop ${b.flows.length} flows: ${b.flows.map(name).join(", ")}?`,
          choices: [{ label: "Yes, stop", value: "yes", hint: "agents at work stop; every finished step stays saved" }, { label: "No", value: "no" }],
          then: async (v) => {
            if (v !== "yes") return text("Not stopped.");
            const said = await pressButton(b, needProject(ctx).id, name);
            await ctx.core.refresh();
            return ok(said);
          } } };
      }
      const t = flowNow(ctx);
      if (!t || !["running", "waiting"].includes(t.status)) return text("No running flow to stop. /stop all stops every running or waiting one.");
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
  {
    // the flow's run mode, as the dashboard's switch: how much keel decides by itself, from the next gate on
    name: "run",
    run: async (ctx, a) => {
      const t = flowNow(ctx);
      if (!t || !["running", "waiting"].includes(t.status)) return text("No running or waiting flow: a run mode is set when a flow starts (/flow).");
      const want = a.trim().toLowerCase() as RunMode;
      const now = t.run_mode ?? "manual";
      const set = async (m: RunMode) => {
        if (m === now) return text(`"${t.title}" runs in ${m} mode already.`);
        await inboxApi.setMode(t.thread_id, m);
        await ctx.core.refresh();
        return ok(`"${t.title}" runs in ${m} mode from its next gate on: it ${RUN_MODE_ABOUT[m]}.`);
      };
      if (want) return RUN_MODES.includes(want) ? set(want) : fail(`A run mode is one of ${RUN_MODES.join(", ")}.`);
      return { blocks: [], pick: { title: `Run mode of "${t.title}" (now ${now})`,
        choices: RUN_MODES.map((m) => ({ label: m + (m === now ? " (now)" : ""), value: m, hint: RUN_MODE_ABOUT[m] })),
        then: (v) => set(v as RunMode) } };
    },
  },
  { name: "status", run: async (ctx) => {
    await ctx.core.refresh();
    return text(fmt.status(needProject(ctx), ctx.core.snapshot.flow, P(ctx), ctx.width));
  } },
  { name: "next", run: async (ctx) => {
    await ctx.core.refresh();
    return text(fmt.next(ctx.core.snapshot.project, ctx.core.snapshot.flow, P(ctx)));
  } },
  { name: "inbox", run: async (ctx) => {
    await ctx.core.refresh();
    const items = ctx.core.snapshot.inbox;
    const c = P(ctx);
    return text(fmt.inbox(items, c) + (items.length ? `\n\n${c.bold(c.gate("/approve <n>"))} or ${c.bold(c.gate("/reject <n> <why>"))} answers one; ${c.accent("Ctrl+B")} keeps the inbox on screen.` : ""));
  } },
  { name: "approve", run: (ctx, a) => decide(ctx, "approve", a) },
  { name: "reject", run: (ctx, a) => decide(ctx, "reject", a) },
  {
    name: "answer",
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
  { name: "jobs", run: async (ctx) => text(fmt.jobs(await api.jobs({ project: needProject(ctx).id, limit: 20 }), P(ctx))) },
  {
    name: "live", run: async (ctx) => {
      const running = await api.jobs({ status: "running", limit: 50 });
      const last: Record<string, JobStep | undefined> = {};
      await Promise.all(running.map(async (j: Job) => {
        const s = await api.jobSteps(j.id).catch(() => ({ steps: [] as JobStep[] }));
        last[j.id] = s.steps[s.steps.length - 1];
      }));
      return { ...text(fmt.live(running, last, P(ctx)) + (running.length ? `\n\n${P(ctx).accent("Ctrl+A")} keeps the agents on screen.` : "")) };
    },
  },
  {
    name: "steps",
    run: async (ctx, a) => {
      const id = a.trim();
      if (!id) return flowDiagram(ctx);
      const r = await api.jobSteps(id);
      return text(r.steps.length ? r.steps.map((s) => `${P(ctx).faint(String(s.n).padStart(3))} ${fmt.stepLine(s, Math.max(60, ctx.width - 6), P(ctx))}`).join("\n") + (r.running ? "\n… still running" : "")
        : "no steps yet.");
    },
  },
  {
    name: "timeline",
    run: async (ctx) => {
      const p = needProject(ctx);
      const t = flowNow(ctx);
      const [hist, jobs] = await Promise.all([t ? api.history(t.thread_id) : Promise.resolve([]), api.jobs({ project: p.id, limit: 20 })]);
      return text(fmt.timeline(hist, jobs, 20, t, P(ctx)));
    },
  },
  {
    name: "workflows",
    complete: (ctx, a) => cachedWorkflowIds(ctx).filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const rows = await workflows(ctx);
      const [id, zoom] = a.trim().split(/\s+/);
      if (id) {
        const w = rows.find((x) => x.id === id);
        if (!w) return fail(`No workflow "${id}". This project has: ${rows.map((x) => x.id).join(", ")}`);
        return diagram(await draw(ctx, "workflow", { workflow: w }, zoom));
      }
      return join(text(fmt.workflowsList(rows, P(ctx))), pickWorkflowThen(ctx, rows, async (w) => diagram(await draw(ctx, "workflow", { workflow: w })), "Draw which workflow?"));
    },
  },
  {
    name: "diagram",
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
    name: "rules",
    run: async (ctx) => {
      const p = needProject(ctx);
      const t = flowNow(ctx);
      const [v, now] = await Promise.all([rulesApi.view(p.id), t ? rulesApi.now(t.thread_id).catch(() => null) : Promise.resolve(null)]);
      return text(fmt.rules(p, v as never, now as never, P(ctx)));
    },
  },
  {
    name: "plugins",
    run: async (ctx) => {
      const body = await get<unknown>("/plugins/installed");
      const rows = (Array.isArray(body) ? body : ((body as { plugins?: unknown[] })?.plugins ?? [])) as never[];
      const here = ctx.core.pid ? await api.plugins(ctx.core.pid).catch(() => []) : [];
      return text(fmt.plugins(rows, here.map((x) => ({ name: x.name, enabled: !!(x as { enabled?: boolean }).enabled })), P(ctx)));
    },
  },
  { name: "budget", run: async (ctx) => text(fmt.budget(await api.budgetNow(needProject(ctx).id), P(ctx))) },
  {
    name: "dashboard",
    complete: (_c, a) => ["flow", "map", "er", "keelbot", "inbox"].filter((x) => x.startsWith(a)),
    run: (ctx, a) => text(dashboardUrl(ctx, a.trim() || "flow") + "\nOpen it in your browser: the same keel, the same flows and chats."),
  },
  {
    name: "model",
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
    name: "chats",
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
  {
    // agents: the flow's at work, and the ones the person started (/agent new: KeelBot chats that work on their own)
    name: "agent",
    run: async (ctx, a) => {
      const p = needProject(ctx);
      const arg = a.trim();
      const m = /^(new|spawn|start)\s+(?:(ask|side)\s+)?([\s\S]+)$/i.exec(arg);
      if (/^(new|spawn|start)$/i.test(arg)) return { blocks: [], ask: { prompt: "What should the agent do?", then: (task) => spawn(ctx, task, "side") } };
      if (m) return spawn(ctx, m[3].trim(), (m[2]?.toLowerCase() as HelperMode) || "side");
      const [jobs, chats] = await Promise.all([api.jobs({ project: p.id, status: "running", limit: 20 }).catch(() => [] as Job[]), ctx.core.chats()]);
      const mine = chats.filter((s) => s.mode === "side" || ctx.core.spawnedAtWork().includes(s.id) || s.busy).slice(0, 12);
      const rows: { label: string; hint: string; go: () => Promise<Reply> | Reply }[] = [
        ...jobs.map((j) => ({ label: `▶ ${j.agent} (flow)`, hint: [j.step, j.ac, `${fmt.short(fmt.tokensOf(j))} tokens`].filter(Boolean).join(" · "),
          go: () => ({ blocks: [{ kind: "dim" as const, text: `following ${j.agent} · ${j.step}${j.ac ? " " + j.ac : ""} · Esc or /panel off stops following` }], follow: j.id }) })),
        ...mine.map((s) => ({ label: `${s.busy || s.status === "running" ? "▶" : s.status === "failed" ? "✗" : "✓"} ${s.title || s.id}`,
          hint: [s.mode === "side" ? `own worktree${s.branch ? " " + s.branch : ""}` : s.mode, s.busy || s.status === "running" ? "at work" : s.status, fmt.usd(s.cost_usd)].join(" · "),
          go: () => openAgent(ctx, s.id) })),
      ];
      const n = /^#?(\d+)$/.exec(arg);
      if (n) return rows[Number(n[1]) - 1]?.go() ?? fail(`No agent ${n[1]}: /agent lists them.`);
      if (arg) return fail("/agent lists the agents; /agent <n> opens one; /agent new <task> starts one.");
      const c = P(ctx);
      const list = rows.length ? rows.map((r, k) => `${c.bold(`${String(k + 1).padStart(2)}.`)} ${r.label}  ${c.dim(r.hint)}`).join("\n")
        : c.dim("No agent at work, and none of yours yet.");
      const help = c.dim(`/agent new <task> starts an agent in its own worktree (/agent new ask <question>: it only reads) · /agent <n> opens one`);
      if (!rows.length) return text(`${list}\n${help}`);
      return { blocks: [{ kind: "text", text: `${c.bold("Agents")}\n${list}\n${help}` }],
        pick: { title: "Go to which agent?", choices: rows.map((r, k) => ({ label: r.label, value: String(k), hint: r.hint })), then: (v) => rows[Number(v)].go() } };
    },
  },
  { name: "new", run: (ctx) => { ctx.core.newChat(); return ok("New chat: the next message starts it."); } },
  {
    name: "mode",
    complete: (_c, a) => ["ask", "fix"].filter((x) => x.startsWith(a)),
    run: (ctx, a) => {
      const m = a.trim();
      if (m !== "ask" && m !== "fix") return text(`KeelBot is in ${ctx.core.snapshot.chat.mode} mode. /mode ask or /mode fix.`);
      ctx.core.setChatMode(m);
      return ok(`KeelBot: ${m} mode (a new chat starts with the next message).`);
    },
  },
  {
    name: "changes",
    run: async (ctx) => text(fmt.changesText(await ctx.core.changes(), P(ctx)) + `\n\n${P(ctx).accent("/keep")} [path|all] · ${P(ctx).accent("/undo")} [path|all]`),
  },
  {
    name: "keep",
    complete: (ctx, a) => changedPaths(ctx).filter((p) => p.startsWith(a)),
    run: async (ctx, a) => {
      const arg = a.trim();
      const all = !arg || arg === "all";
      const r = await ctx.core.keep(all ? undefined : [arg]);
      if (!r.ok) {
        const f = r as { step: string; error: string; command?: string; output?: string };
        return fail(`${f.error}${f.command ? `\n${f.command}` : ""}${f.output ? `\n${f.output.split("\n").slice(-12).join("\n")}` : ""}`);
      }
      void refreshChanged(ctx);
      return ok(`kept ${r.files.length} file(s): ${r.message} (${r.sha.slice(0, 7)})${r.checks ? ` · checks: ${r.checks}` : ""}`);
    },
  },
  {
    name: "undo",
    complete: (ctx, a) => changedPaths(ctx).filter((p) => p.startsWith(a)),
    run: async (ctx, a) => {
      const arg = a.trim();
      const left = await ctx.core.undo(!arg || arg === "all" ? undefined : arg);
      changedCache = { sid: ctx.core.snapshot.chat.session?.id ?? "", paths: left.map((c) => c.path) };
      return ok(`put back ${!arg || arg === "all" ? "every file KeelBot changed" : arg}` + (left.length ? ` · still changed: ${left.map((c) => c.path).join(", ")}` : ""));
    },
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
  { name: "mouse", run: (_ctx, a) => {
    const w = a.trim().toLowerCase();
    if (w && w !== "on" && w !== "off") return fail("/mouse on or /mouse off (no word switches it).");
    return { blocks: [], mouse: w ? w === "on" : "toggle" };
  } },
  { name: "quit", run: () => ({ blocks: [], quit: true }) },
];

/** keel's commands: the shared table's words with what each one does here. */
export const COMMANDS: Command[] = TABLE.commands.map((spec) => {
  const impl = IMPLS.find((i) => i.name === spec.name);
  if (!impl) throw new Error(`content/agent-clients/commands.json names /${spec.name}, but keel TUI does not have it`);
  const { complete: _from, ...words } = spec;      // `complete` in the table names the source; here it is the function
  return { ...words, run: impl.run, complete: impl.complete };
});
for (const i of IMPLS) if (!TABLE.commands.some((c) => c.name === i.name)) throw new Error(`/${i.name} is missing from content/agent-clients/commands.json`);

export const COMMANDS_BY_NAME: Record<string, Command> = Object.fromEntries(COMMANDS.flatMap((c) => [[c.name, c], ...(c.aliases ?? []).map((a) => [a, c])]));

// ---- what keel's plugins add (core/plugins.ts): looked up after keel's own commands ----
let pluginCmds: Command[] = [];
export function setPluginCommands(cmds: Command[]) {
  pluginCmds = cmds.filter((c) => !COMMANDS_BY_NAME[c.name]);
}
export const pluginCommandList = () => pluginCmds;
/** keel's command, or a plugin's */
export const lookup = (name: string): Command | null => COMMANDS_BY_NAME[name] ?? pluginCmds.find((c) => c.name === name) ?? null;

// the paths KeelBot changed, for /keep and /undo's Tab (read when a Fix or Side turn ends, and after each)
let changedCache: { sid: string; paths: string[] } = { sid: "", paths: [] };
export function setChanged(sid: string, paths: string[]) {
  changedCache = { sid, paths };
}
const changedPaths = (ctx: Ctx) => (changedCache.sid === (ctx.core.snapshot.chat.session?.id ?? "") ? ["all", ...changedCache.paths] : ["all"]);
async function refreshChanged(ctx: Ctx) {
  try {
    changedCache = { sid: ctx.core.snapshot.chat.session?.id ?? "", paths: (await ctx.core.changes()).map((c) => c.path) };
  } catch {
    /* no chat */
  }
}

export function dashboardUrl(ctx: Ctx, view: string): string {
  const base = ctx.core.snapshot.publicUrl;
  const pid = ctx.core.pid;
  if (view === "inbox") return `${base}/#/inbox`;
  if (!pid) return base;
  const path = { flow: "flow", map: "map", er: "map/er", keelbot: "keelbot" }[view] ?? view;
  return `${base}/#/projects/${encodeURIComponent(pid)}/${path}`;
}

/** /help: the commands by group (the shared table's groups), names in the accent colour, arguments in a second one. */
export function helpText(c: Paint = PLAIN): string {
  const w = Math.max(...[...COMMANDS, ...pluginCmds].map((x) => (x.name + (x.args ? " " + x.args : "")).length));
  const cut = Math.min(w, 34);
  const groups = TABLE.groups ?? [...new Set(COMMANDS.map((x) => x.group ?? ""))];
  const out = [`Type a question for ${c.accent("KeelBot")}, or a command:`];
  for (const g of groups) {
    const cmds = [...COMMANDS, ...pluginCmds].filter((x) => (x.group ?? "") === g);
    if (!cmds.length) continue;
    out.push("", c.bold(c.gate(g)));
    for (const x of cmds) {
      const plainHead = `/${x.name}${x.args ? " " + x.args : ""}`;
      const head = c.bold(c.accent(`/${x.name}`)) + (x.args ? " " + c.attr(x.args) : "");
      const pad = " ".repeat(Math.max(1, cut + 3 - plainHead.length));
      out.push(plainHead.length > cut + 1 ? `  ${head}\n  ${" ".repeat(cut + 3)}${c.dim(x.summary)}` : `  ${head}${pad}${c.dim(x.summary)}`);
    }
  }
  out.push("", c.bold(c.gate("Keys")), "  " + TABLE.keys.map((k) => `${c.bold(c.accent(k.key))} ${c.dim(k.does)}`).join(c.faint(" · ")),
    "", c.dim("KeelBot's own commands (/gate, /where …) go to KeelBot as they are."));
  return out.join("\n");
}

// ------------------------------------------------------------------ parse, complete, run

export type Parsed = { kind: "command"; name: string; args: string; command: Command | null } | { kind: "chat"; text: string } | { kind: "empty" };

export function parse(input: string): Parsed {
  const t = input.trim();
  if (!t) return { kind: "empty" };
  if (!t.startsWith("/") || t.startsWith("//")) return { kind: "chat", text: t.startsWith("//") ? t.slice(1) : t };
  const m = /^\/([\w?-]*)\s*([\s\S]*)$/.exec(t)!;
  const name = m[1].toLowerCase();
  return { kind: "command", name, args: m[2] ?? "", command: lookup(name) };
}

export type Completion = { value: string; label: string; hint?: string };

/** What Tab offers for the line typed so far: command names, then each command's argument. */
export function complete(ctx: Ctx, input: string, extra: { name: string; description: string }[] = []): Completion[] {
  if (!input.startsWith("/")) return [];
  const m = /^\/([\w?-]*)(\s+([\s\S]*))?$/.exec(input);
  if (!m) return [];
  const [, name, space, arg] = m;
  if (space === undefined) {
    const mine = [...COMMANDS, ...pluginCmds].filter((c) => c.name.startsWith(name.toLowerCase()))
      .map((c) => ({ value: `/${c.name}${c.args ? " " : ""}`, label: `/${c.name}${c.args ? " " + c.args : ""}`, hint: c.summary }));
    const bot = extra.filter((c) => c.name.startsWith(name) && !COMMANDS_BY_NAME[c.name])
      .map((c) => ({ value: `/${c.name} `, label: `/${c.name}`, hint: `KeelBot · ${c.description}` }));
    return [...mine, ...bot];
  }
  const cmd = lookup(name.toLowerCase());
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
