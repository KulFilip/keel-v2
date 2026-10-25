import * as vscode from "vscode";
import { effortsOf, say } from "../api/client";
import type {
  HelperChange,
  HelperSession,
  JobStep,
  Model,
} from "../api/models";
import { openPath } from "../core/files";
import type { KeelState } from "../core/state";
import { ktokens, toolSummary, usd } from "../logic/format";
import { renderMarkdown } from "../logic/markdown";
import { relativeTo } from "../logic/paths";
import { webviewHtml } from "./html";
import type { ChatVm, FromChat, ToChat } from "./protocol";

/** The tool log's lines ("$ cmd", "read path"). */
function toolLines(steps: JobStep[]): string {
  return steps
    .map((s) => {
      const first = (s.text ?? "").split("\n")[0];
      if (s.kind === "tool")
        return `$ ${first}${s.ok === false ? "  (failed)" : ""}`;
      if (s.kind === "read") return `read ${s.path ?? first}`;
      if (s.kind === "edit" || s.kind === "write")
        return `${s.kind} ${s.path ?? ""}`;
      return undefined;
    })
    .filter(Boolean)
    .join("\n");
}

/**
 * KeelBot in the keel sidebar: a chat with Ask / Fix / Edit, its model, answers rendered as markdown with file:line
 * links, the tool log of each answer, and the files it changed. The answer streams in from the live stream
 * (helper.delta, the text so far); while it works the chat is also read again every 1.5 s, in case the stream is down.
 */
export class KeelBotView
  implements vscode.WebviewViewProvider, vscode.Disposable
{
  static readonly id = "keel.keelbot";
  private view: vscode.WebviewView | undefined;
  private session: HelperSession | undefined;
  private changes: HelperChange[] = [];
  private readonly steps = new Map<string, JobStep[]>();
  private mode = "ask";
  private sending = false;
  private note: string | undefined;
  private poll: ReturnType<typeof setTimeout> | undefined;
  private pendingPrefill: string | undefined;
  private loadedFor: string | undefined;
  private readonly disposables: vscode.Disposable[] = [];
  private renderTimer: ReturnType<typeof setTimeout> | undefined;

  constructor(
    private readonly state: KeelState,
    private readonly extensionUri: vscode.Uri,
  ) {
    this.disposables.push(
      state.onDidChange(() => {
        if (this.loadedFor !== this.state.pid) void this.load();
      }),
      state.onEvent((ev) => {
        if (!this.session) return;
        if (ev.type === "helper.delta" && this.busy) this.renderSoon();
        else if (
          ev.type.startsWith("helper") &&
          !ev.type.endsWith(".delta") &&
          !ev.type.endsWith(".step") &&
          ev.type !== "helper.tool"
        )
          void this.reloadChat();
      }),
    );
  }

  private get busy(): boolean {
    return (
      this.sending ||
      this.session?.status === "running" ||
      this.session?.busy === true
    );
  }

  resolveWebviewView(view: vscode.WebviewView): void {
    this.view = view;
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.extensionUri, "dist"),
        vscode.Uri.joinPath(this.extensionUri, "media"),
      ],
    };
    view.webview.html = webviewHtml(
      view.webview,
      this.extensionUri,
      "keelbot",
      "KeelBot",
    );
    view.webview.onDidReceiveMessage(
      (m: FromChat) => void this.onMessage(m),
      undefined,
      this.disposables,
    );
    view.onDidDispose(
      () => (this.view = undefined),
      undefined,
      this.disposables,
    );
  }

  /** Puts text in the box (Ask KeelBot about selection); it is sent when the person presses Send. */
  async prefill(text: string): Promise<void> {
    this.pendingPrefill = text;
    await vscode.commands.executeCommand(`${KeelBotView.id}.focus`);
    this.post({ type: "prefill", text });
  }

  private post(m: ToChat): void {
    void this.view?.webview.postMessage(m);
  }

  private async onMessage(m: FromChat): Promise<void> {
    switch (m.type) {
      case "ready":
        if (!this.session || this.loadedFor !== this.state.pid)
          await this.load();
        else this.render();
        if (this.pendingPrefill)
          this.post({ type: "prefill", text: this.pendingPrefill });
        break;
      case "send":
        this.pendingPrefill = undefined;
        await this.send(m.text);
        break;
      case "stop":
        await this.stop();
        break;
      case "mode":
        await this.setMode(m.mode);
        break;
      case "new":
        this.session = undefined;
        this.changes = [];
        this.steps.clear();
        this.render();
        break;
      case "pickChat":
        await this.pickChat();
        break;
      case "pickModel":
        await this.pickModel();
        break;
      case "open":
        await openPath(this.state, m.path, m.line);
        break;
      case "undoAll":
        await this.undoAll();
        break;
      case "keep":
        await this.keep();
        break;
      case "mention": {
        const ed = vscode.window.activeTextEditor;
        const folder = this.state.folder;
        if (ed && folder)
          this.post({
            type: "prefill",
            text: `@${relativeTo(folder, ed.document.uri.fsPath)} `,
          });
        break;
      }
    }
  }

  private async load(): Promise<void> {
    this.loadedFor = this.state.pid;
    if (!this.state.pid) {
      this.session = undefined;
      this.render();
      return;
    }
    const s = await this.state.call(async (api, pid) => {
      const list = await api.chats(pid);
      const last = [...list].sort((a, b) =>
        (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
      )[0];
      return last ? api.chat(pid, last.id) : null;
    }, true);
    this.session = s ?? undefined;
    if (s) this.mode = s.mode ?? this.mode;
    this.render();
    if (s) await this.loadChanges();
    if (this.busy) this.watch();
  }

  private async reloadChat(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) return;
    const was = this.busy;
    const s = await this.state.call((api, pid) => api.chat(pid, sid), true);
    if (!s) return;
    this.session = s;
    this.render();
    if (was && !this.busy) await this.loadChanges();
  }

  private async loadChanges(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) return;
    this.changes =
      (await this.state.call((api, pid) => api.changes(pid, sid), true)) ?? [];
    this.render();
  }

  private async send(text: string): Promise<void> {
    const t = text.trim();
    if (!t || this.busy) return;
    this.sending = true;
    this.note = undefined;
    this.render();
    const mode = this.mode;
    const s = await this.state.call(async (api, pid) => {
      const sess = this.session ?? (await api.newChat(pid, mode));
      await api.send(pid, sess.id, t);
      return api.chat(pid, sess.id);
    });
    this.sending = false;
    if (s) {
      this.session = s;
      this.post({ type: "prefill", text: "" });
      this.watch();
    }
    this.render();
  }

  /** While KeelBot works: the chat again every 1.5 s (the live stream tells too), then its changed files. */
  private watch(): void {
    if (this.poll) clearTimeout(this.poll);
    const sid = this.session?.id;
    if (!sid) return;
    let n = 0;
    const tick = async () => {
      if (this.session?.id !== sid || n++ > 400) return;
      const s = await this.state.call((api, pid) => api.chat(pid, sid), true);
      if (s && this.session?.id === sid) {
        this.session = s;
        this.render();
        if (s.status !== "running" && s.busy !== true) {
          await this.loadChanges();
          return;
        }
      }
      this.poll = setTimeout(() => void tick(), 1500);
    };
    this.poll = setTimeout(() => void tick(), 1500);
  }

  private async stop(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) return;
    const s = await this.state.call((api, pid) => api.stopChat(pid, sid));
    if (s) this.session = s;
    this.render();
  }

  private async setMode(mode: string): Promise<void> {
    this.mode = mode;
    const sid = this.session?.id;
    if (sid) {
      const s = await this.state.call((api, pid) =>
        api.setChatMode(pid, sid, mode),
      );
      if (s) this.session = s;
    }
    this.render();
  }

  private async pickChat(): Promise<void> {
    const list = (await this.state.call((api, pid) => api.chats(pid))) ?? [];
    if (!list.length) {
      vscode.window.showInformationMessage("keel: no KeelBot chats yet.");
      return;
    }
    const sorted = [...list].sort((a, b) =>
      (b.updated_at ?? "").localeCompare(a.updated_at ?? ""),
    );
    const pick = await vscode.window.showQuickPick(
      sorted.map((s) => ({
        label: s.title || s.id,
        description: s.mode,
        id: s.id,
      })),
      { placeHolder: "Open a KeelBot chat" },
    );
    if (!pick) return;
    const s = await this.state.call((api, pid) => api.chat(pid, pick.id));
    if (!s) return;
    this.session = s;
    this.mode = s.mode ?? this.mode;
    this.steps.clear();
    this.render();
    await this.loadChanges();
    if (this.busy) this.watch();
  }

  private async pickModel(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) {
      this.note = "Send a first message; then pick the model.";
      this.render();
      return;
    }
    const catalog =
      (await this.state.call((api) => api.providerModels())) ?? [];
    const items: (vscode.QuickPickItem & { model: Model })[] = [];
    for (const p of catalog) {
      for (const [mode, ms] of Object.entries(p.modes)) {
        for (const m of ms) {
          const efforts = effortsOf(p, m.id, mode);
          for (const e of efforts.length ? efforts : [""]) {
            items.push({
              label: `${p.label} · ${m.label}${e ? ` · ${e}` : ""}`,
              description: Object.keys(p.modes).length > 1 ? mode : undefined,
              model: {
                provider: p.id,
                mode,
                model: m.id,
                effort: e || undefined,
              },
            });
          }
        }
      }
    }
    if (!items.length) return;
    const pick = await vscode.window.showQuickPick(items, {
      placeHolder: "KeelBot's model for this chat",
    });
    if (!pick) return;
    const s = await this.state.call((api, pid) =>
      api.setChatModel(pid, sid, pick.model),
    );
    if (s) this.session = s;
    this.render();
  }

  private async undoAll(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) return;
    const ok = await vscode.window.showWarningMessage(
      "Undo all of KeelBot's changes in this chat?",
      { modal: true },
      "Undo all",
    );
    if (ok !== "Undo all") return;
    const left = await this.state.call((api, pid) => api.undo(pid, sid));
    if (left) this.changes = left;
    this.render();
  }

  private async keep(): Promise<void> {
    const sid = this.session?.id;
    if (!sid) return;
    this.note = "keel runs the checks…";
    this.render();
    const d = await this.state.call((api, pid) => api.keep(pid, sid));
    this.note = d
      ? d.ok
        ? `Committed ${(d.sha ?? "").slice(0, 8)} ${d.message ?? ""}`.trim()
        : d.error || "The checks did not pass."
      : undefined;
    await this.loadChanges();
  }

  private renderSoon(): void {
    if (this.renderTimer) return;
    this.renderTimer = setTimeout(() => {
      this.renderTimer = undefined;
      this.render();
    }, 100);
  }

  private loadSteps(callId: string): void {
    if (this.steps.has(callId)) return;
    this.steps.set(callId, []);
    void this.state
      .call((api) => api.jobSteps(callId), true)
      .then((r) => {
        const st = r?.steps ?? [];
        this.steps.set(callId, st);
        if (st.length) this.renderSoon();
      });
  }

  /** The chat as the webview shows it. */
  chatVm(): ChatVm {
    const s = this.session;
    const messages = (s?.messages ?? []).map((m) => {
      const isUser = m.role === "user";
      const cid = m.call_id ?? undefined;
      let tools: string | undefined;
      let lines: string | undefined;
      if (cid && !isUser) {
        const st = this.steps.get(cid);
        if (!st) this.loadSteps(cid);
        else if (st.length) {
          tools = toolSummary(st);
          lines = toolLines(st);
        }
      }
      return {
        n: m.n,
        role: m.role,
        html: isUser ? "" : renderMarkdown(m.text ?? ""),
        text: isUser ? (m.text ?? "") : undefined,
        tools,
        toolLines: lines,
        files: m.data?.files ?? undefined,
      };
    });
    let liveHtml: string | undefined;
    if (this.busy) {
      const cid = [...(s?.messages ?? [])]
        .reverse()
        .find((m) => m.call_id)?.call_id;
      const t = cid ? this.state.liveText.get(cid) : undefined;
      if (t?.trim()) liveHtml = renderMarkdown(t);
    }
    const model = s?.model
      ? [s.model.model, s.model.effort].filter(Boolean).join(" · ")
      : "";
    return {
      title: s?.title ?? "",
      mode: s?.mode ?? this.mode,
      model,
      usage: s
        ? `${ktokens((s.tokens_in ?? 0) + (s.tokens_out ?? 0))} · ${usd(s.cost_usd)}`
        : "",
      busy: this.busy,
      messages,
      liveHtml,
      changes: this.changes.map((c) => ({
        path: c.path,
        added: c.added ?? 0,
        removed: c.removed ?? 0,
      })),
      note: this.note,
      noProject: this.state.pid
        ? undefined
        : this.state.connected
          ? "This folder is not one of keel's projects. Run keel: Pick project."
          : this.state.error
            ? say(this.state.error)
            : "Connecting to keel…",
    };
  }

  private render(): void {
    if (!this.view) return;
    this.post({ type: "chat", chat: this.chatVm() });
  }

  dispose(): void {
    if (this.poll) clearTimeout(this.poll);
    if (this.renderTimer) clearTimeout(this.renderTimer);
    for (const d of this.disposables) d.dispose();
  }
}
