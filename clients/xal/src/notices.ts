// keel's live events as one line in xal's transcript. The words come from the web's Events panel
// (web/src/components/events.ts eventLine): one place for them, not a copy.

import { eventLine } from "../../../web/src/components/events.ts";

/** What shows in xal: what needs the person or ends something. Steps and agent output stay on keel's Live page. */
export const NOTICE_TYPES = new Set([
  "thread.started",
  "gate.waiting",
  "gate.decided",
  "thread.done",
  "thread.failed",
  "agent.started",
  "budget.warn",
  "budget.stop",
  "guard.refused",
  "helper.permission",
]);

type EngineEvent = { type: string; thread_id: string; project_id: string; step?: string; at: string; data: Record<string, unknown> };

/** The SSE message (its name and JSON) as a transcript line, or undefined when it is not one to show. keel's bell
 *  ("notification") repeats what these events say, so it is not shown twice. */
export function noticeFor(event: string, data: string, project?: string): string | undefined {
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(data) as Record<string, unknown>;
  } catch {
    return undefined;
  }
  const type = event === "engine" || event === "message" ? String(body.type ?? "") : event;
  if (!NOTICE_TYPES.has(type)) return undefined;
  const ev = { ...body, type, data: (body.data as Record<string, unknown>) ?? {} } as EngineEvent;
  if (project && ev.project_id && ev.project_id !== project) return undefined;
  const { k, text } = eventLine(ev as Parameters<typeof eventLine>[0]);
  const where = ev.step && !text.startsWith(ev.step) ? ` (${ev.step})` : "";
  return `keel · ${k} · ${text}${where}`;
}
