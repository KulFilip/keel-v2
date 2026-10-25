import { randomBytes } from "node:crypto";
import * as vscode from "vscode";

/**
 * A webview page: a strict CSP (no inline script; only this extension's script with a fresh nonce, styles from the
 * extension and inline style attributes), VS Code's theme variables for colors, so light, dark and high contrast work.
 */
export function webviewHtml(webview: vscode.Webview, extensionUri: vscode.Uri, script: string, title: string): string {
  const nonce = randomBytes(16).toString("base64");
  const js = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "dist", "webview", `${script}.js`));
  const css = webview.asWebviewUri(vscode.Uri.joinPath(extensionUri, "media", "webview.css"));
  const csp = [
    "default-src 'none'",
    `style-src ${webview.cspSource} 'unsafe-inline'`,
    `script-src 'nonce-${nonce}'`,
    `img-src ${webview.cspSource} https: data:`,
    `font-src ${webview.cspSource}`,
  ].join("; ");
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta http-equiv="Content-Security-Policy" content="${csp}">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<link rel="stylesheet" href="${css}">
<title>${title.replace(/[<>&"]/g, "")}</title>
</head>
<body>
<div id="app" class="app"><p class="muted">Loading…</p></div>
<script nonce="${nonce}" src="${js}"></script>
</body>
</html>`;
}
