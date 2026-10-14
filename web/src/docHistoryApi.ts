// v0.15.9 keel's file history (api DocHistoryService): versions of specs, knowledge, ADRs and the runbook, and what a
// flow applied on top of the repo.

import { get, post } from "./api";

export type DocVersion = {
  id: string; path: string; kind: string; version: number; sha256: string; size: number; deleted: boolean;
  by_kind: "agent" | "keelbot" | "user" | "keel" | "outside" | string; by_name?: string | null; via?: string | null;
  thread_id?: string | null; step?: string | null; phase?: string | null; commit_sha?: string | null; at: string; content?: string | null;
};
export type DocFile = { path: string; kind: string; versions: number; at: string; state: "ok" | "missing" | "changed" | "deleted" | "unreadable" };
export type Applied = { kind: string; ref: string; subject?: string | null; files: string[]; at: string };

const e = encodeURIComponent;

export const docHistoryApi = {
  files: (pid: string) => get<DocFile[]>(`/projects/${e(pid)}/docs/history`),
  versions: (pid: string, path: string) => get<DocVersion[]>(`/projects/${e(pid)}/docs/history/versions?path=${e(path)}`),
  version: (pid: string, id: string) => get<DocVersion>(`/projects/${e(pid)}/docs/history/versions/${e(id)}`),
  diff: (pid: string, path: string, from: string, to: string) =>
    get<{ diff: string }>(`/projects/${e(pid)}/docs/history/diff?path=${e(path)}&from=${e(from)}&to=${e(to)}`),
  restore: (pid: string, versionId: string) => post<DocVersion>(`/projects/${e(pid)}/docs/history/restore`, { version_id: versionId }),
  applied: (tid: string) => get<{ thread_id: string; items: Applied[] }>(`/threads/${e(tid)}/applied`),
};

/** Who changed a version, in words. */
export function byText(v: DocVersion): string {
  const who = { agent: v.by_name ?? "an agent", keelbot: "KeelBot", user: "you", keel: `keel (${v.by_name ?? "a step"})`,
    outside: "outside keel" }[v.by_kind] ?? v.by_kind;
  return v.via === "mcp" ? `${who} · via MCP` : who;
}
