// keel TUI's pieces: the start screen, the transcript's blocks, the picker, the panels and the status line. Each is a
// plain function of its props; App.tsx holds the state.

import React from "react";
import { Box, Text } from "ink";
import type { Job, JobStep } from "../core/sdk";
import type { Block, Choice, Completion, PanelName } from "../core/commands";
import type { Snapshot } from "../core/keel";
import { LOGO } from "../core/logo";
import { renderMarkdown } from "../core/markdown";
import * as fmt from "../core/format";
import { VERSION } from "../core/version";

export const ACCENT = "#e8a33d";

export function StartScreen({ s, width }: { s: Snapshot; width?: number }) {
  const p = s.project;
  const t = s.flow?.thread ?? null;
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Box borderStyle="round" borderColor={ACCENT} flexDirection="column" paddingX={1} width={width}>
        {LOGO.map((l, i) => <Text key={i} color={ACCENT}>{l}</Text>)}
        <Text> </Text>
        <Text><Text bold>keel v2 {s.health?.version ?? VERSION}</Text><Text dimColor> · keel TUI {VERSION}</Text></Text>
        <Text><Text dimColor>keel     </Text>{fmt.which(s.publicUrl, s.health)}</Text>
        {s.error
          ? <Text color="red">{`keel is not reachable: ${s.error}\nStart it: keel2 start (or pass --url).`}</Text>
          : <>
            <Text><Text dimColor>project  </Text>{p ? `${p.name || p.id} · branch ${p.branch || "-"}` : "none yet: add one in the dashboard"}</Text>
            {t && <Text><Text dimColor>flow     </Text>{`${t.workflow_id} "${t.title}" · ${t.status}${t.current ? ` at ${t.current}` : ""}`}</Text>}
            <Text><Text dimColor>waiting  </Text><Text color={s.inbox.length ? "yellow" : undefined}>{fmt.waitingBrief(s.inbox, p)}</Text></Text>
            <Text><Text dimColor>next     </Text>{fmt.next(p, s.flow).split("\n")[0]}</Text>
          </>}
      </Box>
      <Text dimColor wrap="truncate-end">  Ask KeelBot anything · /help · /flow starts a flow · Ctrl+F flow · Ctrl+A agents · Ctrl+B inbox</Text>
    </Box>
  );
}

export function BlockView({ b }: { b: Block }) {
  switch (b.kind) {
    case "markdown": return <Box marginLeft={2}><Text>{renderMarkdown(b.text)}</Text></Box>;
    case "diagram": return <Box marginLeft={1}><Text>{b.text}</Text></Box>;
    case "error": return <Text color="red">{"✗ " + b.text}</Text>;
    case "ok": return <Text color="green">{"✓ " + b.text}</Text>;
    case "notice": return <Text color="yellow">{"◆ " + b.text}</Text>;
    case "user": return <Text bold>{"› " + b.text}</Text>;
    case "dim": return <Text dimColor>{b.text}</Text>;
    default: return <Text>{b.text}</Text>;
  }
}

export function Picker({ title, choices, index, filter }: { title: string; choices: Choice[]; index: number; filter: string }) {
  const max = 10;
  const start = Math.max(0, Math.min(index - Math.floor(max / 2), choices.length - max));
  const shown = choices.slice(start, start + max);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={ACCENT} paddingX={1}>
      <Text bold>{title}</Text>
      {filter && <Text dimColor>{`filter: ${filter}`}</Text>}
      {shown.length === 0 && <Text dimColor>nothing matches</Text>}
      {shown.map((c, k) => {
        const on = start + k === index;
        return (
          <Text key={c.value} color={on ? ACCENT : undefined}>
            {on ? "❯ " : "  "}{c.label}{c.hint ? <Text dimColor>{"  " + c.hint}</Text> : null}
          </Text>
        );
      })}
      <Text dimColor>↑/↓ choose · Enter picks · type to filter · Esc cancels</Text>
    </Box>
  );
}

export function Completions({ items, index }: { items: Completion[]; index: number }) {
  const shown = items.slice(0, 8);
  return (
    <Box flexDirection="column" marginLeft={2}>
      {shown.map((c, k) => (
        <Text key={c.value} color={k === index ? ACCENT : undefined}>
          {(k === index ? "❯ " : "  ") + c.label.padEnd(26)}<Text dimColor>{c.hint ?? ""}</Text>
        </Text>
      ))}
      {items.length > shown.length && <Text dimColor>{`  … ${items.length - shown.length} more`}</Text>}
    </Box>
  );
}

// ------------------------------------------------------------------ panels

const MARK: Record<string, string> = { done: "✔", now: "▶", wait: "◆", todo: "·", fail: "✗", stop: "■" };

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

export function FlowPanel({ s, width }: { s: Snapshot; width: number }) {
  const t = s.flow?.thread;
  if (!t) return <PanelBox title="Flow"><Text dimColor>No flow on this project. /flow starts one.</Text></PanelBox>;
  const rail = railOf(s);
  const [done, all] = fmt.acCount(t);
  const gates = (s.flow?.workflow?.steps ?? []).filter((x) => x.kind === "gate");
  const cur = t.current?.replace(/__fix$/, "");
  const parts = rail.map((r) => `${MARK[r.state]} ${r.phase}`);
  return (
    <PanelBox title={`Flow · ${t.workflow_id} "${t.title}" · ${t.status}`}>
      <Text wrap="wrap">{parts.map((p, i) => <Text key={i} color={rail[i].state === "wait" ? "yellow" : rail[i].state === "now" ? ACCENT : rail[i].state === "done" ? "green" : rail[i].state === "fail" ? "red" : undefined} dimColor={rail[i].state === "todo"}>{p}{i < parts.length - 1 ? "  " : ""}</Text>)}</Text>
      <Text><Text dimColor>step  </Text>{t.current || "-"}{t.ac ? ` · ${t.ac}` : ""}<Text dimColor>{` · phase ${t.phase || "none"}`}</Text></Text>
      {all > 0 && <Text><Text dimColor>AC    </Text>{t.acs.map((a) => (a.status === "done" || a.status === "already-met" ? "■" : a.id === t.ac ? "▶" : "□")).join("")}{`  ${done}/${all}`}</Text>}
      {gates.length > 0 && <Text wrap="truncate-end"><Text dimColor>gates </Text>{gates.slice(0, Math.max(3, Math.floor(width / 22))).map((g) => (g.id === cur ? `◆ ${g.name}` : g.name)).join(" · ")}</Text>}
      {t.waiting && <Text color="yellow" wrap="truncate-end">{`◆ waiting for you: ${t.waiting.title} · ${t.waiting.kind === "clarify" ? "/answer" : fmt.answerWords(t.waiting)}`}</Text>}
      {t.error && <Text color="red">{t.error}</Text>}
    </PanelBox>
  );
}

export function AgentsPanel({ running, last, width }: { running: Job[]; last: Record<string, JobStep | undefined>; width: number }) {
  return (
    <PanelBox title={`Agents · ${running.length} at work`}>
      {running.length === 0 && <Text dimColor>No agent is running.</Text>}
      {running.slice(0, 6).map((j) => (
        <Box key={j.id} flexDirection="column">
          <Text><Text color={ACCENT}>{"▶ " + j.agent}</Text>{` · ${[j.step, j.ac].filter(Boolean).join(" ")} · ${j.provider}/${j.model} · ${fmt.short(fmt.tokensOf(j))} tokens`}</Text>
          {last[j.id] && <Text dimColor wrap="truncate-end">{"   " + fmt.stepLine(last[j.id]!, width - 6)}</Text>}
        </Box>
      ))}
    </PanelBox>
  );
}

export function InboxPanel({ s }: { s: Snapshot }) {
  return (
    <PanelBox title={`Inbox · ${s.inbox.length} waiting`}>
      {s.inbox.length === 0 && <Text dimColor>Nothing waits for you.</Text>}
      {s.inbox.slice(0, 6).map((i, k) => (
        <Text key={`${i.thread_id}-${k}`} wrap="truncate-end">
          <Text color="yellow">{`${k + 1}. `}</Text>{`${i.project_name || i.project_id} · ${i.kind}: ${i.title}`}<Text dimColor>{` · /approve ${k + 1} · /reject ${k + 1} <why>`}</Text>
        </Text>
      ))}
    </PanelBox>
  );
}

function PanelBox({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <Box flexDirection="column" borderStyle="single" borderColor="gray" paddingX={1}>
      <Text bold>{title}</Text>
      {children}
    </Box>
  );
}

export function Panel({ name, s, width }: { name: PanelName; s: Snapshot; width: number }) {
  if (name === "flow") return <FlowPanel s={s} width={width} />;
  if (name === "agents") return <AgentsPanel running={s.running} last={s.lastStep} width={width} />;
  return <InboxPanel s={s} />;
}

/** project · flow · phase · AC n/m · gates waiting · tokens · live */
export function statusParts(s: Snapshot): string[] {
  const t = s.flow?.thread;
  const [done, all] = fmt.acCount(t);
  const here = s.project ? s.inbox.filter((i) => i.project_id === s.project!.id).length : 0;
  return [
    s.project ? `${s.project.id}${s.project.branch ? ` (${s.project.branch.length > 28 ? s.project.branch.slice(0, 27) + "…" : s.project.branch})` : ""}` : "no project",
    t ? `${t.workflow_id} ${t.status}` : "no flow",
    t ? `phase ${t.phase || "none"}` : "",
    t && all ? `AC ${done}/${all}` : "",
    `${here} waiting${s.inbox.length > here ? ` (+${s.inbox.length - here})` : ""}`,
    t ? `${fmt.short(fmt.tokensOf(t.usage))} tokens` : "",
    s.chat.mode === "fix" ? "KeelBot fix" : "",
    s.live,
  ].filter(Boolean);
}

export function StatusLine({ s }: { s: Snapshot }) {
  const parts = statusParts(s);
  const live = parts[parts.length - 1];
  return (
    <Text wrap="truncate-end">
      <Text dimColor>{parts.slice(0, -1).join(" · ")}</Text>
      <Text color={live === "live" ? "green" : live === "closed" ? "gray" : "yellow"}>{` · ● ${live}`}</Text>
    </Text>
  );
}
