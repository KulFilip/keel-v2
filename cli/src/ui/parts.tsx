// keel TUI's pieces: the start screen, the transcript's blocks, the picker, the panels and the status line, in keel's
// colours (the dashboard's palette: ./theme.tsx). Each is a plain function of its props; App.tsx holds the state.

import React, { useEffect, useState } from "react";
import { panelText, type TuiPanel } from "../core/plugins";
import { Box, Text } from "ink";
import { api, type Job, type JobStep } from "../core/sdk";
import type { Block, Choice, Completion, PanelName } from "../core/commands";
import type { Snapshot } from "../core/keel";
import { LOGO } from "../core/logo";
import { renderMarkdown } from "../core/markdown";
import { colorDiagram } from "../core/colorize";
import * as fmt from "../core/format";
import { VERSION } from "../core/version";
import { noteText, noticeRole, textBlock } from "../core/lines";
import { toolLines } from "../core/tools";

export { noticeRole };
import { useTheme, type RoleProps } from "./theme";
import { pickVerb, Thinking } from "./thinking";
import { Clickable } from "./click";

/** What a click in a panel does (the full screen with the mouse): App.tsx gives it. */
export type PanelActs = {
  agent: (jobId: string) => void;
  waiting: () => void;
  flow: () => void;
  inbox: (n: number) => void;
};

export function StartScreen({ s, width }: { s: Snapshot; width?: number }) {
  const { color, look, paint } = useTheme();
  const p = s.project;
  const t = s.flow?.thread ?? null;
  const label = (x: string) => <Text {...look("dim")}>{x}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box
        borderStyle="round"
        borderColor={color("accent")}
        flexDirection="column"
        paddingX={1}
        width={width}
      >
        {LOGO.map((l, i) => (
          <Text key={i} {...look("accent")}>
            {l}
          </Text>
        ))}
        <Text> </Text>
        <Text>
          <Text bold>keel v2 {s.health?.version ?? VERSION}</Text>
          <Text {...look("dim")}> · keel TUI {VERSION}</Text>
        </Text>
        <Text>
          {label("keel     ")}
          <Text {...look("run")}>{s.publicUrl}</Text>
          <Text {...look("dim")}>
            {fmt.which(s.publicUrl, s.health).slice(s.publicUrl.length)}
          </Text>
        </Text>
        {s.error ? (
          <Text
            {...look("bad")}
          >{`keel is not reachable: ${s.error}\nStart it: keel2 start (or pass --url).`}</Text>
        ) : (
          <>
            <Text>
              {label("project  ")}
              {p ? (
                <>
                  <Text bold>{p.name || p.id}</Text>
                  <Text {...look("dim")}> · branch </Text>
                  <Text {...look("run")}>{p.branch || "-"}</Text>
                </>
              ) : (
                "none yet: add one in the dashboard"
              )}
            </Text>
            {t && (
              <Text>
                {label("flow     ")}
                <Text {...look("accent")}>{t.workflow_id}</Text>
                {` "${t.title}" · `}
                {fmt.badge(t.status, paint)}
                {t.current ? (
                  <Text {...look("dim")}>{` at ${t.current}`}</Text>
                ) : null}
              </Text>
            )}
            <Text>
              {label("waiting  ")}
              <Text
                {...look(
                  s.inbox.length ? "gate" : "ok",
                  false,
                  !!s.inbox.length,
                )}
              >
                {fmt.waitingBrief(s.inbox, p)}
              </Text>
            </Text>
            <Text>
              {label("next     ")}
              {fmt.next(p, s.flow, paint).split("\n")[0]}
            </Text>
          </>
        )}
      </Box>
      <Text {...look("dim")} wrap="truncate-end">
        {"  Ask KeelBot anything · "}
        <Text {...look("accent")}>/help</Text>
        {" · "}
        <Text {...look("accent")}>/flow</Text>
        {" starts a flow · "}
        <Text {...look("accent")}>Ctrl+F</Text>
        {" flow · "}
        <Text {...look("accent")}>Ctrl+A</Text>
        {" agents · "}
        <Text {...look("accent")}>Ctrl+N</Text>
        {" inbox"}
      </Text>
    </Box>
  );
}

/** A line with a mark (✗ ✓ ◆): a line that wraps goes on under its text, not under the mark. */
function Marked({
  mark,
  children,
  look,
  bold,
}: {
  mark: string;
  children: string;
  look: RoleProps;
  bold?: boolean;
}) {
  return (
    <Box>
      <Text {...look} bold>
        {mark + " "}
      </Text>
      <Box flexShrink={1}>
        <Text {...look} bold={bold}>
          {children}
        </Text>
      </Box>
    </Box>
  );
}

export function BlockView({
  b,
  width = 100,
  gap,
}: {
  b: Block;
  width?: number;
  gap?: boolean;
}) {
  return (
    <Box flexDirection="column" marginTop={gap ? 1 : 0}>
      <BlockBody b={b} width={width} />
    </Box>
  );
}

function BlockBody({ b, width }: { b: Block; width: number }) {
  const { look, paint } = useTheme();
  switch (b.kind) {
    case "markdown":
      return (
        <Box marginLeft={2}>
          <Text>{renderMarkdown(b.text, paint, width - 2)}</Text>
        </Box>
      );
    case "diagram":
      return (
        <Box marginLeft={1}>
          <Text>{colorDiagram(b.text, paint)}</Text>
        </Box>
      );
    case "error":
      return (
        <Marked mark="✗" look={look("bad")}>
          {b.text}
        </Marked>
      );
    case "ok":
      return (
        <Marked mark="✓" look={look("ok")}>
          {b.text}
        </Marked>
      );
    case "notice": {
      const r = noticeRole(b.text);
      return (
        <Marked mark="◆" look={look(r)} bold={r === "gate"}>
          {b.text}
        </Marked>
      );
    }
    // the person's message: a bar in the person's colour down its left side, with air inside it and above it, bold
    // words; KeelBot's answer (markdown, above) has no bar: the terminal's own text colour, indented
    case "user":
      return (
        <Box
          marginTop={1}
          borderStyle="single"
          borderTop={false}
          borderRight={false}
          borderBottom={false}
          borderLeftColor={look("person").color}
          borderLeftDimColor={!!look("person").dimColor}
          paddingLeft={2}
          paddingY={1}
        >
          <Text bold>{b.text}</Text>
        </Box>
      );
    case "tool":
      return b.tool ? (
        <Text>
          {toolLines(b.tool, width, paint, !!b.open, b.hint).join("\n")}
        </Text>
      ) : (
        <Text>{b.text}</Text>
      );
    case "dim":
      return <Text>{noteText(b.text, paint)}</Text>;
    default:
      return <Text>{textBlock(b.text, paint)}</Text>;
  }
}

export function Picker({
  title,
  choices,
  index,
  filter,
  ticked,
}: {
  title: string;
  choices: Choice[];
  index: number;
  filter: string;
  /** keel 0.18.9 a pick of several: the values ticked so far (Space ticks) */
  ticked?: Set<string>;
}) {
  const { color, look } = useTheme();
  // three looks, each with its own mark and border: KeelBot's suggestion ("✦ KeelBot suggests:", the accent), a
  // question (a yes or no, a gate's question: "?" and the gate's amber, its words bold), a list (the accent). A
  // suggested answer to a gate reads "KeelBot suggests this answer for …" (no colon), and has the suggestion's look too
  const sug = /^KeelBot suggests(:\s*|\s+)/.exec(title);
  const ask = !sug && title.trim().endsWith("?");
  const tone = sug ? color("suggest") : ask ? color("gate") : color("accent");
  const max = 10;
  const start = Math.max(
    0,
    Math.min(index - Math.floor(max / 2), choices.length - max),
  );
  const shown = choices.slice(start, start + max);
  // the numbers match the keys App.tsx takes (1–9, only while no filter is typed)
  const numbered = !filter && choices.length > 1;
  const numW = String(Math.min(choices.length, start + max)).length;
  const roomy = shown.some((c) => c.hint);
  return (
    <Box
      flexDirection="column"
      borderStyle="round"
      borderColor={tone}
      paddingX={1}
    >
      {sug ? (
        <Text>
          <Text {...look("suggest", true)}>
            {sug[1].startsWith(":")
              ? "✦ KeelBot suggests: "
              : "✦ KeelBot suggests "}
          </Text>
          <Text bold>{title.slice(sug[0].length)}</Text>
        </Text>
      ) : ask ? (
        <Text>
          <Text {...look("gate", true)}>{"? "}</Text>
          <Text {...look("question", true)}>{title}</Text>
        </Text>
      ) : (
        <Text {...look("accent")} bold>
          {title}
        </Text>
      )}
      {filter && <Text {...look("meta")}>{`filter: ${filter}`}</Text>}
      {shown.length === 0 && <Text {...look("meta")}>nothing matches</Text>}
      {shown.map((c, k) => {
        const at = start + k;
        const on = at === index;
        // an option: its number (1–9 picks it while nothing is typed), its label bold, "(recommended)" in the
        // recommended colour; its description on its own line under the label, so a long one wraps there and not
        // under the number; with descriptions, a blank line between options
        const rec = / \(recommended\)/.exec(c.label);
        const label = rec ? c.label.slice(0, rec.index) : c.label;
        const num = numbered ? (at < 9 ? `${at + 1}. ` : "").padStart(numW + 2) : "";
        const mark =
          (on ? "❯ " : "  ") +
          (ticked ? (ticked.has(c.value) ? "[x] " : "[ ] ") : "") +
          num;
        const tone = look(on ? "accent" : "option");
        return (
          <Box
            key={c.value}
            flexDirection="column"
            marginTop={roomy ? 1 : 0}
          >
            <Box>
              <Text {...tone} bold>
                {mark}
              </Text>
              <Box flexShrink={1}>
                <Text>
                  <Text {...tone} bold>
                    {label}
                  </Text>
                  {rec ? (
                    <Text {...look("recommended")} bold>
                      {c.label.slice(rec.index, rec.index + rec[0].length)}
                    </Text>
                  ) : null}
                  {rec ? (
                    <Text {...tone} bold>
                      {c.label.slice(rec.index + rec[0].length)}
                    </Text>
                  ) : null}
                </Text>
              </Box>
            </Box>
            {c.hint ? (
              <Box marginLeft={mark.length}>
                <Text {...look("detail")}>{c.hint}</Text>
              </Box>
            ) : null}
          </Box>
        );
      })}
      <Box marginTop={roomy ? 1 : 0}>
        <Text {...look("meta")}>
          {(numbered ? `1–${Math.min(9, choices.length)} picks · ` : "") +
            (ticked
              ? "↑↓ · Space ticks · Enter sends the ticked (or this one) · Esc"
              : "↑↓ · Enter · type to filter · Esc")}
        </Text>
      </Box>
    </Box>
  );
}

export function Completions({
  items,
  index,
}: {
  items: Completion[];
  index: number;
}) {
  const { color, look } = useTheme();
  const shown = items.slice(0, 8);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((c, k) => {
        const on = k === index;
        const m = /^(\/\S+)(.*)$/.exec(c.label);
        const name = m ? m[1] : c.label;
        const args = m ? m[2] : "";
        const pad = " ".repeat(Math.max(1, 26 - c.label.length));
        return (
          <Text key={c.value}>
            <Text {...look("accent", false, on)}>
              {(on ? "❯ " : "  ") + name}
            </Text>
            <Text {...look("attr")}>{args}</Text>
            <Text {...look("detail")}>{pad + (c.hint ?? "")}</Text>
          </Text>
        );
      })}
      {items.length > shown.length && (
        <Text
          {...look("faint")}
        >{`  … ${items.length - shown.length} more`}</Text>
      )}
    </Box>
  );
}

// ------------------------------------------------------------------ panels

const MARK: Record<string, string> = {
  done: "✔",
  now: "▶",
  wait: "◆",
  todo: "·",
  fail: "✗",
  stop: "■",
};
const MARK_ROLE = {
  done: "ok",
  now: "accent",
  wait: "gate",
  todo: "faint",
  fail: "bad",
  stop: "faint",
} as const;

/** The flow rail: the flow's phases in order, where it is, the gates and what waits. */
export function railOf(s: Snapshot): { phase: string; state: string }[] {
  const t = s.flow?.thread;
  const w = s.flow?.workflow;
  if (!t || !w) return [];
  const phases: string[] = [];
  let last = "none";
  w.steps.forEach((st) => {
    const ph = st.phase || last;
    last = ph;
    if (!phases.includes(ph)) phases.push(ph);
  });
  const curStep = t.current
    ? w.steps.find((x) => x.id === t.current?.replace(/__fix$/, ""))
    : undefined;
  const cur =
    t.phase && phases.includes(t.phase) ? t.phase : (curStep?.phase ?? null);
  const at = cur ? phases.indexOf(cur) : -1;
  return phases.map((ph, i) => ({
    phase: ph,
    state:
      t.status === "done"
        ? "done"
        : i < at
          ? "done"
          : i === at
            ? t.status === "waiting"
              ? "wait"
              : t.status === "failed"
                ? "fail"
                : t.status === "stopped"
                  ? "stop"
                  : "now"
            : "todo",
  }));
}

export function FlowPanel({
  s,
  width,
  on,
}: {
  s: Snapshot;
  width: number;
  on?: PanelActs;
}) {
  const { color, look, paint } = useTheme();
  const t = s.flow?.thread;
  if (!t)
    return (
      <PanelBox title="Flow">
        <Text {...look("dim")}>No flow on this project. /flow starts one.</Text>
      </PanelBox>
    );
  const rail = railOf(s);
  const [done, all] = fmt.acCount(t);
  const gates = (s.flow?.workflow?.steps ?? []).filter(
    (x) => x.kind === "gate",
  );
  const cur = t.current?.replace(/__fix$/, "");
  const flowAct = on?.flow ?? (() => undefined);
  return (
    <Clickable act={flowAct}>
      <PanelBox
        title={
          <>
            {"Flow · "}
            <Text {...look("accent")}>{t.workflow_id}</Text>
            {` "${t.title}" · `}
            {fmt.badge(t.status, paint)}
          </>
        }
      >
        <Text wrap="wrap">
          {rail.map((r, i) => (
            <Text
              key={i}
              {...look(
                MARK_ROLE[r.state as keyof typeof MARK_ROLE],
                false,
                r.state === "now" || r.state === "wait",
              )}
            >
              {`${MARK[r.state]} ${r.phase}`}
              {i < rail.length - 1 ? "  " : ""}
            </Text>
          ))}
        </Text>
        <Text>
          <Text {...look("dim")}>step </Text>
          <Text bold>{t.current || "-"}</Text>
          {t.ac ? <Text {...look("accent")}>{` · ${t.ac}`}</Text> : null}
          <Text {...look("dim")}>{` · phase ${t.phase || "none"}`}</Text>
        </Text>
        {all > 0 && (
          <Text>
            <Text {...look("dim")}>AC </Text>
            {t.acs.map((a, i) => (
              <Text
                key={i}
                {...look(
                  a.status === "done" || a.status === "already-met"
                    ? "ok"
                    : a.id === t.ac
                      ? "accent"
                      : "faint",
                )}
              >
                {a.status === "done" || a.status === "already-met"
                  ? "■"
                  : a.id === t.ac
                    ? "▶"
                    : "□"}
              </Text>
            ))}
            <Text
              {...look(done === all ? "ok" : "fg")}
            >{`  ${done}/${all}`}</Text>
          </Text>
        )}
        {gates.length > 0 && (
          <Text wrap="truncate-end">
            <Text {...look("dim")}>gates </Text>
            {gates.slice(0, Math.max(3, Math.floor(width / 22))).map((g, i) => (
              <Text
                key={g.id}
                {...look(g.id === cur ? "gate" : "dim", false, g.id === cur)}
              >
                {(i ? " · " : "") + (g.id === cur ? `◆ ${g.name}` : g.name)}
              </Text>
            ))}
          </Text>
        )}
        {t.waiting && (
          <Clickable act={on?.waiting ?? (() => undefined)}>
            <Text {...look("gate")} bold wrap="truncate-end">
              {`◆ waiting for you: ${t.waiting.title} · ${t.waiting.kind === "clarify" ? "/answer" : fmt.answerWords(t.waiting)}${on ? " · click to answer" : ""}`}
            </Text>
          </Clickable>
        )}
        {t.error && <Text {...look("bad")}>{t.error}</Text>}
      </PanelBox>
    </Clickable>
  );
}

export function AgentsPanel({
  running,
  last,
  live,
  width,
  on,
  flowTitles,
}: {
  running: Job[];
  last: Record<string, JobStep | undefined>;
  live?: Record<string, string>;
  width: number;
  on?: PanelActs;
  flowTitles?: Record<string, string>;
}) {
  const { color, look, paint } = useTheme();
  return (
    <PanelBox
      title={
        <>
          {"Agents · "}
          <Text
            {...look(running.length ? "accent" : "dim")}
          >{`${running.length} at work`}</Text>
        </>
      }
    >
      {running.length === 0 && (
        <Text {...look("dim")}>No agent is running.</Text>
      )}
      {running.slice(0, 6).map((j) => {
        const writing = live?.[j.id];
        return (
          <Clickable key={j.id} act={() => on?.agent(j.id)}>
            <Thinking
              who={j.agent}
              verb={pickVerb(j.id)}
              since={Date.parse(j.started_at) || null}
              tokens={fmt.tokensOf(j) || undefined}
              hint={[
                flowTitles ? fmt.flowOf(flowTitles, j.thread_id) : "",
                [j.step, j.ac].filter(Boolean).join(" "),
              ]
                .filter(Boolean)
                .join(" · ")}
            />
            {writing ? (
              <Text {...look("fg")} wrap="truncate-end">
                {"   ✎ " + writing.replace(/\s+/g, " ").slice(-(width - 8))}
              </Text>
            ) : (
              last[j.id] && (
                <Text wrap="truncate-end">
                  {"   " + fmt.stepLine(last[j.id]!, width - 6, paint)}
                </Text>
              )
            )}
          </Clickable>
        );
      })}
    </PanelBox>
  );
}

export function InboxPanel({ s, on }: { s: Snapshot; on?: PanelActs }) {
  const { color, look } = useTheme();
  return (
    <PanelBox
      title={
        <>
          {"Inbox · "}
          <Text
            {...look(s.inbox.length ? "gate" : "dim")}
          >{`${s.inbox.length} waiting`}</Text>
        </>
      }
    >
      {s.inbox.length === 0 && (
        <Text {...look("dim")}>Nothing waits for you.</Text>
      )}
      {s.inbox.slice(0, 6).map((i, k) => (
        <Clickable key={`${i.thread_id}-${k}`} act={() => on?.inbox(k + 1)}>
          <Text wrap="truncate-end">
            <Text {...look("gate")} bold>{`${k + 1}. `}</Text>
            <Text
              {...look("dim")}
            >{`${i.project_name || i.project_id} · `}</Text>
            <Text {...look("gate")}>{`${i.kind}: ${i.title}`}</Text>
            <Text
              {...look("faint")}
            >{` · /approve ${k + 1} · /reject ${k + 1} <why>`}</Text>
          </Text>
        </Clickable>
      ))}
    </PanelBox>
  );
}

function PanelBox({
  title,
  children,
}: {
  title: React.ReactNode;
  children: React.ReactNode;
}) {
  const { color, look } = useTheme();
  return (
    <Box
      flexDirection="column"
      borderStyle="single"
      borderColor={color("border")}
      borderDimColor={!!look("border").dimColor}
      paddingX={1}
    >
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

/** A plugin's panel (contributes.tui.panel): its call, read again every `every` seconds while it is on screen. */
export function PluginPanel({
  plugin,
  panel,
  pid,
  width,
}: {
  plugin: string;
  panel: TuiPanel;
  pid: string;
  width: number;
}) {
  const { paint } = useTheme();
  const [text, setText] = useState("…");
  useEffect(() => {
    let alive = true;
    const read = () =>
      void panelText(panel, pid, paint, width - 4).then(
        (t) => alive && setText(t),
      );
    read();
    const id = setInterval(read, Math.max(5, panel.every) * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [panel, pid, paint, width]);
  return (
    <PanelBox
      title={
        <>
          {panel.title}
          {` · ${plugin}`}
        </>
      }
    >
      <Text wrap="truncate-end">{text}</Text>
    </PanelBox>
  );
}

/** One agent of a flow, followed (/agent <n>): what it is doing, its last steps and the text it writes now. Its steps
 *  are read again every 2 s; when it is finished the panel says so and stays until Esc or /panel off. */
export function JobPanel({
  id,
  s,
  width,
}: {
  id: string;
  s: Snapshot;
  width: number;
}) {
  const { color, look, paint } = useTheme();
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    let alive = true;
    const read = () =>
      void api
        .jobSteps(id)
        .then((r) => {
          if (!alive) return;
          setSteps(r.steps);
          setRunning(r.running);
        })
        .catch(() => undefined);
    read();
    const t = setInterval(read, 2000);
    return () => {
      alive = false;
      clearInterval(t);
    };
  }, [id]);
  const j = s.running.find((x) => x.id === id);
  const writing = s.liveText[id];
  const shown = steps.filter((x) => x.kind !== "thinking").slice(-6);
  return (
    <PanelBox
      title={
        <>
          {"Agent · "}
          <Text {...look("accent")}>
            {j
              ? [
                  j.agent,
                  fmt.flowOf(s.flowTitles, j.thread_id),
                  [j.step, j.ac].filter(Boolean).join(" "),
                ]
                  .filter(Boolean)
                  .join(" · ")
              : id.slice(0, 8)}
          </Text>
          <Text {...look("dim")}>
            {running ? "" : " · finished"}
            {" · Esc stops following"}
          </Text>
        </>
      }
    >
      {running && j && (
        <Thinking
          who={j.agent}
          verb={pickVerb(j.id)}
          since={Date.parse(j.started_at) || null}
          tokens={fmt.tokensOf(j) || undefined}
        />
      )}
      {shown.length === 0 && <Text {...look("dim")}>no steps yet</Text>}
      {shown.map((x) => (
        <Text key={x.n} wrap="truncate-end">
          {fmt.stepLine(x, width - 6, paint)}
        </Text>
      ))}
      {writing ? (
        <Text {...look("fg")} wrap="truncate-end">
          {"✎ " + writing.replace(/\s+/g, " ").slice(-(width - 8))}
        </Text>
      ) : null}
    </PanelBox>
  );
}

export function Panel({
  name,
  s,
  width,
  on,
}: {
  name: PanelName;
  s: Snapshot;
  width: number;
  on?: PanelActs;
}) {
  if (name === "flow") return <FlowPanel s={s} width={width} on={on} />;
  if (name === "agents")
    return (
      <AgentsPanel
        running={s.running}
        last={s.lastStep}
        live={s.liveText}
        width={width}
        on={on}
        flowTitles={s.flowTitles}
      />
    );
  return <InboxPanel s={s} on={on} />;
}

type Seg = {
  text: string;
  role: "fg" | "dim" | "accent" | "gate" | "ok" | "warn" | "bad" | "faint";
  bold?: boolean;
};

/** keel 0.18.8 KeelBot's mode as the status line's first word, with a small ASCII tool (every terminal and font has
 *  these): a question, a pencil, a wrench, a branch. */
export const MODE_MARK: Record<string, string> = {
  ask: "[?] ask",
  edit: "[=/] edit",
  fix: "[-{] fix",
  side: "[-<] side",
};

/** project · flow · phase · AC n/m · gates waiting · tokens · live, each with the role it is coloured with. `meter`
 *  false: no context meter (the sidebar shows it). */
export function statusSegments(s: Snapshot, meter = true): Seg[] {
  const t = s.flow?.thread;
  const [done, all] = fmt.acCount(t);
  const here = s.project
    ? s.inbox.filter((i) => i.project_id === s.project!.id).length
    : 0;
  const flowRole: Seg["role"] = !t
    ? "dim"
    : t.status === "waiting"
      ? "gate"
      : t.status === "running"
        ? "accent"
        : t.status === "done"
          ? "ok"
          : t.status === "failed"
            ? "bad"
            : "faint";
  const segs: Seg[] = [
    // keel 0.18.8 KeelBot's mode comes first (Alt+Tab or Shift+Tab changes it): ask quiet, a mode that changes files bright
    {
      text: MODE_MARK[s.chat.mode] ?? s.chat.mode,
      role: s.chat.mode === "ask" ? "dim" : "accent",
      bold: s.chat.mode !== "ask",
    },
    {
      text: s.project
        ? `${s.project.id}${s.project.branch ? ` (${s.project.branch.length > 28 ? s.project.branch.slice(0, 27) + "…" : s.project.branch})` : ""}`
        : "no project",
      role: "fg",
      bold: true,
    },
    { text: t ? `${t.workflow_id} ${t.status}` : "no flow", role: flowRole },
  ];
  if (t) segs.push({ text: `phase ${t.phase || "none"}`, role: "dim" });
  if (t && all)
    segs.push({ text: `AC ${done}/${all}`, role: done === all ? "ok" : "dim" });
  // "waiting" says what it counts: here, and in the other projects; a click on the line answers them
  segs.push({
    text: s.inbox.length
      ? `◆ ${here} waiting here${s.inbox.length > here ? `, ${s.inbox.length - here} in other projects` : ""}`
      : "nothing waits",
    role: s.inbox.length ? "gate" : "dim",
    bold: s.inbox.length > 0,
  });
  if (t)
    segs.push({
      text: `${fmt.short(fmt.tokensOf(t.usage))} tokens`,
      role: "dim",
    });
  // P1-1 the open KeelBot chat's context meter: how full its model's window is after the last turn
  const session = s.chat.session;
  if (meter && session && session.ctx_window) {
    const pct = Math.round(
      ((session.ctx_tokens ?? 0) / session.ctx_window) * 100,
    );
    segs.push({
      text: `ctx ${pct}%`,
      role: pct >= 85 ? "bad" : pct >= 70 ? "warn" : "dim",
    });
  }
  segs.push({
    text: `● ${s.live}`,
    role: s.live === "live" ? "ok" : s.live === "closed" ? "faint" : "gate",
  });
  return segs;
}

/** The status line's words (tests, and front ends without colour). */
export const statusParts = (s: Snapshot) =>
  statusSegments(s).map((x) => x.text.replace(/^● /, ""));

/** `hint`: a quiet last segment (the full screen with the mouse on: how to select with the terminal itself). */
export function StatusLine({
  s,
  meter = true,
  hint,
}: {
  s: Snapshot;
  meter?: boolean;
  hint?: string;
}) {
  const { color, look } = useTheme();
  const segs = [
    ...statusSegments(s, meter),
    ...(hint ? [{ text: hint, role: "faint" as const }] : []),
  ];
  return (
    <Text wrap="truncate-end">
      {" "}
      {segs.map((x, i) => (
        <Text key={i}>
          {i ? <Text {...look("faint")}>{" · "}</Text> : null}
          <Text {...look(x.role, false, !!x.bold)}>{x.text}</Text>
        </Text>
      ))}
    </Text>
  );
}
