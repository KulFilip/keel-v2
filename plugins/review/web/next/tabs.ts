// More tabs in the new Review view's pull request (0.18.57): keel's overview tabs (Overview · Database (n) · System,
// with their diagrams) come from another part of the Code Review plugin. A tab registers here once; the pull request
// shows it next to Comments · Files · Problems · Commits · Checklist when its `show` says the api gave its data.
//
//   registerReviewTab({ id: "database", label: "Database", order: 6,
//     show: ({ ai }) => !!ai?.overview?.result?.database, count: ({ ai }) => ai?.overview?.result?.database?.tables.length,
//     component: DatabaseTab })
//
// The built-in tabs have the orders 10 (Comments), 20 (Files), 30 (Problems), 40 (Commits) and 50 (Checklist): an
// order under 10 puts a tab first.

import { useSyncExternalStore, type ComponentType } from "react";
import type { AiState, ReviewView } from "../reviewApi";

export type ReviewTabProps = {
  pid: string;
  reviewKey: string;
  view: ReviewView;
  ai: AiState | null;
  /** show a file of the review at a line (the Files tab) */
  onOpenFile: (path: string, line?: number | null) => void;
};

export type ReviewTab = {
  id: string;
  label: string;
  order?: number;
  /** the tab shows only when this says yes (the api gave its data); without it the tab always shows */
  show?: (p: ReviewTabProps) => boolean;
  /** a number after its label (Database (3)), or nothing */
  count?: (p: ReviewTabProps) => number | null | undefined;
  component: ComponentType<ReviewTabProps>;
};

const tabs = new Map<string, ReviewTab>();
let version = 0;
const subs = new Set<() => void>();

/** Add a tab (one with the same id is replaced). Returns a function that takes it away again. */
export function registerReviewTab(t: ReviewTab): () => void {
  tabs.set(t.id, t);
  version++;
  subs.forEach((f) => f());
  return () => {
    if (tabs.get(t.id) !== t) return;
    tabs.delete(t.id);
    version++;
    subs.forEach((f) => f());
  };
}

/** The registered tabs, live: the component renders again when one comes or goes. */
export function useReviewTabs(): ReviewTab[] {
  useSyncExternalStore(
    (f) => {
      subs.add(f);
      return () => {
        subs.delete(f);
      };
    },
    () => version,
  );
  return [...tabs.values()];
}
