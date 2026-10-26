// keel 0.18.57 the overview's diagrams (GET /review/diagrams), one load per review and head commit, shared by the
// classic overview (ReviewPanel's Database and System tabs) and the new Review view's tabs (DiagramTabs.tsx). The api
// keeps them per head commit too; this only saves the second request and lets a tab ask "is there data yet?" while
// it draws.

import { useEffect, useSyncExternalStore } from "react";
import { errorParts } from "@keel/web-sdk";
import { reviewApi, type Diagrams } from "./reviewApi";

export type DiagramEntry =
  | { status: "loading" }
  | { status: "done"; d: Diagrams }
  | { status: "error"; error: { message: string; hint?: string } };

const cache = new Map<string, DiagramEntry>();
const subs = new Set<() => void>();
const MAX = 40;

const id = (pid: string, key: string, head: string) => `${pid}|${key}|${head}`;

function set(k: string, e: DiagramEntry) {
  cache.delete(k);
  cache.set(k, e);
  while (cache.size > MAX) cache.delete(cache.keys().next().value as string);
  subs.forEach((f) => f());
}

function load(pid: string, key: string, head: string, refresh: boolean) {
  const k = id(pid, key, head);
  cache.set(k, { status: "loading" });
  reviewApi
    .diagrams(pid, key, refresh)
    .then((d) => set(k, { status: "done", d }))
    .catch((e: unknown) => {
      const p = errorParts(e);
      set(k, {
        status: "error",
        error: { message: p.message, hint: p.hint ?? undefined },
      });
    });
}

/** What is known now; the first ask starts the load (a change notifies the subscribers when it lands). */
export function diagramsFor(
  pid: string,
  key: string,
  head: string,
): DiagramEntry {
  const k = id(pid, key, head);
  const e = cache.get(k);
  if (e) return e;
  load(pid, key, head, false);
  return cache.get(k)!;
}

/** Load again, past the api's cache too (Try again). */
export function reloadDiagrams(pid: string, key: string, head: string) {
  load(pid, key, head, true);
  subs.forEach((f) => f());
}

export function subscribeDiagrams(f: () => void): () => void {
  subs.add(f);
  return () => {
    subs.delete(f);
  };
}

const LOADING: DiagramEntry = { status: "loading" };

/** The entry for a review, live; mounting it starts the load. */
export function useDiagrams(pid: string | undefined, key: string, head: string): DiagramEntry | null {
  const e = useSyncExternalStore(subscribeDiagrams, () => (pid ? cache.get(id(pid, key, head)) : undefined));
  useEffect(() => {
    if (pid && !cache.has(id(pid, key, head))) {
      load(pid, key, head, false);
      subs.forEach((f) => f());
    }
  }, [pid, key, head]);
  return pid ? (e ?? LOADING) : null;
}

/** Tests: forget every load. */
export function clearDiagrams() {
  cache.clear();
}
