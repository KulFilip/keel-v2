// keel 0.18.55 a project keel does not know yet (no .keel/config.yml): the init flow sets it up. These are the small
// shared pieces: the test, the one line on what init does, starting it, and the ask that "Start a flow" and the Tasks
// Start show before another flow starts on such a project (Run init first / Start anyway). The card after Add projects
// and the Flow page's banner are in InitSetup.tsx.

import { useEffect, useRef, useState } from "react";
import {
  api,
  errorParts,
  type Project,
  type ThreadState,
  type Workflow,
} from "../api";
import { readStored, writeStored } from "../storage";
import { go, useApp } from "../state";

/** What init does, in one line (the card, the banner and the ask say it the same way). */
export const INIT_ONE_LINE =
  "init finds the stack and the test commands, and writes .keel/config.yml and the project knowledge.";

/** keel does not know this project yet. An older keel sends no `configured`: then nothing asks. */
export const needsInit = (
  p: Pick<Project, "configured"> | null | undefined,
): boolean => p?.configured === false;

/** The init flow, or a workflow made from it. */
export const isInitFlow = (
  w: Pick<Workflow, "id" | "based_on"> | null | undefined,
): boolean =>
  !!w &&
  (w.id === "init" || w.based_on === "keel/init" || w.based_on === "init");

const offeredKey = (pid: string) => `keel2.init-offered.${pid}`;
/** The setup card was answered for this project in this browser (Set up now or Later): the Flow page shows the banner. */
export const initOffered = (pid: string): boolean =>
  readStored<boolean>(offeredKey(pid), false, "local");
export const markInitOffered = (pid: string) =>
  writeStored(offeredKey(pid), true, "local");

/** Starts the init flow on the project (the project's run mode and cap, like any flow). */
export function startInit(pid: string, name?: string): Promise<ThreadState> {
  return api.startFlow(pid, {
    workflow_id: "init",
    title: `Set up keel for ${name || pid}`,
  });
}

type Err = { message: string; hint?: string };

/** Start init, then show it: the project is picked, the list reloaded, the Flow page opened. */
export function useStartInit(
  project: Pick<Project, "id" | "name"> | null | undefined,
  onStarted?: () => void,
) {
  const { setProjectId, reloadProjects, toast, pid } = useApp();
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<Err | null>(null);
  const start = async () => {
    if (!project) return;
    setBusy(true);
    setErr(null);
    try {
      await startInit(project.id, project.name);
      markInitOffered(project.id);
      if (project.id !== pid) setProjectId(project.id);
      await reloadProjects();
      toast(
        `init started for ${project.name || project.id}. It stops at its first question for you.`,
      );
      onStarted?.();
      go("flow");
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return { start, busy, err };
}

/** The ask before another flow starts on a project keel does not know yet. Asked once per start; it blocks nothing. */
export function InitAsk({
  name,
  busy,
  onInit,
  onAnyway,
  onCancel,
}: {
  name: string;
  busy?: boolean;
  onInit: () => void;
  onAnyway: () => void;
  onCancel?: () => void;
}) {
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    first.current?.scrollIntoView?.({ block: "nearest" });
    first.current?.focus({ preventScroll: true });
  }, []);
  return (
    <div
      className="wbar warn init-ask"
      role="group"
      aria-label="keel does not know this project yet"
      data-testid="init-ask"
    >
      <span>
        <b>keel does not know this project yet.</b> {name} has no
        .keel/config.yml. {INIT_ONE_LINE} The flow works better after it.
      </span>
      <span className="row">
        <button
          ref={first}
          className="btn sm primary"
          type="button"
          disabled={busy}
          onClick={onInit}
        >
          {busy ? "Starting init…" : "Run init first (recommended)"}
        </button>
        <button
          className="btn sm"
          type="button"
          disabled={busy}
          onClick={onAnyway}
        >
          Start anyway
        </button>
        {onCancel && (
          <button
            className="btn sm ghost"
            type="button"
            disabled={busy}
            onClick={onCancel}
          >
            Cancel
          </button>
        )}
      </span>
    </div>
  );
}
