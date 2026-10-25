import { existsSync } from "node:fs";
import * as path from "node:path";
import * as vscode from "vscode";
import { KeelError, say } from "../api/client";
import type { EngineEvent, FlowView, ThreadState } from "../api/models";
import type { KeelState } from "../core/state";
import { openPath } from "../core/files";
import {
  activityOf,
  activityOfStep,
  FlowLive,
  type ActivityLine,
} from "../logic/activity";
import { ktokens, usd } from "../logic/format";
import { flowVm, lineVm } from "../logic/flowVm";
import { buildAnswer, gateButtons } from "../logic/gate";
import type { FromFlow, ToFlow } from "./protocol";
import { webviewHtml } from "./html";

const MAX_LINES = 500;

/**
 * One flow in an editor tab: its steps, criteria, the question it waits at (answered with exactly the offered
 * choices), Stop, and its live activity: the agents running now and a feed of their reads, edits, commands, tests,
 * guard refusals and gates, fed by the window's one live stream.
 */
export class FlowPanel implements vscode.Disposable {
  private static readonly open = new Map<string, FlowPanel>();

  static show(
    state: KeelState,
    extensionUri: vscode.Uri,
    threadId: string,
    focusGate = false,
  ): FlowPanel {
    const have = FlowPanel.open.get(threadId);
    if (have) {
      have.panel.reveal(have.panel.viewColumn);
      if (focusGate) have.post({ type: "focusGate" });
      void have.load();
      return have;
    }
    const p = new FlowPanel(state, extensionUri, threadId, focusGate);
    FlowPanel.open.set(threadId, p);
    return p;
  }

  /** For the smoke test: the panels open now. */
  static count(): number {
    return FlowPanel.open.size;
  }

  private readonly panel: vscode.WebviewPanel;
  private readonly live = new FlowLive();
  private readonly lines: ActivityLine[] = [];
  private readonly keys = new Set<string>();
  private readonly disposables: vscode.Disposable[] = [];
  private view: FlowView | undefined;
  private ready = false;
  private queue: ToFlow[] = [];
  private reload: ReturnType<typeof setTimeout> | undefined;
  private specRel: string | undefined;

  private constructor(
    private readonly state: KeelState,
    extensionUri: vscode.Uri,
    readonly threadId: string,
    private focusGate: boolean,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      "keel.flow",
      "keel flow",
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [
          vscode.Uri.joinPath(extensionUri, "dist"),
          vscode.Uri.joinPath(extensionUri, "media"),
        ],
      },
    );
    this.panel.iconPath = vscode.Uri.joinPath(
      extensionUri,
      "media",
      "keel.svg",
    );
    this.panel.webview.html = webviewHtml(
      this.panel.webview,
      extensionUri,
      "flow",
      "keel flow",
    );
    this.disposables.push(
      this.panel.onDidDispose(() => this.dispose()),
      this.panel.webview.onDidReceiveMessage(
        (m: FromFlow) => void this.onMessage(m),
      ),
      state.onEvent((ev) => this.onEvent(ev)),
    );
    void this.load();
    void this.backlog();
  }

  private post(m: ToFlow): void {
    if (!this.ready) {
      this.queue.push(m);
      return;
    }
    void this.panel.webview.postMessage(m);
  }

  private async onMessage(m: FromFlow): Promise<void> {
    switch (m.type) {
      case "ready":
        this.ready = true;
        // the queued lines are in the full list sent next
        for (const q of this.queue.splice(0))
          if (q.type !== "lines") void this.panel.webview.postMessage(q);
        this.post({
          type: "lines",
          lines: this.lines.map(lineVm),
          reset: true,
        });
        this.sendNow();
        if (this.focusGate) {
          this.focusGate = false;
          this.post({ type: "focusGate" });
        }
        break;
      case "answer":
        await this.answer(m);
        break;
      case "stop":
        await this.stop();
        break;
      case "resume":
        await this.resume();
        break;
      case "open":
        await openPath(this.state, m.path, m.line);
        break;
      case "openSpec":
        if (this.specRel) await openPath(this.state, this.specRel, 1);
        break;
      case "copyLog":
        await vscode.env.clipboard.writeText(m.text);
        vscode.window.showInformationMessage(
          `keel: the flow's activity is on the clipboard (${this.lines.length} lines).`,
        );
        break;
      case "refresh":
        await this.load();
        break;
    }
  }

  /** The flow view again (steps, criteria, the gate). */
  async load(): Promise<void> {
    const v = await this.state.call(
      (api, pid) => api.flowOf(pid, this.threadId),
      true,
    );
    if (!v?.thread) {
      if (!this.view)
        this.post({
          type: "note",
          text: this.state.error
            ? say(this.state.error)
            : "keel did not send this flow.",
          bad: true,
        });
      return;
    }
    this.view = v;
    this.panel.title = `◆ ${v.thread.title || "keel flow"}`;
    const row = this.state.runs.find((r) => r.thread_id === this.threadId);
    this.specRel = this.specFile(v.thread.title ?? "");
    const vm = flowVm(v, {
      where: row?.where,
      branch: row?.branch ?? undefined,
      cost: row?.cost_usd,
      spec: this.specRel,
    });
    if (vm) this.post({ type: "flow", flow: vm });
    if (!this.live.step && vm?.current) this.sendNow();
  }

  /** `.keel/specs/<title as a slug>.md` when the project has it (the spec step writes it there). */
  private specFile(title: string): string | undefined {
    const folder = this.state.folder;
    const slug = title
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "");
    if (!folder || !slug) return undefined;
    const rel = `.keel/specs/${slug}.md`;
    return existsSync(path.join(folder, rel)) ? rel : undefined;
  }

  private reloadSoon(): void {
    if (this.reload) clearTimeout(this.reload);
    this.reload = setTimeout(() => void this.load(), 300);
  }

  private onEvent(ev: EngineEvent): void {
    if (ev.type === "connected") {
      // the stream came back: what happened meanwhile is in keel, not in the feed
      this.reloadSoon();
      void this.backlog();
      return;
    }
    if (ev.thread_id !== this.threadId) return;
    this.live.apply(ev);
    const l = activityOf(ev, this.live.agentOf);
    if (l) this.add([l]);
    if (
      ev.type.startsWith("agent.") ||
      ev.type.startsWith("step.") ||
      ev.type.startsWith("thread.")
    ) {
      if (ev.type !== "agent.step" && ev.type !== "agent.delta") this.sendNow();
    }
    // the flow view only when a step, a gate or the flow changed, not per agent step
    if (
      ev.type.startsWith("step.") ||
      ev.type.startsWith("gate.") ||
      ev.type.startsWith("thread.")
    )
      this.reloadSoon();
  }

  private add(ls: ActivityLine[]): void {
    const fresh = ls.filter((l) => {
      if (this.keys.has(l.key)) return false;
      this.keys.add(l.key);
      return true;
    });
    if (!fresh.length) return;
    this.lines.push(...fresh);
    let reset = false;
    if (this.lines.length > MAX_LINES) {
      for (const l of this.lines.splice(0, this.lines.length - MAX_LINES))
        this.keys.delete(l.key);
      reset = true;
    }
    this.post(
      reset
        ? { type: "lines", lines: this.lines.map(lineVm), reset: true }
        : { type: "lines", lines: fresh.map(lineVm) },
    );
  }

  private sendNow(): void {
    const agents = [...this.live.running.values()].map((a) => ({
      callId: a.callId,
      agent: a.agent,
      model: a.model,
      effort: a.effort,
      since: a.since,
      tokens: a.tokens > 0 ? `${ktokens(a.tokens)} tokens` : "",
      cost: a.costUsd > 0 ? usd(a.costUsd) : "",
    }));
    const t = this.view?.thread;
    const fallback = t
      ? (t.current &&
          this.view?.workflow?.steps?.find((s) => s.id === t.current)?.name) ||
        t.current ||
        t.phase
      : undefined;
    this.post({ type: "now", step: this.live.step ?? fallback ?? "—", agents });
  }

  /** The flow's recent agent calls and their steps, for a flow opened while it runs (or after). */
  private async backlog(): Promise<void> {
    const got = await this.state.call(async (api, pid) => {
      const jobs = (await api.jobs(pid, 80))
        .filter((j) => j.thread_id === this.threadId)
        .sort((a, b) => (a.started_at ?? "").localeCompare(b.started_at ?? ""))
        .slice(-6);
      return Promise.all(
        jobs.map(async (j) => ({
          job: j,
          steps:
            (await api.jobSteps(j.id).catch(() => ({ steps: [] }))).steps ?? [],
        })),
      );
    }, true);
    if (!got) return;
    for (const { job } of got) this.live.start(job);
    const ls = got
      .flatMap(({ job, steps }) =>
        steps.map((s) => activityOfStep(s, job.agent ?? undefined, job.id)),
      )
      .filter((l): l is ActivityLine => !!l)
      .sort((a, b) => a.at.localeCompare(b.at));
    this.add(ls);
    this.sendNow();
  }

  private async answer(
    m: Extract<FromFlow, { type: "answer" }>,
  ): Promise<void> {
    const w = this.view?.thread?.waiting;
    if (!w) return;
    const body = buildAnswer(w, {
      picked: m.picked,
      why: m.why,
      qPicked: m.qPicked,
      qTyped: m.qTyped,
    });
    this.post({ type: "busy", busy: true });
    try {
      const api = await this.state.ensure();
      await api.answer(this.threadId, body);
      const label =
        gateButtons(w).find((b) => b.name === m.picked)?.label ??
        "your answers";
      this.post({ type: "note", text: `Sent: ${label}` });
    } catch (e) {
      if (e instanceof KeelError && e.status === 409)
        this.post({
          type: "note",
          text: "The flow asks something else now. Here is the new question.",
          bad: true,
        });
      else this.post({ type: "note", text: say(e), bad: true });
    } finally {
      this.post({ type: "busy", busy: false });
    }
    await this.load();
    void this.state.refresh();
  }

  private async stop(): Promise<void> {
    const t: ThreadState | undefined = this.view?.thread ?? undefined;
    const ok = await vscode.window.showWarningMessage(
      `Stop the flow "${t?.title ?? this.threadId}"? Its work so far stays.`,
      { modal: true },
      "Stop flow",
    );
    if (ok !== "Stop flow") return;
    const r = await this.state.call((api) => api.stop(this.threadId));
    if (r) this.post({ type: "note", text: "The flow stopped." });
    await this.load();
    void this.state.refresh();
  }

  private async resume(): Promise<void> {
    const r = await this.state.call(async (api) => {
      const cps = await api.history(this.threadId);
      const cp = [...cps].sort((a, b) => (b.n ?? 0) - (a.n ?? 0))[0];
      if (!cp)
        throw new KeelError(0, "This flow has no saved step to resume from.");
      return api.rewind(this.threadId, cp.id);
    });
    if (r) this.post({ type: "note", text: "The flow goes on." });
    await this.load();
    void this.state.refresh();
  }

  private disposed = false;

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    FlowPanel.open.delete(this.threadId);
    if (this.reload) clearTimeout(this.reload);
    for (const d of this.disposables) d.dispose();
    this.panel.dispose();
  }
}
