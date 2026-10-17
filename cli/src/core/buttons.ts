// KeelBot's buttons in keel TUI. KeelBot never acts by itself: its answer ends with fenced blocks (the KeelBot plugin's
// engine, keel_plugin_keelbot/keelbot.py) and the person presses one. The dashboard draws them as cards
// (plugins/keelbot/web/Actions.tsx); here each becomes a yes / no choice after the answer:
//
//   ```keel-start {"workflow", "title", "request"}```                       start a flow
//   ```keel-flow  {"do": "approve" | "reject", "flow", "why"?}```           decide the gate a flow waits at
//   ```keel-flow  {"do": "stop", "flows": [ids]}```                         stop flows (finished steps stay saved)
//   ```keel-flow  {"do": "mode", "flow", "mode": manual|important|auto|readonly}```   a flow's run mode
//   ```keel-workflow <yaml>```                                              a new workflow (checked, then saved)
//   ```keel-rule <yaml>```                                                  a new rule pack (checked, then saved)
//   ```keel-agent {"name", "about", "prompt", "tools", "phases"}```         a new agent
//   ```keel-skill <SKILL.md>```                                             a new skill (checked, saved, put on the
//                                                                           agents its front matter names)
//
//   ```keel-git {"op": "switch" | "commit" | "push" | "pr" | "sync", …}```  the Git plugin's (0.18.9)
//   ```keel-ci {"op": "fix" | "rerun", "run"?}```                           the CI/CD plugin's (0.18.9)
//   ```keel-query {"sql", "connection"?}```                                  the Database plugin's (0.18.9)
//   ```keel-questions [{"id", "question", "why"?, "multiple"?, "options"}]``` KeelBot asks the person to choose (0.18.9)
//
// Another plugin's kind is the dashboard's: the answer says where to press it.
// No UI here: App.tsx shows the text and asks; `pressButton` does what a pressed button does.

import { api, get, post, type RunMode } from "../../../web/src/api";
import type { Answers, Question } from "./commands";
import { inboxApi } from "../../../web/src/inboxApi";

export const RUN_MODES: RunMode[] = ["manual", "important", "auto", "readonly"];

/** What each run mode decides (engine runtime/run_mode.py ABOUT). */
export const RUN_MODE_ABOUT: Record<RunMode, string> = {
  manual: "stops at every gate",
  important: "approves a criterion's gate when its checks and review pass; stops at everything else",
  auto: "approves every gate keel can decide; still stops for money, new dependencies, secrets and failures",
  readonly: "stops at every gate; agents may not edit, write or commit",
};

export type NewAgent = { name: string; about?: string; prompt: string; tools?: string[]; phases?: string[] };
export const AGENT_TOOLS = ["Read", "Grep", "Glob", "Edit", "Write", "Bash"];

export type Button =
  | { kind: "start"; workflow: string; title: string; request?: string }
  | { kind: "decide"; decision: "approve" | "reject"; flow: string; why?: string }
  | { kind: "stop"; flows: string[] }
  | { kind: "mode"; flow: string; mode: RunMode }
  | { kind: "workflow"; yaml: string }
  | { kind: "rule"; yaml: string }
  | { kind: "agent"; agent: NewAgent }
  | { kind: "skill"; text: string }
  | { kind: "git"; op: "switch" | "commit" | "push" | "pr" | "sync"; branch?: string; create?: boolean; message?: string; title?: string;
      body?: string; draft?: boolean; stash?: boolean }
  | { kind: "ci"; op: "fix" | "rerun"; run?: number }
  | { kind: "query"; sql: string; connection?: string }
  | { kind: "questions"; questions: Question[] }
  | { kind: "other"; name: string };

const OPEN = /^\s*(`{3,}|~{3,})\s*keel-([a-z]+)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

function json(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** A SKILL.md's front matter: its name, what it is for, the agents that should load it (a list, or words with commas). */
export function skillHead(text: string): { name: string; description: string; agents: string[]; body: string } {
  const t = (text ?? "").replace(/\r\n?/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(t);
  const fm = m?.[1] ?? "";
  const field = (k: string) => (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim().replace(/^["']|["']$/g, "");
  const agents = field("agents").replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return { name: field("name"), description: field("description"), agents, body: m ? m[2] : t };
}

/** What keel refuses in a SKILL.md before it is saved: the twin of the engine's mcp_skills.check_text. */
export function skillProblems(text: string): string[] {
  const h = skillHead(text);
  const out: string[] = [];
  if (!/^---\n/.test((text ?? "").replace(/\r\n?/g, "\n"))) out.push("it has no front matter: start with ---, name: <id>, description: <one sentence>, ---");
  else if (!h.name) out.push("its front matter has no name");
  else if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(h.name)) out.push(`its name "${h.name}" is not an id: lower-case words with dashes, like changelog-entries`);
  if (/^---\n/.test(text ?? "") && !h.description) out.push("its front matter has no description (one sentence: what it teaches, when it is needed)");
  if (!h.body.trim()) out.push("it has no text after its front matter");
  return out;
}

/** One block as a button, or null when its body is not what its kind needs (it then stays text). */
export function toButton(kind: string, body: string): Button | null {
  if (kind === "workflow" || kind === "rule") return body.trim() ? { kind, yaml: body } : null;
  if (kind === "skill") return body.trim() ? { kind, text: body.endsWith("\n") ? body : body + "\n" } : null;
  if (kind === "agent") {
    const v = json(body);
    const name = str(v?.name ?? v?.label);
    const prompt = str(v?.prompt);
    if (!v || !name || !prompt) return null;
    const list = (x: unknown) => (Array.isArray(x) ? x.map(String).filter(Boolean) : undefined);
    return { kind: "agent", agent: { name, prompt, about: str(v.about) || undefined, tools: list(v.tools), phases: list(v.phases) } };
  }
  if (kind === "questions") {
    const qs = parseQuestions(body);
    return qs.length ? { kind, questions: qs } : null;
  }
  if (kind === "git" || kind === "ci" || kind === "query") {
    const v = json(body);
    if (!v) return null;
    if (kind === "query") return str(v.sql) ? { kind, sql: str(v.sql), connection: str(v.connection) || undefined } : null;
    if (kind === "ci") return str(v.op) === "fix" || str(v.op) === "rerun" ? { kind, op: str(v.op) as "fix" | "rerun", run: typeof v.run === "number" ? v.run : undefined } : null;
    const op = str(v.op) as "switch" | "commit" | "push" | "pr" | "sync";
    if (!["switch", "commit", "push", "pr", "sync"].includes(op) || (op === "switch" && !str(v.branch))) return null;
    return { kind, op, branch: str(v.branch) || undefined, create: !!v.create, message: str(v.message) || undefined, title: str(v.title) || undefined,
      body: str(v.body) || undefined, draft: !!v.draft };
  }
  if (kind !== "start" && kind !== "flow") return { kind: "other", name: kind };
  const v = json(body);
  if (!v) return null;
  if (kind === "start") return str(v.workflow) ? { kind: "start", workflow: str(v.workflow), title: str(v.title), request: str(v.request) || undefined } : null;
  const what = str(v.do);
  if (what === "approve" || what === "reject") return str(v.flow) ? { kind: "decide", decision: what, flow: str(v.flow), why: str(v.why) || undefined } : null;
  if (what === "stop") {
    const flows = (Array.isArray(v.flows) ? v.flows : [v.flow]).map(str).filter(Boolean);
    return flows.length ? { kind: "stop", flows: [...new Set(flows)] } : null;
  }
  if (what === "mode") return str(v.flow) && RUN_MODES.includes(str(v.mode) as RunMode) ? { kind: "mode", flow: str(v.flow), mode: str(v.mode) as RunMode } : null;
  return null;
}

/** The answer without its button blocks (a block inside another code block stays), and the buttons in order. */
export function splitButtons(text: string): { text: string; buttons: Button[] } {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const buttons: Button[] = [];
  let i = 0;
  while (i < lines.length) {
    const a = lines[i].match(OPEN);
    if (a) {
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i], a[1])) body.push(lines[i++]);
      i++;
      const b = toButton(a[2], body.join("\n"));
      if (b) buttons.push(b);
      else out.push(...lines.slice(start, i));
      continue;
    }
    const f = lines[i].match(FENCE);
    out.push(lines[i++]);
    if (f) {
      while (i < lines.length && !closes(lines[i], f[1])) out.push(lines[i++]);
      if (i < lines.length) out.push(lines[i++]);
    }
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), buttons };
}

/** A flow's name for a question: its title from the project's flows, else its id. */
export type Names = (tid: string) => string;

/** The question a button asks before anything happens; null for buttons only the dashboard has. */
export function question(b: Button, name: Names): string | null {
  switch (b.kind) {
    case "start": return `KeelBot suggests: start ${b.workflow}${b.title ? ` "${b.title}"` : ""}?`;
    case "decide": return `KeelBot suggests: ${b.decision} the gate of ${name(b.flow)}${b.why ? ` (${b.why})` : ""}?`;
    case "stop": return b.flows.length === 1 ? `KeelBot suggests: stop ${name(b.flows[0])}?` : `KeelBot suggests: stop ${b.flows.length} flows (${b.flows.map(name).join(", ")})?`;
    case "mode": return `KeelBot suggests: run ${name(b.flow)} in ${b.mode} mode (${RUN_MODE_ABOUT[b.mode]})?`;
    case "git": return `KeelBot suggests: ${gitWords(b)}?`;
    case "ci": return b.op === "fix" ? `KeelBot suggests: fix the failed CI run${b.run ? ` #${b.run}` : ""} (a ci-fix flow on this branch)?`
      : `KeelBot suggests: run the failed CI jobs${b.run ? ` of run #${b.run}` : ""} again?`;
    case "query": return `KeelBot suggests: run this on ${b.connection || "the local database"}: ${b.sql.replace(/\s+/g, " ").slice(0, 90)}?`;
    default: return null;
  }
}

/** KeelBot's questions (the explorer's format, engine runtime/clarify.py): at most 4, 2 to 4 options each, the
 *  recommended one marked (else the first), "multiple" when several may be picked. */
export function parseQuestions(body: string): Question[] {
  let raw: unknown;
  try {
    raw = JSON.parse(body);
  } catch {
    return [];
  }
  const list = Array.isArray(raw) ? raw : raw && typeof raw === "object" && Array.isArray((raw as { questions?: unknown }).questions)
    ? (raw as { questions: unknown[] }).questions : [];
  const out: Question[] = [];
  list.forEach((q, i) => {
    if (out.length >= 4 || !q || typeof q !== "object") return;
    const v = q as Record<string, unknown>;
    const question = str(v.question);
    const options = (Array.isArray(v.options) ? v.options : []).slice(0, 4).map((o) => (typeof o === "string" ? { label: o } : o as Record<string, unknown>))
      .filter((o) => str(o?.label)).map((o) => ({ label: str(o.label), description: str(o.description) || undefined, recommended: o.recommended === true }));
    if (!question || !options.length) return;
    if (!options.some((o) => o.recommended)) options[0].recommended = true;
    out.push({ id: str(v.id) || `q${i + 1}`, question, why: str(v.why) || undefined, multiple: v.multiple === true, options });
  });
  return out;
}

/** The answers as KeelBot's next message. */
export function answersMessage(qs: Question[], answers: Answers): string {
  return ["Answers to your questions:", ...qs.map((q, i) => {
    const a = answers[q.id];
    const said = Array.isArray(a) ? a.join("; ") : a;
    return `${i + 1}. ${q.question}\n   → ${said || "(not answered: use the recommended one)"}`;
  })].join("\n");
}

/** A git button in words: "switch to main", "commit \"fix: …\"", "push", "open the pull request \"…\"". */
export function gitWords(b: Extract<Button, { kind: "git" }>): string {
  switch (b.op) {
    case "switch": return `${b.create ? "create and switch to" : "switch to"} ${b.branch}`;
    case "commit": return `commit ${b.message ? `"${b.message.split("\n")[0]}"` : "the changes"}`;
    case "push": return "push the branch";
    case "pr": return `open the pull request${b.title ? ` "${b.title}"` : ""}`;
    default: return "update the branch from the base branch";
  }
}

/** A failed git switch that the folder's changes block: keel can stash them and switch (the Git plugin, 0.18.9). */
export const blockedByChanges = (b: Button, message: string) => b.kind === "git" && b.op === "switch" && /would be overwritten|local changes/i.test(message);

/** What a button tried, for KeelBot's fix request. */
export function buttonWords(b: Button): string {
  return b.kind === "git" ? `git: ${gitWords(b)}` : b.kind === "ci" ? `CI: ${b.op}` : b.kind === "query" ? `the query ${b.sql.slice(0, 120)}`
    : b.kind === "stop" ? "stopping flows" : b.kind === "decide" ? `${b.decision} a gate` : b.kind === "mode" ? `the run mode ${b.mode}`
    : b.kind === "start" ? `starting the ${b.workflow} flow` : `saving the ${b.kind}`;
}

/** Where to press a button the terminal does not have. */
export function elsewhere(b: Button): string {
  return `KeelBot gave a ${b.kind === "other" ? b.name : b.kind} button: press it in the dashboard's KeelBot panel (/dashboard keelbot).`;
}

type WorkflowReview = { name?: string; steps?: number; gates?: number; agents?: string[]; commands?: string[]; edits_files?: boolean;
  valid?: boolean; errors?: string[]; warnings?: string[]; lines?: { line: number; message: string }[] };
type RuleCheck = { ok?: boolean; errors?: string[]; dry_run?: { checked?: number; blocked?: { kind?: string; target?: string; agent?: string }[] } };

const pathOf = (pid: string) => `/projects/${encodeURIComponent(pid)}`;

/** A new workflow, rule pack or agent: keel's check first (nothing is saved), as the question and its detail; or why it
 *  cannot be saved. The other buttons: their question only. */
export async function prepare(b: Button, pid: string, name: Names): Promise<{ title: string; detail?: string } | { error: string } | null> {
  if (b.kind === "workflow") {
    const r = await post<WorkflowReview>(`${pathOf(pid)}/workflows/check`, { yaml: b.yaml });
    const what = `${r.name ?? "it"}: ${r.steps ?? 0} steps, ${r.gates ?? 0} gates` + (r.agents?.length ? `, agents ${r.agents.join(", ")}` : "")
      + (r.commands?.length ? `, runs ${r.commands.join(", ")}` : "") + (r.edits_files ? ", changes files" : ", changes no file");
    if (r.errors?.length || r.valid === false) {
      const at = new Map((r.lines ?? []).map((l) => [l.message, l.line]));
      return { error: `KeelBot's workflow cannot be saved yet (${what}):
` + (r.errors ?? []).map((e) => `  ${at.get(e) ? `line ${at.get(e)}: ` : ""}${e}`).join("\n")
        + "\nAsk KeelBot to fix it." };
    }
    return { title: `KeelBot wrote a workflow: save ${r.name ?? "it"}?`, detail: what + (r.warnings?.length ? `\n${r.warnings.map((w) => `warning: ${w}`).join("\n")}` : "") };
  }
  if (b.kind === "rule") {
    const r = await post<RuleCheck>(`${pathOf(pid)}/rules/check`, { yaml: b.yaml });
    if (!r.ok) return { error: "KeelBot's rule pack cannot be saved yet:\n" + (r.errors ?? []).map((e) => `  ${e}`).join("\n") + "\nAsk KeelBot to fix it." };
    const blocked = r.dry_run?.blocked ?? [];
    const name = /^name:\s*(\S+)/m.exec(b.yaml)?.[1] ?? "it";
    return { title: `KeelBot wrote a rule pack: save ${name}?`,
      detail: `On the recent tool calls it would have refused ${blocked.length} of ${r.dry_run?.checked ?? 0}`
        + (blocked.length ? `:\n${blocked.slice(0, 6).map((x) => `  ${x.kind}: ${x.target}${x.agent ? ` (${x.agent})` : ""}`).join("\n")}` : ".") };
  }
  if (b.kind === "agent") {
    const bad = (b.agent.tools ?? []).filter((x) => !AGENT_TOOLS.includes(x));
    if (bad.length) return { error: `KeelBot's agent has unknown tools: ${bad.join(", ")} (keel has ${AGENT_TOOLS.join(", ")}).` };
    return { title: `KeelBot wrote an agent: save "${b.agent.name}"?`,
      detail: `${b.agent.about ? b.agent.about + "\n" : ""}tools ${(b.agent.tools ?? ["Read", "Grep", "Glob"]).join(", ")} · phases ${(b.agent.phases ?? ["any"]).join(", ")}` };
  }
  if (b.kind === "skill") {
    const bad = skillProblems(b.text);
    if (bad.length) return { error: "KeelBot's skill cannot be saved yet:\n" + bad.map((e) => `  ${e}`).join("\n") + "\nAsk KeelBot to fix it." };
    const h = skillHead(b.text);
    const known = (await api.agents(pid)).map((a) => a.id);
    const unknown = h.agents.filter((a) => !known.includes(a));
    if (unknown.length) return { error: `KeelBot's skill names agents this project does not have: ${unknown.join(", ")} (it has ${known.join(", ")}).` };
    return { title: `KeelBot wrote a skill: save ${h.name}?`,
      detail: `${h.description ? h.description + "\n" : ""}~${Math.round(b.text.length / 4)} tokens · `
        + (h.agents.length ? `loaded by ${h.agents.join(", ")}` : "no agent loads it yet (/skill attach)") };
  }
  const q = question(b, name);
  return q ? { title: q } : null;
}

/** What a pressed button does; the words say what happened. */
export async function pressButton(b: Button, pid: string, name: Names): Promise<string> {
  switch (b.kind) {
    case "start": {
      const t = await api.startFlow(pid, { workflow_id: b.workflow, title: b.title || b.workflow, request: b.request, options: { started_via: "tui-keelbot" } });
      return `started ${b.workflow} "${t.title}": ${t.status}${t.current ? ` at ${t.current}` : ""}.`;
    }
    case "decide": {
      if (b.decision === "reject" && !b.why) throw new Error("A send-back needs a reason: /reject <why>.");
      const s = await inboxApi.act(b.flow, { decision: b.decision, ...(b.why ? { why: b.why } : {}) });
      return `${b.decision === "approve" ? "approved" : "sent back"} the gate of ${name(b.flow)}. The flow is ${s.status} at ${s.current || "-"}.`;
    }
    case "stop": {
      const done: string[] = [];
      const failed: string[] = [];
      for (const f of b.flows) {
        try {
          await api.stopThread(f);
          done.push(name(f));
        } catch (e) {
          failed.push(`${name(f)} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      return (done.length ? `stopped ${done.join(", ")}. Finished steps stay saved.` : "")
        + (failed.length ? `${done.length ? " " : ""}Not stopped: ${failed.join("; ")}.` : "");
    }
    case "mode": {
      await inboxApi.setMode(b.flow, b.mode);
      return `${name(b.flow)} runs in ${b.mode} mode from its next gate on.`;
    }
    case "workflow": {
      const r = await post<{ workflow: { id: string; steps?: unknown[] } }>(`${pathOf(pid)}/workflows/import`, { yaml: b.yaml });
      return `saved the workflow ${r.workflow.id} (${r.workflow.steps?.length ?? 0} steps). Start it: /flow ${r.workflow.id} <idea>.`;
    }
    case "rule": {
      const r = await post<{ pack?: { id?: string } }>(`${pathOf(pid)}/rules/packs`, { yaml: b.yaml });
      return `saved the rule pack ${r.pack?.id ?? ""} (.keel/rules/${r.pack?.id ?? "…"}.yaml): it applies from the next tool call. /rules shows it.`;
    }
    case "agent": {
      const a = b.agent;
      const r = await post<{ id: string; tools?: string[] }>(`${pathOf(pid)}/agents`, { name: a.name, about: a.about ?? "", prompt: a.prompt,
        tools: a.tools ?? ["Read", "Grep", "Glob"], phases: a.phases ?? ["any"] });
      return `saved the agent ${r.id} (tools ${(r.tools ?? a.tools ?? []).join(", ")}). A workflow uses it with agent: ${r.id}.`;
    }
    case "skill": {
      const h = skillHead(b.text);
      const r = await post<{ id: string; tokens?: number }>(`${pathOf(pid)}/skills/import`, { body: b.text });
      if (h.agents.length) await api.saveSkill(pid, r.id, { agents: h.agents });
      return `saved the skill ${r.id}` + (h.agents.length ? `; loaded by ${h.agents.join(", ")} from their next run.` : `. Put it on agents: /skill attach ${r.id} <agent…>.`);
    }
    case "git": {
      const body: Record<string, unknown> = b.op === "switch" ? { branch: b.branch, create: !!b.create, ...(b.stash ? { stash: true } : {}) }
        : b.op === "commit" ? { message: b.message ?? "" } : b.op === "pr" ? { title: b.title ?? "", body: b.body ?? "", draft: !!b.draft } : {};
      const r = await post<Record<string, any>>(`${pathOf(pid)}/git/${b.op}`, body);
      if (b.op === "switch") return `on ${r.branch} now.` + (r.stashed ? ` Your changes from ${r.stashed.from} are in git's stash: switch back to ${r.stashed.from} and run git stash pop to get them back.` : "");
      if (b.op === "commit") return `committed ${String(r.sha).slice(0, 7)} ${r.subject}.`;
      if (b.op === "push") return `pushed ${r.branch} (${String(r.sha).slice(0, 7)}).`;
      if (b.op === "pr") return `${r.updated ? "updated" : "opened"} the pull request${r.url ? `: ${r.url}` : "."}`;
      return r.merged ? `merged ${r.from} into ${r.branch}.` : `${r.branch} already has ${r.from}.`;
    }
    case "ci": {
      if (b.op === "fix") {
        const t = await post<{ thread_id: string }>(`${pathOf(pid)}/ci/fix`, b.run ? { run: b.run } : {});
        return `the ci-fix flow started (${t.thread_id.slice(0, 8)}): it reads the failure, fixes it, commits, pushes and waits for CI.`;
      }
      const run = b.run ?? (await get<{ id: number; failed?: boolean }[]>(`${pathOf(pid)}/ci/runs`)).find((r) => r.failed)?.id;
      if (!run) return "no failed CI run to start again.";
      await post(`${pathOf(pid)}/ci/runs/${run}/rerun`, {});
      return `the failed jobs of run #${run} run again.`;
    }
    case "query": {
      const r = await post<{ columns?: string[]; rows?: unknown[][]; count?: number; changed?: number; kind?: string }>(`${pathOf(pid)}/db/query`,
        { connection: b.connection ?? "", sql: b.sql, change: true, confirm: true });
      if (r.kind === "change") return `done: ${r.changed ?? 0} row(s) changed.`;
      const rows = (r.rows ?? []).slice(0, 15).map((x) => x.map((c) => String(c ?? "")).join(" | "));
      return [`${r.count ?? rows.length} row(s)`, (r.columns ?? []).join(" | "), ...rows].filter(Boolean).join("\n");
    }
    default: return elsewhere(b);
  }
}
