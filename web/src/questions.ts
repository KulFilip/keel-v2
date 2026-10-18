// keel 0.18.13 "one way to ask": the questions a flow (the explorer's clarify loop, init's three questions) or KeelBot
// (```keel-questions```) asks, and the named choices of a gate, read the same way in the dashboard, KeelBot's panel and
// keel2. No React here: keel2 imports this file too (Dockerfile, stage cli).
import type { ChoiceInfo, ClarifyQuestion } from "./api";

export type ClarifyAnswers = Record<string, string | string[]>;

/** The first line of the message that carries the answers to KeelBot's questions (the chat reads it back: C2). */
export const ANSWERS_PREFIX = "Answers to your questions:";

/** The options with the recommended ones first (the order among each group stays). */
export function byRecommended<T extends { recommended?: boolean }>(
  options: T[],
): T[] {
  return [
    ...options.filter((o) => o.recommended),
    ...options.filter((o) => !o.recommended),
  ];
}

/** What a question's options start as before the person touches it: a `multiple` question ticks every recommended
 *  option; a single question picks nothing (unanswered = the recommended one, written down as an assumption). */
export function defaultPick(q: ClarifyQuestion): string[] {
  return q.multiple
    ? q.options.filter((o) => o.recommended).map((o) => o.label)
    : [];
}

/** The answers to send: a typed answer wins over a clicked option (a `multiple` question: the typed words are added to
 *  the ticked ones, and an untouched one sends its recommended options, the ones it shows ticked); an unanswered
 *  question is left out (the engine then uses the recommended option and says so). */
export function answersOf(
  questions: ClarifyQuestion[],
  picked: ClarifyAnswers,
  typed: ClarifyAnswers,
): ClarifyAnswers {
  const out: ClarifyAnswers = {};
  for (const q of questions) {
    const t = String(typed[q.id] ?? "").trim();
    const p = q.id in picked ? picked[q.id] : undefined;
    if (q.multiple) {
      const ticked =
        p === undefined ? defaultPick(q) : Array.isArray(p) ? p : p ? [p] : [];
      const list = [...ticked, ...(t ? [t] : [])];
      if (list.length) out[q.id] = list;
    } else if (t) out[q.id] = t;
    else if (p) out[q.id] = Array.isArray(p) ? p[0] : p;
  }
  return out;
}

const str = (v: unknown) => (typeof v === "string" ? v.trim() : "");

/** Questions as keel's form reads them (the explorer's format, engine runtime/clarify.py): at most 4, 2 to 4 options
 *  each (a plain string is a label), the recommended one marked (else the first), `multiple` when several may be
 *  picked. `raw` is a ```keel-questions``` block's text, or what it holds (a list, or {questions: [...]}). */
export function parseQuestions(raw: unknown): ClarifyQuestion[] {
  let v = raw;
  if (typeof raw === "string") {
    try {
      v = JSON.parse(raw);
    } catch {
      return [];
    }
  }
  const list = Array.isArray(v)
    ? v
    : v &&
        typeof v === "object" &&
        Array.isArray((v as { questions?: unknown }).questions)
      ? (v as { questions: unknown[] }).questions
      : [];
  const out: ClarifyQuestion[] = [];
  list.forEach((q, i) => {
    if (out.length >= 4 || !q || typeof q !== "object") return;
    const x = q as Record<string, unknown>;
    const question = str(x.question);
    const options = (Array.isArray(x.options) ? x.options : [])
      .slice(0, 4)
      .map((o) =>
        typeof o === "string" ? { label: o } : (o as Record<string, unknown>),
      )
      .filter((o) => str(o?.label))
      .map((o) => ({
        label: str(o.label),
        description: str(o.description) || undefined,
        recommended: o.recommended === true,
      }));
    if (!question || !options.length) return;
    if (!options.some((o) => o.recommended)) options[0].recommended = true;
    out.push({
      id: str(x.id) || `q${i + 1}`,
      question,
      why: str(x.why) || undefined,
      multiple: x.multiple === true,
      options,
    });
  });
  return out;
}

/** The answers as the next chat message to KeelBot (it starts with ANSWERS_PREFIX). */
export function answersMessage(
  questions: ClarifyQuestion[],
  answers: ClarifyAnswers,
): string {
  return [
    ANSWERS_PREFIX,
    ...questions.map((q, i) => {
      const a = answers[q.id];
      const said = Array.isArray(a) ? a.join("; ") : a;
      return `${i + 1}. ${q.question}\n   → ${said || "(not answered: use the recommended one)"}`;
    }),
  ].join("\n");
}

/** A message answersMessage wrote, read back: each question and what was sent; null for any other message. */
export function readAnswersMessage(
  text: string,
): { question: string; answer: string }[] | null {
  const t = (text ?? "").replace(/\r\n?/g, "\n").trim();
  if (!t.startsWith(ANSWERS_PREFIX)) return null;
  const out: { question: string; answer: string }[] = [];
  for (const line of t.slice(ANSWERS_PREFIX.length).split("\n")) {
    const q = /^\s*\d+\.\s+(.*)$/.exec(line);
    const a = /^\s*→\s?(.*)$/.exec(line);
    if (q) out.push({ question: q[1].trim(), answer: "" });
    else if (a && out.length) out[out.length - 1].answer = a[1].trim();
  }
  return out;
}

// ------------------------------------------------------------------ a gate's named choices

/** A waiting question's choices as rows to show: the engine's choice_info when it sent one (same order as `choices`),
 *  else (an older engine) the raw names, the first one the default, a `reject` that needs a reason. */
export function choiceRows(
  choices: string[] | null | undefined,
  info?: ChoiceInfo[] | null,
): ChoiceInfo[] {
  if (info?.length) return info;
  return (choices ?? []).map((name, n) => ({
    name,
    label: name,
    description: "",
    why: name === "reject" ? "required" : "none",
    default: n === 0,
  }));
}

/** Why an answer with this choice cannot be sent yet ("" = it can). */
export function choiceProblem(c: ChoiceInfo | undefined, why: string): string {
  if (!c) return "Choose one first.";
  return c.why === "required" && !why.trim()
    ? `Write why first: “${c.label}” needs a reason.`
    : "";
}
