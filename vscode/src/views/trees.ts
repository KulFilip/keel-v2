import * as vscode from "vscode";
import type { InboxItem, RunRow } from "../api/models";
import type { KeelState } from "../core/state";
import { ago, firstLine, usd } from "../logic/format";
import { ACTIVE, sortRuns } from "../logic/flowVm";

function runIcon(r: RunRow): vscode.ThemeIcon {
  if (r.waiting || r.status === "waiting")
    return new vscode.ThemeIcon(
      "bell-dot",
      new vscode.ThemeColor("charts.yellow"),
    );
  switch (r.status) {
    case "running":
      return new vscode.ThemeIcon(
        "sync~spin",
        new vscode.ThemeColor("charts.blue"),
      );
    case "done":
      return new vscode.ThemeIcon(
        "pass",
        new vscode.ThemeColor("charts.green"),
      );
    case "failed":
    case "error":
      return new vscode.ThemeIcon("error", new vscode.ThemeColor("charts.red"));
    case "stopped":
    case "cancelled":
      return new vscode.ThemeIcon("debug-stop");
    default:
      return new vscode.ThemeIcon("circle-outline");
  }
}

/** Flows: the current project's flows, the active ones on top. */
export class FlowsTree implements vscode.TreeDataProvider<RunRow> {
  private readonly emitter = new vscode.EventEmitter<RunRow | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: KeelState) {
    state.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(el?: RunRow): RunRow[] {
    if (el || !this.state.connected || !this.state.pid) return [];
    return sortRuns(this.state.runs);
  }

  getTreeItem(r: RunRow): vscode.TreeItem {
    const it = new vscode.TreeItem(
      r.title || r.thread_id,
      vscode.TreeItemCollapsibleState.None,
    );
    it.id = r.thread_id;
    it.iconPath = runIcon(r);
    const state = r.waiting
      ? "waits for you"
      : r.status === "running"
        ? r.phase || "running"
        : r.status;
    it.description = [
      state,
      r.workflow_id,
      r.acs_total ? `${r.acs_done ?? 0}/${r.acs_total} criteria` : undefined,
      r.cost_usd ? usd(r.cost_usd) : undefined,
      ago(r.updated_at) || undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMd(r.title || r.thread_id)}**\n\n`);
    tip.appendMarkdown(
      `${escapeMd(r.status ?? "")}${r.phase ? ` · ${escapeMd(r.phase)}` : ""}${r.where ? ` · ${escapeMd(r.where)}` : ""}${r.branch ? ` · branch \`${r.branch.replace(/`/g, "")}\`` : ""}`,
    );
    if (r.waiting) tip.appendMarkdown(`\n\nWaits: ${escapeMd(r.waiting)}`);
    if (r.error)
      tip.appendMarkdown(`\n\n$(error) ${escapeMd(firstLine(r.error, 200))}`);
    tip.supportThemeIcons = true;
    it.tooltip = tip;
    it.contextValue =
      ACTIVE.has(r.status ?? "") || r.waiting ? "flow-active" : "flow";
    it.command = {
      command: "keel.openFlow",
      title: "Open flow",
      arguments: [r.thread_id, !!r.waiting],
    };
    return it;
  }
}

/** Inbox: the questions waiting for you (this project's; every project's when this folder is not one of keel's). */
export class InboxTree implements vscode.TreeDataProvider<InboxItem> {
  private readonly emitter = new vscode.EventEmitter<InboxItem | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly state: KeelState) {
    state.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(el?: InboxItem): InboxItem[] {
    if (el || !this.state.connected) return [];
    return this.state.questions;
  }

  getTreeItem(i: InboxItem): vscode.TreeItem {
    const perm = i.kind === "permission" && i.permission;
    const title = perm
      ? `KeelBot wants to run: ${firstLine(i.permission?.command, 80)}`
      : i.title || "keel waits for you";
    const it = new vscode.TreeItem(title, vscode.TreeItemCollapsibleState.None);
    it.iconPath = new vscode.ThemeIcon(
      perm ? "shield" : i.kind === "clarify" ? "question" : "bell-dot",
      new vscode.ThemeColor("charts.yellow"),
    );
    it.description = [
      i.flow,
      this.state.pid ? undefined : i.project_name,
      i.kind,
      ago(i.since) || undefined,
    ]
      .filter(Boolean)
      .join(" · ");
    const tip = new vscode.MarkdownString();
    tip.appendMarkdown(`**${escapeMd(title)}**`);
    if (i.detail)
      tip.appendMarkdown(`\n\n${escapeMd(firstLine(i.detail, 400))}`);
    it.tooltip = tip;
    it.contextValue = `inbox-${i.kind}`;
    it.command = {
      command: "keel.answerItem",
      title: "Answer",
      arguments: [i],
    };
    return it;
  }
}

/** Markdown special characters as plain text. */
export function escapeMd(s: string): string {
  return s.replace(/([\\`*_{}[\]()#+\-.!|<>])/g, "\\$1");
}
