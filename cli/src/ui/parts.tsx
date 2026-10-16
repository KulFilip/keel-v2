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
import { noticeRole } from "../core/lines";

export { noticeRole };
import { useTheme } from "./theme";
import { pickVerb, Thinking } from "./thinking";
import { Clickable } from "./click";

/** What a click in a panel does (the full screen with the mouse): App.tsx gives it. */
export type PanelActs = { agent: (jobId: string) => void; waiting: () => void; flow: () => void; inbox: (n: number) => void };

export function StartScreen({ s, width }: { s: Snapshot; width?: number }) {
  const { color, paint } = useTheme();
  const p = s.project;
  const t = s.flow?.thread ?? null;
  const label = (x: string) => <Text color={color("dim")}>{x}</Text>;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={color("accent")} flexDirection="column" paddingX={1} width={width}>
        {LOGO.map((l, i) => <Text key={i} color={color("accent")}>{l}</Text>)}
        <Text> </Text>
        <Text><Text bold>keel v2 {s.health?.version ?? VERSION}</Text><Text color={color("dim")}> · keel TUI {VERSION}</Text></Text>
        <Text>{label("keel     ")}<Text color={color("run")}>{s.publicUrl}</Text><Text color={color("dim")}>{fmt.which(s.publicUrl, s.health).slice(s.publicUrl.length)}</Text></Text>
        {s.error
          ? <Text color={color("bad")}>{`keel is not reachable: ${s.error}\nStart it: keel2 start (or pass --url).`}</Text>
          : <>
            <Text>{label("project  ")}{p ? <><Text bold>{p.name || p.id}</Text><Text color={color("dim")}> · branch </Text><Text color={color("run")}>{p.branch || "-"}</Text></> : "none yet: add one in the dashboard"}</Text>
            {t && <Text>{label("flow     ")}<Text color={color("accent")}>{t.workflow_id}</Text>{` "${t.title}" · `}{fmt.badge(t.status, paint)}{t.current ? <Text color={color("dim")}>{` at ${t.current}`}</Text> : null}</Text>}
            <Text>{label("waiting  ")}<Text color={s.inbox.length ? color("gate") : color("ok")} bold={!!s.inbox.length}>{fmt.waitingBrief(s.inbox, p)}</Text></Text>
            <Text>{label("next     ")}{fmt.next(p, s.flow, paint).split("\n")[0]}</Text>
          </>}
      </Box>
      <Text color={color("dim")} wrap="truncate-end">
        {"  Ask KeelBot anything · "}<Text color={color("accent")}>/help</Text>{" · "}<Text color={color("accent")}>/flow</Text>
        {" starts a flow · "}<Text color={color("accent")}>Ctrl+F</Text>{" flow · "}<Text color={color("accent")}>Ctrl+A</Text>{" agents · "}
        <Text color={color("accent")}>Ctrl+B</Text>{" inbox"}
      </Text>
    </Box>
  );
}

/** A line with a mark (✗ ✓ ◆): a line that wraps goes on under its text, not under the mark. */
function Marked({ mark, children, color, bold }: { mark: string; children: string; color?: string; bold?: boolean }) {
  return (
    <Box>
      <Text color={color} bold={bold}>{mark + " "}</Text>
      <Box flexShrink={1}><Text color={color} bold={bold}>{children}</Text></Box>
    </Box>
  );
}

export function BlockView({ b, width = 100, gap }: { b: Block; width?: number; gap?: boolean }) {
  return <Box flexDirection="column" marginTop={gap ? 1 : 0}><BlockBody b={b} width={width} /></Box>;
}

function BlockBody({ b, width }: { b: Block; width: number }) {
  const { color, paint, tint } = useTheme();
  switch (b.kind) {
    case "markdown": return <Box marginLeft={2}><Text>{renderMarkdown(b.text, paint, width - 2)}</Text></Box>;
    case "diagram": return <Box marginLeft={1}><Text>{colorDiagram(b.text, paint)}</Text></Box>;
    case "error": return <Marked mark="✗" color={color("bad")}>{b.text}</Marked>;
    case "ok": return <Marked mark="✓" color={color("ok")}>{b.text}</Marked>;
    case "notice": {
      const r = noticeRole(b.text);
      return <Marked mark="◆" color={color(r)} bold={r === "gate"}>{b.text}</Marked>;
    }
    // the person's message: on its own tinted line, with air above it (xal's bubble)
    case "user": {
      const pad = " ".repeat(Math.max(0, width - 3 - [...b.text].length));
      return (
        <Box marginTop={1}>
          <Text backgroundColor={tint}><Text color={color("accent")} bold>{" › "}</Text><Text bold>{b.text}</Text>{tint ? pad : ""}</Text>
        </Box>
      );
    }
    case "dim": return <Text color={color("dim")}>{b.text}</Text>;
    default: return <Text>{b.text}</Text>;
  }
}

export function Picker({ title, choices, index, filter }: { title: string; choices: Choice[]; index: number; filter: string }) {
  const { color } = useTheme();
  // a question (a yes or no, a gate's question) in amber with a "?", like xal's permission prompt; a list in the accent
  const ask = title.trim().endsWith("?");
  const tone = ask ? color("gate") : color("accent");
  const max = 10;
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), choices.length - max));
  const shown = choices.slice(start, start + max);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={tone} paddingX={1}>
      <Text bold color={tone}>{ask ? "? " : ""}{title}</Text>
      {filter && <Text color={color("dim")}>{`filter: ${filter}`}</Text>}
      {shown.length === 0 && <Text color={color("dim")}>nothing matches</Text>}
      {shown.map((c, k) => {
        const on = start + k === index;
        return (
          <Text key={c.value} color={on ? color("accent") : undefined} bold={on}>
            {on ? "❯ " : "  "}{c.label}{c.hint ? <Text color={color("dim")} bold={false}>{"  " + c.hint}</Text> : null}
          </Text>
        );
      })}
      <Text color={color("faint")}>↑↓ · Enter · type to filter · Esc</Text>
    </Box>
  );
}

export function Completions({ items, index }: { items: Completion[]; index: number }) {
  const { color } = useTheme();
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
            <Text color={color("accent")} bold={on}>{(on ? "❯ " : "  ") + name}</Text>
            <Text color={color("attr")}>{args}</Text>
            <Text color={on ? color("fg") : color("dim")}>{pad + (c.hint ?? "")}</Text>
          </Text>
        );
      })}
      {items.length > shown.length && <Text color={color("faint")}>{`  … ${items.length - shown.length} more`}</Text>}
    </Box>
  );
}

// ------------------------------------------------------------------ panels

const MARK: Record<string, string> = { done: "✔", now: "▶", wait: "◆", todo: "·", fail: "✗", stop: "■" };
const MARK_ROLE = { done: "ok", now: "accent", wait: "gate", todo: "faint", fail: "bad", stop: "faint" } as const;

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
  const curStep = t.current ? w.steps.find((x) => x.id === t.current?.replace(/__fix$/, "")) : undefined;
  const cur = t.phase && phases.includes(t.phase) ? t.phase : curStep?.phase ?? null;
  const at = cur ? phases.indexOf(cur) : -1;
  return phases.map((ph, i) => ({
    phase: ph,
    state: t.status === "done" ? "done" : i < at ? "done" : i === at ? (t.status === "waiting" ? "wait" : t.status === "failed" ? "fail" : t.status === "stopped" ? "stop" : "now") : "todo",
  }));
}

export function FlowPanel({ s, width, on }: { s: Snapshot; width: number; on?: PanelActs }) {
  const { color, paint } = useTheme();
  const t = s.flow?.thread;
  if (!t) return <PanelBox title="Flow"><Text color={color("dim")}>No flow on this project. /flow starts one.</Text></PanelBox>;
  const rail = railOf(s);
  const [done, all] = fmt.acCount(t);
  const gates = (s.flow?.workflow?.steps ?? []).filter((x) => x.kind === "gate");
  const cur = t.current?.replace(/__fix$/, "");
  const flowAct = on?.flow ?? (() => undefined);
  return (
    <Clickable act={flowAct}>
    <PanelBox title={<>{"Flow · "}<Text color={color("accent")}>{t.workflow_id}</Text>{` "${t.title}" · `}{fmt.badge(t.status, paint)}</>}>
      <Text wrap="wrap">{rail.map((r, i) => (
        <Text key={i} color={color(MARK_ROLE[r.state as keyof typeof MARK_ROLE])} bold={r.state === "now" || r.state === "wait"}>
          {`${MARK[r.state]} ${r.phase}`}{i < rail.length - 1 ? "  " : ""}
        </Text>))}
      </Text>
      <Text><Text color={color("dim")}>step  </Text><Text bold>{t.current || "-"}</Text>{t.ac ? <Text color={color("accent")}>{` · ${t.ac}`}</Text> : null}<Text color={color("dim")}>{` · phase ${t.phase || "none"}`}</Text></Text>
      {all > 0 && <Text><Text color={color("dim")}>AC    </Text>{t.acs.map((a, i) => (
        <Text key={i} color={a.status === "done" || a.status === "already-met" ? color("ok") : a.id === t.ac ? color("accent") : color("faint")}>
          {a.status === "done" || a.status === "already-met" ? "■" : a.id === t.ac ? "▶" : "□"}</Text>))}
        <Text color={done === all ? color("ok") : undefined}>{`  ${done}/${all}`}</Text></Text>}
      {gates.length > 0 && <Text wrap="truncate-end"><Text color={color("dim")}>gates </Text>{gates.slice(0, Math.max(3, Math.floor(width / 22))).map((g, i) => (
        <Text key={g.id} color={g.id === cur ? color("gate") : color("dim")} bold={g.id === cur}>{(i ? " · " : "") + (g.id === cur ? `◆ ${g.name}` : g.name)}</Text>))}</Text>}
      {t.waiting && <Clickable act={on?.waiting ?? (() => undefined)}><Text color={color("gate")} bold wrap="truncate-end">
        {`◆ waiting for you: ${t.waiting.title} · ${t.waiting.kind === "clarify" ? "/answer" : fmt.answerWords(t.waiting)}${on ? " · click to answer" : ""}`}</Text></Clickable>}
      {t.error && <Text color={color("bad")}>{t.error}</Text>}
    </PanelBox>
    </Clickable>
  );
}

export function AgentsPanel({ running, last, live, width, on }: { running: Job[]; last: Record<string, JobStep | undefined>; live?: Record<string, string>;
  width: number; on?: PanelActs }) {
  const { color, paint } = useTheme();
  return (
    <PanelBox title={<>{"Agents · "}<Text color={running.length ? color("accent") : color("dim")}>{`${running.length} at work`}</Text></>}>
      {running.length === 0 && <Text color={color("dim")}>No agent is running.</Text>}
      {running.slice(0, 6).map((j) => {
        const writing = live?.[j.id];
        return (
          <Clickable key={j.id} act={() => on?.agent(j.id)}>
            <Thinking who={j.agent} verb={pickVerb(j.id)} since={Date.parse(j.started_at) || null} tokens={fmt.tokensOf(j) || undefined}
              hint={[j.step, j.ac].filter(Boolean).join(" ")} />
            {writing ? <Text color={color("fg")} wrap="truncate-end">{"   ✎ " + writing.replace(/\s+/g, " ").slice(-(width - 8))}</Text>
              : last[j.id] && <Text wrap="truncate-end">{"   " + fmt.stepLine(last[j.id]!, width - 6, paint)}</Text>}
          </Clickable>
        );
      })}
    </PanelBox>
  );
}

export function InboxPanel({ s, on }: { s: Snapshot; on?: PanelActs }) {
  const { color } = useTheme();
  return (
    <PanelBox title={<>{"Inbox · "}<Text color={s.inbox.length ? color("gate") : color("dim")}>{`${s.inbox.length} waiting`}</Text></>}>
      {s.inbox.length === 0 && <Text color={color("dim")}>Nothing waits for you.</Text>}
      {s.inbox.slice(0, 6).map((i, k) => (
        <Clickable key={`${i.thread_id}-${k}`} act={() => on?.inbox(k + 1)}>
        <Text wrap="truncate-end">
          <Text color={color("gate")} bold>{`${k + 1}. `}</Text><Text color={color("dim")}>{`${i.project_name || i.project_id} · `}</Text>
          <Text color={color("gate")}>{`${i.kind}: ${i.title}`}</Text>
          <Text color={color("faint")}>{` · /approve ${k + 1} · /reject ${k + 1} <why>`}</Text>
        </Text>
        </Clickable>
      ))}
    </PanelBox>
  );
}

function PanelBox({ title, children }: { title: React.ReactNode; children: React.ReactNode }) {
  const { color } = useTheme();
  return (
    <Box flexDirection="column" borderStyle="single" borderColor={color("border")} paddingX={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

/** A plugin's panel (contributes.tui.panel): its call, read again every `every` seconds while it is on screen. */
export function PluginPanel({ plugin, panel, pid, width }: { plugin: string; panel: TuiPanel; pid: string; width: number }) {
  const { paint } = useTheme();
  const [text, setText] = useState("…");
  useEffect(() => {
    let alive = true;
    const read = () => void panelText(panel, pid, paint, width - 4).then((t) => alive && setText(t));
    read();
    const id = setInterval(read, Math.max(5, panel.every) * 1000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [panel, pid, paint, width]);
  return (
    <PanelBox title={<>{panel.title}{` · ${plugin}`}</>}>
      <Text wrap="truncate-end">{text}</Text>
    </PanelBox>
  );
}

/** One agent of a flow, followed (/agent <n>): what it is doing, its last steps and the text it writes now. Its steps
 *  are read again every 2 s; when it is finished the panel says so and stays until Esc or /panel off. */
export function JobPanel({ id, s, width }: { id: string; s: Snapshot; width: number }) {
  const { color, paint } = useTheme();
  const [steps, setSteps] = useState<JobStep[]>([]);
  const [running, setRunning] = useState(true);
  useEffect(() => {
    let alive = true;
    const read = () => void api.jobSteps(id).then((r) => {
      if (!alive) return;
      setSteps(r.steps);
      setRunning(r.running);
    }).catch(() => undefined);
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
    <PanelBox title={<>{"Agent · "}<Text color={color("accent")}>{j ? `${j.agent} · ${[j.step, j.ac].filter(Boolean).join(" ")}` : id.slice(0, 8)}</Text>
      <Text color={color("dim")}>{running ? "" : " · finished"}{" · Esc stops following"}</Text></>}>
      {running && j && <Thinking who={j.agent} verb={pickVerb(j.id)} since={Date.parse(j.started_at) || null} tokens={fmt.tokensOf(j) || undefined} />}
      {shown.length === 0 && <Text color={color("dim")}>no steps yet</Text>}
      {shown.map((x) => <Text key={x.n} wrap="truncate-end">{fmt.stepLine(x, width - 6, paint)}</Text>)}
      {writing ? <Text color={color("fg")} wrap="truncate-end">{"✎ " + writing.replace(/\s+/g, " ").slice(-(width - 8))}</Text> : null}
    </PanelBox>
  );
}

export function Panel({ name, s, width, on }: { name: PanelName; s: Snapshot; width: number; on?: PanelActs }) {
  if (name === "flow") return <FlowPanel s={s} width={width} on={on} />;
  if (name === "agents") return <AgentsPanel running={s.running} last={s.lastStep} live={s.liveText} width={width} on={on} />;
  return <InboxPanel s={s} on={on} />;
}

type Seg = { text: string; role: "fg" | "dim" | "accent" | "gate" | "ok" | "bad" | "faint"; bold?: boolean };

/** project · flow · phase · AC n/m · gates waiting · tokens · live, each with the role it is coloured with. */
export function statusSegments(s: Snapshot): Seg[] {
  const t = s.flow?.thread;
  const [done, all] = fmt.acCount(t);
  const here = s.project ? s.inbox.filter((i) => i.project_id === s.project!.id).length : 0;
  const flowRole: Seg["role"] = !t ? "dim" : t.status === "waiting" ? "gate" : t.status === "running" ? "accent" : t.status === "done" ? "ok"
    : t.status === "failed" ? "bad" : "faint";
  const segs: Seg[] = [
    { text: s.project ? `${s.project.id}${s.project.branch ? ` (${s.project.branch.length > 28 ? s.project.branch.slice(0, 27) + "…" : s.project.branch})` : ""}` : "no project", role: "fg", bold: true },
    { text: t ? `${t.workflow_id} ${t.status}` : "no flow", role: flowRole },
  ];
  if (t) segs.push({ text: `phase ${t.phase || "none"}`, role: "dim" });
  if (t && all) segs.push({ text: `AC ${done}/${all}`, role: done === all ? "ok" : "dim" });
  segs.push({ text: `${here} waiting${s.inbox.length > here ? ` (+${s.inbox.length - here})` : ""}`, role: s.inbox.length ? "gate" : "dim", bold: here > 0 });
  if (t) segs.push({ text: `${fmt.short(fmt.tokensOf(t.usage))} tokens`, role: "dim" });
  if (s.chat.mode === "fix") segs.push({ text: "KeelBot fix", role: "accent" });
  segs.push({ text: `● ${s.live}`, role: s.live === "live" ? "ok" : s.live === "closed" ? "faint" : "gate" });
  return segs;
}

/** The status line's words (tests, and front ends without colour). */
export const statusParts = (s: Snapshot) => statusSegments(s).map((x) => x.text.replace(/^● /, ""));

export function StatusLine({ s }: { s: Snapshot }) {
  const { color } = useTheme();
  const segs = statusSegments(s);
  return (
    <Text wrap="truncate-end">
      {" "}
      {segs.map((x, i) => (
        <Text key={i}>
          {i ? <Text color={color("faint")}>{" · "}</Text> : null}
          <Text color={color(x.role)} bold={x.bold}>{x.text}</Text>
        </Text>
      ))}
    </Text>
  );
}
