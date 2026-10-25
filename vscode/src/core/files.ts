import { existsSync } from "node:fs";
import * as vscode from "vscode";
import { localCandidates } from "../logic/paths";
import type { KeelState } from "./state";

/** The file on this computer a path keel names is, if any (see localCandidates). */
export function localFile(state: KeelState, path: string): vscode.Uri | undefined {
  const folder = state.folder;
  if (!folder) return undefined;
  const hit = localCandidates(path, state.project?.root, folder).find((p) => existsSync(p));
  return hit ? vscode.Uri.file(hit) : undefined;
}

/** Opens a path keel names at a 1-based line; false when it is not in this folder. */
export async function openPath(state: KeelState, path: string, line?: number): Promise<boolean> {
  const uri = localFile(state, path);
  if (!uri) {
    vscode.window.showInformationMessage(`keel: ${path} is not in this folder.`);
    return false;
  }
  const opts: vscode.TextDocumentShowOptions = { preview: true };
  if (line && line > 0) opts.selection = new vscode.Range(line - 1, 0, line - 1, 0);
  try {
    await vscode.window.showTextDocument(uri, opts);
    return true;
  } catch {
    // not a text file (an image, a binary): let VS Code pick the editor
    await vscode.commands.executeCommand("vscode.open", uri);
    return true;
  }
}
