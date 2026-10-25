// The Wiki's menu, in order of use: the pages of /wiki grouped by kind (Specs, Project knowledge, Decisions, Workflows,
// Overview), each group in a stable order, with readable titles, a filter, recent pages and the place of a page (its
// breadcrumb). Pure functions, so the order is tested on its own. A keel before the wiki's order sends only id, title
// and status: the kind then comes from the id (kb:, spec:, adr:, wf:, runbook) and the order from the title.
// 0.18.55 the sidebar: specs in one list that needs-you-first, the knowledge sections not written yet folded into one
// row, the workflows by purpose (Build, Fix, Check & ship, Set up & learn, Product, Yours, Other) from their metadata
// (source, addon, based_on) and without keel's "(keel)" suffix, and the last pages opened.

import type { SpecState, SpecStatus, WikiItem, WikiTree } from "@keel/web-sdk";

export type NavItem = {
  id: string;
  /** what the menu shows: the title without its number */
  title: string;
  /** the spec's or decision's number ("101"), shown before the title */
  number?: string;
  status?: string | null;
  spec?: SpecStatus;
  path?: string | null;
  updated?: string | null;
  /** the same file in other folders (shown once, marked) */
  also: string[];
  /** a workflow that is not one of keel's own ("yours") or keel Product's ("Product"): a small tag in the menu */
  tag?: "Product" | "yours";
  /** a workflow's base (based_on), shown as its tooltip */
  basedOn?: string | null;
};
/** A part of a group. Most groups have one without a title. A part with `fold` opens and closes on its own: the
 *  workflows' purposes ("sub", closed until opened) and the knowledge sections not written yet ("missing", one row). */
export type NavPart = { id: string; title?: string; items: NavItem[]; fold?: "sub" | "missing" };
export type NavGroup = { id: string; title: string; parts: NavPart[] };

const count = (g: NavGroup) => g.parts.reduce((n, p) => n + p.items.length, 0);
/** The pages a group's title counts: the written ones (a section not written yet is not a page to read). */
export const groupCount = (g: NavGroup) =>
  g.parts.reduce((n, p) => n + p.items.filter((i) => i.status !== "missing").length, 0);
export const groupItems = (g: NavGroup) => g.parts.flatMap((p) => p.items);

/** The groups, in order of use; a group nobody has is left out. The ids are the sections' ids keel always had, so a
 *  section someone closed stays closed. */
const GROUPS: { id: string; title: string }[] = [
  { id: "specs", title: "Specs" },
  { id: "knowledge", title: "Project knowledge" },
  { id: "decisions", title: "Decisions" },
  { id: "workflows", title: "Workflows" },
  { id: "overview", title: "Overview" },
];

/** A spec's place in the list: what waits for you, what runs, what stopped, what is not built, then done. */
function specRank(i: NavItem): number {
  const st = i.spec;
  if (!st) return 3;
  if (st.state === "in_progress") return st.status === "waiting" ? 0 : 1;
  return ({ stopped: 2, not_built: 3, built: 4 } as Record<SpecState, number>)[st.state] ?? 3;
}

/** The workflows by purpose, keel's own in this order (the most used first). keel Product's show only while keel
 *  Product is on (keel lists them only then); a workflow keel does not have is "Yours"; one of keel's this list does not
 *  name (a plugin's) goes to Other. */
export const WORKFLOW_PARTS: { id: string; title: string; ids?: string[] }[] = [
  { id: "build", title: "Build", ids: ["feature", "change", "implement", "small", "quick", "spike", "clarify"] },
  { id: "fix", title: "Fix", ids: ["fix", "diagnose"] },
  { id: "check", title: "Check & ship", ids: ["review", "review-pr", "cover", "lint", "ship", "hunt", "hunt-next"] },
  { id: "setup", title: "Set up & learn", ids: ["init", "knowledge-refresh"] },
  {
    id: "product", title: "Product",
    ids: ["product-flows", "product-discover", "product-impact", "product-decide", "product-plan", "product-outcome"],
  },
  { id: "yours", title: "Yours" },
  { id: "other", title: "Other" },
];

const KEEL_SUFFIX = /\s*\(keel(\s+product)?\)\s*$/i;

/** A workflow's name without keel's "(keel)" / "(keel Product)" at its end. */
export const workflowTitle = (t: string) => t.replace(KEEL_SUFFIX, "").trim() || t.trim();

/** Which purpose a workflow goes to, and its tag. It reads the workflow's metadata (source: keel or not, addon:
 *  product); a keel that does not send it gets the same answer from the name's suffix. */
export function workflowPart(item: WikiItem): { part: string; tag?: "Product" | "yours" } {
  const wid = item.id.replace(/^wf:/, "");
  const suffix = KEEL_SUFFIX.exec(item.title);
  const builtIn = item.source ? item.source === "keel" : !!suffix;
  if (!builtIn) return { part: "yours", tag: "yours" };
  const product = item.addon === "product" || (!item.addon && !!suffix?.[1]) ||
    !!WORKFLOW_PARTS.find((p) => p.id === "product")!.ids!.includes(wid);
  if (product) return { part: "product", tag: "Product" };
  return { part: WORKFLOW_PARTS.find((p) => p.ids?.includes(wid))?.id ?? "other" };
}

/** A workflow's place in its purpose: keel's order, then by title. */
function workflowOrder(part: string) {
  const ids = WORKFLOW_PARTS.find((p) => p.id === part)?.ids ?? [];
  const at = (i: NavItem) => {
    const n = ids.indexOf(i.id.replace(/^wf:/, ""));
    return n < 0 ? ids.length : n;
  };
  return (a: NavItem, b: NavItem) => at(a) - at(b) || byText(a.title, b.title);
}

export type NavOptions = {
  /** false: keel Product is off, so its workflows (and the Product group) are left out. Unset: what keel lists. */
  product?: boolean;
};

/** Which group an item goes to: its kind, else what its id says. */
export function groupOf(item: WikiItem): string | undefined {
  const k = item.kind;
  if (
    k === "overview" ||
    k === "runbook" ||
    item.id === "kb:index" ||
    item.id === "runbook"
  )
    return "overview";
  if (k === "knowledge" || item.id.startsWith("kb:")) return "knowledge";
  if (k === "spec" || item.id.startsWith("spec:")) return "specs";
  if (k === "decision" || item.id.startsWith("adr:")) return "decisions";
  if (k === "workflow" || item.id.startsWith("wf:")) return "workflows";
  return undefined;
}

/** The number a file name starts with (SPEC-101-x.md, 0001-x.md, adr:ADR-2-x.md), when the server did not send it. */
export function numberOf(item: WikiItem): string | undefined {
  if (item.number) return item.number;
  if (!/^(spec|adr):/.test(item.id)) return undefined;
  const file =
    item.id
      .slice(item.id.indexOf(":") + 1)
      .split("/")
      .pop() ?? "";
  return /^(?:(?:spec|adr)[\s_-]*)?(\d+)(?![.\d])/i.exec(file)?.[1];
}

/** The title to show: the server's label, else the title without a leading number that is the file's own. */
export function labelOf(item: WikiItem, number?: string): string {
  if (item.label) return item.label;
  const t = item.title.trim();
  if (!number) return t;
  const m = /^(?:(?:spec|adr)[\s_-]*)?(\d+)\s*[:.—–-]\s*(.+)$/i.exec(t);
  return m && Number(m[1]) === Number(number) ? m[2].trim() : t;
}

const byText = (a: string, b: string) =>
  a.localeCompare(b, undefined, { numeric: true, sensitivity: "base" });
const num = (n?: string) => (n === undefined ? NaN : Number(n));
const time = (s?: string | null) => (s ? Date.parse(s) || 0 : 0);

/** Numbered first, by number; then by title. */
function oldestFirst(a: NavItem, b: NavItem) {
  const na = num(a.number),
    nb = num(b.number);
  if (!isNaN(na) || !isNaN(nb)) {
    if (isNaN(na)) return 1;
    if (isNaN(nb)) return -1;
    if (na !== nb) return na - nb;
  }
  return byText(a.title, b.title);
}

/** Newest first: the higher number, else the newer file, else by title. */
function newestFirst(a: NavItem, b: NavItem) {
  const na = num(a.number),
    nb = num(b.number);
  if (!isNaN(na) && !isNaN(nb) && na !== nb) return nb - na;
  if (!isNaN(na) !== !isNaN(nb)) return isNaN(na) ? 1 : -1;
  const t = time(b.updated) - time(a.updated);
  return t || byText(a.title, b.title);
}

/** The knowledge sections in the server's order (keel's fixed order); the ones not written yet fold into one row. */
function knowledgeParts(id: string, items: NavItem[]): NavPart[] {
  return [
    { id, items: items.filter((i) => i.status !== "missing") },
    { id: `${id}-missing`, title: "not written", fold: "missing" as const, items: items.filter((i) => i.status === "missing") },
  ].filter((p) => p.items.length);
}

/** The overview: the index first, then how to run the project. */
const overviewOrder = (items: NavItem[]) =>
  [...items].sort(
    (a, b) => (a.id === "runbook" ? 1 : 0) - (b.id === "runbook" ? 1 : 0),
  );

/** The menu: every page of the tree in its group, each page once, empty groups left out. Specs are one list: waiting
 *  for you, running, stopped, not built, done (newest first in each; newest first when the status is not known).
 *  Workflows are split by purpose. A section keel does not know keeps its own title and order, after the known groups. */
export function buildNav(
  tree: WikiTree,
  specs: Map<string, SpecStatus> = new Map(),
  opts: NavOptions = {},
): NavGroup[] {
  const seen = new Set<string>();
  const by = new Map<string, NavItem[]>();
  const other: NavGroup[] = [];
  for (const s of tree.sections) {
    for (const it of s.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const number = numberOf(it);
      const g = groupOf(it);
      const item: NavItem = {
        id: it.id,
        title: g === "workflows" ? workflowTitle(it.label || it.title) : labelOf(it, number),
        number,
        status: it.status,
        spec: specs.get(it.id),
        path: it.path,
        updated: it.updated,
        also: it.also ?? [],
      };
      if (g === "workflows") {
        const { tag } = workflowPart(it);
        if (tag === "Product" && opts.product === false) continue;
        if (tag) item.tag = tag;
        item.basedOn = it.based_on ?? null;
      }
      if (g) {
        by.set(g, [...(by.get(g) ?? []), item]);
      } else {
        let og = other.find((o) => o.id === s.id);
        if (!og)
          other.push(
            (og = {
              id: s.id,
              title: s.title,
              parts: [{ id: s.id, items: [] }],
            }),
          );
        og.parts[0].items.push(item);
      }
    }
  }
  const groups: NavGroup[] = [];
  for (const { id, title } of GROUPS) {
    const items = by.get(id) ?? [];
    if (!items.length) continue;
    let parts: NavPart[];
    if (id === "specs") {
      parts = [{ id, items: [...items].sort((a, b) => specRank(a) - specRank(b) || newestFirst(a, b)) }];
    } else if (id === "knowledge") {
      parts = knowledgeParts(id, items);
    } else if (id === "workflows") {
      const byPart = byPurpose(items);
      parts = WORKFLOW_PARTS.map(({ id: p, title: t }) => ({
        id: `wf-${p}`,
        title: t,
        fold: "sub" as const,
        items: (byPart.get(p) ?? []).sort(workflowOrder(p)),
      })).filter((p) => p.items.length);
    } else if (id === "overview") {
      parts = [{ id, items: overviewOrder(items) }];
    } else if (id === "decisions") {
      parts = [{ id, items: [...items].sort(oldestFirst) }];
    } else {
      parts = [
        { id, items: [...items].sort((a, b) => byText(a.title, b.title)) },
      ];
    }
    groups.push({ id, title, parts });
  }
  return [...groups, ...other.filter((g) => count(g))];
}

/** The workflows by purpose (their id gives it; a workflow's metadata was read into its tag). */
function byPurpose(items: NavItem[]): Map<string, NavItem[]> {
  const by = new Map<string, NavItem[]>();
  for (const i of items) {
    const part = i.tag === "yours" ? "yours" : i.tag === "Product" ? "product" : workflowPart({ id: i.id, title: "", source: "keel" }).part;
    by.set(part, [...(by.get(part) ?? []), i]);
  }
  return by;
}

/** The words of a search, lower case. */
export const searchWords = (q: string) => q.trim().toLowerCase().split(/\s+/).filter(Boolean);

/** Only the pages that match the words (title, number, id or path, any case); groups and parts without a match go. */
export function filterNav(groups: NavGroup[], q: string): NavGroup[] {
  const words = searchWords(q);
  if (!words.length) return groups;
  const hit = (i: NavItem) => {
    const text = [i.title, i.number, i.id, i.path, i.spec?.title, i.tag]
      .filter(Boolean)
      .join(" ")
      .toLowerCase();
    return words.every((w) => text.includes(w));
  };
  return groups
    .map((g) => ({
      ...g,
      parts: g.parts
        .map((p) => ({ ...p, items: p.items.filter(hit) }))
        .filter((p) => p.items.length),
    }))
    .filter((g) => g.parts.length);
}

/** Where a page is: its group, its part (a spec's status) and the item; undefined when the menu does not have it. */
export function placeOf(
  groups: NavGroup[],
  id: string,
): { group: NavGroup; part: NavPart; item: NavItem } | undefined {
  for (const group of groups) {
    for (const part of group.parts) {
      const item = part.items.find((i) => i.id === id);
      if (item) return { group, part, item };
    }
  }
  return undefined;
}

/** The page the wiki opens on: the overview, else the first written knowledge section, else the first page. */
export function firstPage(groups: NavGroup[]): string | undefined {
  const all = groups.flatMap(groupItems);
  return (
    all.find((i) => i.id === "kb:index")?.id ??
    groups
      .find((g) => g.id === "knowledge")
      ?.parts[0].items.find((i) => i.status !== "missing")?.id ??
    all[0]?.id
  );
}

/** The overview as plain links at the top of the menu when it is short (the index and the runbook), else undefined
 *  (it is then a group at the end like the others). */
export function overviewLinks(groups: NavGroup[]): NavItem[] | undefined {
  const g = groups.find((x) => x.id === "overview");
  const items = g ? groupItems(g) : [];
  return items.length && items.length <= 2 ? items : undefined;
}

// ---- recent pages: the ids of the last pages opened, newest first

/** How many recent pages are kept (one more than shown: the open page is not shown). */
export const RECENT_KEEP = 6;

/** The list after opening `id`: it moves to the front, each page once, at most `keep`. */
export function pushRecent(list: string[], id: string, keep = RECENT_KEEP): string[] {
  return [id, ...list.filter((x) => x !== id)].slice(0, keep);
}

/** The recent pages the menu shows: newest first, without the open page and pages the wiki no longer has, at most 5. */
export function recentItems(groups: NavGroup[], ids: string[], cur: string, max = 5): NavItem[] {
  return ids
    .filter((id) => id !== cur)
    .map((id) => placeOf(groups, id)?.item)
    .filter((i): i is NavItem => !!i)
    .slice(0, max);
}
