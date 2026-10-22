// What a click on a waiting gate offers (the status line, the sidebar, a panel): a choice first, never a decision on one click.

import type { KeelCore, Snapshot } from "../core/keel";
import { pressButton } from "../core/buttons";
import { run, type Ctx, type Pick } from "../core/commands";

/** A gate (this flow's, or inbox item n): a choice first, never a decision on one click. */
export function makeGatePick(env: { ctx: Ctx; snap: Snapshot; core: KeelCore; botCmds: { name: string; description: string }[] }, n?: number): Pick | null {
  const { ctx, snap, core, botCmds } = env;
  const item = n ? snap.inbox[n - 1] : null;
  const thread = snap.flow?.thread;
  const w = item ? { title: item.title, options: item.options, kind: item.kind } : thread?.waiting;
  if (!w) return null;
  const at = n ? ` ${n}` : "";
  const tid = item ? item.thread_id : thread!.thread_id;
  const flow = item ? `${item.project_name || item.project_id} · ${item.flow || item.thread_id.slice(0, 8)}` : `"${thread!.title}"`;
  const opts = w.options ?? ["approve", "reject"];
  // keel 0.18.13 this flow's named choices with the engine's words: one row each, the default marked
  const named = !n && thread?.waiting?.choice_info?.length ? thread.waiting.choice_info : null;
  const choices = named ? [
    ...named.map((x) => ({ label: `${x.label || x.name}${x.default ? " (default)" : ""}${x.why === "required" ? " · needs a reason" : ""}`,
      value: `choice:${x.name}`, hint: x.description || `/answer ${x.name}` })),
  ] : [
    ...(w.kind !== "clarify" && opts.includes("approve") ? [{ label: "Approve", value: "approve", hint: `/approve${at}` }] : []),
    ...(opts.includes("reject") ? [{ label: "Send back…", value: "reject", hint: "you say why; the agent gets your words" }] : []),
    ...(!n || w.kind === "clarify" ? [{ label: "Answer… (its questions or choices)", value: "answer", hint: "/answer" }] : []),
    { label: "Stop the flow", value: "stop", hint: "agents stop; every finished step stays saved" },
    { label: "Read it first", value: "status", hint: n ? "/inbox" : "/status" },
  ];
  return { title: `${flow} · ${w.title}: what do you do?`, choices, index: named ? Math.max(0, named.findIndex((x) => x.default)) : 0, then: (v) => {
    const c = v.startsWith("choice:") ? named?.find((x) => `choice:${x.name}` === v) : undefined;
    if (c) return c.why === "none" ? run(ctx, `/answer ${c.name}`, botCmds) : { blocks: [], ask: {
      prompt: c.why === "required" ? `Why ${c.label || c.name}? (needed)` : `Why ${c.label || c.name}? (optional: Enter sends without)`,
      then: (why) => run(ctx, `/answer ${c.name} ${why}`.trim(), botCmds) } };
    if (v === "approve") return run(ctx, `/approve${at}`, botCmds);
    if (v === "answer") return item && item.project_id !== snap.project?.id
      ? { blocks: [{ kind: "dim", text: `  It is on ${item.project_id}: /project ${item.project_id}, then /answer.` }] } : run(ctx, "/answer", botCmds);
    if (v === "status") return run(ctx, n ? "/inbox" : "/status", botCmds);
    if (v === "stop") return { blocks: [], pick: { title: `Stop ${flow}?`, choices: [{ label: "Yes, stop it", value: "yes" }, { label: "No", value: "no" }],
      then: async (y) => {
        if (y !== "yes") return { blocks: [{ kind: "dim", text: "  not stopped" }] };
        const said = await pressButton({ kind: "stop", flows: [tid] }, snap.project?.id ?? "", () => flow);
        await core.refresh().catch(() => undefined);
        return { blocks: [{ kind: "ok", text: said }] };
      } } };
    return { blocks: [], ask: { prompt: "Why send it back? (the agent gets your words)", then: (why) => run(ctx, `/reject${at} ${why}`, botCmds) } };
  } };
}
