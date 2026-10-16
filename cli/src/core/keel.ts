// keel TUI's core: one keel, one project, its flow, the inbox, the running agents, the live stream and the KeelBot chat.
// No UI here: a front end (keel TUI's Ink app, an xal plugin, OpenTUI) reads `snapshot`, listens with on(), and runs
// commands (commands.ts). Every request goes through the web's own typed client (web/src/api.ts).

import { api, type EngineEvent, type FlowView, type Health, type HelperMessage, type HelperMode, type HelperSession, type Job,
  type JobStep, type Model, type Project } from "./sdk";
import { inboxApi, type InboxItem } from "../../../web/src/inboxApi";
import { kb } from "../../../plugins/keelbot/web/keelbotApi";
import { connect, setCommand, viaHeaders } from "./transport";
import { subscribe, type LiveState, type SseMessage, type Subscription } from "./sse";
import { notice } from "./notices";

export type ChatState = {
  session: HelperSession | null;
  mode: HelperMode;
  model: Model | null;
  busy: boolean;
  /** the running turn's agent call, and its live steps */
  callId: string | null;
  steps: JobStep[];
  /** the text KeelBot is writing now (helper.delta: the current block so far; "" once that block is a whole step) */
  stream: string;
  /** when the running turn started (ms), and how much text it wrote so far (for "~N tokens") */
  startedAt: number | null;
  wrote: number;
};

export type Snapshot = {
  url: string;
  /** the dashboard as the person's browser sees it */
  publicUrl: string;
  health: Health | null;
  error: string | null;
  projects: Project[];
  project: Project | null;
  flow: FlowView | null;
  /** step ids that ran in the flow (its checkpoints): which arm an if / else took */
  visited: string[];
  inbox: InboxItem[];
  running: Job[];
  lastStep: Record<string, JobStep | undefined>;
  /** what each running agent is writing now (agent.delta), by call id */
  liveText: Record<string, string>;
  live: LiveState;
  chat: ChatState;
};

export type CoreEvents = {
  change: (s: Snapshot) => void;
  notice: (text: string, ev: EngineEvent) => void;
  /** a KeelBot turn ended: its answer (markdown) or why not */
  answer: (m: { text: string; ok: boolean; message?: HelperMessage }) => void;
};

export type CoreOptions = {
  url: string;
  publicUrl?: string;
  /** a project id or name; otherwise the one whose folder holds `cwd`, otherwise the first */
  project?: string;
  cwd?: string;
  fetch?: typeof fetch;
  /** no SSE stream (tests, one-shot commands) */
  noLive?: boolean;
};

const STEP_KEEP = 200;

export class KeelCore {
  snapshot: Snapshot;
  private listeners: { [K in keyof CoreEvents]: Set<CoreEvents[K]> } = { change: new Set(), notice: new Set(), answer: new Set() };
  private sub: Subscription | null = null;
  private subPid: string | null | undefined = undefined;
  private refreshTimer: ReturnType<typeof setTimeout> | null = null;
  private pollTimer: ReturnType<typeof setInterval> | null = null;
  private readonly f: typeof fetch;

  constructor(private opts: CoreOptions) {
    this.f = opts.fetch ?? fetch;
    const url = connect(opts.url, this.f);
    this.snapshot = {
      url, publicUrl: (opts.publicUrl || url).replace(/\/+$/, ""), health: null, error: null, projects: [], project: null, flow: null,
      visited: [], inbox: [], running: [], lastStep: {}, liveText: {}, live: opts.noLive ? "closed" : "connecting",
      chat: { session: null, mode: "ask", model: null, busy: false, callId: null, steps: [], stream: "", startedAt: null, wrote: 0 },
    };
  }

  on<K extends keyof CoreEvents>(k: K, fn: CoreEvents[K]): () => void {
    (this.listeners[k] as Set<CoreEvents[K]>).add(fn);
    return () => (this.listeners[k] as Set<CoreEvents[K]>).delete(fn);
  }

  private emit<K extends keyof CoreEvents>(k: K, ...args: Parameters<CoreEvents[K]>) {
    (this.listeners[k] as Set<(...a: unknown[]) => void>).forEach((fn) => fn(...args));
  }

  private set(patch: Partial<Snapshot>) {
    this.snapshot = { ...this.snapshot, ...patch };
    this.emit("change", this.snapshot);
  }

  private setChat(patch: Partial<ChatState>) {
    this.set({ chat: { ...this.snapshot.chat, ...patch } });
  }

  get pid(): string | null {
    return this.snapshot.project?.id ?? null;
  }

  /** The first load: health, projects, the project to work on, then everything else; and the live stream. */
  async start(): Promise<Snapshot> {
    try {
      const health = await api.health();
      this.set({ health, error: null });
    } catch (e) {
      this.set({ health: null, error: e instanceof Error ? e.message : String(e) });
      return this.snapshot;
    }
    await this.loadProjects();
    await this.refresh();
    this.follow();
    return this.snapshot;
  }

  stop() {
    this.sub?.close();
    this.sub = null;
    if (this.refreshTimer) clearTimeout(this.refreshTimer);
    if (this.pollTimer) clearInterval(this.pollTimer);
  }

  async loadProjects() {
    const projects = await api.projects();
    const cur = this.snapshot.project;
    const want = this.opts.project;
    let project: Project | null = null;
    if (cur) project = projects.find((p) => p.id === cur.id) ?? null;
    if (!project && want) project = projects.find((p) => p.id === want || p.name === want) ?? null;
    if (!project && this.opts.cwd) {
      const cwd = this.opts.cwd.replace(/\/+$/, "");
      const inside = projects.filter((p) => p.root && (cwd === p.root || cwd.startsWith(p.root.replace(/\/+$/, "") + "/")));
      project = inside.sort((a, b) => b.root.length - a.root.length)[0] ?? null;
    }
    this.set({ projects, project: project ?? projects[0] ?? null });
  }

  /** Switch to another project (id or name); false when keel has none by that name. */
  async useProject(name: string): Promise<boolean> {
    const projects = this.snapshot.projects.length ? this.snapshot.projects : await api.projects();
    const p = projects.find((x) => x.id === name || x.name === name);
    if (!p) return false;
    this.set({ project: p, flow: null, visited: [], chat: { ...this.snapshot.chat, session: null, callId: null, steps: [], busy: false } });
    await this.refresh();
    this.follow();
    return true;
  }

  /** The project's flow, its checkpoints, the inbox, the running agents. */
  async refresh(): Promise<Snapshot> {
    const pid = this.pid;
    const [flow, inbox, running, projects] = await Promise.all([
      pid ? api.flow(pid).catch(() => null) : Promise.resolve(null),
      inboxApi.list().then((v) => v.items).catch(() => [] as InboxItem[]),
      api.jobs({ status: "running", limit: 50 }).catch(() => [] as Job[]),
      api.projects().catch(() => this.snapshot.projects),
    ]);
    let visited: string[] = [];
    if (flow?.thread) {
      const hist = await api.history(flow.thread.thread_id).catch(() => []);
      visited = hist.map((c) => c.step);
    }
    const project = pid ? projects.find((p) => p.id === pid) ?? this.snapshot.project : this.snapshot.project;
    const lastStep = { ...this.snapshot.lastStep };
    for (const k of Object.keys(lastStep)) if (!running.some((j) => j.id === k)) delete lastStep[k];
    const liveText = { ...this.snapshot.liveText };
    for (const k of Object.keys(liveText)) if (!running.some((j) => j.id === k)) delete liveText[k];
    this.set({ flow, inbox, running, projects, project, visited, lastStep, liveText });
    return this.snapshot;
  }

  /** Refresh soon (many events arrive together: one refresh for them, like the web's bump). */
  bump(ms = 300) {
    if (this.refreshTimer) return;
    this.refreshTimer = setTimeout(() => {
      this.refreshTimer = null;
      void this.refresh().catch(() => undefined);
    }, ms);
  }

  // ------------------------------------------------------------------ the live stream

  /** One stream: this project's events plus the notifications of every project (as the web's one stream per tab). */
  follow() {
    if (this.opts.noLive) return;
    if (this.sub && this.subPid === this.pid) return;
    this.sub?.close();
    this.subPid = this.pid;
    const url = api.eventsUrl(this.pid, true);      // the transport puts keel's address in front
    this.sub = subscribe(url, (m) => this.onMessage(m), {
      fetch: this.f, headers: viaHeaders, onState: (s) => { if (s !== "closed") this.set({ live: s }); },
    });
  }

  /** One message of the stream (public for tests and other front ends that bring their own stream). */
  onMessage(m: SseMessage) {
    if (m.event === "notification" || m.event === "notification.done" || m.event === "project.changed") {
      if (m.event === "project.changed") void this.loadProjects().catch(() => undefined);
      this.bump();
      return;
    }
    let ev: EngineEvent;
    try {
      ev = JSON.parse(m.data) as EngineEvent;
    } catch {
      return;
    }
    if (!ev || typeof ev.type !== "string") return;
    const chat = this.snapshot.chat;
    // live text: KeelBot's answer, or an agent's, as it is written (never a notice, never a refresh)
    if ((ev.type === "helper.delta" || ev.type === "agent.delta") && ev.call_id) {
      const text = String((ev.data as { text?: unknown }).text ?? "");
      if (ev.type === "agent.delta") this.set({ liveText: { ...this.snapshot.liveText, [ev.call_id]: text } });
      else if (ev.call_id === chat.callId && chat.busy) {
        const grew = Math.max(0, text.length - chat.stream.length);
        this.setChat({ stream: text, wrote: chat.wrote + grew });
      }
      return;
    }
    if ((ev.type === "helper.step" || ev.type === "agent.step") && ev.call_id) {
      const d = ev.data as Partial<JobStep>;
      const step: JobStep = { n: Number(d.n) || 0, at: ev.at, kind: String(d.kind ?? "text"), text: String(d.text ?? ""),
        tool: d.tool, server: d.server, path: d.path, ms: d.ms, ok: d.ok };
      if (ev.type === "agent.step") this.set({ lastStep: { ...this.snapshot.lastStep, [ev.call_id]: step } });
      if (ev.type === "agent.step" && (step.kind === "text" || step.kind === "answer") && ev.call_id in this.snapshot.liveText) {
        const { [ev.call_id]: _done, ...rest } = this.snapshot.liveText;
        this.set({ liveText: rest });
      }
      if (ev.call_id === chat.callId && !chat.steps.some((x) => x.n === step.n)) {
        // a whole message arrived: the streamed block is in it now
        const whole = step.kind === "text" || step.kind === "answer";
        this.setChat({ steps: [...chat.steps, step].slice(-STEP_KEEP), ...(whole ? { stream: "" } : {}),
          wrote: chat.wrote + (whole && !chat.stream ? step.text.length : 0) });
      }
      return;
    }
    if (ev.type === "helper.finished" && chat.session && ev.thread_id === chat.session.id && chat.busy) {
      void this.finishTurn();
      return;
    }
    if (ev.type.startsWith("helper.") && ev.type !== "helper.permission") return;
    if (ev.type === "tui.call") return;                     // the TUI's own writes: the person saw them already
    if (ev.project_id && this.pid && ev.project_id !== this.pid) return;
    const text = notice(ev);
    if (text) this.emit("notice", text, ev);
    this.bump();
  }

  // ------------------------------------------------------------------ KeelBot

  setChatMode(mode: HelperMode) {
    this.setChat({ mode, session: null, callId: null, steps: [] });
  }

  async setChatModel(model: Model) {
    const pid = this.pid;
    const s = this.snapshot.chat.session;
    if (pid && s) {
      const next = await kb.patch(pid, s.id, { model });
      this.setChat({ model, session: next });
    } else this.setChat({ model });
  }

  /** Earlier chats of this project, newest first. */
  async chats(): Promise<HelperSession[]> {
    if (!this.pid) return [];
    const all = await kb.sessions(this.pid);
    return [...all].sort((a, b) => (a.updated_at < b.updated_at ? 1 : a.updated_at > b.updated_at ? -1 : 0));
  }

  /** Open an earlier chat: its messages come back with it. */
  async openChat(sid: string): Promise<HelperSession> {
    if (!this.pid) throw new Error("no project");
    const s = await kb.session(this.pid, sid);
    this.setChat({ session: s, mode: s.mode, model: s.model, callId: null, steps: [], busy: !!s.busy });
    return s;
  }

  newChat() {
    this.setChat({ session: null, callId: null, steps: [], busy: false });
  }

  /** Ask KeelBot: the answer streams as `chat.steps`, and arrives with the "answer" event. */
  async send(text: string): Promise<HelperSession> {
    const pid = this.pid;
    if (!pid) throw new Error("no project: /project picks one");
    setCommand("KeelBot");                                   // the timeline: "via keel TUI · KeelBot"
    try {
      return await this.sendTurn(pid, text);
    } finally {
      setCommand("");
    }
  }

  private async sendTurn(pid: string, text: string): Promise<HelperSession> {
    let s = this.snapshot.chat.session;
    if (!s) {
      const { mode, model } = this.snapshot.chat;
      s = await kb.create(pid, { mode, ...(model ? { model } : {}), title: text.slice(0, 60) });
      this.setChat({ session: s });
    }
    const t = await kb.turn(pid, s.id, { text, ...(this.snapshot.chat.model ? { model: this.snapshot.chat.model } : {}) });
    this.setChat({ busy: true, callId: t.call_id, steps: [], stream: "", startedAt: Date.now(), wrote: 0 });
    // a missed helper.finished never leaves the chat "working": look every 3 s
    if (this.pollTimer) clearInterval(this.pollTimer);
    this.pollTimer = setInterval(() => void this.pollTurn(), 3000);
    return s;
  }

  private async pollTurn() {
    const { session, busy } = this.snapshot.chat;
    if (!busy || !session || !this.pid) return;
    try {
      const s = await kb.session(this.pid, session.id);
      if (!s.busy && s.status !== "running") await this.finishTurn(s);
    } catch {
      /* try again next time */
    }
  }

  private finishing = false;

  private async finishTurn(loaded?: HelperSession) {
    if (this.finishing || !this.snapshot.chat.busy) return;
    this.finishing = true;
    try {
      if (this.pollTimer) clearInterval(this.pollTimer);
      this.pollTimer = null;
      const sid = this.snapshot.chat.session?.id;
      if (!sid || !this.pid) return;
      // the answer is stored a moment after helper.finished: wait for a message after the person's
      let s = loaded ?? (await kb.session(this.pid, sid));
      for (let i = 0; i < 10 && lastIsUser(s); i++) {
        await new Promise((r) => setTimeout(r, 300));
        s = await kb.session(this.pid, sid);
      }
      const msgs = s.messages ?? [];
      const last = msgs[msgs.length - 1];
      this.setChat({ session: s, busy: false, callId: null, stream: "", startedAt: null });
      if (last && last.role !== "user") this.emit("answer", { text: last.text, ok: last.role === "helper", message: last });
      else this.emit("answer", { text: s.error || "KeelBot did not answer.", ok: false });
    } finally {
      this.finishing = false;
    }
  }

  async stopChat() {
    const s = this.snapshot.chat.session;
    if (this.pid && s) await kb.stop(this.pid, s.id).catch(() => undefined);
  }

  /** KeelBot's own slash commands (/gate, /where, /explain …): typed in the TUI, they go to KeelBot as they are. */
  async keelbotCommands(): Promise<{ name: string; description: string }[]> {
    if (!this.pid) return [];
    return kb.commands(this.pid).catch(() => []);
  }
}

const lastIsUser = (s: HelperSession) => {
  const m = s.messages ?? [];
  return !m.length || m[m.length - 1].role === "user";
};
