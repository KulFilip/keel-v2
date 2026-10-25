import * as vscode from "vscode";
import { KeelApi, KeelError, say } from "../api/client";
import type { EngineEvent, InboxItem, Project, RunRow } from "../api/models";
import { LiveStream } from "../api/sse";
import { isQuiet } from "../logic/activity";
import { matchProject, type ProjectMatch } from "../logic/paths";
import type { Auth } from "./auth";

/** Events that change what the trees and the status bar show (they reload, debounced). */
const RELOADS = [
  "inbox",
  "flow",
  "gate",
  "thread",
  "approval",
  "notify",
  "step",
];

/**
 * keel for this window: the connection, which keel project the workspace is, its flows and the questions waiting, and
 * the one live stream (SSE) of the window. Views listen to `onDidChange` (state) and `onEvent` (each engine event).
 */
export class KeelState implements vscode.Disposable {
  api: KeelApi | undefined;
  projects: Project[] = [];
  match: ProjectMatch | undefined;
  inbox: InboxItem[] = [];
  runs: RunRow[] = [];
  connected = false;
  error: KeelError | undefined;
  live = false;
  /** KeelBot's and the agents' text as it is written, by call id (the text so far). */
  readonly liveText = new Map<string, string>();

  private readonly changed = new vscode.EventEmitter<void>();
  readonly onDidChange = this.changed.event;
  private readonly events = new vscode.EventEmitter<EngineEvent>();
  readonly onEvent = this.events.event;
  private readonly questionEmitter = new vscode.EventEmitter<InboxItem>();
  /** A question of this project seen for the first time (the notification). */
  readonly onNewQuestion = this.questionEmitter.event;

  private stream: LiveStream | undefined;
  private streamKey: string | undefined;
  private pending: ReturnType<typeof setTimeout> | undefined;
  private poll: ReturnType<typeof setInterval> | undefined;
  private refreshing: Promise<void> | undefined;
  private again = false;
  private readonly told = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly auth: Auth,
    private readonly ctx: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      this.changed,
      this.events,
      this.questionEmitter,
      auth.onDidChange(() => this.reconnect()),
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (
          e.affectsConfiguration("keel.url") ||
          e.affectsConfiguration("keel.useLocalKeel2")
        )
          this.reconnect();
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => this.refresh()),
    );
    // keel down, or the stream down: look again now and then
    this.poll = setInterval(() => {
      if (!this.connected || !this.live) void this.refresh();
    }, 20_000);
  }

  get pid(): string | undefined {
    return this.match?.project.id;
  }

  get project(): Project | undefined {
    return this.match?.project;
  }

  /** The workspace folder keel's project is (the first folder when it was picked by hand). */
  get folder(): string | undefined {
    return (
      this.match?.folder ?? vscode.workspace.workspaceFolders?.[0]?.uri.fsPath
    );
  }

  /** This project's questions (every project's when this folder is not one of keel's). */
  get questions(): InboxItem[] {
    const p = this.pid;
    return p ? this.inbox.filter((i) => i.project_id === p) : this.inbox;
  }

  /** The flow that runs now, for the status bar. */
  get runningFlow(): RunRow | undefined {
    return this.runs.find((r) => r.status === "running");
  }

  private pickedKey(): string {
    return "keel.projectId";
  }

  async pick(projectId: string | undefined): Promise<void> {
    await this.ctx.workspaceState.update(this.pickedKey(), projectId);
    await this.refresh();
  }

  reconnect(): void {
    this.stopStream();
    this.api = undefined;
    void this.refresh();
  }

  /** Projects, the mapping, the inbox and the flows again; then everyone who listens. Calls in a row share one load. */
  refresh(): Promise<void> {
    if (this.refreshing) {
      this.again = true;
      return this.refreshing;
    }
    this.refreshing = this.load().finally(() => {
      this.refreshing = undefined;
      if (this.again) {
        this.again = false;
        void this.refresh();
      }
    });
    return this.refreshing;
  }

  private async load(): Promise<void> {
    try {
      const api = await this.ensure();
      const list = await api.projects();
      const folders = (vscode.workspace.workspaceFolders ?? []).map(
        (f) => f.uri.fsPath,
      );
      const m = matchProject(
        folders,
        list,
        this.ctx.workspaceState.get<string>(this.pickedKey()),
      );
      const [box, runs] = await Promise.all([
        api.inbox(),
        m ? api.runs(m.project.id) : Promise.resolve([] as RunRow[]),
      ]);
      this.projects = list;
      this.match = m;
      this.inbox = box.items ?? [];
      this.runs = runs;
      this.error = undefined;
      this.connected = true;
      this.follow(api, m?.project.id);
      this.tellNew();
    } catch (e) {
      this.error = e instanceof KeelError ? e : new KeelError(0, say(e));
      this.connected = false;
      if (this.error.status === 401 || this.error.status === 403) {
        this.api = undefined;
        this.stopStream();
      }
    }
    await this.setContexts();
    this.changed.fire();
  }

  /** The client, signed in (built again after a change of address or sign-in). */
  async ensure(): Promise<KeelApi> {
    if (this.api) return this.api;
    const token = await this.auth.token();
    if (!token)
      throw new KeelError(401, "keel is not connected.", "Run keel: Connect.");
    this.api = this.auth.api(token, () => void this.onRemoved());
    return this.api;
  }

  private async onRemoved(): Promise<void> {
    this.api = undefined;
    this.stopStream();
    await this.auth.removed();
  }

  /**
   * Calls keel and reports a failure as a notification (or through `quiet`). A refused sign-in also refreshes the
   * connection state.
   */
  async call<T>(
    work: (api: KeelApi, pid: string) => Promise<T>,
    quiet = false,
  ): Promise<T | undefined> {
    try {
      const api = await this.ensure();
      const pid = this.pid;
      if (!pid)
        throw new KeelError(
          0,
          "This folder is not one of keel's projects.",
          "Run keel: Pick project.",
        );
      return await work(api, pid);
    } catch (e) {
      if (e instanceof KeelError && e.deviceRemoved) void this.refresh();
      if (!quiet) vscode.window.showErrorMessage(`keel: ${say(e)}`);
      return undefined;
    }
  }

  private async setContexts(): Promise<void> {
    await vscode.commands.executeCommand(
      "setContext",
      "keel.connected",
      this.connected,
    );
    await vscode.commands.executeCommand(
      "setContext",
      "keel.hasProject",
      !!this.pid,
    );
  }

  // ---------------------------------------------------------------- the live stream (one per window)
  private follow(api: KeelApi, pid: string | undefined): void {
    const key = `${api.base}|${pid ?? "*"}`;
    if (this.stream?.isRunning && this.streamKey === key) return;
    this.stopStream();
    this.streamKey = key;
    this.stream = new LiveStream({
      url: () => api.eventsUrl(pid),
      headers: () => api.streamHeaders(),
      onEvent: (ev) => this.onStreamEvent(ev),
      onState: (c) => {
        const was = this.live;
        this.live = c;
        // each (re)connection: reload what the stream may have missed
        if (c && !was) {
          this.events.fire({ type: "connected" });
          this.refreshSoon();
        }
        this.changed.fire();
      },
      onRefused: () => void this.refresh(),
    });
    this.stream.start();
  }

  private stopStream(): void {
    this.stream?.stop();
    this.stream = undefined;
    this.streamKey = undefined;
    this.live = false;
  }

  private onStreamEvent(ev: EngineEvent): void {
    const call = ev.call_id ?? undefined;
    if ((ev.type === "helper.delta" || ev.type === "agent.delta") && call) {
      const t = ev.data && typeof ev.data.text === "string" ? ev.data.text : "";
      this.liveText.set(call, t);
      this.events.fire(ev);
      return;
    }
    if (ev.type === "helper.finished" && call) this.liveText.delete(call);
    if (ev.type.endsWith("thinking.delta")) return;
    if (!isQuiet(ev.type) && RELOADS.some((r) => ev.type.startsWith(r)))
      this.refreshSoon();
    this.events.fire(ev);
  }

  private refreshSoon(): void {
    if (this.pending) clearTimeout(this.pending);
    this.pending = setTimeout(() => {
      this.pending = undefined;
      void this.refresh();
    }, 400);
  }

  private tellNew(): void {
    const mine = this.pid;
    if (!mine) return;
    const now = this.inbox.filter((i) => i.project_id === mine);
    const fresh = now.filter((i) => {
      const k = keyOf(i);
      if (this.told.has(k)) return false;
      this.told.add(k);
      return true;
    });
    if (this.told.size > 300) {
      const keep = new Set(now.map(keyOf));
      for (const k of [...this.told]) if (!keep.has(k)) this.told.delete(k);
    }
    for (const q of fresh.slice(0, 3)) this.questionEmitter.fire(q);
  }

  dispose(): void {
    this.stopStream();
    if (this.pending) clearTimeout(this.pending);
    if (this.poll) clearInterval(this.poll);
    for (const d of this.disposables) d.dispose();
  }
}

export const keyOf = (i: InboxItem): string =>
  `${i.project_id}|${i.thread_id ?? ""}|${i.id ?? i.permission?.id ?? i.title ?? ""}`;
