// keel 0.18.57 Mermaid text -> an SVG string, for pages that show a Mermaid diagram (the Code Review plugin's Database
// and System tabs). Mermaid is big, so it is its own chunk, loaded the first time a page draws one. It runs at the
// strict security level (no scripts, no clickable links from the text) and with plain SVG text labels (no
// foreignObject), so the SVG can be saved and turned into a PNG. A text Mermaid cannot read rejects: the caller shows
// its fallback (keel's ASCII picture).

type MermaidApi = typeof import("mermaid").default;

let loading: Promise<MermaidApi> | null = null;
let seq = 0;
// mermaid keeps one global config: renders go one after the other, each with its own theme
let queue: Promise<unknown> = Promise.resolve();

function load(): Promise<MermaidApi> {
  loading ??= import("mermaid")
    .then((m) => m.default)
    .catch((e) => {
      loading = null;
      throw e;
    });
  return loading;
}

/** Whether keel's page is dark now (the theme switch, else the system's). */
export function pageIsDark(): boolean {
  const r = document.documentElement;
  if (r.dataset.theme) return r.dataset.theme === "dark";
  try {
    return !!window.matchMedia?.("(prefers-color-scheme: dark)").matches;
  } catch {
    return false;
  }
}

export function renderMermaid(
  text: string,
  opts: { dark?: boolean } = {},
): Promise<string> {
  const run = queue.then(async () => {
    const mermaid = await load();
    const dark = opts.dark ?? pageIsDark();
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme: dark ? "dark" : "default",
      htmlLabels: false,
      flowchart: { htmlLabels: false, curve: "basis", wrappingWidth: 360 },
      fontFamily: "ui-sans-serif, system-ui, sans-serif",
    });
    const id = `keel-mermaid-${++seq}`;
    try {
      const { svg } = await mermaid.render(id, text);
      return svg;
    } finally {
      document.getElementById(id)?.remove();
      document.getElementById(`d${id}`)?.remove();
    }
  });
  queue = run.catch(() => undefined);
  return run;
}
