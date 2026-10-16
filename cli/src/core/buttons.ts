// KeelBot's buttons in keel TUI. KeelBot never acts by itself: its answer ends with fenced blocks (the KeelBot plugin's
// engine, keel_plugin_keelbot/keelbot.py) and the person presses one. The dashboard draws them as cards
// (plugins/keelbot/web/Actions.tsx); here each becomes a yes / no choice after the answer:
//
//   ```keel-start {"workflow", "title", "request"}```                       start a flow
//   ```keel-flow  {"do": "approve" | "reject", "flow", "why"?}```           decide the gate a flow waits at
//   ```keel-flow  {"do": "stop", "flows": [ids]}```                         stop flows (finished steps stay saved)
//   ```keel-flow  {"do": "mode", "flow", "mode": manual|important|auto|readonly}```   a flow's run mode
//   ```keel-workflow <yaml>```                                              a new workflow: saved in the dashboard
//
// Other kinds (a plugin's keel-query, keel-git, keel-ci) are the dashboard's: the answer says where to press them.
// No UI here: App.tsx shows the text and asks; `pressButton` does what a pressed button does.

import { api, type RunMode } from "../../../web/src/api";
import { inboxApi } from "../../../web/src/inboxApi";

export const RUN_MODES: RunMode[] = ["manual", "important", "auto", "readonly"];

/** What each run mode decides (engine runtime/run_mode.py ABOUT). */
export const RUN_MODE_ABOUT: Record<RunMode, string> = {
  manual: "stops at every gate",
  important: "approves a criterion's gate when its checks and review pass; stops at everything else",
  auto: "approves every gate keel can decide; still stops for money, new dependencies, secrets and failures",
  readonly: "stops at every gate; agents may not edit, write or commit",
};

export type Button =
  | { kind: "start"; workflow: string; title: string; request?: string }
  | { kind: "decide"; decision: "approve" | "reject"; flow: string; why?: string }
  | { kind: "stop"; flows: string[] }
  | { kind: "mode"; flow: string; mode: RunMode }
  | { kind: "workflow"; yaml: string }
  | { kind: "other"; name: string };

const OPEN = /^\s*(`{3,}|~{3,})\s*keel-([a-z]+)\s*$/;
const FENCE = /^\s*(`{3,}|~{3,})/;
const closes = (line: string, open: string) => {
  const t = line.trim();
  return t.length >= open.length && t === open[0].repeat(t.length);
};

function json(body: string): Record<string, unknown> | null {
  try {
    const v = JSON.parse(body);
    return v && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** One block as a button, or null when its body is not what its kind needs (it then stays text). */
export function toButton(kind: string, body: string): Button | null {
  if (kind === "workflow") return body.trim() ? { kind: "workflow", yaml: body } : null;
  if (kind !== "start" && kind !== "flow") return { kind: "other", name: kind };
  const v = json(body);
  if (!v) return null;
  if (kind === "start") return str(v.workflow) ? { kind: "start", workflow: str(v.workflow), title: str(v.title), request: str(v.request) || undefined } : null;
  const what = str(v.do);
  if (what === "approve" || what === "reject") return str(v.flow) ? { kind: "decide", decision: what, flow: str(v.flow), why: str(v.why) || undefined } : null;
  if (what === "stop") {
    const flows = (Array.isArray(v.flows) ? v.flows : [v.flow]).map(str).filter(Boolean);
    return flows.length ? { kind: "stop", flows: [...new Set(flows)] } : null;
  }
  if (what === "mode") return str(v.flow) && RUN_MODES.includes(str(v.mode) as RunMode) ? { kind: "mode", flow: str(v.flow), mode: str(v.mode) as RunMode } : null;
  return null;
}

/** The answer without its button blocks (a block inside another code block stays), and the buttons in order. */
export function splitButtons(text: string): { text: string; buttons: Button[] } {
  const lines = (text ?? "").replace(/\r\n?/g, "\n").split("\n");
  const out: string[] = [];
  const buttons: Button[] = [];
  let i = 0;
  while (i < lines.length) {
    const a = lines[i].match(OPEN);
    if (a) {
      const start = i;
      const body: string[] = [];
      i++;
      while (i < lines.length && !closes(lines[i], a[1])) body.push(lines[i++]);
      i++;
      const b = toButton(a[2], body.join("\n"));
      if (b) buttons.push(b);
      else out.push(...lines.slice(start, i));
      continue;
    }
    const f = lines[i].match(FENCE);
    out.push(lines[i++]);
    if (f) {
      while (i < lines.length && !closes(lines[i], f[1])) out.push(lines[i++]);
      if (i < lines.length) out.push(lines[i++]);
    }
  }
  return { text: out.join("\n").replace(/\n{3,}/g, "\n\n").trim(), buttons };
}

/** A flow's name for a question: its title from the project's flows, else its id. */
export type Names = (tid: string) => string;

/** The question a button asks before anything happens; null for buttons only the dashboard has. */
export function question(b: Button, name: Names): string | null {
  switch (b.kind) {
    case "start": return `KeelBot suggests: start ${b.workflow}${b.title ? ` "${b.title}"` : ""}?`;
    case "decide": return `KeelBot suggests: ${b.decision} the gate of ${name(b.flow)}${b.why ? ` (${b.why})` : ""}?`;
    case "stop": return b.flows.length === 1 ? `KeelBot suggests: stop ${name(b.flows[0])}?` : `KeelBot suggests: stop ${b.flows.length} flows (${b.flows.map(name).join(", ")})?`;
    case "mode": return `KeelBot suggests: run ${name(b.flow)} in ${b.mode} mode (${RUN_MODE_ABOUT[b.mode]})?`;
    default: return null;
  }
}

/** Where to press a button the terminal does not have. */
export function elsewhere(b: Button): string {
  return b.kind === "workflow" ? "KeelBot wrote a new workflow: save it in the dashboard's KeelBot panel (/dashboard keelbot)."
    : `KeelBot gave a ${b.kind === "other" ? b.name : b.kind} button: press it in the dashboard's KeelBot panel (/dashboard keelbot).`;
}

/** What a pressed button does; the words say what happened. */
export async function pressButton(b: Button, pid: string, name: Names): Promise<string> {
  switch (b.kind) {
    case "start": {
      const t = await api.startFlow(pid, { workflow_id: b.workflow, title: b.title || b.workflow, request: b.request, options: { started_via: "tui-keelbot" } });
      return `started ${b.workflow} "${t.title}": ${t.status}${t.current ? ` at ${t.current}` : ""}.`;
    }
    case "decide": {
      if (b.decision === "reject" && !b.why) throw new Error("A send-back needs a reason: /reject <why>.");
      const s = await inboxApi.act(b.flow, { decision: b.decision, ...(b.why ? { why: b.why } : {}) });
      return `${b.decision === "approve" ? "approved" : "sent back"} the gate of ${name(b.flow)}. The flow is ${s.status} at ${s.current || "-"}.`;
    }
    case "stop": {
      const done: string[] = [];
      const failed: string[] = [];
      for (const f of b.flows) {
        try {
          await api.stopThread(f);
          done.push(name(f));
        } catch (e) {
          failed.push(`${name(f)} (${e instanceof Error ? e.message : String(e)})`);
        }
      }
      return (done.length ? `stopped ${done.join(", ")}. Finished steps stay saved.` : "")
        + (failed.length ? `${done.length ? " " : ""}Not stopped: ${failed.join("; ")}.` : "");
    }
    case "mode": {
      await inboxApi.setMode(b.flow, b.mode);
      return `${name(b.flow)} runs in ${b.mode} mode from its next gate on.`;
    }
    default: return elsewhere(b);
  }
}
