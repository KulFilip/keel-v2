// The stream's messages into keel TUI's core: what each engine event does to the snapshot and the KeelBot chat (the live
// text, the steps and tool calls, the running agents, the permission questions, notices). KeelCore (keel.ts) reads the
// stream and hands each message here; this file reaches back only through `StreamHost`.

import type { EngineEvent, HelperSession, JobStep } from "./sdk";
import { kb } from "../../../plugins/keelbot/web/keelbotApi";
import type { SseMessage } from "./sse";
import { notice } from "./notices";
import type { Profiler } from "./profile";
import { toolFromEvent, toolFromStep, upsertTool } from "./tools";
import type { ChatState, CoreEvents, Focus, Snapshot } from "./keel";

/** The steps of a KeelBot turn kept in the chat state. */
export const STEP_KEEP = 200;

/** What the stream's handler needs of KeelCore (getters read the live value each time). */
export type StreamHost = {
  readonly client: string;
  readonly pid: string | null;
  readonly snapshot: Snapshot;
  readonly sending: boolean;
  readonly profiler?: Profiler;
  followFocus(f: Focus): Promise<void>;
  loadProjects(): Promise<unknown>;
  bump(): void;
  set(patch: Partial<Snapshot>): void;
  setChat(patch: Partial<ChatState>): void;
  emit<K extends keyof CoreEvents>(k: K, ...args: Parameters<CoreEvents[K]>): void;
  dropRunning(callId: string): void;
  /** KeelBot's turn polled every few seconds (a turn started from the dashboard) */
  startPolling(): void;
  finishTurn(loaded?: HelperSession): Promise<void>;
};

/** One message of the stream. */
export function handleMessage(h: StreamHost, m: SseMessage) {
  if (m.event === "ui.focus") {
    try {
      const f = JSON.parse(m.data) as Focus;
      if (f && f.client !== h.client) void h.followFocus(f);
    } catch {
      /* not ours to read */
    }
    return;
  }
  if (m.event === "notification" || m.event === "notification.done" || m.event === "project.changed") {
    if (m.event === "project.changed") void h.loadProjects().catch(() => undefined);
    h.bump();
    return;
  }
  let ev: EngineEvent;
  try {
    ev = JSON.parse(m.data) as EngineEvent;
  } catch {
    return;
  }
  if (!ev || typeof ev.type !== "string") return;
  h.profiler?.event(ev.at);
  const chat = h.snapshot.chat;
  // live text: KeelBot's answer, or an agent's, as it is written (never a notice, never a refresh)
  // 0.18.23 KeelBot's thinking as the model writes it: shown apart from the answer, never stored here
  if (ev.type === "helper.thinking.delta" && ev.call_id) {
    if (ev.call_id === chat.callId && chat.busy) h.setChat({ thinking: String((ev.data as { text?: unknown }).text ?? ""), thoughtAt: Date.now() });
    return;
  }
  // KeelBot's tool calls, one record each (keel TUI's tool lines): the richer record of a step that came before it
  if (ev.type === "helper.tool" && ev.call_id) {
    const t = ev.call_id === chat.callId && chat.busy ? toolFromEvent((ev.data ?? {}) as Record<string, unknown>) : null;
    if (t) h.setChat({ tools: upsertTool(chat.tools, t) });
    return;
  }
  if ((ev.type === "helper.delta" || ev.type === "agent.delta") && ev.call_id) {
    const text = String((ev.data as { text?: unknown }).text ?? "");
    if (ev.type === "agent.delta") h.set({ liveText: { ...h.snapshot.liveText, [ev.call_id]: text } });
    else if (ev.call_id === chat.callId && chat.busy) {
      const grew = Math.max(0, text.length - chat.stream.length);
      h.setChat({ stream: text, wrote: chat.wrote + grew });
    }
    return;
  }
  if ((ev.type === "helper.step" || ev.type === "agent.step" || ev.type === "code.step") && ev.call_id) {
    const d = ev.data as Partial<JobStep>;
    const step: JobStep = { n: Number(d.n) || 0, at: ev.at, kind: String(d.kind ?? "text"), text: String(d.text ?? ""),
      tool: d.tool, server: d.server, path: d.path, ms: d.ms, ok: d.ok, ...(d.diff ? { diff: d.diff } : {}) };
    if (ev.type === "agent.step" || ev.type === "code.step") h.set({ lastStep: { ...h.snapshot.lastStep, [ev.call_id]: step } });
    if (ev.type === "agent.step" && (step.kind === "text" || step.kind === "answer") && ev.call_id in h.snapshot.liveText) {
      const { [ev.call_id]: _done, ...rest } = h.snapshot.liveText;
      h.set({ liveText: rest });
    }
    if (!chat.callId && chat.busy && ev.type === "helper.step" && chat.session && ev.thread_id === chat.session.id) {
      h.setChat({ callId: ev.call_id });
      chat.callId = ev.call_id;
    }
    if (ev.call_id === chat.callId && !chat.steps.some((x) => x.n === step.n)) {
      // a whole message arrived: the streamed block is in it now
      const whole = step.kind === "text" || step.kind === "answer";
      const tool = ev.type === "helper.step" && !chat.tools.some((x) => x.n === step.n) ? toolFromStep({ ...step, ...(d.output ? { output: String(d.output) } : {}) }) : null;
      h.setChat({ steps: [...chat.steps, step].slice(-STEP_KEEP), ...(whole ? { stream: "" } : {}), ...(tool ? { tools: upsertTool(chat.tools, tool) } : {}),
        wrote: chat.wrote + (whole && !chat.stream ? step.text.length : 0) });
    }
    // 0.18.15 a code step's commands (the ladder's rungs, a suite) show as lines too: keel is not silent while they run
    if (ev.type === "code.step" && !(ev.project_id && h.pid && ev.project_id !== h.pid)) {
      const text = notice(ev);
      if (text) h.emit("notice", text, ev);
    }
    return;
  }
  // KeelBot's calls are among keel's running agents too: a finished one leaves the list at once, and the list is read
  // again (helper events never reach the refresh at the end)
  if (ev.type === "helper.started" || ev.type === "helper.finished") {
    if (ev.type === "helper.finished" && ev.call_id) h.dropRunning(ev.call_id);
    h.bump();
  }
  // 0.18.6 the person asked in this chat from the dashboard: their words, then KeelBot's answer as it is written
  if (ev.type === "helper.started" && chat.session && ev.thread_id === chat.session.id && !chat.busy && !h.sending && ev.call_id) {
    h.setChat({ busy: true, callId: ev.call_id, steps: [], tools: [], stream: "", startedAt: Date.now(), wrote: 0, thinking: "", thoughtAt: null });
    const pid = h.pid;
    void (pid ? kb.session(pid, chat.session.id) : Promise.reject(new Error("no project"))).then((s) => {
      const last = [...(s.messages ?? [])].reverse().find((x) => x.role === "user");
      if (last) h.emit("remote", last.text, "the dashboard");
    }).catch(() => undefined);
    h.startPolling();
    return;
  }
  if (ev.type === "helper.finished" && chat.session && ev.thread_id === chat.session.id && chat.busy) {
    void h.finishTurn();
    return;
  }
  // KeelBot asks the person's OK for a command: a yes/no in the TUI (the dashboard shows the same card)
  if (ev.type === "helper.permission" && (!h.pid || ev.project_id === h.pid)) {
    const q = ev.data as { id?: string; command?: string; title?: string; path?: string | null; warning?: string; always?: string };
    if (q.id) h.emit("question", { id: q.id, command: String(q.command ?? ""), title: String(q.title ?? "KeelBot asks to run a command"), path: q.path,
      ...(q.warning ? { warning: String(q.warning) } : {}), ...(q.always !== undefined ? { always: String(q.always ?? "") } : {}) });
  }
  // keel 0.18.18 answered in the dashboard, or closed when KeelBot's turn ended: the card here goes too
  if (ev.type === "helper.permission.answered") {
    const id = (ev.data as { id?: string }).id;
    if (id) h.emit("questionGone", String(id));
  }
  if (ev.type.startsWith("helper.") && ev.type !== "helper.permission") return;
  if (ev.type === "tui.call") return;                     // the TUI's own writes: the person saw them already
  if (ev.project_id && h.pid && ev.project_id !== h.pid) return;
  const text = notice(ev);
  if (text) h.emit("notice", text, ev);
  h.bump();

}
