// The answer form of a waiting question, as the web builds it (web Inbox.tsx / Gate.tsx, the JetBrains GateForm):
// keel's named choices when it sends them; else Approve / Send back, but only those the question offers; and the
// questions of a clarify step with their options and free text. Pure: the unit tests read it.

import type {
  ChoiceInfo,
  ClarifyQuestion,
  InboxAnswer,
  InboxItem,
  Waiting,
} from "../api/models";

export const APPROVE = "approve";
export const REJECT = "reject";

/** One button of the gate form. `why`: required | optional | none (a reason box when not none). */
export interface GateButton {
  name: string;
  label: string;
  description: string;
  why: "required" | "optional" | "none";
  default: boolean;
  /** approve / reject made here from `options` (not one of keel's named choices) */
  plain: boolean;
}

const whyOf = (w: string | null | undefined): GateButton["why"] =>
  w === "required" || w === "optional" ? w : "none";

/** A waiting question's named choices: keel's choice_info when it sent one, else the raw names (a reject needs a reason). */
export function choiceRows(
  choices: string[] | null | undefined,
  info: ChoiceInfo[] | null | undefined,
): GateButton[] {
  if (info && info.length) {
    return info.map((c) => ({
      name: c.name,
      label: c.label || c.name,
      description: c.description ?? "",
      why: whyOf(c.why),
      default: !!c.default,
      plain: false,
    }));
  }
  return (choices ?? []).map((name, n) => ({
    name,
    label: name.charAt(0).toUpperCase() + name.slice(1),
    description: "",
    why: name === REJECT ? "required" : "none",
    default: n === 0,
    plain: false,
  }));
}

/**
 * The buttons of a gate: exactly the choices keel offers. Named choices win; else approve / reject, each only when it
 * is in `options`. Nothing invented: a question with neither gets no buttons (its questions, if any, are the form).
 */
export function gateButtons(w: Waiting): GateButton[] {
  const named = choiceRows(w.choices, w.choice_info);
  if (named.length) return named;
  const opts = w.options ?? [];
  const out: GateButton[] = [];
  if (opts.includes(APPROVE)) {
    out.push({
      name: APPROVE,
      label: w.labels?.approve || "Approve",
      description: "The flow goes on to its next step.",
      why: "none",
      default: true,
      plain: true,
    });
  }
  if (opts.includes(REJECT)) {
    out.push({
      name: REJECT,
      label: w.labels?.reject || "Send back",
      description: "The step runs again, with your note.",
      why: "required",
      default: false,
      plain: true,
    });
  }
  return out;
}

/** The button picked first (keel's default, else the first one). */
export function defaultButton(buttons: GateButton[]): GateButton | undefined {
  return buttons.find((b) => b.default) ?? buttons[0];
}

/** Why the answer cannot be sent yet ("" = it can). */
export function answerProblem(
  buttons: GateButton[],
  picked: string | undefined,
  why: string,
  questions: ClarifyQuestion[] = [],
): string {
  if (!buttons.length)
    return questions.length
      ? ""
      : "This question has no answers to pick here. Open it in keel.";
  const b = buttons.find((x) => x.name === picked);
  if (!b) return "Choose one first.";
  if (b.why === "required" && !why.trim())
    return `Write why first: “${b.label}” needs a reason.`;
  return "";
}

/** The label of the reason box for a button; undefined: no box. */
export function reasonLabel(b: GateButton | undefined): string | undefined {
  if (!b || b.why === "none") return undefined;
  if (b.plain && b.name === REJECT) return "What should keel change?";
  return b.why === "required" ? "Why? (needed)" : "A note for keel (optional)";
}

export function defaultPick(q: ClarifyQuestion): string[] {
  return q.multiple
    ? (q.options ?? []).filter((o) => o.recommended).map((o) => o.label)
    : [];
}

/** The picked option of a single question when it takes a reason: the typed words are then that option's reason. */
export function reasonOption(
  q: ClarifyQuestion,
  picked: string[] | undefined,
): string | undefined {
  if (q.multiple || !picked || !picked.length) return undefined;
  const o = (q.options ?? []).find((x) => x.label === picked[0]);
  return o && (o.why === "required" || o.why === "optional")
    ? o.label
    : undefined;
}

/**
 * The answers to send (web questions.ts answersOf): a typed answer wins over a clicked option (an option that takes a
 * reason sends "<label>: <words>"); a `multiple` question sends its ticks plus the typed words, an untouched one its
 * recommended options; an unanswered single question is left out (keel then uses the recommended one).
 */
export function answersOf(
  questions: ClarifyQuestion[],
  picked: Record<string, string[]>,
  typed: Record<string, string>,
): Record<string, string | string[]> {
  const out: Record<string, string | string[]> = {};
  for (const q of questions) {
    const t = (typed[q.id] ?? "").trim();
    const p = picked[q.id];
    if (q.multiple) {
      const list = [...(p ?? defaultPick(q)), ...(t ? [t] : [])];
      if (list.length) out[q.id] = list;
    } else if (t) {
      const r = reasonOption(q, p);
      out[q.id] = r ? `${r}: ${t}` : t;
    } else if (p && p.length) {
      out[q.id] = p[0];
    }
  }
  return out;
}

/** What the person chose in the form. */
export interface GateChoice {
  picked?: string;
  why?: string;
  qPicked?: Record<string, string[]>;
  qTyped?: Record<string, string>;
}

/** The answer body for /api/inbox/{tid}/act, bound to the question's id. */
export function buildAnswer(w: Waiting, choice: GateChoice): InboxAnswer {
  const buttons = gateButtons(w);
  const b = buttons.find((x) => x.name === choice.picked);
  const reason = (choice.why ?? "").trim() || undefined;
  const questions = w.questions ?? [];
  const payload: Record<string, unknown> = {};
  if (b && !b.plain) payload.choice = b.name;
  if (questions.length)
    payload.answers = answersOf(
      questions,
      choice.qPicked ?? {},
      choice.qTyped ?? {},
    );
  const decision = b?.plain && b.name === REJECT ? REJECT : APPROVE;
  const out: InboxAnswer = { decision };
  if (w.id) out.id = w.id;
  if (reason) out.why = reason;
  if (Object.keys(payload).length) out.payload = payload;
  return out;
}

/** An inbox item's question as a Waiting (the same form answers both). */
export function waitingOf(item: InboxItem): Waiting {
  return {
    step: item.step ?? "",
    kind: item.kind,
    title: item.title ?? "",
    detail: item.detail ?? "",
    options: item.options ?? [],
    id: item.id ?? null,
    labels: item.labels ?? null,
    questions: item.questions ?? null,
    choices: item.choices ?? null,
    choice_info: item.choice_info ?? null,
  };
}

/**
 * The notification's one-click Approve: only when the question offers exactly one approve that needs no reason and
 * asks nothing else. Else undefined (the notification then only offers Open).
 */
export function quickApprove(item: InboxItem): GateButton | undefined {
  if (item.kind === "permission" || !item.thread_id) return undefined;
  if (item.questions && item.questions.length) return undefined;
  const approves = gateButtons(waitingOf(item)).filter(
    (b) => b.name === APPROVE,
  );
  if (approves.length !== 1 || approves[0].why === "required") return undefined;
  return approves[0];
}
