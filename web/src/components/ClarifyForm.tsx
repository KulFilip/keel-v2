// The explorer's questions (clarify loop) as buttons: one click per answer, the recommended option first,
// and a text field for "something else". Controlled by the gate card, which sends the answers with the resume.
// keel 0.18.9: a question marked `multiple` takes several options (checkboxes; your own words are added to them), and
// the form says how many are answered before it is sent. The same form answers KeelBot's own questions.
// keel 0.18.13 the recommended options come first; a `multiple` question starts with its recommended options ticked
// (until the person touches it); the number keys 1–4 pick an option of the question that has the focus.
import type { ClarifyQuestion } from "../api";
import { answersOf, byRecommended, defaultPick, type ClarifyAnswers } from "../questions";

// the answers moved to questions.ts (keel2 and KeelBot read them too); these stay for older imports and the SDK
export { answersOf, type ClarifyAnswers };

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
        const p = q.id in picked ? picked[q.id] : undefined;
        const ticked = p === undefined ? defaultPick(q) : Array.isArray(p) ? p : p ? [p] : [];
        const options = byRecommended(q.options);
        const press = (label: string) => {
          if (q.multiple) onPick(q.id, ticked.includes(label) ? ticked.filter((x) => x !== label) : [...ticked, label]);
          else {
            onType(q.id, "");
            onPick(q.id, label);
          }
        };
        // 1–4 pick (or tick) that option while the focus is in this question, but not while typing
        const onKey = (e: React.KeyboardEvent) => {
          const tag = (e.target as HTMLElement).tagName;
          if (e.metaKey || e.ctrlKey || e.altKey || tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT") return;
          const k = Number(e.key);
          if (!Number.isInteger(k) || k < 1 || k > Math.min(4, options.length)) return;
          e.preventDefault();
          e.stopPropagation();
          press(options[k - 1].label);
        };
        return (
          <fieldset key={q.id} className="clarify-q" onKeyDown={onKey}>
            <legend><span className="clarify-n">{n + 1}</span> {q.question}{q.multiple && <span className="sub"> · pick any</span>}</legend>
            {q.why && <p className="sub clarify-why">{q.why}</p>}
            <div className="clarify-opts" role={q.multiple ? "group" : "radiogroup"} aria-label={q.question}>
              {options.map((o, k) => {
                const on = !usesText && ticked.includes(o.label);
                return (
                  <button key={o.label} type="button" role={q.multiple ? "checkbox" : "radio"} aria-checked={on} className={`clarify-opt${on ? " on" : ""}`}
                    aria-keyshortcuts={k < 4 ? String(k + 1) : undefined} onClick={() => press(o.label)}>
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
