// Which keel project a VS Code folder is, and where a path keel names is on this computer. keel usually runs in
// Docker, so its project root (/projects/shop) and the folder here (/Users/ana/code/shop) differ.

import type { Project } from "../api/models";

export interface ProjectMatch {
  project: Project;
  /** picked | path | folder | name */
  how: string;
  /** the workspace folder it matched (the first one for a pick) */
  folder?: string;
}

export const normPath = (p: string): string =>
  p.trim().replace(/\\/g, "/").replace(/\/+$/, "") || "/";
export const lastSegment = (p: string): string =>
  p.slice(p.lastIndexOf("/") + 1);
const slug = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * Compare the whole path first, then the folder name, then keel's project name, for each workspace folder in order. A
 * project picked by hand always wins; no match means "pick it" (a wrong guess would show another project's questions).
 */
export function matchProject(
  folders: string[],
  projects: Project[],
  pickedId?: string | null,
): ProjectMatch | undefined {
  if (pickedId) {
    const p = projects.find((x) => x.id === pickedId);
    if (p) return { project: p, how: "picked", folder: folders[0] };
  }
  if (!projects.length) return undefined;
  for (const f of folders) {
    const base = normPath(f);
    const byPath = projects.find((p) => p.root && normPath(p.root) === base);
    if (byPath) return { project: byPath, how: "path", folder: f };
  }
  for (const f of folders) {
    const folder = lastSegment(normPath(f));
    const byFolder = projects.filter(
      (p) =>
        p.root &&
        lastSegment(normPath(p.root)).toLowerCase() === folder.toLowerCase(),
    );
    if (byFolder.length === 1)
      return { project: byFolder[0], how: "folder", folder: f };
    const byName = projects.filter(
      (p) => slug(p.name) === slug(folder) || slug(p.id) === slug(folder),
    );
    if (byName.length === 1)
      return { project: byName[0], how: "name", folder: f };
  }
  return undefined;
}

/**
 * Where a path keel names could be on this computer, best first: a path under keel's project root maps onto the
 * folder here; a relative path is relative to the folder; an absolute path elsewhere (a worktree) is tried by its
 * last parts. The caller takes the first one that exists.
 */
export function localCandidates(
  path: string,
  keelRoot: string | undefined,
  folder: string,
): string[] {
  const p = normPath(path);
  const f = normPath(folder);
  const out: string[] = [];
  const add = (s: string) => {
    if (!out.includes(s)) out.push(s);
  };
  if (!p.startsWith("/") && !/^[A-Za-z]:\//.test(p)) {
    add(`${f}/${p.replace(/^\.\//, "")}`);
    return out;
  }
  if (p === f || p.startsWith(f + "/")) add(p);
  const root = keelRoot ? normPath(keelRoot) : undefined;
  if (root && root !== "/" && p.startsWith(root + "/"))
    add(`${f}/${p.slice(root.length + 1)}`);
  // a worktree (…/<branch>/src/app.ts): try the shorter tails, longest first
  const parts = p.split("/").filter(Boolean);
  for (let i = 1; i < parts.length; i++)
    add(`${f}/${parts.slice(i).join("/")}`);
  return out;
}

/** A path relative to the folder (for "@path" in KeelBot), or the path as it is when it is not under it. */
export function relativeTo(folder: string, path: string): string {
  const f = normPath(folder);
  const p = normPath(path);
  return p.startsWith(f + "/") ? p.slice(f.length + 1) : p;
}
