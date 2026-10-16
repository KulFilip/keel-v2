// keel's answers as text: the same words as keel2 mcp's tools (engine keel_engine/mcp_server.py, mcp_more.py), from
// the web's typed data. Pure functions, no UI: keel TUI prints them, another front end (an xal plugin, OpenTUI) can too.

import type { BudgetNow, Checkpoint, FlowView, Health, Job, JobStep, Project, RunRow, ThreadState, Workflow } from "./sdk";
import type { InboxItem } from "../../../web/src/inboxApi";

export const n = (x: unknown) => {
  const v = Number(x ?? 0);
  return Number.isFinite(v) ? Math.trunc(v).toLocaleString("en-US") : String(x);
};
export const usd = (x: unknown) => `$${Number(x ?? 0).toFixed(2)}`;
/** 1.2k, 3.4M: short token counts for the status line. */
export const short = (x: number) => (x >= 1e6 ? `${(x / 1e6).toFixed(1)}M` : x >= 1000 ? `${(x / 1000).toFixed(1)}k` : String(x));
export const clock = (at?: string | null) => {
  const d = at ? new Date(at) : null;
  if (!d || Number.isNaN(d.getTime())) return "--";
  const p = (v: number) => String(v).padStart(2, "0");
  return `${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
};

export const tokensOf = (u?: { tokens_in?: number; tokens_out?: number } | null) => Number(u?.tokens_in ?? 0) + Number(u?.tokens_out ?? 0);

export function flowName(t: ThreadState, w: Workflow | null): string {
  const wid = t.workflow_id || "?";
  return w?.name && w.name !== wid ? `${w.name} (${wid})` : wid;
}

export function acCount(t: ThreadState | null | undefined): [number, number] {
  const acs = t?.acs ?? [];
  return [acs.filter((a) => a.status === "done" || a.status === "already-met").length, acs.length];
}

type Waiting = NonNullable<ThreadState["waiting"]>;

/** What waits, and how to answer it in keel TUI. */
export function waitingLines(w: Waiting): string[] {
  const labels = w.labels ?? {};
  const out = [`waiting   ${w.kind || "gate"}: ${w.title}`];
  if (w.kind === "clarify") {
    out.push(`          answer: /answer (one question after the other)`);
    for (const q of w.questions ?? []) {
      const choices = q.options.map((o) => o.label + (o.recommended ? " (recommended)" : "")).join(" / ");
      out.push(`          ${q.id}: ${q.question}  [${choices}]`);
    }
  } else if (w.choices?.length) {
    out.push(`          answer: /answer <${w.choices.join(" | ")}>`);
  } else {
    const opts = w.options ?? ["approve", "reject"];
    const parts = [];
    if (opts.includes("approve")) parts.push("/approve" + (labels.approve ? ` ("${labels.approve}")` : ""));
    if (opts.includes("reject")) parts.push("/reject <why>" + (labels.reject ? ` ("${labels.reject}")` : ""));
    out.push(`          answer: ${parts.join(" or ") || "-"}`);
  }
  const detail = (w.detail ?? "").trim();
  if (detail) out.push(...detail.slice(0, 600).split("\n").map((l) => "          " + l));
  return out;
}

export function status(p: Project, view: FlowView | null): string {
  const head = `project   ${p.id} · branch ${p.branch || "-"}`;
  const t = view?.thread;
  if (!t) return `${head}\nflow      none. Start one: /flow`;
  const out = [head,
    `flow      ${flowName(t, view?.workflow ?? null)} · "${t.title}" · ${t.status} · thread ${t.thread_id}`,
    `step      ${t.current || "-"} · phase ${t.phase || "none"}` + (t.ac ? ` · ${t.ac}` : "")
      + (t.run_mode && t.run_mode !== "manual" ? ` · run mode ${t.run_mode}` : "")];
  if (t.acs?.length) {
    const [done, all] = acCount(t);
    out.push(`criteria  ${done}/${all} done`);
    t.acs.forEach((a) => out.push(`  ${`[${a.status}]`.padEnd(14)}${a.id} ${a.layer}  ${a.title}`));
  }
  if (t.waiting) out.push(...waitingLines(t.waiting));
  const u = t.usage ?? ({} as ThreadState["usage"]);
  const cap = u.cap_tokens ? ` of cap ${n(u.cap_tokens)}` : " (no cap)";
  out.push(`usage     ${n(tokensOf(u))} tokens${cap} · in ${n(u.tokens_in)} · out ${n(u.tokens_out)} · cached ${n(u.tokens_cached)} · ${usd(u.cost_usd)}`);
  if (t.error) out.push(`error     ${t.error}`);
  (t.blockers ?? []).forEach((b) => out.push(`blocker   ${b.gate}: ${b.why} -> ${b.fix}`));
  return out.join("\n");
}

export function next(p: Project | null, view: FlowView | null): string {
  const t = view?.thread;
  if (!p) return "no project: add one in the dashboard (All projects › Add projects), then /project.";
  if (!t) return "no flow: start one with /flow (feature, change, fix, diagnose, review, cover, ship, hunt, lint, init …).";
  const w = t.waiting;
  const ac = t.ac ? ` for ${t.ac}` : "";
  let out: string[];
  if (t.status === "waiting" && w) {
    if (w.kind === "clarify") out = [`waiting at ${w.title}: answer the ${(w.questions ?? []).length} question(s) with /answer.`];
    else if (w.kind === "budget") out = [`waiting at ${w.title}: /approve to go past the token cap, or /reject <why> to stop.`];
    else if (w.kind === "fix") out = [`waiting at ${w.title}: /approve to try again, or /reject <why> to stop the flow.`];
    else if (w.choices?.length) out = [`waiting at ${w.title}: choose with /answer <${w.choices.join(" | ")}>.`];
    else {
      const l = w.labels ?? {};
      out = [`waiting at ${w.step} (${w.title})${ac}: /approve` + (l.approve ? ` ("${l.approve}")` : "")
        + ((w.options ?? []).includes("reject") ? " or /reject <why>" + (l.reject ? ` ("${l.reject}")` : "") : "") + "."];
    }
  } else if (t.status === "running") out = [`running ${t.current || "the next step"} (phase ${t.phase || "none"})${ac}: nothing to do, keel is working. /live follows the agents.`];
  else if (t.status === "done") out = [`flow ${flowName(t, view?.workflow ?? null)} is done. Review the branch ${p.branch || ""} and open a PR, or start a new flow (/flow).`];
  else if (t.status === "failed") out = [`flow failed at ${t.current}: ${t.error || "see /timeline"}. /resume goes on from the last saved step.`];
  else if (t.status === "stopped") out = [`flow stopped at ${t.current}. /resume goes on from the last saved step, or start a new flow (/flow).`];
  else out = [`flow is ${t.status} at ${t.current}.`];
  const blockers = t.blockers ?? [];
  if (blockers.length) out.push("", "blocking a push:", ...blockers.map((b) => `  ${b.gate}: ${b.why} -> ${b.fix}`));
  return out.join("\n");
}

/** One line for the start screen: what waits for you. */
export function waitingBrief(inbox: InboxItem[], p: Project | null): string {
  if (!inbox.length) return "nothing waits for you";
  const here = p ? inbox.filter((i) => i.project_id === p.id) : [];
  const first = here[0] ?? inbox[0];
  const elsewhere = inbox.length - here.length;
  return `${inbox.length} waiting for you · ${first.kind}: ${first.title}` + (here.length ? "" : ` (${first.project_name})`)
    + (here.length && elsewhere ? ` · ${elsewhere} in other projects` : "");
}

export function timeline(history: Checkpoint[], jobs: Job[], limit = 20, thread?: ThreadState | null): string {
  const ev: [number, string][] = [];
  const at = (s?: string | null) => (s ? Date.parse(s) || 0 : 0);
  history.forEach((c) => ev.push([at(c.at), `${clock(c.at)}  step   ${c.step}` + (c.note ? ` · ${c.note}` : "")]));
  jobs.forEach((j) => {
    const where = [j.step, j.ac].filter(Boolean).join(" ");
    ev.push([at(j.started_at), `${clock(j.started_at)}  agent  ${j.agent} ${j.status} · ${where} · ${n(tokensOf(j))} tokens · ${j.provider}/${j.model} · job ${j.id}`]);
  });
  if (thread?.error) ev.push([at(thread.updated_at), `${clock(thread.updated_at)}  flow   ${thread.status} · ${thread.error}`]);
  if (!ev.length) return thread ? "no events yet." : "nothing yet: no flow has run on this project.";
  return ev.sort((a, b) => b[0] - a[0]).slice(0, limit).map(([, l]) => l).join("\n");
}

export function flows(rows: RunRow[]): string {
  if (!rows.length) return "no flow has run on this project yet. /flow starts one.";
  return rows.map((r) => `${r.thread_id}  ${r.workflow_id || "?"} "${r.title}" · ${r.status}` + (r.current ? ` at ${r.current}` : "")
    + ` · criteria ${r.acs_done ?? 0}/${r.acs_total ?? 0} · ${n(r.tokens)} tokens · ${usd(r.cost_usd)} · ${r.where || "folder"}`
    + (r.branch ? ` · branch ${r.branch}` : "") + (r.latest ? " · latest" : "") + (r.error ? ` · error: ${r.error}` : "")).join("\n");
}

export function inbox(items: InboxItem[]): string {
  if (!items.length) return "nothing waits for a person.";
  const out: string[] = [];
  items.forEach((i, k) => {
    out.push(`${k + 1}. ${i.project_name || i.project_id} · ${i.flow || i.thread_id} · ${i.kind}: ${i.title}` + (i.ac ? ` (${i.ac})` : "")
      + ` · ${(i.options ?? []).join(" / ") || "-"}`);
    (i.questions ?? []).forEach((q) => out.push(`     ${q.id}: ${q.question}`));
    if (i.permission) out.push(`     command: ${i.permission.command}`);
    if (i.detail) out.push(...String(i.detail).slice(0, 300).split("\n").map((l) => "     " + l));
  });
  return out.join("\n");
}

export function jobs(rows: Job[]): string {
  if (!rows.length) return "no agent calls yet.";
  return rows.map((j) => `${j.status.padEnd(8)} ${j.agent} · ${[j.step, j.ac].filter(Boolean).join(" ") || "-"} · ${j.provider}/${j.model} · `
    + `${n(tokensOf(j))} tokens · ${usd(j.cost_usd)} · ${clock(j.started_at)} · job ${j.id}`).join("\n");
}

export function stepLine(s: JobStep, width = 160): string {
  const head = s.kind === "tool" ? `${s.tool ?? "tool"}${s.server ? ` (${s.server})` : ""}: ` : s.path ? `${s.kind} ${s.path}: ` : `${s.kind}: `;
  const text = String(s.text ?? "").replace(/\s+/g, " ").trim();
  const line = head + text;
  return line.length > width ? line.slice(0, width - 1) + "…" : line;
}

export function live(running: Job[], last: Record<string, JobStep | undefined>): string {
  if (!running.length) return "no agent is running.";
  const out: string[] = [];
  running.forEach((j) => {
    out.push(`${j.agent} on ${j.project_id} · ${[j.step, j.ac].filter(Boolean).join(" ")} · ${j.provider}/${j.model} · ${n(tokensOf(j))} tokens · since ${clock(j.started_at)} · job ${j.id}`);
    const s = last[j.id];
    if (s) out.push(`    last: ${stepLine(s)}`);
  });
  return out.join("\n");
}

export function budget(now: BudgetNow): string {
  const out = [`today  ${n(now.today?.tokens)} tokens · ${usd(now.today?.cost_usd)}`, `month  ${n(now.month?.tokens)} tokens · ${usd(now.month?.cost_usd)}`];
  (now.flows ?? []).forEach((f) => out.push(`flow   "${f.title}" (${f.status}) · ${n(f.tokens)} tokens${f.cap_tokens ? ` of cap ${n(f.cap_tokens)}` : ""} · ${usd(f.cost_usd)}`));
  (now.caps ?? []).forEach((c) => {
    const x = c as unknown as Record<string, unknown>;
    out.push(`cap    ${x.scope} ${x.window ?? ""}: ${x.left} of ${x.limit} ${x.unit} left` + (x.resets_at ? ` (resets ${x.resets_at})` : "") + ` · then ${x.action}`);
  });
  return out.join("\n");
}

export function workflowsList(rows: Workflow[]): string {
  if (!rows.length) return "no workflows.";
  return rows.map((w) => `${w.id.padEnd(18)} ${w.name} · ${w.steps.length} steps · ${w.steps.filter((s) => s.kind === "gate").length} gates`
    + (w.source ? ` · ${w.source}` : "") + (w.runs ? ` · ran ${w.runs}x` : "")).join("\n");
}

type RulesLike = {
  config_file?: string; rules_folder?: string;
  engines?: { engine: string; words: string }[];
  builtins?: { id: string; words: string; phases: string; can_off?: boolean; off?: boolean }[];
  lists?: { key: string; value: string; saved_in: string }[];
  packs?: { id: string; version?: string; off?: boolean; title: string; summary?: string; source?: string; file?: string; rules?: { kind: string; match: string; phases: string; reason: string }[] }[];
  pack_errors?: { file: string; errors: string[] }[];
};
type RulesNowLike = { phase?: string; meaning?: string; may?: { what: string }[]; may_not?: { what: string }[]; fired?: { count: number; reason: string }[] };

export function rules(p: Project, v: RulesLike, now?: RulesNowLike | null): string {
  const out = [`keel's rules for ${p.name || p.id} (saved in ${v.config_file} and ${v.rules_folder}/):`, "", "Engines:"];
  (v.engines ?? []).forEach((e) => out.push(`  ${e.engine}: ${e.words}`));
  out.push("", "Always on:");
  (v.builtins ?? []).filter((b) => !b.can_off).forEach((b) => out.push(`  ${b.id}: ${b.words} (${b.phases})`));
  out.push("", "keel's rules you can switch off:");
  (v.builtins ?? []).filter((b) => b.can_off).forEach((b) => out.push(`  ${b.id}${b.off ? " [OFF]" : ""}: ${b.words} (${b.phases})`));
  if (v.lists?.length) {
    out.push("", "The project's lists:");
    v.lists.forEach((x) => out.push(`  ${x.key} = ${x.value}  (${x.saved_in})`));
  }
  const packs = v.packs ?? [];
  out.push("", packs.length ? "Rule packs:" : "Rule packs: none (the dashboard's Rules page adds one from the library).");
  packs.forEach((pk) => {
    out.push(`  ${pk.id} ${pk.version ?? ""}${pk.off ? " [OFF]" : ""} — ${pk.title}: ${pk.summary ?? ""}`);
    (pk.rules ?? []).forEach((r) => out.push(`    ${r.kind} ${r.match} (${r.phases}): ${r.reason}`));
  });
  (v.pack_errors ?? []).forEach((e) => out.push(`  NOT USED ${e.file}: ${e.errors.join("; ")}`));
  if (now) {
    out.push("", `Now (phase ${now.phase}): ${now.meaning ?? ""}`,
      "  may change: " + ((now.may ?? []).map((b) => b.what).join(", ") || "nothing"),
      "  may not change: " + ((now.may_not ?? []).map((b) => b.what).join(", ") || "—"));
    (now.fired ?? []).forEach((f) => out.push(`  stopped ${f.count}x: ${f.reason}`));
  }
  return out.join("\n");
}

type InstalledLike = { name: string; version?: string; title?: string; from?: string; on?: boolean; status?: string; update?: string; problems?: string[] };

export function plugins(installed: InstalledLike[], here?: { name: string; enabled: boolean }[]): string {
  if (!installed.length) return "keel has no plugins (a core-only keel). Control › Plugins adds them.";
  const on = new Map((here ?? []).map((p) => [p.name, p.enabled]));
  return ["keel has:", ...installed.map((p) => `  ${p.name.padEnd(10)} ${p.version ?? ""}  ${p.title ?? ""} · ${p.on ? "on" : "off"}`
    + (on.has(p.name) ? ` · this project: ${on.get(p.name) ? "on" : "off"}` : "") + (p.from ? ` · from ${p.from}` : "")
    + (p.update ? ` · update ${p.update}` : "") + (p.problems?.length ? ` · problem: ${p.problems.join("; ")}` : ""))].join("\n");
}

export function which(url: string, h: Health | null): string {
  if (!h) return `${url} · not reachable`;
  return `${url} · ${h.native ? "native" : "docker"}` + (h.fake ? " · fake model" : "") + (h.engine ? "" : " · engine down");
}
