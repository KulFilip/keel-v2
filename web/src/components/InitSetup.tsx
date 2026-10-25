// keel 0.18.55 setting keel up for a project it does not know yet: the card after Add projects (and the first time a
// project found by itself opens on the Flow page), and the Flow page's banner after that. Both start the init flow;
// when keel refuses the start (uncommitted files, the fake model) "Start a flow" opens on init, with its boxes for that.

import { useEffect, useRef, useState } from "react";
import type { Project } from "../api";
import { INIT_ONE_LINE, markInitOffered, useStartInit } from "./InitAsk";
import { StartFlowDrawer } from "./StartFlow";
import { ErrorBox } from "./ui";

/** "Set up keel for <project>": Set up now (recommended) starts init and opens it; Later puts the card away. */
export function SetupCard({
  project,
  onLater,
  onStarted,
  focus,
}: {
  project: Pick<Project, "id" | "name">;
  onLater: () => void;
  onStarted?: () => void;
  /** put the card in view and its first button in focus (it shows after an action, not when a page opens) */
  focus?: boolean;
}) {
  const { start, busy, err } = useStartInit(project, onStarted);
  const [drawer, setDrawer] = useState(false);
  const first = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!focus) return;
    first.current?.scrollIntoView?.({ block: "nearest" });
    first.current?.focus({ preventScroll: true });
  }, [focus]);
  const name = project.name || project.id;
  const later = () => {
    markInitOffered(project.id);
    onLater();
  };
  return (
    <section
      className="init-card"
      role="region"
      aria-label={`Set up keel for ${name}`}
      data-testid="init-card"
    >
      <div className="init-card-t">
        <b>Set up keel for {name}</b>
        <span className="sub">{INIT_ONE_LINE}</span>
      </div>
      {err && (
        <>
          <ErrorBox error={err} />
          <span className="hint">
            Start a flow, with init picked, lets you start it anyway.{" "}
            <button
              type="button"
              className="linkbtn"
              onClick={() => setDrawer(true)}
            >
              Open Start a flow
            </button>
          </span>
        </>
      )}
      <div className="row">
        <button
          ref={first}
          className="btn primary"
          type="button"
          disabled={busy}
          onClick={() => void start()}
        >
          {busy ? "Starting init…" : "Set up now (recommended)"}
        </button>
        <button className="btn" type="button" disabled={busy} onClick={later}>
          Later
        </button>
      </div>
      {drawer && (
        <StartFlowDrawer
          projectId={project.id}
          workflowId="init"
          onClose={() => setDrawer(false)}
        />
      )}
    </section>
  );
}

/** The Flow page's line for a project keel does not know yet (after the card was answered). */
export function InitBanner({
  project,
}: {
  project: Pick<Project, "id" | "name">;
}) {
  const { start, busy, err } = useStartInit(project);
  const [drawer, setDrawer] = useState(false);
  return (
    <div
      className="wbar warn init-banner"
      role="region"
      aria-label="keel does not know this project yet"
      data-testid="init-banner"
    >
      <span>
        <b>keel does not know {project.name || project.id} yet.</b>{" "}
        {INIT_ONE_LINE} Flows work better after it.
      </span>
      <button
        className="btn sm primary"
        type="button"
        disabled={busy}
        onClick={() => void start()}
      >
        {busy ? "Starting init…" : "Run init"}
      </button>
      {err && (
        <span className="hint">
          {err.message}
          {err.hint ? ` ${err.hint}` : ""}{" "}
          <button
            type="button"
            className="linkbtn"
            onClick={() => setDrawer(true)}
          >
            Open Start a flow
          </button>
        </span>
      )}
      {drawer && (
        <StartFlowDrawer
          projectId={project.id}
          workflowId="init"
          onClose={() => setDrawer(false)}
        />
      )}
    </div>
  );
}
