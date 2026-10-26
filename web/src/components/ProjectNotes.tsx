// keel 0.18.57 the project notes (the knowledge base the librarians write) are opt-in: `knowledge.build` in
// .keel/config.yml. Off, the Wiki and the Map say "Project notes are off" with Build them (the knowledge-refresh flow,
// which turns them on) and its expected cost; notes that exist but were turned off get Turn on instead.

import { useEffect, useState } from "react";
import { api, errorParts, put, type Estimate, type Notes } from "../api";
import { useHasPage } from "../sdk/registry";
import { useApp } from "../state";
import { ErrorBox, GoButton } from "./ui";

/** The five sections Build them writes (the engine's init_gates.SECTIONS). */
export const NOTE_SECTIONS = [
  "architecture",
  "domain",
  "conventions",
  "data",
  "integrations",
];

/** "≈$3–7" from an estimate (low 0.7x, high 1.6x of its cost, as the engine's knowledge.cost_label), or the tokens
 *  when the models are paid by a plan. */
export function notesCostLabel(
  est: Pick<Estimate, "cost_usd" | "low" | "high"> | null | undefined,
): string {
  if (!est) return "";
  const cost = Number(est.cost_usd) || 0;
  if (cost > 0) {
    const lo = cost * 0.7,
      hi = cost * 1.6;
    const fmt = (x: number) =>
      hi < 1 ? String(Number(x.toFixed(2))) : String(Math.round(x));
    return fmt(lo) === fmt(hi) ? `≈$${fmt(lo)}` : `≈$${fmt(lo)}–${fmt(hi)}`;
  }
  const k = (n: number) =>
    n >= 1e6 ? `${(n / 1e6).toFixed(1)}M` : `${Math.round(n / 1000)}k`;
  return `≈${k(est.low)}–${k(est.high)} tokens`;
}

/** Turn the project notes on or off (the Rules config route writes only the knowledge: block). */
export const setNotes = (pid: string, on: boolean) =>
  put(`/projects/${encodeURIComponent(pid)}/rules/config`, {
    knowledge: { build: on ? "on" : "off" },
  });

/** "Project notes are off — Build them": the banner the Wiki and the Map show while the notes are off. */
export function ProjectNotesOff({
  pid,
  notes,
  onChange,
  compact = false,
}: {
  pid: string;
  notes: Notes | null | undefined;
  onChange?: () => void;
  compact?: boolean;
}) {
  const { toast, reloadProjects } = useApp();
  const wiki = useHasPage("wiki");
  const [cost, setCost] = useState("");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  const off = !!notes && !notes.on;
  const written = (notes?.written ?? 0) > 0;
  useEffect(() => {
    if (!off || written) return;
    let gone = false;
    api.estimate(pid, "knowledge-refresh", 0).then(
      (e) => !gone && setCost(notesCostLabel(e)),
      () => undefined,
    );
    return () => {
      gone = true;
    };
  }, [pid, off, written]);
  if (!off) return null;
  const build = async () => {
    setBusy(true);
    setErr(null);
    try {
      const t = await api.refreshWiki(pid, NOTE_SECTIONS);
      setStarted(t?.thread_id ?? "");
      toast(
        "The librarians are writing the project notes. They are on from now.",
      );
      void reloadProjects();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const turnOn = async () => {
    setBusy(true);
    setErr(null);
    try {
      await setNotes(pid, true);
      toast("Project notes are on: keel's agents read them again.");
      onChange?.();
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <div
      className={`notes-off${compact ? " compact" : ""}`}
      role="status"
      data-testid="notes-off"
    >
      <span>
        <b>Project notes are off</b>
        {compact ? null : (
          <span className="sub">
            {" "}
            — keel's agents read the code itself.{" "}
            {written
              ? "The notes are there; turn them on to give them to the agents again."
              : `Build them for a large repo${cost ? ` (${cost})` : ""}: five librarians write them, and the flows keep them up to date.`}
          </span>
        )}
      </span>
      <span className="row">
        {written ? (
          <button
            type="button"
            className="btn sm"
            onClick={() => void turnOn()}
            disabled={busy}
          >
            {busy ? "Turning on…" : "Turn on"}
          </button>
        ) : (
          wiki &&
          started === null && (
            <button
              type="button"
              className="btn sm"
              onClick={() => void build()}
              disabled={busy}
              title={`The knowledge-refresh flow: ${NOTE_SECTIONS.join(", ")}`}
            >
              {busy ? "Starting…" : `Build them${cost ? ` (${cost})` : ""}`}
            </button>
          )
        )}
        {started !== null && <GoButton to="flow">Writing · watch it</GoButton>}
      </span>
      {err && <ErrorBox error={err} />}
    </div>
  );
}
