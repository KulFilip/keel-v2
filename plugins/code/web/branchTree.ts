// The branches as a tree: Local (the current branch pinned, then main/master, then folders by "/" prefix, then the
// branches without a prefix under "other") and one group per remote with its own prefix folders. Pure: no React.

export type BranchItem = { name: string; note: string };

export type TreeFolder = { type: "folder"; id: string; label: string; count: number; children: TreeNode[] };
export type TreeLeaf = { type: "leaf"; id: string; label: string; branch: BranchItem; remote?: string };
export type TreeNode = TreeFolder | TreeLeaf;
export type TreeGroup = { id: string; title: string; count: number; nodes: TreeNode[]; remote?: string };

const TRUNKS = ["main", "master"];

/** Folders by "/" prefix, the last segment is the leaf (feature/ERPDM-1-x stays one leaf). Folders first, by size. */
function folderize(items: { path: string[]; branch: BranchItem }[], idBase: string, remote?: string): TreeNode[] {
  const leaves: TreeLeaf[] = [];
  const dirs = new Map<string, { path: string[]; branch: BranchItem }[]>();
  for (const it of items) {
    if (it.path.length === 1) leaves.push({ type: "leaf", id: `${idBase}/${it.branch.name}`, label: it.path[0], branch: it.branch, remote });
    else dirs.set(it.path[0], [...(dirs.get(it.path[0]) ?? []), { path: it.path.slice(1), branch: it.branch }]);
  }
  const folders: TreeFolder[] = [...dirs.entries()].map(([name, inner]) => ({
    type: "folder", id: `${idBase}/${name}/`, label: `${name}/`, count: inner.length, children: folderize(inner, `${idBase}/${name}`, remote),
  }));
  folders.sort((a, b) => b.count - a.count || a.label.localeCompare(b.label));
  leaves.sort((a, b) => a.label.localeCompare(b.label));
  return [...folders, ...leaves];
}

/** Local then one group per remote; empty groups are left out. */
export function buildBranchTree(local: BranchItem[], remotes: BranchItem[], current: string | undefined): TreeGroup[] {
  const groups: TreeGroup[] = [];
  const leaf = (b: BranchItem): TreeLeaf => ({ type: "leaf", id: `local/${b.name}`, label: b.name, branch: b });
  const pinned: TreeNode[] = [];
  const cur = local.find((b) => b.name === current);
  if (cur) pinned.push(leaf(cur));
  for (const t of TRUNKS) {
    const b = local.find((x) => x.name === t && x.name !== current);
    if (b) pinned.push(leaf(b));
  }
  const rest = local.filter((b) => !pinned.some((p) => p.type === "leaf" && p.branch.name === b.name));
  const prefixed = rest.filter((b) => b.name.includes("/"));
  const plain = rest.filter((b) => !b.name.includes("/"));
  const nodes: TreeNode[] = [...pinned, ...folderize(prefixed.map((b) => ({ path: b.name.split("/"), branch: b })), "local")];
  if (plain.length) {
    nodes.push({
      type: "folder", id: "local/other/", label: "other", count: plain.length,
      children: plain.sort((a, b) => a.name.localeCompare(b.name)).map((b) => ({ type: "leaf", id: `local/other/${b.name}`, label: b.name, branch: b })),
    });
  }
  if (local.length) groups.push({ id: "local", title: "Local", count: local.length, nodes });

  const byRemote = new Map<string, BranchItem[]>();
  for (const b of remotes) {
    const r = b.name.slice(0, Math.max(b.name.indexOf("/"), 0));
    if (!r) continue;
    byRemote.set(r, [...(byRemote.get(r) ?? []), b]);
  }
  for (const [r, list] of [...byRemote.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
    groups.push({
      id: `remote:${r}`, title: r, count: list.length, remote: r,
      nodes: folderize(list.map((b) => ({ path: b.name.slice(r.length + 1).split("/"), branch: b })), `remote:${r}`, r),
    });
  }
  return groups;
}

/** The tree cut to the branches whose name has `q` (case-insensitive); the folders on the way stay with their new counts. */
export function filterTree(groups: TreeGroup[], q: string): { groups: TreeGroup[]; matches: number } {
  const needle = q.trim().toLowerCase();
  if (!needle) return { groups, matches: 0 };
  const cut = (nodes: TreeNode[]): TreeNode[] => nodes.flatMap((n): TreeNode[] => {
    if (n.type === "leaf") return n.branch.name.toLowerCase().includes(needle) ? [n] : [];
    const children = cut(n.children);
    return children.length ? [{ ...n, children, count: countLeaves(children) }] : [];
  });
  const out = groups.flatMap((g) => {
    const nodes = cut(g.nodes);
    return nodes.length ? [{ ...g, nodes, count: countLeaves(nodes) }] : [];
  });
  return { groups: out, matches: out.reduce((n, g) => n + g.count, 0) };
}

export const countLeaves = (nodes: TreeNode[]): number => nodes.reduce((n, x) => n + (x.type === "leaf" ? 1 : countLeaves(x.children)), 0);

const key = (pid: string) => `keel.scm.branches.${pid}`;

/** The folders the person opened or closed in this project: id -> open. Never throws. */
export function loadOpen(pid: string): Record<string, boolean> {
  try {
    const v = JSON.parse(localStorage.getItem(key(pid)) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveOpen(pid: string, open: Record<string, boolean>): void {
  try {
    localStorage.setItem(key(pid), JSON.stringify(open));
  } catch {
    // storage blocked or full: the folders just start as default next time
  }
}

/** The default: Local is open, its folders and the remotes are closed. */
export const defaultOpen = (id: string): boolean => id === "local";
