// KeelBot's Flow action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useState } from "react";
import { AskFixButton, errorParts, go, useLoad, type ChoiceInfo, type ClarifyAnswers, type ClarifyQuestion } from "@keel/web-sdk";
import { kb } from "./keelbotApi";
import { gateName, NOT_SENT_NEW_MESSAGE } from "./suggest";
import { parseJson } from "./cardUtil";

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
