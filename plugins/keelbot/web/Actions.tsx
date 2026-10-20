// v0.9.0 KeelBot's buttons (v0.10.0: keel-query and keel-git from the Database and Git plugins: QueryCard, GitCard).
// An answer may end with action blocks (the plugin's engine, keel_plugin_keelbot/keelbot.py): ```keel-start {json}```
// becomes a card that starts a flow when the person presses Start; ```keel-workflow <yaml>``` becomes a card that keel
// checks (POST …/workflows/check) and the person saves (POST …/workflows/import, into a folder if they like). Nothing
// starts or is saved without a press.
// Since step 3 a block of a kind no core card handles is a plugin's card, from the slot keelbot.card (SlotCard below):
// the Database plugin's ```keel-query``` (plugins/db/web/QueryCard.tsx) and the Git plugin's ```keel-git```
// (plugins/git/web/GitCard.tsx), so KeelBot imports no plugin.

import { useEffect, useState } from "react";
import {
  CodeBlock,
  errorParts,
  go,
  SLOTS,
  useLoad,
  useSlot,
  type KeelbotBlock,
  type KeelbotCardItem,
  type Workflow,
  type WorkflowCheck,
} from "@keel/web-sdk";
import { kb } from "./keelbotApi";
import { gateName, NOT_SENT_NEW_MESSAGE } from "./suggest";
import {
  AskFixButton,
  AskKeelBot,
  ClarifyForm,
  answersMessage,
  answersOf,
  parseQuestions,
  readAnswersMessage,
  type ChoiceInfo,
  type ClarifyAnswers,
  type ClarifyQuestion,
} from "@keel/web-sdk";
import { useContext } from "react";

export type Segment =
  { kind: "text"; text: string } | { kind: "start" | "workflow" | "query" | "git" | "ci" | "flow" | "rule" | "agent" | "skill" | "stack" | "questions"; body: string };

const ACTION = /^\s*(`{3,}|~{3,})\s*keel-(start|workflow|query|git|ci|flow|rule|agent|skill|stack|questions)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

/** The answer as text and action blocks, in order. A keel block inside another code block stays text. */
export function splitActions(text: string): Segment[] {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: Segment[] = [];
  let buf: string[] = [];
  const flush = () => {
    if (buf.join("\n").trim()) out.push({ kind: "text", text: buf.join("\n") });
    buf = [];
  };
  let i = 0;
  while (i < lines.length) {
    const a = lines[i].match(ACTION);
    if (a) {
      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i], a[1])) body.push(lines[i++]);
      i++;
      flush();
      out.push({
        kind: a[2] as Exclude<Segment["kind"], "text">,
        body: body.join("\n"),
      });
      continue;
    }
    const f = lines[i].match(FENCE);
    buf.push(lines[i++]);
    if (f) {
      while (i < lines.length && !closes(lines[i], f[1])) buf.push(lines[i++]);
      if (i < lines.length) buf.push(lines[i++]);
    }
  }
  flush();
  return out;
}

/** 0.18.28 `mode`: the run mode the person asked for (manual | important | auto | readonly); else the project's */
type StartSpec = { workflow: string; title: string; request?: string; mode?: "manual" | "important" | "auto" | "readonly" };
const START_MODES = ["manual", "important", "auto", "readonly"] as const;

function parseStart(body: string): StartSpec | null {
  try {
    const v = JSON.parse(body) as Partial<StartSpec>;
    return v && typeof v.workflow === "string" && v.workflow
      ? {
          workflow: v.workflow,
          title: String(v.title ?? ""),
          request: v.request ? String(v.request) : undefined,
          mode: START_MODES.includes(v.mode as never) ? v.mode : undefined,
        }
      : null;
  } catch {
    return null;
  }
}

/** "Start a flow": the workflow KeelBot suggests, a title the person can change, and the request every agent gets. */
export function StartCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseStart(body);
  const wfs = useLoad(pid ? `wfs:${pid}` : null, () => kb.workflows(pid), {
    live: false,
  });
  const [title, setTitle] = useState(spec?.title ?? "");
  const [busy, setBusy] = useState(false);
  const [started, setStarted] = useState<{ tid: string; title: string } | null>(
    null,
  );
  const [err, setErr] = useState<{
    message: string;
    hint?: string;
    dirty?: boolean;
  } | null>(null);
  if (!spec)
    return (
      <p className="kb-card bad" role="note">
        KeelBot's start button could not be read. Ask it to give the button
        again.
      </p>
    );
  const wf = wfs.data?.find((w) => w.id === spec.workflow);
  const unknown = !!wfs.data && !wf;
  const start = async (allowDirty = false) => {
    setBusy(true);
    setErr(null);
    try {
      const t = await kb.startFlow(pid, {
        workflow_id: spec.workflow,
        title: title.trim(),
        request: spec.request,
        ...(spec.mode ? { run_mode: spec.mode } : {}),
        ...(allowDirty ? { allow_dirty: true } : {}),
      });
      setStarted({ tid: t.thread_id, title: title.trim() });
    } catch (e) {
      const p = errorParts(e);
      setErr({ ...p, dirty: /uncommitted changes/i.test(p.message) });
    } finally {
      setBusy(false);
    }
  };
  return (
    <section
      className="kb-card"
      aria-label={`Start a flow: ${spec.title || spec.workflow}`}
    >
      <div className="kb-card-h">
        <span className="kb-tag">Start a flow</span>
        <b>{wf?.name ?? spec.workflow}</b>
      </div>
      {started ? (
        <p className="kb-done">
          Started <b>{started.title}</b>.{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => go("flow", started.tid)}
          >
            Open the flow ▸
          </button>
        </p>
      ) : (
        <>
          <label className="kb-field">
            <span>Title</span>
            <input
              className="inline-input"
              value={title}
              onChange={(e) => setTitle(e.target.value)}
              aria-label="Title of the flow"
            />
          </label>
          {spec.request && (
            <p className="kb-request">
              <span className="sub">What the agents get:</span> {spec.request}
            </p>
          )}
          {spec.mode && (
            <p className="kb-request" data-testid="kb-start-mode">
              <span className="sub">Run mode:</span> {spec.mode}
            </p>
          )}
          {unknown && (
            <p className="kb-err" role="alert">
              This project has no workflow called {spec.workflow}.
            </p>
          )}
          {err && (
            <div className="kb-err" role="alert">
              <b>{err.message}</b>
              {err.hint && <span className="sub"> {err.hint}</span>}
              {err.dirty && (
                <button
                  type="button"
                  className="btn sm"
                  onClick={() => void start(true)}
                  disabled={busy}
                >
                  Start anyway
                </button>
              )}
            </div>
          )}
          <div className="row">
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !title.trim() || unknown}
              onClick={() => void start()}
            >
              {busy ? "Starting…" : "Start the flow"}
            </button>
            {wf && (
              <button
                type="button"
                className="btn sm ghost"
                onClick={() => go("workflows", wf.id)}
              >
                See the workflow
              </button>
            )}
          </div>
        </>
      )}
    </section>
  );
}

const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;

/** A workflow KeelBot wrote: keel's check of it, the YAML, and Save (into a folder of the Workflows page). */
export function WorkflowCard({
  pid,
  body,
  onAsk,
}: {
  pid: string;
  body: string;
  onAsk?: (text: string) => void;
}) {
  const [check, setCheck] = useState<WorkflowCheck | null>(null);
  const [checkErr, setCheckErr] = useState<string | null>(null);
  const [folder, setFolder] = useState("");
  const [busy, setBusy] = useState(false);
  const [saved, setSaved] = useState<Workflow | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(
    null,
  );
  useEffect(() => {
    let live = true;
    kb.checkWorkflow(pid, body).then(
      (c) => live && setCheck(c),
      (e) => live && setCheckErr(errorParts(e).message),
    );
    return () => {
      live = false;
    };
  }, [pid, body]);
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.importWorkflow(pid, {
        yaml: body,
        ...(folder.trim() ? { folder: folder.trim() } : {}),
      });
      setSaved(r.workflow);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const name = check?.name || "New workflow";
  const problems = check && !check.valid ? check.errors : [];
  return (
    <section className="kb-card" aria-label={`New workflow: ${name}`}>
      <div className="kb-card-h">
        <span className="kb-tag">New workflow</span>
        <b>{name}</b>
      </div>
      {!check && !checkErr && <p className="sub">keel checks it…</p>}
      {checkErr && (
        <p className="kb-err" role="alert">
          keel could not check it: {checkErr}
        </p>
      )}
      {check && (
        <p className="sub kb-meta">
          {plural(check.steps, "step")} · {plural(check.gates, "gate")} ·{" "}
          {check.agents.length
            ? `agents: ${check.agents.join(", ")}`
            : "no agents (code steps only, no model runs)"}
          {check.commands.length > 0 && (
            <>
              {" "}
              · runs{" "}
              {check.commands.map((c) => (
                <code key={c}>{c}</code>
              ))}
            </>
          )}
        </p>
      )}
      {check?.warnings.map((w) => (
        <p key={w} className="kb-warn">
          {w}
        </p>
      ))}
      {problems.length > 0 && (
        <div className="kb-err" role="alert">
          <b>keel cannot run it yet:</b>
          <ul>
            {problems.map((p) => (
              <li key={p}>{p}</li>
            ))}
          </ul>
          {onAsk && (
            <button
              type="button"
              className="btn sm"
              onClick={() =>
                onAsk(
                  `keel's check found problems in the workflow "${name}":\n${problems.map((p) => `- ${p}`).join("\n")}\nFix them and give the whole workflow again.`,
                )
              }
            >
              Ask KeelBot to fix it
            </button>
          )}
        </div>
      )}
      <details className="kb-yaml">
        <summary>Show the YAML</summary>
        <CodeBlock text={body} lang="yaml" gutter={false} />
      </details>
      {saved ? (
        <p className="kb-done">
          Saved as <b>{saved.name}</b>
          {saved.folder ? (
            <>
              {" "}
              in the folder <b>{saved.folder}</b>
            </>
          ) : null}
          .{" "}
          <button
            type="button"
            className="btn sm"
            onClick={() => go("workflows", saved.id)}
          >
            Open it ▸
          </button>
        </p>
      ) : (
        <>
          {err && (
            <p className="kb-err" role="alert">
              <b>{err.message}</b>
              {err.hint && <span className="sub"> {err.hint}</span>}
            </p>
          )}
          <div className="row">
            <input
              className="inline-input kb-folder"
              placeholder="Folder (optional)"
              aria-label="Folder for the workflow"
              value={folder}
              onChange={(e) => setFolder(e.target.value)}
            />
            <button
              type="button"
              className="btn sm primary"
              disabled={busy || !check?.valid}
              onClick={() => void save()}
            >
              {busy ? "Saving…" : "Save the workflow"}
            </button>
          </div>
        </>
      )}
    </section>
  );
}

function parseJson<T>(body: string): T | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" ? (v as T) : null;
  } catch {
    return null;
  }
}

/** A CI step KeelBot gives as a button (CI/CD plugin): fix starts the ci-fix flow on this branch; rerun runs the failed
 *  jobs of the run again. */
export function CiCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseJson<{ op?: string; run?: number }>(body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<{ text: string; tid?: string } | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const op = spec?.op ?? "";
  if (!spec || !["fix", "rerun"].includes(op)) return <p className="kb-card bad" role="note">KeelBot's CI button could not be read. Ask it to give it again.</p>;
  const go_ = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (op === "fix") {
        const t = await kb.ciFix(pid, spec.run);
        setDone({ text: "The fix flow started: it reads the failure, fixes it, commits, pushes and waits for CI.", tid: t.thread_id });
      } else {
        const run = spec.run ?? (await kb.ciRuns(pid)).find((r) => r.failed)?.id;
        if (!run) {
          setDone({ text: "No failed run to start again." });
        } else {
          await kb.ciRerun(pid, run);
          setDone({ text: `The failed jobs of run #${run} run again.` });
        }
      }
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  const label = op === "fix" ? "Fix it" : "Run the failed jobs again";
  return (
    <section className="kb-card" aria-label={`CI: ${label}`}>
      <div className="kb-card-h"><span className="kb-tag">CI</span><b>{label}</b>{spec.run ? <span className="sub">run #{spec.run}</span> : null}</div>
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`KeelBot's CI button "${label}"`} error={err} />
      {done ? (
        <p className="kb-done" role="status">{done.text}{" "}
          {done.tid && <button type="button" className="btn sm" onClick={() => go("flow", done.tid)}>Open the flow ▸</button>}</p>
      ) : (
        <div className="row">
          <button type="button" className="btn sm primary" disabled={busy} onClick={() => void go_()}>{busy ? "Starting…" : label}</button>
          {op === "fix" && <span className="sub">It pushes the fix with the Git plugin, following your push setting.</span>}
        </div>
      )}
    </section>
  );
}

type FlowSpec = { do?: string; flow?: string; thread?: string; flows?: string[]; why?: string; mode?: string;
  /** keel 0.18.13 do: "answer": the answers to the flow's questions (question id → a label, labels or own words), or
   *  one of its named choices */
  answers?: Record<string, unknown>; choice?: string };
const RUN_MODES = ["manual", "important", "auto", "readonly"] as const;
const MODE_ABOUT: Record<string, string> = {
  manual: "stops at every gate",
  important: "approves a criterion's gate when its checks and review pass",
  auto: "approves every gate keel can decide; still stops for money, new dependencies, secrets and failures",
  readonly: "agents may read but change nothing",
};

/** 0.18.4 a flow button KeelBot gives (```keel-flow```): approve or send back the gate a flow waits at, stop flows, or
 *  a flow's run mode. Nothing happens until the person presses it. */
export function FlowCard({ pid, body, later }: { pid: string; body: string;
  /** 0.18.23 the person wrote a new message after this answer: a suggested gate answer not sent yet is not offered */
  later?: boolean }) {
  const spec = parseJson<FlowSpec>(body);
  return spec?.do === "answer" ? <AnswerFlowCard pid={pid} spec={spec} later={!!later} /> : <FlowOpCard pid={pid} body={body} />;
}

function FlowOpCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseJson<FlowSpec>(body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const op = spec?.do ?? "";
  const flows = [...new Set((spec?.flows ?? (spec?.flow ? [spec.flow] : [])).filter((x) => typeof x === "string" && x))];
  const ok = !!spec && flows.length > 0 && (["approve", "reject", "stop"].includes(op) || (op === "mode" && RUN_MODES.includes(spec.mode as never)))
    && !(op === "reject" && !spec.why);
  const views = useLoad(ok ? `kb-flow-titles:${flows.join(",")}` : null,
    () => Promise.all(flows.map((f) => kb.flowOf(pid, f).then((v) => v.thread ?? null).catch(() => null))), { live: false });
  if (!ok) return <p className="kb-card bad" role="note">KeelBot's flow button could not be read. Ask it to give it again.</p>;
  const decides = op === "approve" || op === "reject";
  // 0.18.28 a gate decision names the gate by its step ("verify the suite + commit"), not the flow's title cut short
  const waiting = decides ? views.data?.[0]?.waiting : undefined;
  const gate = waiting ? gateName(waiting) : "";
  const names = gate ? `"${gate}"` : flows.map((f, i) => `"${views.data?.[i]?.title || f.slice(0, 8)}"`).join(", ");
  // and what the button really does there: a reject that only stops the flow hands its reason to nobody
  const effect = decides ? waiting?.plain?.[op as "approve" | "reject"] : undefined;
  const label = op === "approve" ? "Approve the gate" : op === "reject" ? "Send back" : op === "stop"
    ? (flows.length === 1 ? "Stop the flow" : `Stop ${flows.length} flows`) : `Run in ${spec!.mode} mode`;
  const press = async () => {
    setBusy(true);
    setErr(null);
    try {
      if (op === "approve" || op === "reject") {
        const s = await kb.decideGate(flows[0], { decision: op, ...(spec!.why ? { why: spec!.why } : {}) });
        setDone(`${op === "approve" ? "Approved" : "Sent back"}. The flow is ${s.status}${s.current ? ` at ${s.current}` : ""}.`);
      } else if (op === "stop") {
        const failed: string[] = [];
        for (const f of flows) await kb.stopFlow(f).catch(() => failed.push(f));
        setDone(failed.length ? `Stopped ${flows.length - failed.length}; ${failed.length} could not be stopped.` : "Stopped. Every finished step stays saved.");
      } else {
        await kb.setRunMode(flows[0], spec!.mode as (typeof RUN_MODES)[number]);
        setDone(`From the next gate on it ${MODE_ABOUT[spec!.mode!]}.`);
      }
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`Flow: ${label}`}>
      <div className="kb-card-h"><span className="kb-tag">Flow</span><b>{label}</b><span className="sub">{names}</span></div>
      {op === "reject" && <p className="kb-request"><span className="sub">{effect && /^not used/.test(effect.reason) ? "The reason (no agent gets it here):" : "The reason the agent gets:"}</span> {spec!.why}</p>}
      {effect && <p className={`kb-request${op === "reject" && /^not used/.test(effect.reason) ? " kb-warn" : ""}`} data-testid="kb-plain-effect">
        <span className="sub">{op === "approve" ? "Approve" : "Send back"} here:</span> {effect.does}</p>}
      {op === "mode" && <p className="kb-request"><span className="sub">{spec!.mode}:</span> {MODE_ABOUT[spec!.mode!]}</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`KeelBot's flow button "${label}"`} error={err} />
      {done ? (
        <p className="kb-done" role="status">{done}{" "}
          <button type="button" className="btn sm" onClick={() => go("flow", flows[0])}>Open the flow ▸</button></p>
      ) : (
        <div className="row">
          <button type="button" className={`btn sm ${op === "stop" ? "warn" : "primary"}`} disabled={busy} onClick={() => void press()}>
            {busy ? "…" : label}</button>
        </div>
      )}
    </section>
  );
}

/** The answers KeelBot proposes, as the engine takes them: question id → a label, a list of labels, or own words. */
function proposedAnswers(raw: unknown): ClarifyAnswers | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const out: ClarifyAnswers = {};
  for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
    if (Array.isArray(v)) {
      const list = v.map((x) => String(x ?? "").trim()).filter(Boolean);
      if (list.length) out[k] = list;
    } else if (typeof v === "string" || typeof v === "number") {
      if (String(v).trim()) out[k] = String(v).trim();
    }
  }
  return Object.keys(out).length ? out : null;
}

/** keel 0.18.13 KeelBot proposes the answer to the question a flow waits at (```keel-flow {"do": "answer"}```): its
 *  answers to the questions, or one of the gate's named choices with the reason. The card shows them with the
 *  questions' and choices' own words; the button sends the same resume the Flow page sends. Nothing is sent until the
 *  person presses it. */
function AnswerFlowCard({ pid, spec, later }: { pid: string; spec: FlowSpec; later: boolean }) {
  const tid = String(spec.flow || spec.thread || "").trim();
  const answers = proposedAnswers(spec.answers);
  const choice = typeof spec.choice === "string" ? spec.choice.trim() : "";
  const why = typeof spec.why === "string" ? spec.why.trim() : "";
  const view = useLoad(tid && (answers || choice) ? `kb-flow-answer:${pid}:${tid}` : null, () => kb.flowOf(pid, tid), { live: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  if (!tid || (!answers && !choice)) return <p className="kb-card bad" role="note">KeelBot's answer button could not be read. Ask it to give it again.</p>;
  const t = view.data?.thread;
  const w = t?.waiting;
  const questions: ClarifyQuestion[] = w?.questions ?? [];
  const info: ChoiceInfo | undefined = choice ? w?.choice_info?.find((c) => c.name === choice) : undefined;
  const label = answers ? "Send these answers" : `Choose “${info?.label || choice}”`;
  const needsWhy = !!choice && !why && (info?.why === "required" || (!info && choice === "reject"));
  const notWaiting = !!view.data && t?.status !== "waiting";
  // 0.18.23 like the gate: its short name (the step's), not the flow's request; the flow's title only without one
  const gate = gateName(w);
  const stale = later && !done && !notWaiting;
  const press = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await kb.answerFlow(tid, { decision: "approve", ...(why ? { why } : {}), payload: answers ? { answers } : { choice } });
      setDone(`Sent. The flow is ${s.status}${s.current ? ` at ${s.current}` : ""}.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`Flow: ${label}`}>
      <div className="kb-card-h"><span className="kb-tag">Flow</span><b>{label}</b><span className="sub">{gate ? `"${gate}"` : t?.title ? `"${t.title}"` : tid.slice(0, 8)}</span></div>
      {answers && (
        <ol className="kb-answers" aria-label="KeelBot's answers">
          {Object.entries(answers).map(([id, v]) => {
            const q = questions.find((x) => x.id === id)?.question;
            const said = Array.isArray(v) ? v.join("; ") : v;
            return <li key={id}>{q && <><span className="sub">{q}</span> → </>}<b>{said}</b></li>;
          })}
        </ol>
      )}
      {choice && info?.description && <p className="kb-request"><span className="sub">{info.label || choice}:</span> {info.description}</p>}
      {why && <p className="kb-request"><span className="sub">The reason:</span> {why}</p>}
      {needsWhy && <p className="kb-err" role="alert">“{info?.label || choice}” needs a reason: ask KeelBot for one, or answer on the Flow page.</p>}
      {notWaiting && !done && <p className="kb-warn">The flow does not wait for this now ({t?.status ?? "gone"}).</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`KeelBot's flow button "${label}"`} error={err} />
      {stale && <p className="kb-warn" role="status">{NOT_SENT_NEW_MESSAGE}</p>}
      {done ? (
        <p className="kb-done" role="status">{done}{" "}
          <button type="button" className="btn sm" onClick={() => go("flow", tid)}>Open the flow ▸</button></p>
      ) : (
        <div className="row">
          {!stale && <button type="button" className="btn sm primary" disabled={busy || needsWhy || notWaiting} onClick={() => void press()}>{busy ? "…" : label}</button>}
          <button type="button" className="btn sm ghost" onClick={() => go("flow", tid)}>Open the flow</button>
        </div>
      )}
    </section>
  );
}

/** 0.18.5 a rule pack KeelBot wrote (```keel-rule```): keel checks it and says what it would have refused lately; Save
 *  puts it in .keel/rules/. */
export function RuleCard({ pid, body }: { pid: string; body: string }) {
  const check = useLoad(pid && body.trim() ? `kb-rule-check:${pid}:${body.length}:${body.slice(0, 80)}` : null,
    () => kb.checkRule(pid, body), { live: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = /^name:\s*(\S+)/m.exec(body)?.[1] ?? "rule pack";
  const c = check.data;
  const blocked = c?.dry_run?.blocked ?? [];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.saveRule(pid, body);
      setDone(`Saved ${r.pack?.id ?? name}: it applies from the next tool call.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New rule pack: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Rule pack</span><b>{name}</b></div>
      <CodeBlock text={body} gutter={false} />
      {c && !c.ok && <div className="kb-err" role="alert"><b>keel cannot save it yet:</b>{(c.errors ?? []).map((e) => <div key={e} className="sub">{e}</div>)}</div>}
      {c?.ok && <p className="sub">On the recent tool calls it would have refused {blocked.length} of {c.dry_run?.checked ?? 0}.</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the rule pack ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("rules")}>Open Rules ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy || !c?.ok} onClick={() => void save()}>{busy ? "Saving…" : "Save the rule pack"}</button></div>}
    </section>
  );
}

type AgentSpec = { name?: string; label?: string; about?: string; prompt?: string; tools?: string[]; phases?: string[] };

/** 0.18.5 an agent KeelBot wrote (```keel-agent```): its tools and instructions; Save adds it to the project. */
export function AgentCard({ pid, body }: { pid: string; body: string }) {
  const spec = parseJson<AgentSpec>(body);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = spec?.name ?? spec?.label ?? "";
  if (!spec || !name || !spec.prompt) return <p className="kb-card bad" role="note">KeelBot's agent could not be read. Ask it to give it again.</p>;
  const tools = spec.tools?.length ? spec.tools : ["Read", "Grep", "Glob"];
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const a = await kb.saveAgent(pid, { name, about: spec.about ?? "", prompt: spec.prompt!, tools, phases: spec.phases?.length ? spec.phases : ["any"] });
      setDone(`Saved ${a.id}. A workflow uses it with agent: ${a.id}.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New agent: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Agent</span><b>{name}</b><span className="sub">{tools.join(", ")}</span></div>
      {spec.about && <p>{spec.about}</p>}
      <p className="kb-request"><span className="sub">Its instructions:</span> {spec.prompt}</p>
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the agent ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("agents")}>Open Agents ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the agent"}</button></div>}
    </section>
  );
}

/** A SKILL.md's front matter as KeelBot writes it: name, description, and the agents that should load it (a list or
 *  words with commas). */
export function skillHead(body: string): { name: string; description: string; agents: string[] } {
  const m = /^---\n([\s\S]*?)\n---/.exec((body ?? "").replace(/\r\n?/g, "\n"));
  const fm = m?.[1] ?? "";
  const field = (k: string) => new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1]?.trim() ?? "";
  const agents = field("agents").replace(/^\[|\]$/g, "").split(",").map((a) => a.trim().replace(/^["']|["']$/g, "")).filter(Boolean);
  return { name: field("name").replace(/^["']|["']$/g, ""), description: field("description"), agents };
}

/** 0.18.6 a skill KeelBot wrote (```keel-skill```): its text and the agents to load it (from its front matter, the
 *  person changes them); Save adds it to the project's skills and puts it on those agents. */
export function SkillCard({ pid, body }: { pid: string; body: string }) {
  const head = skillHead(body);
  const agents = useLoad(pid ? `kb-agents:${pid}` : null, () => kb.agentIds(pid), { live: false });
  const [who, setWho] = useState<string[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  if (!head.name) return <p className="kb-card bad" role="note">KeelBot's skill has no name in its front matter. Ask it to give it again.</p>;
  const known = (agents.data ?? []).map((a) => a.id);
  const picked = who ?? head.agents.filter((a) => !agents.data || known.includes(a));
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const s = await kb.saveSkill(pid, body);
      if (picked.length) await kb.skillAgents(pid, s.id, picked);
      setDone(`Saved ${s.id}` + (picked.length ? `: loaded by ${picked.join(", ")} from their next run.` : ". Put it on agents on the Skills page."));
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New skill: ${head.name}`}>
      <div className="kb-card-h"><span className="kb-tag">Skill</span><b>{head.name}</b><span className="sub">~{Math.round(body.length / 4)} tokens</span></div>
      {head.description && <p>{head.description}</p>}
      <CodeBlock text={body} gutter={false} />
      {known.length > 0 && !done && (
        <div className="row" role="group" aria-label="Agents that load it" style={{ flexWrap: "wrap", gap: 8 }}>
          <span className="sub">Load it for:</span>
          {known.map((a) => (
            <label key={a} className="chk">
              <input type="checkbox" checked={picked.includes(a)}
                onChange={(e) => setWho(e.target.checked ? [...picked, a] : picked.filter((x) => x !== a))} /> {a}
            </label>
          ))}
        </div>
      )}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the skill KeelBot wrote`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("skills")}>Open Skills ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy} onClick={() => void save()}>{busy ? "Saving…" : "Save the skill"}</button></div>}
    </section>
  );
}

/** 0.18.9 a stack KeelBot wrote (```keel-stack```): keel checks it first (nothing is saved), then Save writes
 *  .keel/stacks/<name>.yml. */
export function StackCard({ pid, body }: { pid: string; body: string }) {
  const check = useLoad(pid && body.trim() ? `kb-stack-check:${pid}:${body.length}:${body.slice(0, 80)}` : null,
    () => kb.checkStack(pid, body), { live: false });
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState<string | null>(null);
  const [err, setErr] = useState<{ message: string; hint?: string } | null>(null);
  const name = /^name:\s*(\S+)/m.exec(body)?.[1] ?? "stack";
  const c = check.data;
  const save = async () => {
    setBusy(true);
    setErr(null);
    try {
      const r = await kb.saveStack(pid, body);
      setDone(`Saved ${name} as ${r.path}: keel uses it from the next step on.`);
    } catch (e) {
      setErr(errorParts(e));
    } finally {
      setBusy(false);
    }
  };
  return (
    <section className="kb-card" aria-label={`New stack: ${name}`}>
      <div className="kb-card-h"><span className="kb-tag">Stack</span><b>{name}</b>{c?.review?.lane && <span className="sub">{c.review.lane}</span>}</div>
      <CodeBlock text={body} gutter={false} />
      {c && !c.ok && <div className="kb-err" role="alert"><b>keel cannot save it yet:</b>{(c.errors ?? []).map((e) => <div key={e} className="sub">{e}</div>)}</div>}
      {c?.ok && !!c.warnings?.length && <div className="sub">{c.warnings.map((w) => <div key={w}>warning: {w}</div>)}</div>}
      {c?.replaces === "keel" && <p className="sub">keel has a stack called {name}: in this project this one is used in its place.</p>}
      {err && <p className="kb-err" role="alert"><b>{err.message}</b>{err.hint && <span className="sub"> {err.hint}</span>}</p>}
      <AskFixButton what={`saving the stack ${name}`} error={err} />
      {done ? <p className="kb-done" role="status">{done}{" "}<button type="button" className="btn sm" onClick={() => go("stacks")}>Open Stacks ▸</button></p>
        : <div className="row"><button type="button" className="btn sm primary" disabled={busy || !c?.ok} onClick={() => void save()}>{busy ? "Saving…" : "Save the stack"}</button></div>}
    </section>
  );
}

/** keel 0.18.9 KeelBot asks the person to choose (```keel-questions```): keel's question form (pick one, tick several,
 *  your own words, how many are answered); Send gives the answers to KeelBot as the next message.
 *  keel 0.18.13 `answered`: the chat's later message with the answers (it starts with "Answers to your questions"): the
 *  card shows what was sent, read only, also after a reload (derived from the chat, nothing stored). */
export function QuestionsCard({ body, answered }: { body: string; answered?: string | null }) {
  const qs = parseQuestions(body);
  const ask = useContext(AskKeelBot);
  const [picked, setPicked] = useState<ClarifyAnswers>({});
  const [typed, setTyped] = useState<ClarifyAnswers>({});
  const [sent, setSent] = useState<string | null>(null);
  if (!qs.length) return <p className="kb-card bad" role="note">KeelBot's questions could not be read. Ask it to ask again.</p>;
  const send = () => {
    const text = answersMessage(qs, answersOf(qs, picked, typed));
    ask?.(text);
    setSent(text);
  };
  const said = readAnswersMessage(answered ?? sent ?? "");
  return (
    <section className="kb-card" aria-label="KeelBot's questions">
      <div className="kb-card-h"><span className="kb-tag">Questions</span><b>KeelBot asks</b></div>
      {said ? (
        <div className="kb-done" role="status">
          <p>Your answers went to KeelBot:</p>
          <ol className="kb-answers" aria-label="Your answers">
            {said.map((x, i) => <li key={i}><span className="sub">{x.question}</span> → <b>{x.answer}</b></li>)}
          </ol>
        </div>
      ) : (
        <>
          <ClarifyForm questions={qs} picked={picked} typed={typed}
            onPick={(id, value) => setPicked((p) => ({ ...p, [id]: value }))} onType={(id, text) => setTyped((p) => ({ ...p, [id]: text }))} />
          <div className="row"><button type="button" className="btn sm primary" disabled={!ask} onClick={send}>Send my answers</button></div>
        </>
      )}
    </section>
  );
}

/** A block no core card handles (```keel-query```, ```keel-git```: the Database and Git plugins' buttons): the card a
 *  plugin put in the slot keelbot.card for its kind ({ id, kind: "keel-query", component }), which gets { block, pid }.
 *  Live: the card shows once the plugin's web part has loaded. Without one (the plugin is not there) the block shows as
 *  the code it is. */
export function SlotCard({ pid, block }: { pid: string; block: KeelbotBlock }) {
  const card = useSlot<KeelbotCardItem>(SLOTS.keelbotCard).find((c) => c.kind === block.kind);
  if (!card) return <CodeBlock text={block.body} gutter={false} />;
  const Card = card.component;
  return <Card block={block} pid={pid} />;
}
