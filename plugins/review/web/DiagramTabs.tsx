// keel 0.18.57 the Database and System tabs in the new Review view's pull request (next/tabs.ts): the same parts as the
// classic overview (Diagrams.tsx), from the same load (diagramStore.ts). A tab shows only when the api gave its data:
// System once the diagrams are read, Database when the change touches the database (with its count). A tab asks for
// the load the first time the pull request asks whether to show it, and the tabs register again when it lands, so the
// pull request draws its tab row again.

import { DiagramPart } from "./Diagrams";
import { diagramsFor, subscribeDiagrams } from "./diagramStore";
import {
  registerReviewTab,
  type ReviewTab,
  type ReviewTabProps,
} from "./next/tabs";

function data(p: ReviewTabProps) {
  const e = diagramsFor(p.pid, p.reviewKey, p.view.head_sha);
  return e.status === "done" ? e.d : null;
}

const database: ReviewTab = {
  id: "keel-database",
  label: "Database",
  order: 6,
  show: (p) => !!data(p)?.database.shown,
  count: (p) => data(p)?.database.count ?? null,
  component: (p) => (
    <div className="rv-next-part">
      <DiagramPart
        pid={p.pid}
        reviewKey={p.reviewKey}
        view={p.view}
        part="database"
        onOpen={p.onOpenFile}
      />
    </div>
  ),
};

const system: ReviewTab = {
  id: "keel-system",
  label: "System",
  order: 7,
  show: (p) => !!data(p),
  component: (p) => (
    <div className="rv-next-part">
      <DiagramPart
        pid={p.pid}
        reviewKey={p.reviewKey}
        view={p.view}
        part="system"
        onOpen={p.onOpenFile}
      />
    </div>
  ),
};

/** Registers both tabs (setup() calls it once); returns the function that takes them away. */
export function registerDiagramTabs(): () => void {
  let offs = [registerReviewTab(database), registerReviewTab(system)];
  const stop = subscribeDiagrams(() => {
    offs.forEach((off) => off());
    offs = [registerReviewTab(database), registerReviewTab(system)];
  });
  return () => {
    stop();
    offs.forEach((off) => off());
  };
}
