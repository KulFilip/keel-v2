import * as vscode from "vscode";
import { say } from "../api/client";
import type {
  ChangedFile,
  PrSummary,
  ReviewThread,
  ReviewView,
} from "../api/models";
import type { KeelState } from "../core/state";
import { ago, ciSummary, firstLine, threadStateOf } from "../logic/format";
import { prFileStatusOf } from "../logic/diff";
import type { ReviewMode } from "./reviewMode";

export type ReviewNode =
  | { kind: "pr"; pr: PrSummary }
  | { kind: "files"; key: string; files: ChangedFile[] }
  | {
      kind: "threads";
      key: string;
      threads: ReviewThread[];
      me?: string | null;
    }
  | { kind: "file"; key: string; file: ChangedFile; threads: number }
  | { kind: "thread"; key: string; thread: ReviewThread; me?: string | null }
  | { kind: "note"; text: string };

const keyOf = (n: number) => `pr:${n}`;

function fileIcon(f: ChangedFile): vscode.ThemeIcon {
  switch (prFileStatusOf(f.status)) {
    case "new":
      return new vscode.ThemeIcon(
        "diff-added",
        new vscode.ThemeColor("gitDecoration.addedResourceForeground"),
      );
    case "deleted":
      return new vscode.ThemeIcon(
        "diff-removed",
        new vscode.ThemeColor("gitDecoration.deletedResourceForeground"),
      );
    case "renamed":
      return new vscode.ThemeIcon(
        "diff-renamed",
        new vscode.ThemeColor("gitDecoration.renamedResourceForeground"),
      );
    default:
      return new vscode.ThemeIcon(
        "diff-modified",
        new vscode.ThemeColor("gitDecoration.modifiedResourceForeground"),
      );
  }
}

/** The tree item of a changed file (the Review view and the Changed files view). */
export function fileItem(
  key: string,
  f: ChangedFile,
  threads: number,
): vscode.TreeItem {
  const name = f.path.slice(f.path.lastIndexOf("/") + 1);
  const dir = f.path.includes("/")
    ? f.path.slice(0, f.path.lastIndexOf("/"))
    : "";
  const it = new vscode.TreeItem(name, vscode.TreeItemCollapsibleState.None);
  it.id = `${key}|file|${f.path}`;
  it.iconPath = fileIcon(f);
  it.description = [
    `+${f.added ?? 0} −${f.removed ?? 0}`,
    threads ? `${threads} thread${threads === 1 ? "" : "s"}` : undefined,
    dir,
  ]
    .filter(Boolean)
    .join(" · ");
  it.tooltip = `${f.path}\n${prFileStatusOf(f.status)} · +${f.added ?? 0} −${f.removed ?? 0}${f.binary ? " · binary" : ""}`;
  it.command = {
    command: "keel.review.openFile",
    title: "Open changed file",
    arguments: [key, f.path],
  };
  it.contextValue = "pr-file";
  return it;
}

/** Review: the project's open pull requests; a PR shows its changed files and its threads. */
export class ReviewTree implements vscode.TreeDataProvider<ReviewNode> {
  private readonly emitter = new vscode.EventEmitter<ReviewNode | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;
  private prs: PrSummary[] | undefined;
  private note: string | undefined;
  private readonly views = new Map<string, ReviewView>();
  private loadedFor: string | undefined;
  private loading: Promise<void> | undefined;
  treeView: vscode.TreeView<ReviewNode> | undefined;

  constructor(
    private readonly state: KeelState,
    private readonly mode: ReviewMode,
  ) {
    state.onDidChange(() => {
      if (this.loadedFor !== this.state.pid) {
        this.prs = undefined;
        this.views.clear();
        this.emitter.fire(undefined);
      }
    });
    mode.onDidChange(() => {
      if (mode.view) this.views.set(mode.view.key, mode.view);
      this.emitter.fire(undefined);
    });
  }

  filter(): string {
    return vscode.workspace
      .getConfiguration("keel")
      .get<string>("review.filter", "review");
  }

  refresh(): void {
    this.prs = undefined;
    this.views.clear();
    this.emitter.fire(undefined);
  }

  private async loadPrs(): Promise<void> {
    const pid = this.state.pid;
    this.loadedFor = pid;
    if (!pid) {
      this.prs = [];
      return;
    }
    const f = this.filter();
    if (this.treeView) this.treeView.description = f;
    try {
      const api = await this.state.ensure();
      const list = await api.prs(pid, f);
      this.prs = list.prs ?? [];
      this.note = list.note ?? undefined;
    } catch (e) {
      this.prs = [];
      this.note = say(e);
    }
  }

  async getChildren(el?: ReviewNode): Promise<ReviewNode[]> {
    if (!this.state.connected || !this.state.pid) return [];
    if (!el) {
      if (!this.prs) {
        this.loading ??= this.loadPrs().finally(
          () => (this.loading = undefined),
        );
        await this.loading;
      }
      const out: ReviewNode[] = (this.prs ?? []).map((pr) => ({
        kind: "pr",
        pr,
      }));
      if (this.note) out.push({ kind: "note", text: this.note });
      return out;
    }
    switch (el.kind) {
      case "pr": {
        const key = keyOf(el.pr.number);
        let v = this.mode.key === key ? this.mode.view : this.views.get(key);
        if (!v) {
          v = await this.state.call((api, pid) => api.review(pid, key), true);
          if (!v)
            return [
              { kind: "note", text: "keel could not read this pull request." },
            ];
          this.views.set(key, v);
        }
        return [
          { kind: "files", key, files: v.files ?? [] },
          { kind: "threads", key, threads: v.threads ?? [], me: v.me },
        ];
      }
      case "files": {
        const v = this.views.get(el.key);
        return el.files.map((file) => ({
          kind: "file",
          key: el.key,
          file,
          threads: (v?.threads ?? []).filter(
            (t) => t.path === file.path && !t.resolved,
          ).length,
        }));
      }
      case "threads":
        return [...el.threads]
          .sort(
            (a, b) =>
              order(threadStateOf(a, el.me)) - order(threadStateOf(b, el.me)),
          )
          .map((thread) => ({
            kind: "thread",
            key: el.key,
            thread,
            me: el.me,
          }));
      default:
        return [];
    }
  }

  getTreeItem(n: ReviewNode): vscode.TreeItem {
    switch (n.kind) {
      case "pr": {
        const pr = n.pr;
        const key = keyOf(pr.number);
        const active = this.mode.key === key;
        const it = new vscode.TreeItem(
          `#${pr.number} ${pr.title ?? ""}`,
          active
            ? vscode.TreeItemCollapsibleState.Expanded
            : vscode.TreeItemCollapsibleState.Collapsed,
        );
        it.id = key;
        it.iconPath = new vscode.ThemeIcon(
          active
            ? "eye"
            : pr.draft
              ? "git-pull-request-draft"
              : "git-pull-request",
          active ? new vscode.ThemeColor("charts.blue") : undefined,
        );
        const v = this.views.get(key);
        it.description = [
          active ? "reviewing" : undefined,
          pr.author,
          pr.base && pr.branch ? `${pr.base} ← ${pr.branch}` : undefined,
          v ? ciSummary(v.checks) || undefined : undefined,
          ago(pr.updated_at) || undefined,
        ]
          .filter(Boolean)
          .join(" · ");
        it.tooltip = `#${pr.number} ${pr.title ?? ""}\n${pr.author ?? ""}${pr.url ? `\n${pr.url}` : ""}`;
        it.contextValue = "pr";
        it.command = {
          command: "keel.review.open",
          title: "Review pull request",
          arguments: [pr.number],
        };
        return it;
      }
      case "files": {
        const it = new vscode.TreeItem(
          `Changed files (${n.files.length})`,
          vscode.TreeItemCollapsibleState.Collapsed,
        );
        it.id = `${n.key}|files`;
        it.iconPath = new vscode.ThemeIcon("files");
        return it;
      }
      case "threads": {
        const waiting = n.threads.filter(
          (t) => threadStateOf(t, n.me) === "waiting",
        ).length;
        const it = new vscode.TreeItem(
          `Threads (${n.threads.length})`,
          n.threads.length
            ? vscode.TreeItemCollapsibleState.Collapsed
            : vscode.TreeItemCollapsibleState.None,
        );
        it.id = `${n.key}|threads`;
        it.iconPath = new vscode.ThemeIcon("comment-discussion");
        if (waiting) it.description = `${waiting} waiting for you`;
        return it;
      }
      case "file":
        return fileItem(n.key, n.file, n.threads);
      case "thread": {
        const t = n.thread;
        const first = t.comments?.[0];
        const place = threadStateOf(t, n.me);
        const it = new vscode.TreeItem(
          firstLine(first?.body ?? "(no text)", 70),
          vscode.TreeItemCollapsibleState.None,
        );
        it.id = `${n.key}|thread|${t.id}`;
        it.iconPath = new vscode.ThemeIcon(
          place === "resolved"
            ? "pass"
            : place === "waiting"
              ? "comment-unresolved"
              : "comment",
          place === "waiting"
            ? new vscode.ThemeColor("charts.yellow")
            : undefined,
        );
        it.description = [
          first?.author,
          t.path
            ? `${t.path.slice(t.path.lastIndexOf("/") + 1)}${t.line ? `:${t.line}` : ""}`
            : undefined,
          t.outdated ? "outdated" : undefined,
          `${t.comments?.length ?? 0}`,
        ]
          .filter(Boolean)
          .join(" · ");
        it.tooltip = new vscode.MarkdownString(
          (t.comments ?? [])
            .map((c) => `**${c.author ?? ""}**: ${c.body ?? ""}`)
            .join("\n\n---\n\n"),
        );
        it.command = {
          command: "keel.review.openThread",
          title: "Open review thread",
          arguments: [n.key, t],
        };
        return it;
      }
      case "note": {
        const it = new vscode.TreeItem(
          n.text,
          vscode.TreeItemCollapsibleState.None,
        );
        it.iconPath = new vscode.ThemeIcon("info");
        return it;
      }
    }
  }
}

const order = (p: string) => (p === "waiting" ? 0 : p === "open" ? 1 : 2);

/** Changed files: the files of the PR under review (only while review mode is on). */
export class ChangedFilesTree implements vscode.TreeDataProvider<ChangedFile> {
  private readonly emitter = new vscode.EventEmitter<ChangedFile | undefined>();
  readonly onDidChangeTreeData = this.emitter.event;

  constructor(private readonly mode: ReviewMode) {
    mode.onDidChange(() => this.emitter.fire(undefined));
  }

  getChildren(el?: ChangedFile): ChangedFile[] {
    return el || !this.mode.active ? [] : this.mode.files;
  }

  getTreeItem(f: ChangedFile): vscode.TreeItem {
    const threads = (this.mode.view?.threads ?? []).filter(
      (t) => t.path === f.path && !t.resolved,
    ).length;
    return fileItem(this.mode.key ?? "", f, threads);
  }
}
