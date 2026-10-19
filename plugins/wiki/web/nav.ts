// The Wiki's menu, in order: the pages of /wiki grouped by kind (Overview, Architecture & knowledge, Specs by build
// status, Decisions, Workflows), each group in a stable order, with readable titles, a filter and the place of a page
// (its breadcrumb). Pure functions, so the order is tested on its own. A keel before the wiki's order sends only id,
// title and status: the kind then comes from the id (kb:, spec:, adr:, wf:, runbook) and the order from the title.

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
};
/** A part of a group: Specs has one per build status; the other groups have one without a title. */
export type NavPart = { id: string; title?: string; items: NavItem[] };
export type NavGroup = { id: string; title: string; parts: NavPart[] };

const count = (g: NavGroup) => g.parts.reduce((n, p) => n + p.items.length, 0);
export const groupCount = count;
export const groupItems = (g: NavGroup) => g.parts.flatMap((p) => p.items);

/** The groups, in this order; a group nobody has is left out. The ids are the sections' ids keel always had, so a
 *  section someone closed stays closed. */
const GROUPS: { id: string; title: string }[] = [
  { id: "overview", title: "Overview" },
  { id: "knowledge", title: "Architecture & knowledge" },
  { id: "specs", title: "Specs" },
  { id: "decisions", title: "Decisions" },
  { id: "workflows", title: "Workflows" },
];

/** Specs by build status: what moves first, done last. */
const SPEC_PARTS: { state: SpecState; title: string }[] = [
  { state: "in_progress", title: "In progress" },
  { state: "stopped", title: "Stopped" },
  { state: "not_built", title: "Not built yet" },
  { state: "built", title: "Done" },
];

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

/** The knowledge sections in the server's order (keel's fixed order), the ones not written yet last. */
function knowledgeOrder(items: NavItem[]) {
  return [
    ...items.filter((i) => i.status !== "missing"),
    ...items.filter((i) => i.status === "missing"),
  ];
}

/** The overview: the index first, then how to run the project. */
const overviewOrder = (items: NavItem[]) =>
  [...items].sort(
    (a, b) => (a.id === "runbook" ? 1 : 0) - (b.id === "runbook" ? 1 : 0),
  );

/** The menu: every page of the tree in its group, each page once, empty groups left out. Specs are split by build
 *  status when it is known (newest first in each), else one list, newest first. A section keel does not know keeps its
 *  own title and order, after the known groups. */
export function buildNav(
  tree: WikiTree,
  specs: Map<string, SpecStatus> = new Map(),
): NavGroup[] {
  const seen = new Set<string>();
  const by = new Map<string, NavItem[]>();
  const other: NavGroup[] = [];
  for (const s of tree.sections) {
    for (const it of s.items) {
      if (seen.has(it.id)) continue;
      seen.add(it.id);
      const number = numberOf(it);
      const item: NavItem = {
        id: it.id,
        title: labelOf(it, number),
        number,
        status: it.status,
        spec: specs.get(it.id),
        path: it.path,
        updated: it.updated,
        also: it.also ?? [],
      };
      const g = groupOf(it);
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
    if (id === "specs" && items.some((i) => i.spec)) {
      parts = SPEC_PARTS.map(({ state, title: t }) => ({
        id: `specs-${state}`,
        title: t,
        items: items
          .filter((i) => (i.spec?.state ?? "not_built") === state)
          .sort(newestFirst),
      })).filter((p) => p.items.length);
    } else if (id === "specs") {
      parts = [{ id, items: [...items].sort(newestFirst) }];
    } else if (id === "knowledge") {
      parts = [{ id, items: knowledgeOrder(items) }];
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

/** Only the pages that match the words (title, number, id or path, any case); groups and parts without a match go. */
export function filterNav(groups: NavGroup[], q: string): NavGroup[] {
  const words = q.trim().toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return groups;
  const hit = (i: NavItem) => {
    const text = [i.title, i.number, i.id, i.path, i.spec?.title]
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
