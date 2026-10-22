// Settings › Code Review threads: "Is the reviewer right?" (quick: agent, model, effort, token cap, think harder; or a
// workflow), the workflow "Address it" starts, and up to 6 extra thread buttons. It draws itself in the Settings page
// for the scope shown (General, or the project's own) and saves through the plugin's checked routes
// (PUT /review/settings, /projects/{pid}/review/settings); a project's own value can be reset to General.

import { useEffect, useState, type ReactNode } from "react";
import { ErrorBox, errorParts, type SettingsSectionProps } from "@keel/web-sdk";
import {
  reviewApi,
  type ThreadButton,
  type ThreadSettingsValues,
  type ThreadSettingsView,
} from "./reviewApi";

type K = keyof ThreadSettingsValues;
type Err = { message: string; hint?: string };

const blankButton = (agent: string): ThreadButton => ({
  label: "",
  mode: "ask",
  agent,
  workflow: null,
  prompt:
    "Explain {{file}} {{lines}} of {{pr}} in simple words.\n{{thread}}\n{{diff}}",
});

export function ThreadSettings({ pid, scope }: SettingsSectionProps) {
  const project = scope === "project" && pid ? pid : null;
  const [v, setV] = useState<ThreadSettingsView | null>(null);
  const [err, setErr] = useState<Err | null>(null);
  const [saved, setSaved] = useState("");
  const [buttons, setButtons] = useState<ThreadButton[]>([]);
  const [dirty, setDirty] = useState(false);
  const [cap, setCap] = useState("");
  const load = () =>
    reviewApi.threadSettings(project).then(
      (x) => {
        setV(x);
        setButtons(x.effective.thread_buttons ?? []);
        setCap(String(x.effective.judge_token_cap ?? ""));
        setDirty(false);
      },
      (e) => setErr(errorParts(e)),
    );
  useEffect(() => {
    setV(null);
    void load();
  }, [project]); // eslint-disable-line react-hooks/exhaustive-deps

  if (!v)
    return err ? (
      <ErrorBox error={err} />
    ) : (
      <p className="rv-dim">Loading the thread settings…</p>
    );
  const e = v.effective;
  const own = (k: K) =>
    project != null &&
    v.overrides != null &&
    v.overrides[k] !== undefined &&
    v.overrides[k] !== null;
  const save = async (patch: Partial<Record<K, unknown>>, what: string) => {
    setErr(null);
    setSaved("Saving…");
    try {
      const x = await reviewApi.saveThreadSettings(project, patch);
      setV(x);
      setButtons(x.effective.thread_buttons ?? []);
      setCap(String(x.effective.judge_token_cap ?? ""));
      setDirty(false);
      setSaved(`Saved: ${what}`);
    } catch (ex) {
      setErr(errorParts(ex));
      setSaved("Not saved");
    }
  };
  const id = (k: string) => `rvs-${k}`;
  const row = (k: K, label: string, help: string, control: ReactNode) => (
    <div
      className={`sg-row${own(k) ? " is-changed" : ""}`}
      data-key={`review.${k}`}
    >
      <div className="sg-lab">
        <label className="sg-name" htmlFor={id(k)}>
          {label}
        </label>
        <span className="sg-help" id={`${id(k)}-help`}>
          {help}
        </span>
        {project && (
          <span className="sg-src">
            {own(k) ? (
              <>
                <span className="tag star">changed for this project</span>
                <button
                  type="button"
                  className="btn sm ghost"
                  aria-label={`Reset ${label} to General`}
                  onClick={() =>
                    void save({ [k]: null }, `${label} follows General`)
                  }
                >
                  Reset to General
                </button>
              </>
            ) : (
              <span className="sub">from General</span>
            )}
          </span>
        )}
      </div>
      <div className="sg-ctl">{control}</div>
    </div>
  );
  const agents = (cur?: string | null) =>
    Array.from(new Set([...(cur ? [cur] : []), ...v.agents]));
  const flows = (cur?: string | null) => {
    const list = v.workflows.map((w) => [w.id, w.name] as [string, string]);
    return cur && !list.some(([i]) => i === cur)
      ? [[cur, cur] as [string, string], ...list]
      : list;
  };
  const modelKey = (m?: { provider: string; model: string } | null) =>
    m ? `${m.provider}|${m.model}` : "";
  const models = v.models.filter(
    (m, i, a) =>
      a.findIndex((x) => modelKey(x.model) === modelKey(m.model)) === i,
  );
  const quick = (e.judge_mode ?? "quick") === "quick";
  const setButton = (i: number, patch: Partial<ThreadButton>) => {
    setButtons((b) => b.map((x, j) => (j === i ? { ...x, ...patch } : x)));
    setDirty(true);
  };
  const move = (i: number, d: -1 | 1) => {
    setButtons((b) => {
      const n = [...b];
      const j = i + d;
      if (j < 0 || j >= n.length) return b;
      [n[i], n[j]] = [n[j], n[i]];
      return n;
    });
    setDirty(true);
  };

  return (
    <div className="rv-settings" data-testid="review-thread-settings">
      <h3 className="rv-settings-h">✦ Is the reviewer right?</h3>
      {row(
        "judge_mode",
        "How keel checks",
        quick
          ? "Quick: one cheap model call on the thread and its lines, no tools."
          : "Workflow: runs a workflow as a flow with the thread as its request.",
        <select
          id={id("judge_mode")}
          value={e.judge_mode ?? "quick"}
          aria-describedby={`${id("judge_mode")}-help`}
          onChange={(x) =>
            void save(
              { judge_mode: x.target.value },
              `checks are ${x.target.value}`,
            )
          }
        >
          <option value="quick">quick (one cheap call)</option>
          <option value="workflow">workflow (a flow)</option>
        </select>,
      )}
      {quick ? (
        <>
          {row(
            "judge_agent",
            "Agent",
            "Who checks: its own model counts when no model is set below.",
            <select
              id={id("judge_agent")}
              value={e.judge_agent ?? ""}
              onChange={(x) =>
                void save(
                  { judge_agent: x.target.value },
                  `the agent is ${x.target.value}`,
                )
              }
            >
              {agents(e.judge_agent).map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>,
          )}
          {row(
            "judge_model",
            "Model",
            "Empty: the cheapest model keel has configured.",
            <select
              id={id("judge_model")}
              value={modelKey(e.judge_model)}
              onChange={(x) => {
                const m =
                  models.find((y) => modelKey(y.model) === x.target.value)
                    ?.model ?? null;
                void save(
                  { judge_model: m },
                  m ? `the model is ${m.model}` : "the cheapest model",
                );
              }}
            >
              <option value="">cheapest configured</option>
              {models.map((m) => (
                <option key={modelKey(m.model)} value={modelKey(m.model)}>
                  {m.model.provider} · {m.model.model} ({m.role})
                </option>
              ))}
            </select>,
          )}
          {row(
            "judge_effort",
            "Effort",
            "How hard the model thinks. Low is the cheapest.",
            <select
              id={id("judge_effort")}
              value={e.judge_effort ?? "low"}
              onChange={(x) =>
                void save(
                  { judge_effort: x.target.value },
                  `effort ${x.target.value}`,
                )
              }
            >
              {["low", "medium", "high"].map((o) => (
                <option key={o} value={o}>
                  {o}
                </option>
              ))}
            </select>,
          )}
          {row(
            "judge_token_cap",
            "Token cap per check",
            `A check that needs more does not run (${v.limits.min_cap}–${v.limits.max_cap}).`,
            <input
              id={id("judge_token_cap")}
              className="sg-input"
              inputMode="numeric"
              value={cap}
              onChange={(x) => setCap(x.target.value)}
              onBlur={() =>
                Number(cap) !== e.judge_token_cap &&
                void save({ judge_token_cap: Number(cap) }, `the cap is ${cap}`)
              }
              onKeyDown={(x) =>
                x.key === "Enter" &&
                Number(cap) !== e.judge_token_cap &&
                void save({ judge_token_cap: Number(cap) }, `the cap is ${cap}`)
              }
            />,
          )}
          {row(
            "judge_allow_harder",
            'Offer "Think harder"',
            "A stronger model or more effort for one check, when you ask.",
            <input
              id={id("judge_allow_harder")}
              type="checkbox"
              checked={e.judge_allow_harder ?? true}
              onChange={(x) =>
                void save(
                  { judge_allow_harder: x.target.checked },
                  x.target.checked
                    ? "Think harder is offered"
                    : "Think harder is off",
                )
              }
            />,
          )}
        </>
      ) : (
        row(
          "judge_workflow",
          "Workflow",
          "Runs as a normal flow with the thread as its request.",
          <select
            id={id("judge_workflow")}
            value={e.judge_workflow ?? "review"}
            onChange={(x) =>
              void save(
                { judge_workflow: x.target.value },
                `the check runs ${x.target.value}`,
              )
            }
          >
            {flows(e.judge_workflow).map(([i, n]) => (
              <option key={i} value={i}>
                {n}
              </option>
            ))}
          </select>,
        )
      )}
      <h3 className="rv-settings-h">✦ Address it</h3>
      {row(
        "address_workflow",
        "Workflow",
        "Runs on the pull request's branch with the thread as its request. It never pushes.",
        <select
          id={id("address_workflow")}
          value={e.address_workflow ?? "small"}
          onChange={(x) =>
            void save(
              { address_workflow: x.target.value },
              `Address it runs ${x.target.value}`,
            )
          }
        >
          {flows(e.address_workflow).map(([i, n]) => (
            <option key={i} value={i}>
              {n}
            </option>
          ))}
        </select>,
      )}
      <h3 className="rv-settings-h">Extra thread buttons</h3>
      <p className="rv-dim">
        Up to {v.limits.buttons}. Ask: one cheap call, like the quick check.
        Workflow: a flow on the pull request's branch, like Address it. The
        prompt may use {v.limits.placeholders.map((p) => `{{${p}}}`).join(" ")}.
        {project && own("thread_buttons") && (
          <>
            {" "}
            <button
              type="button"
              className="btn sm ghost"
              onClick={() =>
                void save(
                  { thread_buttons: null },
                  "the buttons follow General",
                )
              }
            >
              Reset the buttons to General
            </button>
          </>
        )}
      </p>
      <ol className="rv-btnlist" aria-label="Extra thread buttons">
        {buttons.map((b, i) => (
          <li
            key={i}
            className="rv-btnrow"
            aria-label={`Button ${i + 1}${b.label ? `: ${b.label}` : ""}`}
          >
            <div className="rv-btnrow-1">
              <label>
                <span>Label</span>
                <input
                  className="sg-input"
                  value={b.label}
                  maxLength={v.limits.label + 10}
                  aria-label={`Label of button ${i + 1}`}
                  onChange={(x) => setButton(i, { label: x.target.value })}
                />
              </label>
              <label>
                <span>Mode</span>
                <select
                  value={b.mode}
                  aria-label={`Mode of button ${i + 1}`}
                  onChange={(x) =>
                    setButton(
                      i,
                      x.target.value === "ask"
                        ? {
                            mode: "ask",
                            agent: b.agent ?? e.judge_agent ?? v.agents[0],
                            workflow: null,
                          }
                        : {
                            mode: "workflow",
                            workflow: b.workflow ?? v.workflows[0]?.id ?? null,
                            agent: null,
                          },
                    )
                  }
                >
                  <option value="ask">ask</option>
                  <option value="workflow">workflow</option>
                </select>
              </label>
              {b.mode === "ask" ? (
                <label>
                  <span>Agent</span>
                  <select
                    value={b.agent ?? ""}
                    aria-label={`Agent of button ${i + 1}`}
                    onChange={(x) => setButton(i, { agent: x.target.value })}
                  >
                    {agents(b.agent).map((a) => (
                      <option key={a} value={a}>
                        {a}
                      </option>
                    ))}
                  </select>
                </label>
              ) : (
                <label>
                  <span>Workflow</span>
                  <select
                    value={b.workflow ?? ""}
                    aria-label={`Workflow of button ${i + 1}`}
                    onChange={(x) => setButton(i, { workflow: x.target.value })}
                  >
                    {flows(b.workflow).map(([wid, n]) => (
                      <option key={wid} value={wid}>
                        {n}
                      </option>
                    ))}
                  </select>
                </label>
              )}
              <span className="rv-btnrow-tools">
                <button
                  type="button"
                  className="ib"
                  aria-label={`Move button ${i + 1} up`}
                  disabled={i === 0}
                  onClick={() => move(i, -1)}
                >
                  ↑
                </button>
                <button
                  type="button"
                  className="ib"
                  aria-label={`Move button ${i + 1} down`}
                  disabled={i === buttons.length - 1}
                  onClick={() => move(i, 1)}
                >
                  ↓
                </button>
                <button
                  type="button"
                  className="ib"
                  aria-label={`Remove button ${i + 1}`}
                  onClick={() => {
                    setButtons((x) => x.filter((_, j) => j !== i));
                    setDirty(true);
                  }}
                >
                  ✕
                </button>
              </span>
            </div>
            <label className="rv-btnrow-p">
              <span>Prompt</span>
              <textarea
                className="rv-ta"
                value={b.prompt}
                aria-label={`Prompt of button ${i + 1}`}
                onChange={(x) => setButton(i, { prompt: x.target.value })}
              />
            </label>
          </li>
        ))}
      </ol>
      <div className="rv-row">
        <button
          type="button"
          className="btn sm"
          disabled={buttons.length >= v.limits.buttons}
          onClick={() => {
            setButtons((b) => [
              ...b,
              blankButton(e.judge_agent ?? v.agents[0] ?? ""),
            ]);
            setDirty(true);
          }}
        >
          Add a button
        </button>
        <button
          type="button"
          className="btn sm primary"
          disabled={!dirty}
          onClick={() =>
            void save({ thread_buttons: buttons }, "the thread buttons")
          }
        >
          Save the buttons
        </button>
        {dirty && (
          <button
            type="button"
            className="btn sm ghost"
            onClick={() => void load()}
          >
            Undo changes
          </button>
        )}
      </div>
      {err && <ErrorBox error={err} />}
      <span className="rv-dim" role="status" aria-live="polite">
        {saved}
      </span>
    </div>
  );
}
