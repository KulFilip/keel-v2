// keel's live events as one-line notices in the transcript ("vice versa": what happens in the dashboard, in the engine
// or through keel2 mcp shows in the terminal). null = not worth a line (steps, the TUI's own calls, …).
import type { EngineEvent } from "./sdk";

const s = (v: unknown) => (v === undefined || v === null ? "" : String(v));

export function notice(ev: EngineEvent): string | null {
  const d = (ev.data ?? {}) as Record<string, unknown>;
  switch (ev.type) {
    case "thread.started": {
      const via = d.via === "mcp" ? " via MCP" : d.via === "tui" ? " via keel TUI" : "";
      return `flow started${via}: ${s(d.workflow) || "flow"} "${s(d.title)}"`;
    }
    case "gate.waiting": return `waiting for you: ${s(d.title) || ev.step || "a gate"} · /approve or /reject <why> (/next says more)`;
    case "gate.decided": return `${ev.step ?? "gate"} ${s(d.decision) === "reject" ? "sent back" : "approved"}${d.why ? ` — "${s(d.why)}"` : ""}${d.by ? ` (${s(d.by)})` : ""}`;
    case "thread.done": return "flow done · /next";
    case "thread.failed": return `flow failed${d.error ? ": " + s(d.error) : ""} · /resume or /timeline`;
    case "agent.started": return `agent ${s(d.agent)} started${ev.step ? ` · ${ev.step}` : ""}${d.ac ? ` · ${s(d.ac)}` : ""}${d.model ? ` · ${s(d.provider)}/${s(d.model)}` : ""}`;
    case "agent.finished": return s(d.status) && s(d.status) !== "done" ? `agent ${s(d.agent) || "agent"} ${s(d.status)}${ev.step ? ` · ${ev.step}` : ""}` : null;
    case "budget.warn": return `budget: ${s(d.text) || "the flow is near its cap"}`;
    case "budget.stop": return `budget: ${s(d.text) || "cap reached, the flow is paused"} · /approve to go on`;
    case "guard.refused": return `keel refused: ${s(d.text) || s(d.path) || "a write the phase does not allow"}`;
    case "helper.permission": return `KeelBot asks to run: ${s(d.command).slice(0, 120)} · /inbox`;
    case "mcp.call": return `via MCP · ${s(d.client) || "a client"}: ${s(d.tool) || "a tool"}${d.ok === false ? " (refused)" : ""}`;
    default: return null;
  }
}
