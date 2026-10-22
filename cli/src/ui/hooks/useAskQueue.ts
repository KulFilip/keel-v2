import { useEffect, type Dispatch, type MutableRefObject, type SetStateAction } from "react";
import { run } from "../../core/commands";
import { inboxApi } from "../../../../web/src/inboxApi";
import type { Pick } from "../../core/commands";
import type { PermissionQuestion } from "../../core/keel";
import type { Pending } from "./types";

/** The next thing KeelBot asks, when nothing else is being asked: its permission questions first, then its buttons. */
export function useAskQueue(env: {
  pending: Pending | null;
  qTick: number;
  questions: MutableRefObject<PermissionQuestion[]>;
  buttonAsks: MutableRefObject<Pick[]>;
  setPending: (p: Pending) => void;
  setPickIdx: Dispatch<SetStateAction<number>>;
  setPickFilter: Dispatch<SetStateAction<string>>;
}) {
  const { pending, qTick, questions, buttonAsks, setPending, setPickIdx, setPickFilter } = env;
  // the next question KeelBot asks, when nothing else is being asked; then KeelBot's buttons
  useEffect(() => {
    if (!pending && !questions.current.length && buttonAsks.current.length) {
      setPending({ cmd: "KeelBot", pick: buttonAsks.current.shift()! });
      setPickIdx(0);
      setPickFilter("");
      return;
    }
    if (pending || !questions.current.length) return;
    const q = questions.current.shift()!;
    const deny = async (why: string) => {
      await inboxApi.decide(q.id, "deny", why);
      return { blocks: [{ kind: "dim" as const, text: `  refused: ${q.command}${why ? ` (${why})` : ""}` }] };
    };
    // keel 0.18.18 the warning (it throws work away, a flow works in this folder), what "in this chat" keeps (its
    // family: git checkout *), a deny with the person's reason (KeelBot reads it), and Esc says no
    setPending({ cmd: "KeelBot", qid: q.id, pick: { title: `KeelBot asks to run: ${q.command}${q.path ? ` (${q.path})` : ""}?${q.warning ? ` ⚠ ${q.warning}` : ""}`,
      choices: [{ label: "Allow once", value: "once" },
        ...(q.always !== "" ? [{ label: q.always && q.always !== q.command ? `Allow ${q.always} in this chat` : "Allow in this chat", value: "always",
          hint: q.always && q.always !== q.command ? "this command and its kind, for the rest of the chat" : "this command, for the rest of the chat" }] : []),
        { label: "Deny", value: "deny" },
        { label: "Deny, and say why", value: "why", hint: "KeelBot reads your reason and goes on from it" }],
      then: async (v) => {
        if (v === "why") return { blocks: [], ask: { prompt: `Why not ${q.command}? (KeelBot reads it)`, then: (why: string) => deny(why.trim()) } };
        if (v === "deny") return deny("");
        await inboxApi.decide(q.id, v);
        const kept = v === "always" && q.always && q.always !== q.command ? ` (${q.always})` : "";
        return { blocks: [{ kind: "ok", text: `allowed ${v === "always" ? "in this chat" : "once"}: ${q.command}${kept}` }] };
      },
      onCancel: () => deny("The person closed the question without an answer.") } });
    setPickIdx(0);
    setPickFilter("");
  }, [pending, qTick]);
}
