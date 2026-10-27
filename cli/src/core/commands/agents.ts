// KeelBot and agent commands: the chat (model, effort, compact, export, chats, undo), the agent helpers and /create, /fix.

import { api, type HelperSession, type Job, type HelperMode } from "../sdk";
import * as fmt from "../format";
import { fixRequest } from "../../../../web/src/askFix";
import { prepare, pressButton, toButton, type Button } from "../buttons";
import { effortComplete, effortRun, modelRun } from "../effort";
import { guidedStack, stackRequest } from "../stacks";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { COMMANDS_BY_NAME, P, errorReply, fail, join, messageBlock, needProject, ok, text } from "./base";
import type { Block, Ctx, Impl, Reply } from "./base";
import { decide, workflows } from "./flow";

const CREATE_KINDS = ["workflow", "rule", "agent", "skill", "stack"] as const;
type CreateKind = (typeof CREATE_KINDS)[number];
const CREATE_WORDS: Record<CreateKind, string> = { workflow: "workflow", rule: "rule pack", agent: "agent", skill: "skill", stack: "stack" };

/** /create <kind> --file <path>, or a button KeelBot gave: keel's check first, then one yes saves it. */
async function confirmSave(ctx: Ctx, b: Button): Promise<Reply> {
  const pid = needProject(ctx).id;
  const prep = await prepare(b, pid, (x) => x);
  if (!prep) return fail("Nothing to save.");
  if ("error" in prep) return fail(prep.error.replace(/^KeelBot's /, "The "));
  return { blocks: prep.detail ? [{ kind: "dim", text: prep.detail.split("\n").map((l) => "  " + l).join("\n") }] : [],
    pick: { title: prep.title.replace(/^KeelBot wrote an? [a-z ]+: /, ""), choices: [{ label: "Yes, save it", value: "yes" }, { label: "No", value: "no" }],
      then: async (v) => (v === "yes" ? ok(await pressButton(b, pid, (x) => x)) : text("Not saved.")) } };
}

/** /create agent with no words: its name, what it is for, its tools and its instructions, one question after the other. */
function agentQuestions(ctx: Ctx): Reply {
  return { blocks: [{ kind: "dim", text: "  A new agent: four questions. Esc stops." }], ask: { prompt: "Its name (for example: doc writer)?", then: (name) => {
    if (!name.trim()) return text("No name: nothing saved.");
    return { blocks: [], ask: { prompt: `What is "${name.trim()}" for (one sentence)?`, then: (about) => ({ blocks: [], pick: {
      title: "What may it do?", choices: [
        { label: "Read only", value: "Read,Grep,Glob", hint: "it reads and answers" },
        { label: "Read and change files", value: "Read,Grep,Glob,Edit,Write", hint: "keel's rules and the phase still decide where" },
        { label: "Read, change files and run commands", value: "Read,Grep,Glob,Edit,Write,Bash", hint: "commands go through keel's shell guard" }],
      then: (tools) => ({ blocks: [], ask: { prompt: "Its instructions: what it does, how, and what its answer looks like?", then: (prompt) =>
        prompt.trim() ? confirmSave(ctx, { kind: "agent", agent: { name: name.trim(), about: about.trim(), prompt: prompt.trim(), tools: tools.split(","), phases: ["any"] } })
          : text("No instructions: nothing saved.") } }) } }) } };
  } } };
}

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
  (s.messages ?? []).slice(-4).forEach((m) => blocks.push(messageBlock(m)));
  if (!busy && s.mode === "side") blocks.push({ kind: "dim", text: "  Its changes: /changes · /keep keeps them · /undo · or ask it more here." });
  return { blocks };
}

/** 0.18.19 /undo (no argument) and /redo: a whole KeelBot answer, through the engine's undo-turn and redo-turn. */
async function turnRun(ctx: Ctx, undo: boolean): Promise<Reply> {
  if (!ctx.core.snapshot.chat.session) return text(`nothing to ${undo ? "undo" : "redo"}: open a chat first (/chats).`);
  try {
    const r = undo ? await ctx.core.undoTurn() : await ctx.core.redoTurn();
    void refreshChanged(ctx);
    const files = `${r.files.length} file${r.files.length === 1 ? "" : "s"} restored`;
    return undo
      ? { blocks: [{ kind: "ok", text: `undid the last answer: ${files}` },
        { kind: "dim", text: `  ${r.files.length ? r.files.join(", ") + " · " : ""}the question is in the prompt: change it and send, or /redo` }],
        prompt: r.text, revert: { undo: true, text: r.text } }
      : { blocks: [{ kind: "ok", text: `redid the answer: ${files}` },
        ...(r.files.length ? [{ kind: "dim" as const, text: `  ${r.files.join(", ")}` }] : [])], revert: { undo: false, text: r.text } };
  } catch (e) {
    return errorReply(e);
  }
}

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

export const AGENTS_IMPLS: Impl[] = [
  { name: "model", run: (ctx) => modelRun(ctx) },
  {
    // P1-2: summarise the open chat's stored history into a fresh engine session; every stored message stays.
    name: "compact",
    run: async (ctx) => {
      if (!ctx.core.snapshot.chat.session) return text("nothing to compact: open a chat first.");
      const r = await ctx.core.compact();
      const tok = (n: number) => (n >= 1000 ? `${Math.round(n / 1000)}k` : String(n));
      return text(`compacted: ${tok(r.before)} → ${tok(r.after)} tokens, nothing lost`);
    },
  },
  {
    // P1-3: write the open chat as Markdown (every stored message, with role and time) into the project's .keel/chats/
    name: "export",
    run: async (ctx) => {
      if (!ctx.core.snapshot.chat.session) return text("nothing to export: open a chat first (/chats).");
      const r = await ctx.core.exportChat();
      return ok(`exported ${r.messages} messages: ${r.path}`);
    },
  },
  { name: "effort", run: (ctx, a) => effortRun(ctx, a), complete: (ctx, a) => effortComplete(ctx, a) },
  {
    // P1-3: name the open chat (the session's PATCH {title}); /chats lists it by that name
    name: "rename",
    run: (ctx, a) => {
      if (!ctx.core.snapshot.chat.session) return text("nothing to rename: open a chat first (/chats).");
      const go = async (name: string): Promise<Reply> => {
        const title = name.trim().replace(/\s+/g, " ").slice(0, 120);
        if (!title) return fail("A chat needs a name: /rename <name>.");
        const s = await ctx.core.rename(title);
        return ok(`renamed: "${s.title}"`);
      };
      return a.trim() ? go(a) : { blocks: [], ask: { prompt: "The chat's new name?", then: go } };
    },
  },
  {
    // P1-3: a picker, newest first, with each chat's last message, age and size; typing narrows it by title or last message
    name: "chats",
    run: async (ctx) => {
      const rows = await ctx.core.chats();
      if (!rows.length) return text("No chats yet: type a question.");
      return { blocks: [], pick: { title: "Open which chat? (type to filter)", choices: rows.slice(0, 50).map((s: HelperSession) => ({
        label: s.title || s.id, value: s.id, search: s.last_message ?? "",
        hint: [s.last_message ? fmt.cut(s.last_message, 40) : "", fmt.age(s.updated_at), s.message_count != null ? `${s.message_count} msgs` : `${s.turns} turns`].filter(Boolean).join(" · ") })),
        then: async (v) => {
          const s = await ctx.core.openChat(v);
          const blocks: Block[] = [{ kind: "dim", text: `chat "${s.title}" · ${s.mode} · ${s.turns} turns` }];
          (s.messages ?? []).slice(-6).forEach((m) => blocks.push(messageBlock(m)));
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
  {
    // a new workflow, rule pack or agent: KeelBot writes it from your words (then keel checks it and you save it), or
    // from a file (--file), or (an agent) from four questions
    name: "create",
    complete: (_ctx, a) => CREATE_KINDS.filter((k) => k.startsWith(a.trim())).map((k) => `${k} `),
    run: async (ctx, a) => {
      const m = /^(\S+)\s*([\s\S]*)$/.exec(a.trim());
      const kind = m?.[1] as CreateKind | undefined;
      if (!kind || !CREATE_KINDS.includes(kind)) {
        return { blocks: [], pick: { title: "Create what?", choices: [
          { label: "workflow", value: "workflow", hint: "the steps a flow runs: agents, checks, gates" },
          { label: "rule", value: "rule", hint: "a rule pack: what agents may not do" },
          { label: "agent", value: "agent", hint: "a new agent workflows can use" },
          { label: "skill", value: "skill", hint: "know-how an agent reads before it works" },
          { label: "stack", value: "stack", hint: "how this project builds and tests" }],
          then: (v) => COMMANDS_BY_NAME.create.run(ctx, v) } };
      }
      const rest = (m?.[2] ?? "").trim();
      const file = /^--file\s+(\S+)$/.exec(rest)?.[1];
      if (file) {
        let body: string;
        try {
          body = readFileSync(resolve(process.env.KEEL_TUI_CWD || process.cwd(), file), "utf8");
        } catch (e) {
          return fail(`Cannot read ${file}: ${e instanceof Error ? e.message : String(e)}`);
        }
        const b = toButton(kind, body);
        return b ? confirmSave(ctx, b) : fail(kind === "agent" ? "The file is not an agent's JSON: name, about, prompt, tools, phases." : `The file is empty.`);
      }
      if (kind === "skill" && rest) {
        const sk = /^([\s\S]*?)\s*--for\s+(.+)$/.exec(rest);
        const idea = (sk?.[1] ?? rest).trim();
        const who = sk ? sk[2].split(/[\s,]+/).filter(Boolean) : [];
        return { blocks: [{ kind: "dim", text: "  KeelBot writes the skill; keel checks it, then you save it." }],
          chat: `Write a new keel skill (a SKILL.md) for this project: ${idea}\nUse this project's own commands, paths and conventions; keep it short.`
            + (who.length ? ` Name these agents in its front matter: agents: [${who.join(", ")}].` : " Name the agents that should load it in its front matter (agents: [...]).")
            + " End your answer with the whole SKILL.md in one keel-skill block." };
      }
      if (!rest && kind === "agent") return agentQuestions(ctx);
      if (kind === "stack") {
        if (!rest) return guidedStack(ctx);
        return { blocks: [{ kind: "dim", text: "  KeelBot writes the stack; keel checks it, then you save it." }], chat: stackRequest(rest) };
      }
      const ask = (idea: string): Reply => ({ blocks: [{ kind: "dim", text: `  KeelBot writes the ${CREATE_WORDS[kind]}; keel checks it, then you save it.` }],
        chat: `Write a new keel ${CREATE_WORDS[kind]} for this project: ${idea}\nUse this project's own commands, paths and agents. `
          + `End your answer with the whole ${CREATE_WORDS[kind]} in one keel-${kind} block.` });
      if (!rest) return { blocks: [], ask: { prompt: `What should the ${CREATE_WORDS[kind]} do?`, then: (idea) => (idea.trim() ? ask(idea.trim()) : text("Nothing to create.")) } };
      return ask(rest);
    },
  },
  {
    // keel 0.18.9 the last thing that failed, to KeelBot: it finds the cause and proposes the fix as buttons you press
    name: "fix",
    run: (ctx, a) => {
      const last = ctx.core.lastError;
      if (!last && !a.trim()) return text("Nothing failed lately. /fix <what went wrong> asks KeelBot about something else.");
      return { blocks: [{ kind: "dim", text: "  KeelBot looks for the cause and a fix; nothing changes until you press its button." }],
        chat: fixRequest(a.trim() ? `what the person describes: ${a.trim()}` : "the last thing keel TUI did", { message: last ?? a.trim() }) };
    },
  },
  // 0.18.62 a new chat starts on a clean screen with keel's start, like /clear
  { name: "new", run: (ctx) => { ctx.core.newChat(); return { ...ok("New chat: the next message starts it."), clear: true }; } },
  {
    name: "mode",
    complete: (_c, a) => ["ask", "edit", "fix", "side"].filter((x) => x.startsWith(a)),
    run: async (ctx, a) => {
      const m = a.trim() as HelperMode;
      const about: Record<string, string> = {
        ask: "it reads and answers; it changes nothing",
        edit: "it changes files and runs commands in the project folder; keel's always-on rules apply, a command that changes something asks you first, /keep commits",
        fix: "it changes files for the gate a flow waits at, inside that phase's rules",
        side: "it works in its own copy of the project (a worktree on its own branch); /keep commits there",
      };
      if (!about[m]) return text(`KeelBot is in ${ctx.core.snapshot.chat.mode} mode. /mode ask | edit | fix | side:\n`
        + Object.entries(about).map(([k, v]) => `  ${k}: ${v}`).join("\n"));
      if (m === "fix" && ctx.core.snapshot.flow?.thread?.status !== "waiting") return fail("Fix works while a flow waits at a gate. /mode edit changes the project folder without a flow.");
      const same = await ctx.core.setChatMode(m);
      return ok(`KeelBot: ${m} mode: ${about[m]}. ` + (same ? `This chat goes on in ${m} mode; KeelBot is told of the change.`
        : "A new chat starts with the next message."));
    },
  },
  {
    name: "changes",
    run: async (ctx) => text(fmt.changesText(await ctx.core.changes(), P(ctx)) + `\n\n${P(ctx).accent("/keep")} [path|all] · ${P(ctx).accent("/undo")} [path|all] · ${P(ctx).accent("/undo")} ${P(ctx).dim("the last answer")}`),
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
      // 0.18.19 no argument: KeelBot's last answer, as opencode's /undo (from opencode (MIT)): its files back, the
      // question in the prompt to change and send again, the turn dim on screen
      if (!arg) return turnRun(ctx, true);
      const left = await ctx.core.undo(arg === "all" ? undefined : arg);
      changedCache = { sid: ctx.core.snapshot.chat.session?.id ?? "", paths: left.map((c) => c.path) };
      return ok(`put back ${arg === "all" ? "every file KeelBot changed" : arg}` + (left.length ? ` · still changed: ${left.map((c) => c.path).join(", ")}` : ""));
    },
  },
  // 0.18.19 the answer /undo took back, again (until a new message is sent)
  { name: "redo", run: (ctx) => turnRun(ctx, false) },
];
