// 0.18.23 KeelBot's suggested answer to a waiting gate, in words the person reads like the gate itself: the gate's
// short name ("frame the question"), then one line per question, "the question → the answer". Never the raw question
// ids, never the flow's request cut at N characters. keel TUI (cli/src/core/buttons.ts) and the panel's answer card
// (Actions.tsx) both use it.

/** What a suggestion that was not sent says, when the person wrote a new message before pressing it. */
export const NOT_SENT_NEW_MESSAGE =
  "Suggestion not sent: you wrote a new message. KeelBot will update it.";

type Waiting =
  | {
      title?: string | null;
      /** 0.18.28 the waiting step's own name, when the engine sends it ("verify the suite + commit") */
      name?: string | null;
      questions?: { id: string; question?: string }[] | null;
    }
  | null
  | undefined;

/** The gate's short name: its step's name. The engine sends it (0.18.28, `name`); else a question round's title is
 *  "<step name> has 2 questions": the step name. Never the flow's title cut short. */
export function gateName(w: Waiting): string {
  const own = String(w?.name ?? "").trim();
  if (own) return own;
  const t = String(w?.title ?? "").trim();
  if (/^The explorer has \d+ questions? before the spec$/i.test(t))
    return "the spec's questions";
  return t.replace(/\s+has \d+ questions?$/i, "").trim();
}

/** One line per proposed answer: "<the question's words> → <the answer>". An answer to a question the gate does not
 *  show (yet) is the answer alone, never its id. */
export function answerLines(
  answers: Record<string, string | string[]>,
  w: Waiting,
): string[] {
  const qs = w?.questions ?? [];
  return Object.entries(answers).map(([id, v]) => {
    const said = Array.isArray(v) ? v.join("; ") : v;
    const q = qs.find((x) => x.id === id)?.question?.trim();
    return q ? `${q} → ${said}` : `→ ${said}`;
  });
}
