// A few DOM helpers for the webviews (no framework). Text always goes in as text nodes; only HTML the extension
// rendered itself (escaped markdown) is set with `html()`.

export interface VsCodeApi {
  postMessage(m: unknown): void;
  getState(): unknown;
  setState(s: unknown): void;
}

declare function acquireVsCodeApi(): VsCodeApi;

export const vscode: VsCodeApi = acquireVsCodeApi();

type Child = Node | string | null | undefined | false;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Record<
    string,
    string | boolean | ((e: Event) => void) | undefined
  > = {},
  ...children: Child[]
): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === false) continue;
    if (typeof v === "function")
      el.addEventListener(k.replace(/^on/, ""), v as EventListener);
    else if (v === true) el.setAttribute(k, "");
    else if (k === "class") el.className = v;
    else el.setAttribute(k, v);
  }
  for (const c of children) {
    if (c === null || c === undefined || c === false) continue;
    el.append(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return el;
}

/** An element holding HTML the extension rendered (escaped markdown). */
export function html(cls: string, markup: string): HTMLDivElement {
  const d = document.createElement("div");
  d.className = cls;
  d.innerHTML = markup;
  return d;
}

/** Clicks on `path:line` links in rendered markdown open the file. */
export function wireFileRefs(root: HTMLElement): void {
  root.addEventListener("click", (e) => {
    const a = (e.target as HTMLElement).closest(
      "a.file-ref",
    ) as HTMLAnchorElement | null;
    if (!a) return;
    e.preventDefault();
    const line = Number(a.dataset.line);
    vscode.postMessage({
      type: "open",
      path: a.dataset.open ?? "",
      line: Number.isFinite(line) ? line : undefined,
      ...(a.dataset.ref ? { ref: a.dataset.ref } : {}),
    });
  });
}

export function elapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  const mm = String(Math.floor((s % 3600) / 60)).padStart(2, "0");
  const ss = String(s % 60).padStart(2, "0");
  return s >= 3600
    ? `${Math.floor(s / 3600)}:${mm}:${ss}`
    : `${Math.floor(s / 60)}:${ss}`;
}
