import { useState } from "react";
import { type Job, type Step, type StepExplanation, type ThreadState, type Workflow } from "../../api";
import { FoldPanel } from "../../components/FoldPanel";
import { infoRequest, StepInfoBody, useStepInfo } from "../../components/StepInfo";
import { StepView } from "../../components/StepView";
import { KIND } from "../../components/workflow";
import { useJobSteps } from "../Live";
import { Drawer, ErrorBox, GoButton, Loading, Prov } from "../../components/ui";
import { EventsPanel } from "./EventsPanel";
import { RunningCard, WaitsCard, stepIdOf } from "./FlowParts";

/** v0.15.2 Is this step the one that runs now (or waits for you)? And the agent of this flow that works in it, if any. */
function nowOf(thread: ThreadState, workflow: Workflow, running: Job[], id: string): { now: boolean; job: Job | null } {
  if (thread.status !== "running" && thread.status !== "waiting") return { now: false, job: null };
  const cur = (thread.waiting?.step ?? thread.current ?? "").replace(/__fix$/, "");
  const job = running.find((j) => j.thread_id === thread.thread_id && stepIdOf(workflow, j.step) === id) ?? null;
  return { now: id === cur || !!job, job };
}

type StepMode = "now" | "details";

/** v0.15.2 The clicked step, in the side panel (or in a drawer: narrow screens, the init flow). The step that runs now,
 * or waits for you, opens on "Now": the step in a few words and only what happens in it now (the waiting or running
 * card, the agent's newest steps, this step's events since it started), not its past runs. "Details" is the whole
 * explanation (task, rules, next, last runs); any other step shows only that. */
export function StepPanel({ pid, thread, workflow, stepId, running, onClose, onJump, drawer }: {
  pid: string; thread: ThreadState; workflow: Workflow; stepId: string; running: Job[]; onClose: () => void; onJump: () => void; drawer?: boolean;
}) {
  // the workflow the page draws, plus the thread (its state and what the step did there)
  const { x, error } = useStepInfo(pid, infoRequest(stepId, workflow, thread.thread_id));
  const [pick, setPick] = useState<StepMode>("now");
  const step = workflow.steps.find((s) => s.id === stepId);
  const { now, job } = nowOf(thread, workflow, running, stepId);
  const showNow = now && !!step && pick === "now";
  const title = showNow ? `${step!.name} now` : `What ${x?.name ?? step?.name ?? stepId} does`;
  const toggle = now && step ? <StepModeToggle value={showNow ? "now" : "details"} onChange={setPick} /> : null;
  const details = error ? <ErrorBox error={error} /> : !x ? <Loading what="Reading the step" /> : <StepInfoBody x={x} />;
  const live = showNow ? <StepNow pid={pid} thread={thread} step={step!} job={job} onJump={onJump} /> : null;
  if (drawer) {
    return (
      <Drawer title={title} onClose={onClose}>
        {toggle}
        {showNow ? <><StepAbout step={step!} x={x} />{live}</> : details}
      </Drawer>
    );
  }
  const head = (
    <div className="panel-head">
      <h2>{title}</h2>
      <div className="fold-tools">{toggle}<button className="btn sm ghost" type="button" onClick={onClose}>Close</button></div>
    </div>
  );
  if (!showNow) return <section className="panel" aria-label={title}>{head}<div className="panel-body">{details}</div></section>;
  return (
    <div className="grid" style={{ gap: 12 }}>
      <section className="panel" aria-label={title}>{head}<div className="panel-body"><StepAbout step={step!} x={x} /></div></section>
      {live}
    </div>
  );
}

function StepModeToggle({ value, onChange }: { value: StepMode; onChange: (m: StepMode) => void }) {
  return (
    <div className="tabs fl-mode" role="group" aria-label="Now or the details of this step">
      <button type="button" aria-pressed={value === "now"} onClick={() => onChange("now")} title="Only what happens in this step now">Now</button>
      <button type="button" aria-pressed={value === "details"} onClick={() => onChange("details")} title="What the step does, its rules and its past runs">Details</button>
    </div>
  );
}

/** v0.15.2 The step in a few words: its kind, agent, phase and loop, then what it does and what its phase means. */
function StepAbout({ step, x }: { step: Step; x: StepExplanation | null }) {
  const what = x?.agent?.about || x?.code?.text || x?.code?.actions?.[0]?.summary || (x?.branch ? `Asks: ${x.branch.condition}` : "")
    || (x?.gate ? "Waits for your answer." : "");
  const phase = x?.phase ?? step.phase;
  const facts = [KIND[step.kind] ?? step.kind, step.agent ? `agent ${step.agent}` : "", phase ? `phase ${phase}` : "", x?.loop?.text ?? ""].filter(Boolean);
  return (
    <div className="fl-about" data-testid="step-about">
      <span className="sub">{facts.join(" · ")}</span>
      {what && <p>{what}</p>}
      {x?.phase_meaning && <p className="sub">{x.phase_meaning}</p>}
    </div>
  );
}

/** v0.15.2 What happens in the step now: the waiting card (Go to it) or the running card, the agent's newest steps, and
 * this step's events since it started. */
function StepNow({ pid, thread, step, job, onJump }: { pid: string; thread: ThreadState; step: Step; job: Job | null; onJump: () => void }) {
  const waits = thread.status === "waiting" && !!thread.waiting && thread.waiting.step.replace(/__fix$/, "") === step.id;
  const runs = !waits && (!!job || (thread.status === "running" && (thread.current ?? "").replace(/__fix$/, "") === step.id));
  return (
    <>
      {waits ? <WaitsCard thread={thread} onJump={onJump} /> : runs ? <RunningCard step={step} name={step.name} ac={job?.ac ?? thread.ac} job={job} /> : null}
      {job && <JobFeed job={job} />}
      <EventsPanel pid={pid} thread={thread} step={step.id} title={`Events of ${step.name}`} />
    </>
  );
}

/** The running agent's newest steps, with a link to watch it live. v0.15.2 Hide folds it (this browser remembers it);
 * ⤢ shows every step so far in a large view. */
export function JobFeed({ job }: { job: Job }) {
  const { steps } = useJobSteps(job.id);
  const last = steps.slice(-6);
  const watch = <GoButton to="live" arg={job.id} className="btn sm">Watch live</GoButton>;
  const none = <span className="sub">Waiting for the first step…</span>;
  return (
    <FoldPanel id="flow.works" title={`${job.agent} works`} extra={watch} bodyClass="feed fl-feed" live
      big={() => (
        <>
          <div className="row fl-big-head">
            <span className="sub">{job.agent} · <Prov p={job.provider} m={job.model} e={job.effort} />{job.ac ? ` · ${job.ac}` : ""} · {steps.length} steps so far</span>
            {watch}
            <GoButton to="jobs" arg={job.id} className="btn sm ghost">Open job</GoButton>
          </div>
          <div className="feed" aria-label={`Every step of ${job.agent}`} aria-live="polite">
            {steps.length ? steps.map((st) => <StepView key={st.n} s={st} idPrefix={`flbig-${job.id}`} />) : none}
          </div>
        </>
      )}>
      {last.length ? last.map((st) => <StepView key={st.n} s={st} idPrefix={`fl-${job.id}`} />) : none}
    </FoldPanel>
  );
}
