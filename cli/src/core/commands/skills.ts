// Skill, rule, stack and plugin commands, and the skill marketplace.

import { api, get, post } from "../sdk";
import { rulesApi } from "../../../../web/src/rulesApi";
import { agentName } from "../../../../web/src/agentNames";
import * as fmt from "../format";
import { type Paint } from "../theme";
import { stackComplete, stackRun, stacksRun } from "../stacks";
import { resolve } from "node:path";
import { COMMANDS_BY_NAME, P, fail, flowNow, join, needProject, ok, text } from "./base";
import type { Ctx, Impl, Reply } from "./base";

// ------------------------------------------------------------------ 0.18.6 skills

type SkillRow = { id: string; kind: string; source: string; tokens: number; agents: string[]; when: string; enabled: boolean; about?: string;
  market?: { version: string; edited: boolean } | null };
type SkillOne = SkillRow & { stack: string; version: string; body: string; refs: { path: string; tokens: number }[] };
type MarketHit = { name: string; title: string; publisher_title?: string; publisher: string; version: string | null; summary: string;
  review?: { tokens: number; sections: string[]; description: string }; installed: { version: string; sid: string } | null; update: string | null;
  refused?: { error: string } | null };
type MarketBuiltin = { name: string; summary: string; source: string; tokens: number; agents: string[] };

const k1 = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
let skillCache: { pid: string; ids: string[] } | null = null;
const cachedSkillIds = (ctx: Ctx) => (skillCache?.pid === ctx.core.pid ? skillCache.ids : []);

async function skillRows(ctx: Ctx): Promise<SkillRow[]> {
  const pid = needProject(ctx).id;
  const rows = (await get<SkillRow[]>(`/projects/${encodeURIComponent(pid)}/skills`)) ?? [];
  skillCache = { pid, ids: rows.map((r) => r.id) };
  return rows;
}

function skillsText(rows: SkillRow[], project: string, p: Paint): string {
  if (!rows.length) return `${project} has no skill. /create skill <what it should teach> writes one.`;
  const w = Math.max(...rows.map((r) => r.id.length));
  return [p.bold(`${rows.length} skills on ${project}`) + p.dim("  (id · kind · from · size · the agents that load it)"),
    ...rows.map((r) => `  ${r.id.padEnd(w)}  ${r.kind} · ${r.source}${r.market ? ` ${r.market.version}${r.market.edited ? " (edited)" : ""}` : ""} · `
      + `${k1(r.tokens)} tokens · ${r.agents.length ? r.agents.join(", ") : p.dim("no agent")}${r.enabled ? "" : p.dim(" · off")}`),
    p.dim("  /skill <id> reads one · /skill attach <id> <agent…> · /skills market finds more · /create skill writes one")].join("\n");
}

/** Put a skill on agents (or take it off): the skill's own list, and the agents whose own skill list is set here (it wins). */
async function attachSkill(ctx: Ctx, sid: string, given: string[], detach: boolean): Promise<Reply> {
  const pid = needProject(ctx).id;
  const agents = [...new Set(given.map(agentName))];      // an old agent name means the new agent
  if (!sid || !agents.length) return fail(`Name the skill and the agents: /skill ${detach ? "detach" : "attach"} <id> <agent…>`);
  const all = await api.agents(pid);
  const bad = agents.filter((a) => !all.some((x) => x.id === a));
  if (bad.length) return fail(`No agent ${bad.join(", ")} here. The agents: ${all.map((a) => a.id).join(", ")}`);
  const now = (await get<SkillOne>(`/skills/${encodeURIComponent(sid)}?project=${encodeURIComponent(pid)}`)).agents ?? [];
  const after = detach ? now.filter((a) => !agents.includes(a)) : [...now, ...agents.filter((a) => !now.includes(a))];
  const changed = agents.filter((a) => now.includes(a) === detach);
  if (!changed.length) return text(`${sid} was ${detach ? "on none of" : "already on"} ${agents.join(", ")}: nothing changed.`);
  await api.saveSkill(pid, sid, { agents: after });
  for (const a of all.filter((x) => agents.includes(x.id) && x.overridden.includes("skills"))) {
    const want = detach ? a.skills.filter((x) => x !== sid) : a.skills.includes(sid) ? a.skills : [...a.skills, sid];
    if (want.join() !== a.skills.join()) await api.saveAgent(pid, a.id, { skills: want });
  }
  return ok(`${detach ? "took" : "put"} ${sid} ${detach ? "off" : "on"} ${changed.join(", ")}; loaded by ${after.length ? after.join(", ") : "no agent"} now, from the next run.`);
}

async function marketSkills(ctx: Ctx, q: string): Promise<Reply> {
  const pid = needProject(ctx).id;
  const r = await get<{ skills: MarketHit[]; builtin: MarketBuiltin[]; catalog_error?: { error: string } | null }>(
    `/marketplace/skills?q=${encodeURIComponent(q)}&project=${encodeURIComponent(pid)}`);
  const p = P(ctx);
  const lines: string[] = [];
  if (r.catalog_error) lines.push(p.dim(`  no skill catalog answers: ${r.catalog_error.error}`));
  for (const h of r.skills ?? []) {
    const have = h.installed ? `installed ${h.installed.version}${h.update ? `, update ${h.update}` : ""}` : h.version ? `version ${h.version}` : `refused: ${h.refused?.error ?? "?"}`;
    lines.push(`  ${h.name}  ${h.title} · ${h.publisher_title || h.publisher} · ${have}${h.review ? ` · ${k1(h.review.tokens)} tokens` : ""}`);
    if (h.summary) lines.push(p.dim(`    ${h.summary}`));
  }
  for (const b of r.builtin ?? []) lines.push(`  ${b.name}  ${p.dim(`keel's own (${b.source}) · in every project · ${k1(b.tokens)} tokens · ${b.agents.join(", ") || "no agent"}`)}`);
  if (!lines.length) return text(q ? `No skill matches "${q}".` : "The marketplace lists no skills yet.");
  return text([p.bold("Skills in the marketplace") + p.dim("  /skill install <name> [agent…] · keel's own: /skill attach"), ...lines].join("\n"));
}

/** /skill install <name> [agent…]: the marketplace's verified skill, its review first, then one yes installs it. */
async function installSkill(ctx: Ctx, name: string, agents: string[]): Promise<Reply> {
  const pid = needProject(ctx).id;
  if (!name) return fail("Name the skill: /skill install <name> [agent…] (/skills market lists them).");
  const s = await get<MarketHit & { text: string | null; builtin?: boolean; fetch_error?: { error: string; hint?: string } | null }>(
    `/marketplace/skills/${encodeURIComponent(name)}?project=${encodeURIComponent(pid)}`);
  if (s.builtin) return text(`${name} is keel's own: it is in every project already. Put it on agents: /skill attach ${name} <agent…>`);
  if (s.fetch_error) return fail(`keel will not install it: ${s.fetch_error.error}${s.fetch_error.hint ? ` ${s.fetch_error.hint}` : ""}`);
  if (s.refused) return fail(`keel will not install it: ${s.refused.error}`);
  const replace = !!s.installed;
  const detail = [`${s.title} ${s.version} by ${s.publisher_title || s.publisher}${s.review ? ` · ${k1(s.review.tokens)} tokens · ${s.review.sections.join(", ")}` : ""}`,
    s.review?.description ?? "", agents.length ? `loaded by ${agents.join(", ")}` : "no agent loads it yet (/skill attach)"].filter(Boolean);
  return { blocks: [{ kind: "dim", text: detail.map((l) => "  " + l).join("\n") }],
    pick: { title: replace ? `Update ${name} ${s.installed!.version} to ${s.version}?` : `Install ${name} ${s.version}?`,
      choices: [{ label: replace ? "Yes, replace my copy" : "Yes, install it", value: "yes" }, { label: "No", value: "no" }],
      then: async (v) => {
        if (v !== "yes") return text("Not installed.");
        const r = await post<{ skill: SkillRow; market: { version: string; catalog: string } }>(`/projects/${encodeURIComponent(pid)}/skills/market/install`,
          { name, ...(agents.length ? { agents } : {}), ...(replace ? { replace: true } : {}) });
        return ok(`installed ${r.skill.id} ${r.market.version} from the catalog ${r.market.catalog}` + (r.skill.agents.length ? `; loaded by ${r.skill.agents.join(", ")}.` : "."));
      } } };
}


export const SKILLS_IMPLS: Impl[] = [
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
    // 0.18.6 the project's skills and the agents that load each; /skills market [words]: the marketplace's
    name: "skills",
    run: async (ctx, a) => {
      const m = /^market\b\s*([\s\S]*)$/.exec(a.trim());
      if (m) return marketSkills(ctx, m[1].trim());
      return text(skillsText(await skillRows(ctx), needProject(ctx).id, P(ctx)));
    },
  },
  {
    // 0.18.6 one skill's text; attach / detach <id> <agent…>; install <name> [agent…] from the marketplace
    name: "skill",
    complete: (ctx, a) => {
      const parts = a.split(/\s+/);
      if (parts.length <= 1) return [...["attach ", "detach ", "install "], ...cachedSkillIds(ctx)].filter((x) => x.startsWith(parts[0]));
      if (parts.length === 2 && (parts[0] === "attach" || parts[0] === "detach")) return cachedSkillIds(ctx).filter((x) => x.startsWith(parts[1])).map((x) => `${parts[0]} ${x} `);
      return [];
    },
    run: async (ctx, a) => {
      const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
      if (!first) {
        const rows = await skillRows(ctx);
        if (!rows.length) return text("No skill yet: /create skill <what it should teach>.");
        return { blocks: [], pick: { title: "Read which skill?", choices: rows.map((r) => ({ label: r.id, value: r.id, hint: `${r.kind} · ${r.source} · ${k1(r.tokens)} tokens` })),
          then: (v) => COMMANDS_BY_NAME.skill.run(ctx, v) } };
      }
      if (first === "attach" || first === "detach") return attachSkill(ctx, rest[0] ?? "", rest.slice(1), first === "detach");
      if (first === "install") return installSkill(ctx, rest[0] ?? "", rest.slice(1));
      const pid = needProject(ctx).id;
      const s = await get<SkillOne>(`/skills/${encodeURIComponent(first)}?project=${encodeURIComponent(pid)}`);
      const p = P(ctx);
      const head = [p.bold(s.id) + p.dim(`  ${s.kind} · ${s.stack} · ${s.source} · version ${s.version} · ${k1(s.tokens)} tokens${s.enabled ? "" : " · off"}`),
        `loaded by ${s.agents.length ? s.agents.join(", ") : "no agent"} · when ${s.when || "on demand"}`,
        ...(s.refs?.length ? [p.dim(`references (read only when asked): ${s.refs.map((r) => r.path).join(", ")}`)] : [])];
      return { blocks: [{ kind: "text", text: head.join("\n") }, { kind: "markdown", text: s.body.trim() }] };
    },
  },
  // 0.18.9 how each project builds and tests (core/stacks.ts): the list (market: the marketplace's), one, remove, off
  { name: "stacks", run: (ctx, a) => stacksRun(ctx, a) },
  { name: "stack", complete: stackComplete, run: (ctx, a) => stackRun(ctx, a) },
  {
    name: "plugins",
    run: async (ctx) => {
      const body = await get<unknown>("/plugins/installed");
      const rows = (Array.isArray(body) ? body : ((body as { plugins?: unknown[] })?.plugins ?? [])) as never[];
      const here = ctx.core.pid ? await api.plugins(ctx.core.pid).catch(() => []) : [];
      return text(fmt.plugins(rows, here.map((x) => ({ name: x.name, enabled: !!(x as { enabled?: boolean }).enabled })), P(ctx)));
    },
  },
];
