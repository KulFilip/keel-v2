// The explorer's questions (clarify loop) as buttons: one click per answer, the recommended option first,
// and a text field for "something else". Controlled by the gate card, which sends the answers with the resume.
// keel 0.18.9: a question marked `multiple` takes several options (checkboxes; your own words are added to them), and
// the form says how many are answered before it is sent. The same form answers KeelBot's own questions.
import type { ClarifyQuestion } from "../api";

export type ClarifyAnswers = Record<string, string | string[]>;

/** The answers to send: a typed answer wins over a clicked option (a `multiple` question: the typed words are added to
 *  the ticked ones); an unanswered question is left out (the engine then uses the recommended option and says so). */
export function answersOf(questions: ClarifyQuestion[], picked: ClarifyAnswers, typed: ClarifyAnswers): ClarifyAnswers {
  const out: ClarifyAnswers = {};
  for (const q of questions) {
    const t = String(typed[q.id] ?? "").trim();
    const p = picked[q.id];
    if (q.multiple) {
      const list = [...(Array.isArray(p) ? p : p ? [p] : []), ...(t ? [t] : [])];
      if (list.length) out[q.id] = list;
    } else if (t) out[q.id] = t;
    else if (p) out[q.id] = Array.isArray(p) ? p[0] : p;
  }
  return out;
}

export function ClarifyForm({ questions, picked, typed, onPick, onType }: {
  questions: ClarifyQuestion[];
  picked: ClarifyAnswers;
  typed: ClarifyAnswers;
  /** the question's new answer: one label, or (a `multiple` question) the ticked labels */
  onPick: (id: string, value: string | string[]) => void;
  onType: (id: string, text: string) => void;
}) {
  const answered = Object.keys(answersOf(questions, picked, typed)).length;
  return (
    <div className="clarify" data-testid="clarify-form">
      {questions.map((q, n) => {
        const usesText = !q.multiple && !!String(typed[q.id] ?? "").trim();
        const ticked = Array.isArray(picked[q.id]) ? (picked[q.id] as string[]) : picked[q.id] ? [picked[q.id] as string] : [];
        return (
          <fieldset key={q.id} className="clarify-q">
            <legend><span className="clarify-n">{n + 1}</span> {q.question}{q.multiple && <span className="sub"> · pick any</span>}</legend>
            {q.why && <p className="sub clarify-why">{q.why}</p>}
            <div className="clarify-opts" role={q.multiple ? "group" : "radiogroup"} aria-label={q.question}>
              {q.options.map((o) => {
                const on = !usesText && ticked.includes(o.label);
                const press = () => {
                  if (q.multiple) onPick(q.id, on ? ticked.filter((x) => x !== o.label) : [...ticked, o.label]);
                  else {
                    onType(q.id, "");
                    onPick(q.id, o.label);
                  }
                };
                return (
                  <button key={o.label} type="button" role={q.multiple ? "checkbox" : "radio"} aria-checked={on} className={`clarify-opt${on ? " on" : ""}`}
                    onClick={press}>
                    <b>{q.multiple ? (on ? "☑ " : "☐ ") : ""}{o.label}</b>
                    {o.recommended && <span className="clarify-rec">recommended</span>}
                    {o.description && <span className="sub">{o.description}</span>}
                  </button>
                );
              })}
            </div>
            <input className="clarify-other" type="text" aria-label={`Your own answer to: ${q.question}`}
              placeholder={q.multiple ? "and/or in your own words" : "or answer in your own words"} value={String(typed[q.id] ?? "")}
              onChange={(e) => onType(q.id, e.target.value)} />
          </fieldset>
        );
      })}
      <p className="sub" role="status">
        {answered} of {questions.length} answered. Not answered = the recommended option, written down as an assumption.
      </p>
    </div>
  );
}
