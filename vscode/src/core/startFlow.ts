import * as vscode from "vscode";
import { effortsOf } from "../api/client";
import type { StartFlowBody } from "../api/models";
import { suggestWorkflow, titleFrom, WORKFLOW_BLURBS } from "../logic/format";
import type { KeelState } from "./state";

/**
 * keel: Start a flow — a workflow of the project (quick pick, the one that fits the request suggested), a title, the
 * request in the person's own words, where it runs (its own worktree or this folder) and the model, then start.
 * Returns the new flow's thread id.
 */
export async function startFlow(state: KeelState, prefill?: string): Promise<string | undefined> {
  if (!state.pid) {
    const pick = await vscode.window.showWarningMessage("keel: this folder is not one of keel's projects.", "Pick project");
    if (pick) await vscode.commands.executeCommand("keel.pickProject");
    return undefined;
  }
  const workflows = await state.call((api, pid) => api.workflows(pid));
  if (!workflows) return undefined;
  if (!workflows.length) {
    vscode.window.showWarningMessage("keel: this project has no workflows.");
    return undefined;
  }
  const suggested = suggestWorkflow(prefill ?? "", workflows.map((w) => w.id));
  const wfItems = workflows.map((w) => ({
    label: w.id,
    description: w.id === suggested ? "suggested" : undefined,
    detail: WORKFLOW_BLURBS[w.id] ?? (w.name && w.name !== w.id ? w.name : `${w.steps?.length ?? 0} steps`),
    id: w.id,
  }));
  wfItems.sort((a, b) => (a.id === suggested ? -1 : b.id === suggested ? 1 : 0));
  const wf = await vscode.window.showQuickPick(wfItems, { title: "Start a keel flow (1/4): workflow", placeHolder: "Which workflow?", ignoreFocusOut: true });
  if (!wf) return undefined;

  const title = await vscode.window.showInputBox({
    title: "Start a keel flow (2/4): title",
    prompt: "A short name, e.g. Add refunds to orders",
    value: prefill ? titleFrom(prefill) : "",
    ignoreFocusOut: true,
    validateInput: (v) => (v.trim() ? undefined : "Give the flow a title."),
  });
  if (title === undefined) return undefined;

  const request = await vscode.window.showInputBox({
    title: "Start a keel flow (3/4): what should keel build?",
    prompt: "In your own words (optional; Enter to skip)",
    value: prefill ?? "",
    ignoreFocusOut: true,
  });
  if (request === undefined) return undefined;

  type Opt = vscode.QuickPickItem & { where?: string; model?: { provider: string; mode: string; model: string; effort?: string } };
  const whereItems: Opt[] = [
    { label: "$(git-branch) Its own worktree", detail: "You keep working here; keel works on a new branch.", where: "worktree" },
    { label: "$(folder) This project folder", detail: "keel works in the folder you have open.", where: "folder" },
  ];
  const where = await vscode.window.showQuickPick(whereItems, { title: "Start a keel flow (4/4): where and model", placeHolder: "Where should it run?", ignoreFocusOut: true });
  if (!where) return undefined;

  const catalog = (await state.call((api) => api.providerModels(), true)) ?? [];
  const modelItems: Opt[] = [{ label: "keel's default", detail: "Each agent of the workflow keeps the model set in keel's settings." }];
  for (const p of catalog) {
    for (const [mode, ms] of Object.entries(p.modes)) {
      for (const m of ms) {
        const efforts = effortsOf(p, m.id, mode);
        for (const e of efforts.length ? efforts : [""]) {
          modelItems.push({ label: `${p.label} · ${m.label}${e ? ` · ${e}` : ""}`, description: Object.keys(p.modes).length > 1 ? mode : undefined, model: { provider: p.id, mode, model: m.id, effort: e || undefined } });
        }
      }
    }
  }
  const model = modelItems.length > 1 ? await vscode.window.showQuickPick(modelItems, { title: "Start a keel flow (4/4): model", placeHolder: "Which model? (it goes along as a flow option)", ignoreFocusOut: true }) : modelItems[0];
  if (!model) return undefined;

  const options: Record<string, string> = {};
  if (model.model) {
    options.provider = model.model.provider;
    options.mode = model.model.mode;
    options.model = model.model.model;
    if (model.model.effort) options.effort = model.model.effort;
  }
  const body: StartFlowBody = {
    workflow_id: wf.id,
    title: title.trim(),
    request: request.trim() || null,
    where: where.where ?? "worktree",
    run_mode: "manual",
    options: Object.keys(options).length ? options : null,
  };
  const t = await state.call((api, pid) => api.startFlow(pid, body));
  if (!t) return undefined;
  vscode.window.showInformationMessage(`keel started "${t.title || body.title}".`);
  void state.refresh();
  return t.thread_id;
}
