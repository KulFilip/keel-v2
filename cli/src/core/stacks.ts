// keel 0.18.9 stacks in keel TUI (the twin of Build › Stacks and Marketplace › Stacks): how each project builds and
// tests. /stacks lists them (market [words]: the marketplace's), /stack <name> shows one with its YAML, /stack remove
// <name> removes one the project added (after a yes; keel's own say why not), /stack off|on <name> turns one off for
// the project, /stack install <name> brings one from the marketplace (its review first, then a yes). /create stack with
// no words is the guided form: keel reads the project's files, you pick the lane and the name, keel checks it, you save.

import { del, get, post, put } from "./sdk";
import type { Ctx, Reply } from "./commands";
import { PLAIN, type Paint } from "./theme";

export type StackRow = {
  name: string; lane: string; source: string; origin?: string; detected: boolean; off?: boolean; removable?: boolean; why?: string | null;
  installable?: boolean; market?: { version?: string; edited?: boolean; catalog?: string } | null; file?: string | null;
  commands: { name: string; cmd: string }[]; tools: { name: string; on?: string; fail?: string; off?: boolean }[]; layers: { id?: string }[];
};
type Suggestion = {
  lane: string; name: string; closest: string | null; read: string[]; detect: { files: string[]; extensions: string[]; package_deps: string[] };
  layers: { id: string; what?: string; where?: string }[]; skills: Record<string, string>; keys: { key: string; what: string }[];
  commands: Record<string, { cmd: string; from: string }[]>; tools: { name: string; run: string; on: string; fail: string }[];
};
type Check = { ok: boolean; errors: string[]; warnings: string[]; name: string | null; yaml: string; detects_here?: boolean | null; skills_missing?: string[] };
type MarketHit = { name: string; title: string; publisher?: string; publisher_title?: string; version: string | null; summary: string;
  review?: { lane: string; layers: string[]; commands: Record<string, string>; tools: { name: string; on: string }[] };
  installed: { version: string; edited: boolean } | null; update: string | null; refused?: { error: string } | null; conflict?: string | null };

const text = (t: string): Reply => ({ blocks: [{ kind: "text", text: t }] });
const ok = (t: string): Reply => ({ blocks: [{ kind: "ok", text: t }] });
const fail = (t: string): Reply => ({ blocks: [{ kind: "error", text: t }] });
const P = (ctx: Ctx): Paint => ctx.paint ?? PLAIN;
const e = encodeURIComponent;
const project = (ctx: Ctx): string => {
  const p = ctx.core.snapshot.project;
  if (!p) throw new Error("No project yet: add one in the dashboard (All projects › Add projects), then /project.");
  return p.id;
};

let cache: { pid: string; names: string[] } | null = null;
export const cachedStackNames = (ctx: Ctx) => (cache?.pid === ctx.core.pid ? cache.names : []);

async function rows(ctx: Ctx): Promise<StackRow[]> {
  const pid = project(ctx);
  const list = (await get<StackRow[]>(`/projects/${e(pid)}/stacks`)) ?? [];
  cache = { pid, names: list.map((s) => s.name) };
  return list;
}

const where = (s: StackRow) => `${s.origin ?? s.source}${s.market?.version ? ` ${s.market.version}${s.market.edited ? " (edited)" : ""}` : ""}`;
const state = (s: StackRow) => (s.off ? "turned off" : s.detected ? "used" : "not used");

export function stacksText(list: StackRow[], pid: string, p: Paint = PLAIN): string {
  if (!list.length) return `keel knows no stack for ${pid}. /create stack writes one.`;
  const w = Math.max(...list.map((s) => s.name.length));
  const used = list.filter((s) => s.detected && !s.off).length;
  return [p.bold(`${list.length} stacks for ${pid}, ${used} used`) + p.dim("  (name · lane · from · in this project)"),
    ...list.map((s) => `  ${s.name.padEnd(w)}  ${s.lane} · ${where(s)} · ${s.off ? p.dim("turned off") : s.detected ? "used" : p.dim("not used")}`
      + (s.installable ? p.dim(" · /stack install-pack " + s.name) : "")),
    p.dim("  /stack <name> shows one · /stack remove <name> · /stack off <name> · /stacks market finds more · /create stack writes one")].join("\n");
}

async function one(ctx: Ctx, name: string): Promise<Reply> {
  const pid = project(ctx);
  const s = await get<StackRow & { yaml: string }>(`/projects/${e(pid)}/stacks/${e(name)}`);
  const p = P(ctx);
  const head = [p.bold(s.name) + p.dim(`  ${s.lane} · ${where(s)} · ${state(s)}${s.file ? ` · ${s.file}` : ""}`),
    s.removable ? p.dim("it can be removed: /stack remove " + s.name) : p.dim(`it cannot be removed: ${s.why ?? "it ships with keel"}`)];
  return { blocks: [{ kind: "text", text: head.join("\n") }, { kind: "markdown", text: "```yaml\n" + (s.yaml ?? "").trim() + "\n```" }] };
}

async function remove(ctx: Ctx, name: string): Promise<Reply> {
  const pid = project(ctx);
  if (!name) return fail("Name the stack: /stack remove <name> (/stacks lists them).");
  const s = (await rows(ctx)).find((x) => x.name === name);
  if (!s) return fail(`No stack ${name} here. /stacks lists them.`);
  if (!s.removable) return fail(`${name} cannot be removed: ${s.why ?? "it ships with keel"}${s.origin === "keel" ? `\nTurn it off for this project: /stack off ${name}` : ""}`);
  return { blocks: [{ kind: "dim", text: `  keel deletes ${s.file ?? "its file"}${s.origin === "pack" ? " with the pack's skills" : ""}${s.market?.edited ? ", and the changes made here" : ""}.` }],
    pick: { title: `Remove the stack ${name} from ${pid}?`, choices: [{ label: "Yes, remove it", value: "yes" }, { label: "No", value: "no" }],
      then: async (v) => {
        if (v !== "yes") return text("Not removed.");
        const r = await del<{ removed: string; back: string | null }>(`/projects/${e(pid)}/stacks/${e(name)}`);
        return ok(`removed ${name} (${r.removed}).` + (r.back === "keel" ? ` keel's own ${name} is used again.` : ""));
      } } };
}

async function turn(ctx: Ctx, name: string, off: boolean): Promise<Reply> {
  const pid = project(ctx);
  if (!name) return fail(`Name the stack: /stack ${off ? "off" : "on"} <name>.`);
  const r = await put<{ all: string[] }>(`/projects/${e(pid)}/stacks/${e(name)}/off`, { off });
  return ok(`${name} is turned ${off ? "off" : "on again"} for ${pid}` + (r.all?.length ? `; turned off there: ${r.all.join(", ")}.` : "."));
}

async function installPack(ctx: Ctx, name: string): Promise<Reply> {
  const pid = project(ctx);
  if (!name) return fail("Name the pack: /stack install-pack <name> (/stacks lists the installable ones).");
  await post(`/projects/${e(pid)}/stacks/${e(name)}/install`, {});
  return ok(`pack ${name} installed in ${pid}: its stack file and skills are in .keel/stacks/${name}.`);
}

export async function marketStacks(ctx: Ctx, q: string): Promise<Reply> {
  const pid = project(ctx);
  const r = await get<{ stacks: MarketHit[]; builtin: { name: string; lane: string; source: string; installable: boolean; used: boolean }[];
    catalog_error?: { error: string } | null }>(`/marketplace/stacks?q=${e(q)}&project=${e(pid)}`);
  const p = P(ctx);
  const lines: string[] = [];
  if (r.catalog_error) lines.push(p.dim(`  no stack catalog answers: ${r.catalog_error.error}`));
  for (const h of r.stacks ?? []) {
    const have = h.installed ? `installed ${h.installed.version}${h.update ? `, update ${h.update}` : ""}` : h.version ? `version ${h.version}` : `refused: ${h.refused?.error ?? "?"}`;
    lines.push(`  ${h.name}  ${h.title} · ${h.review?.lane ?? "?"} · ${h.publisher_title || h.publisher} · ${have}`);
    if (h.summary) lines.push(p.dim(`    ${h.summary}`));
  }
  for (const b of r.builtin ?? []) lines.push(`  ${b.name}  ${p.dim(`keel's own (${b.source}) · ${b.lane} · ${b.used ? "used here" : b.installable ? "/stack install-pack " + b.name : "used where detected"}`)}`);
  if (!lines.length) return text(q ? `No stack matches "${q}".` : "The marketplace lists no stacks yet.");
  return text([p.bold("Stacks in the marketplace") + p.dim("  /stack install <name> · keel's packs: /stack install-pack <name>"), ...lines].join("\n"));
}

/** /stack install <name>: the marketplace's verified stack, every command it runs first, then one yes installs it. */
async function install(ctx: Ctx, name: string): Promise<Reply> {
  const pid = project(ctx);
  if (!name) return fail("Name the stack: /stack install <name> (/stacks market lists them).");
  const s = await get<MarketHit & { builtin?: boolean; installable?: boolean; fetch_error?: { error: string; hint?: string } | null;
    check?: Check | null }>(`/marketplace/stacks/${e(name)}?project=${e(pid)}`);
  if (s.builtin) return text(s.installable ? `${name} is a keel pack: /stack install-pack ${name}` : `${name} is keel's own: it is used wherever it is detected.`);
  if (s.fetch_error) return fail(`keel will not install it: ${s.fetch_error.error}${s.fetch_error.hint ? ` ${s.fetch_error.hint}` : ""}`);
  if (s.refused) return fail(`keel will not install it: ${s.refused.error}`);
  if (s.check && !s.check.ok) return fail(`keel's check finds errors:\n${s.check.errors.map((x) => "  " + x).join("\n")}`);
  const replace = !!s.installed || !!s.conflict;
  const cmds = Object.entries(s.review?.commands ?? {}).map(([k, v]) => `  ${k}: ${v}`);
  const detail = [`${s.title} ${s.version} by ${s.publisher_title || s.publisher} · ${s.review?.lane} · layers ${(s.review?.layers ?? []).join(", ")}`,
    "what it runs:", ...cmds, ...(s.review?.tools ?? []).map((t) => `  tool ${t.name} (on ${t.on})`), ...(s.check?.warnings ?? []).map((w) => `warning: ${w}`)];
  return { blocks: [{ kind: "dim", text: detail.map((l) => "  " + l).join("\n") }],
    pick: { title: s.installed ? `Update ${name} ${s.installed.version} to ${s.version}?` : s.conflict ? `${pid} has its own ${name}: replace it with ${s.version}?` : `Install ${name} ${s.version}?`,
      choices: [{ label: replace ? "Yes, replace my copy" : "Yes, install it", value: "yes" }, { label: "No", value: "no" }],
      then: async (v) => {
        if (v !== "yes") return text("Not installed.");
        const r = await post<{ path: string; market: { version: string; catalog: string } }>(`/projects/${e(pid)}/stacks/market/install`,
          { name, ...(replace ? { replace: true } : {}) });
        return ok(`installed ${name} ${r.market.version} from the catalog ${r.market.catalog} as ${r.path}.`);
      } } };
}

/** What `/stack` does with its words. */
export async function stackRun(ctx: Ctx, a: string): Promise<Reply> {
  const [first, ...rest] = a.trim().split(/\s+/).filter(Boolean);
  if (!first) {
    const list = await rows(ctx);
    if (!list.length) return text("No stack yet: /create stack.");
    return { blocks: [], pick: { title: "Show which stack?", choices: list.map((s) => ({ label: s.name, value: s.name, hint: `${s.lane} · ${where(s)} · ${state(s)}` })),
      then: (v) => one(ctx, v) } };
  }
  if (first === "remove") return remove(ctx, rest[0] ?? "");
  if (first === "off" || first === "on") return turn(ctx, rest[0] ?? "", first === "off");
  if (first === "install") return install(ctx, rest[0] ?? "");
  if (first === "install-pack") return installPack(ctx, rest[0] ?? "");
  return one(ctx, first);
}

export async function stacksRun(ctx: Ctx, a: string): Promise<Reply> {
  const m = /^market\b\s*([\s\S]*)$/.exec(a.trim());
  if (m) return marketStacks(ctx, m[1].trim());
  return text(stacksText(await rows(ctx), project(ctx), P(ctx)));
}

export function stackComplete(ctx: Ctx, a: string): string[] {
  const parts = a.split(/\s+/);
  if (parts.length <= 1) return [...["remove ", "off ", "on ", "install ", "install-pack "], ...cachedStackNames(ctx)].filter((x) => x.startsWith(parts[0]));
  if (parts.length === 2 && ["remove", "off", "on"].includes(parts[0])) return cachedStackNames(ctx).filter((x) => x.startsWith(parts[1])).map((x) => `${parts[0]} ${x}`);
  return [];
}

// ------------------------------------------------------------------ /create stack: the guided form

/** The form from keel's suggestion: the first command keel found for each key, its layers and what detects it. */
export function formFrom(s: Suggestion, name: string) {
  const commands: Record<string, string> = {};
  for (const k of s.keys) if (s.commands[k.key]?.[0]) commands[k.key] = s.commands[k.key][0].cmd;
  return { name, lane: s.lane, detect: { files: s.detect.files.slice(0, 2), package_deps: s.detect.package_deps, extensions: s.detect.extensions.slice(0, 2) },
    layers: s.layers, commands, tools: {}, ...(Object.keys(s.skills ?? {}).length ? { skills: s.skills } : {}) };
}

async function guidedCheck(ctx: Ctx, s: Suggestion, name: string): Promise<Reply> {
  const pid = project(ctx);
  const c = await post<Check>(`/projects/${e(pid)}/stacks/check`, { form: formFrom(s, name) });
  const lines = [...c.errors.map((x) => `error: ${x}`), ...c.warnings.map((x) => `warning: ${x}`)];
  const blocks: Reply["blocks"] = [{ kind: "markdown", text: "```yaml\n" + c.yaml.trim() + "\n```" }];
  if (lines.length) blocks.push({ kind: "dim", text: lines.map((l) => "  " + l).join("\n") });
  if (!c.ok) return { blocks: [...blocks, { kind: "error", text: "keel cannot save it yet. Change the YAML in a file and /create stack --file <path>, or ask KeelBot: /create stack <what it is>." }] };
  return { blocks, pick: { title: `Save the stack ${c.name} as .keel/stacks/${c.name}.yml?`, choices: [{ label: "Yes, save it", value: "yes" }, { label: "No", value: "no" }],
    then: async (v) => {
      if (v !== "yes") return text("Not saved.");
      const r = await post<{ path: string }>(`/projects/${e(pid)}/stacks/save`, { yaml: c.yaml });
      return ok(`saved ${c.name} as ${r.path}: keel uses it from the next step on. /stack ${c.name} shows it.`);
    } } };
}

/** /create stack with no words: keel reads the project's files, the person picks the lane and the name, keel checks. */
export async function guidedStack(ctx: Ctx): Promise<Reply> {
  const pid = project(ctx);
  const first = await get<Suggestion>(`/projects/${e(pid)}/stacks/suggest`);
  const found = first.read.length ? first.read.join(", ") : "no build file keel knows";
  return { blocks: [{ kind: "dim", text: `  keel read ${found}${first.closest ? `; it is most like keel's ${first.closest} stack` : ""}.` }],
    pick: { title: "Which lane does the stack build and test?", index: first.lane === "web" ? 1 : 0,
      choices: [{ label: "api", value: "api", hint: "a backend: the API criteria" }, { label: "web", value: "web", hint: "a frontend: the WEB criteria" }],
      then: async (lane) => {
        const s = lane === first.lane ? first : await get<Suggestion>(`/projects/${e(pid)}/stacks/suggest?lane=${e(lane)}`);
        const found2 = s.keys.map((k) => `  ${k.key}: ${s.commands[k.key]?.[0] ? `${s.commands[k.key][0].cmd}  (${s.commands[k.key][0].from})` : "-"}`);
        return { blocks: [{ kind: "dim", text: ["  what keel found for each command:", ...found2].join("\n") }],
          ask: { prompt: `Its name (Enter: ${s.name})?`, then: (n) => guidedCheck(ctx, s, n.trim() || s.name) } };
      } } };
}

/** The KeelBot request of /create stack <words>: it reads the build files first. */
export function stackRequest(idea: string): string {
  return `Write a new keel stack for this project: ${idea}\nRead its build files first (package.json scripts, the Gradle or Maven build, `
    + "pyproject.toml, composer.json, go.mod, a Makefile, .pre-commit-config.yaml): every command must be one this project really has. "
    + "End your answer with the whole stack YAML in one keel-stack block.";
}
