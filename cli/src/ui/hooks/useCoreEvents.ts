import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import type { Button } from "../../core/buttons";
import type { ChangedFile } from "../sidebar";
import * as fmt from "../../core/format";
import { modelName, modelText } from "../../core/effort";
import { answeredBy, thoughtLine } from "../../core/thinking";
import { messageBlock, setChanged } from "../../core/commands";
import { modelCatalog } from "../../core/effort";
import { splitButtons } from "../../core/buttons";
import { canOpen } from "../../core/tools";
import type { KeelCore, PermissionQuestion, Snapshot } from "../../core/keel";
import type { Block } from "../../core/commands";
import type { Profiler } from "../../core/profile";
import type { Item } from "./types";

type Env = {
  core: KeelCore;
  push: (...bs: Block[]) => void;
  profiler?: Profiler;
  questions: MutableRefObject<PermissionQuestion[]>;
  pendingRef: MutableRefObject<{ qid?: string } | null>;
  setPending: (p: null) => void;
  setQTick: Dispatch<SetStateAction<number>>;
  look: MutableRefObject<{ paint: import("../../core/theme").Paint; width: number }>;
  turnStart: MutableRefObject<number | null>;
  lastThought: MutableRefObject<{ text: string; ms: number } | null>;
  nextId: MutableRefObject<number>;
  askButtons: (buttons: Button[]) => Promise<void>;
  setSnap: (s: Snapshot) => void;
  setItems: Dispatch<SetStateAction<Item[]>>;
  setStarted: (b: boolean) => void;
  setBotCmds: (c: { name: string; description: string }[]) => void;
  setShowThink: (b: boolean) => void;
  setLiveOpen: (n: number | null) => void;
  setFooter: (s: string | null) => void;
  setAnswers: Dispatch<SetStateAction<number>>;
  setTurnFiles: (f: ChangedFile[]) => void;
};

/** keel's events into the screen: notices, the dashboard's chat, queued messages, KeelBot's permission questions and its
 *  answers (tool calls, the answer, how the turn ended, the files it changed); then keel starts. */
export function useCoreEvents(env: Env) {
  const { core, push, profiler, questions, pendingRef, setPending, setQTick, look, turnStart, lastThought, nextId, askButtons, setSnap, setItems,
    setStarted, setBotCmds, setShowThink, setLiveOpen, setFooter, setAnswers, setTurnFiles } = env;
  useEffect(() => {
    const offs = [
      core.on("change", (s) => setSnap(s)),
      core.on("notice", (t) => push({ kind: "notice", text: t })),
      // 0.18.6 the chat the dashboard has open (at the start, or when it opens another): its last messages
      core.on("chat", (s, why) => {
        const blocks: Block[] = [{ kind: "dim", text: `  ${why}: KeelBot chat "${s.title || s.id}" · ${s.mode}` }];
        (s.messages ?? []).slice(-4).forEach((m) => blocks.push(messageBlock(m)));
        push(...blocks);
      }),
      // 0.18.6 a question asked in this chat from the dashboard: shown as the person's own, then KeelBot answers here too
      core.on("remote", (text, by) => push({ kind: "user", text }, { kind: "dim", text: `  asked in ${by}` })),
      // 0.18.28 typed while KeelBot answered: dim until it goes, then the person's message as usual
      core.on("queued", (m) => push(m.sent ? { kind: "user", text: m.text }
        : { kind: "dim", text: `  ⧗ will send after this answer${m.position > 1 ? ` (#${m.position})` : ""}: ${m.text.split("\n")[0].slice(0, 200)}  · Esc stops the answer and sends it now` })),
      // KeelBot asks the person's OK for a command: an amber yes/no, one after the other
      core.on("question", (q) => {
        if (questions.current.some((x) => x.id === q.id)) return;
        questions.current.push(q);
        setQTick((n) => n + 1);
      }),
      // keel 0.18.18 answered in the dashboard, or KeelBot's turn ended: its card goes (an answer here does nothing more)
      core.on("questionGone", (id) => {
        questions.current = questions.current.filter((x) => x.id !== id);
        if (pendingRef.current?.qid === id) {
          setPending(null);
          push({ kind: "dim", text: "  KeelBot's question ended (answered elsewhere, or its answer ended)" });
        }
      }),
      core.on("answer", (a) => {
        const d = a.message?.data;
        const { paint, width: w } = look.current;
        const used = d ? [d.provider && d.model ? modelText(d) : "", d.tokens_in || d.tokens_out ? `${fmt.short((d.tokens_in ?? 0) + (d.tokens_out ?? 0))} tokens` : "",
          d.cost_usd ? `$${d.cost_usd.toFixed(2)}` : ""].filter(Boolean).join(" · ") : "";
        // what it did (one line per tool call, its output folded), the answer, then how the turn ended and what it used
        const calls = core.snapshot.chat.tools;
        const lastOpenable = calls.map(canOpen).lastIndexOf(true);
        const toolBlocks: Block[] = calls.map((c, i) => ({ kind: "tool", text: c.output, tool: c, ...(i === lastOpenable ? { hint: "Ctrl+O to show" } : {}) }));
        const ms = d?.ms ?? (turnStart.current ? Date.now() - turnStart.current : 0);
        const outcome = a.ok ? "done" : d?.status === "stopped" ? "stopped" : "failed";
        const { text: said, buttons } = a.ok ? splitButtons(a.text) : { text: a.text, buttons: [] };
        // 0.18.23 its thinking, folded to one line (Ctrl+T or /thinking shows it), then the answer and who answered
        const thought = typeof d?.thinking === "string" && d.thinking.trim() ? d.thinking : core.snapshot.chat.thinking || "";
        const thoughtMs = typeof d?.thinking_ms === "number" ? d.thinking_ms : 0;
        lastThought.current = thought ? { text: thought, ms: thoughtMs } : null;
        setShowThink(false);
        push(...(thought ? [{ kind: "dim" as const, text: thoughtLine(thoughtMs) }] : []),
          ...toolBlocks, { kind: a.ok ? "markdown" : "error", text: said || "(KeelBot gave buttons only)" },
          ...(d?.model ? [{ kind: "dim" as const, text: answeredBy(d.mode ?? core.snapshot.chat.mode, modelName(d), ms) }] : []));
        setLiveOpen(null);
        // keel 0.18.8 "✓ Finished …" sits on the prompt (the last turn's), with room between it and the answer above
        setFooter(fmt.turnFooter(outcome, ms, used ? `KeelBot · ${used}` : "KeelBot", paint));
        turnStart.current = null;
        if (buttons.length) void askButtons(buttons);
        setAnswers((n) => n + 1);
        // Edit, Fix and Side: the files THIS answer changed, with their diffs, and how to keep or undo them. Never the
        // folder's other uncommitted files (the person's, what keel init left): the answer's data names its own files
        // (0.18.20), and an answer that changed none (or an engine that does not say) shows no block at all.
        const mode = core.snapshot.chat.session?.mode ?? core.snapshot.chat.mode;
        const files = Array.isArray(d?.files) ? d.files : [];
        setTurnFiles([]);
        if ((mode === "fix" || mode === "side" || mode === "edit") && typeof d?.turn === "number" && files.length) {
          const sid = core.snapshot.chat.session?.id ?? "";
          void core.changes().then((all) => setChanged(sid, all.map((c) => c.path))).catch(() => undefined);   // /keep's Tab
          void core.changes(d.turn).then((ch) => {
            setTurnFiles(ch.map((c) => ({ path: c.path, status: c.status, added: c.added, removed: c.removed })));
            if (!ch.length) return;
            const p = look.current.paint;
            push({ kind: "text", text: `${p.bold(p.warn(`${ch.length} file(s) changed`))} ${p.dim("· not kept yet")}\n${fmt.changesText(ch, p, 16)}\n`
              + `${p.accent("/keep")} [path|all] ${p.dim("runs the checks and commits")} · ${p.accent("/undo")} [path|all] · ${p.accent("/changes")}` });
          }).catch(() => undefined);
        }
      }),
    ];
    let alive = true;
    void core.start().then((s) => {
      if (!alive) return;
      setItems([{ id: nextId.current++, kind: "start", s }]);
      setStarted(true);
      profiler?.ready();
      void core.keelbotCommands().then((c) => alive && setBotCmds(c));
      void modelCatalog().catch(() => undefined);          // read early: /model opens at once (0.18.9)
    });
    return () => {
      alive = false;
      offs.forEach((o) => o());
      core.stop();
    };
  }, [core, push]);
}
