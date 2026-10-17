// keel 0.18.11 what a block on the Flow page says about its real run: the model and effort that ran, the working time,
// tokens and cost, the first line of the answer, and how many tries it took (from GET .../flows/{tid}/step-runs).

import type { Step, StepRunFacts } from "../api";

export type StepFacts = {
  tries: number;
  status: string;
  running: boolean;
  provider: string | null;
  model: string | null;
  effort: string | null;
  /** working time of its calls (a gate's wait is not in it) */
  ms: number;
  tokens: number;
  cost: number;
  result: string | null;
  /** the criterion these facts are about (a per-criterion step shows one round) */
  ac: string | null;
};

/** Tokens as keel counts them everywhere: in + out + a tenth of the cache reads (they cost about a tenth). */
export const tokensOf = (r: { tokens_in: number; tokens_out: number; tokens_cached?: number | null }) =>
  r.tokens_in + r.tokens_out + Math.floor((r.tokens_cached ?? 0) / 10);

/** The workflow step a call's step belongs to (a review's fix node `<id>__fix` counts on its review step). */
export const stepIdOf = (steps: Step[], step: string) =>
  steps.find((x) => x.id === step.replace(/__fix$/, "") || x.name === step)?.id ?? null;

/**
 * Per step id: the facts its block shows, and its tokens over every round (the sections' and loops' totals).
 * A per-criterion step shows the round of the current criterion, else its newest round.
 */
export function stepFacts(runs: StepRunFacts[], steps: Step[], currentAc?: string | null): {
  facts: Record<string, StepFacts>; actual: Record<string, number>;
} {
  const byStep = new Map<string, StepRunFacts[]>();
  runs.forEach((r) => {
    const id = stepIdOf(steps, r.step);
    if (id) byStep.set(id, [...(byStep.get(id) ?? []), r]);
  });
  const facts: Record<string, StepFacts> = {};
  const actual: Record<string, number> = {};
  byStep.forEach((rs, id) => {
    actual[id] = rs.reduce((a, r) => a + tokensOf(r), 0);
    const step = steps.find((s) => s.id === id);
    let shown = rs;
    if ((step?.per_ac || step?.per_item) && rs.some((r) => r.ac)) {
      const newest = [...rs].sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1)!;
      const ac = currentAc && rs.some((r) => r.ac === currentAc) ? currentAc : newest.ac;
      shown = rs.filter((r) => r.ac === ac);
    }
    const last = [...shown].sort((a, b) => a.started_at.localeCompare(b.started_at)).at(-1)!;
    const own = shown.filter((r) => !r.step.endsWith("__fix"));
    facts[id] = {
      tries: (own.length ? own : shown).reduce((a, r) => a + r.tries, 0),
      status: last.status,
      running: shown.some((r) => r.status === "running"),
      provider: last.provider,
      model: last.model,
      effort: last.effort ?? null,
      ms: shown.reduce((a, r) => a + r.ms, 0),
      tokens: shown.reduce((a, r) => a + tokensOf(r), 0),
      cost: shown.reduce((a, r) => a + r.cost_usd, 0),
      result: last.result,
      ac: last.ac,
    };
  });
  return { facts, actual };
}

/** "40s", "2m 10s", "1h 05m": a step's working time. */
export function workTime(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  if (s < 60) return `${s}s`;
  if (s < 3600) return `${Math.floor(s / 60)}m${s % 60 ? ` ${s % 60}s` : ""}`;
  return `${Math.floor(s / 3600)}h ${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}m`;
}
