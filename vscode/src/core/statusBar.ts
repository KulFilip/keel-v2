import * as vscode from "vscode";
import { say } from "../api/client";
import { statusText } from "../logic/status";
import type { KeelState } from "./state";

/** "◆ keel: 1 question" / the running flow's phase; a click opens the Inbox. */
export class StatusItem implements vscode.Disposable {
  private readonly item = vscode.window.createStatusBarItem("keel.status", vscode.StatusBarAlignment.Left, 50);
  private readonly sub: vscode.Disposable;

  constructor(private readonly state: KeelState) {
    this.item.name = "keel";
    this.item.command = "keel.openInbox";
    this.sub = state.onDidChange(() => this.update());
    this.update();
    this.item.show();
  }

  update(): void {
    const s = this.state;
    const running = s.runningFlow;
    this.item.text = statusText({ connected: s.connected, hasError: !!s.error, questions: s.questions.length, runningPhase: running ? running.phase || running.current || "running" : undefined });
    const tip = !s.connected
      ? say(s.error) || "keel: connecting"
      : !s.pid
        ? "keel: this folder is not one of keel's projects (keel: Pick project)"
        : `keel: ${s.project?.name} · ${s.questions.length} waiting${running ? ` · "${running.title}" runs` : ""}${s.live ? "" : " · live updates paused"}`;
    this.item.tooltip = tip;
    this.item.backgroundColor = s.questions.length ? new vscode.ThemeColor("statusBarItem.warningBackground") : undefined;
  }

  dispose(): void {
    this.sub.dispose();
    this.item.dispose();
  }
}
