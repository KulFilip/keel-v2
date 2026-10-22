// KeelBot's Questions action block(s), split out of Actions.tsx (Actions.tsx re-exports them).

import { useContext, useState } from "react";
import { answersMessage, answersOf, AskKeelBot, ClarifyForm, parseQuestions, readAnswersMessage, type ClarifyAnswers } from "@keel/web-sdk";

/** keel 0.18.9 KeelBot asks the person to choose (```keel-questions```): keel's question form (pick one, tick several,
 *  your own words, how many are answered); Send gives the answers to KeelBot as the next message.
 *  keel 0.18.13 `answered`: the chat's later message with the answers (it starts with "Answers to your questions"): the
 *  card shows what was sent, read only, also after a reload (derived from the chat, nothing stored).
 *  0.18.38 one question with the id "next" is KeelBot's next steps: buttons, not a form. */
export function QuestionsCard({ body, answered }: { body: string; answered?: string | null }) {
  const qs = parseQuestions(body);
  const ask = useContext(AskKeelBot);
  const [picked, setPicked] = useState<ClarifyAnswers>({});
  const [typed, setTyped] = useState<ClarifyAnswers>({});
  const [sent, setSent] = useState<string | null>(null);
  if (!qs.length) return <p className="kb-card bad" role="note">KeelBot's questions could not be read. Ask it to ask again.</p>;
  const send = () => {
    const text = answersMessage(qs, answersOf(qs, picked, typed));
    ask?.(text);
    setSent(text);
  };
  const said = readAnswersMessage(answered ?? sent ?? "");
  const q = qs[0];
  if (qs.length === 1 && q.id === "next" && !q.multiple) {
    // 0.18.38 KeelBot's next steps (one question with the id "next"): a row of buttons, one press sends the pick
    const pick = (label: string) => {
      const text = answersMessage(qs, { next: label });
      ask?.(text);
      setSent(text);
    };
    return (
      <section className="kb-next" aria-label="Next steps">
        <span className="kb-next-h">Next — KeelBot can</span>
        {said ? <p className="kb-done" role="status">You picked: <b>{said[0]?.answer}</b></p> : (
          <div className="kb-next-btns">
            {q.options.map((o) => (
              <button key={o.label} type="button" className={`btn sm${o.recommended ? " primary" : ""}`} title={o.description} disabled={!ask}
                onClick={() => pick(o.label)}>{o.label}</button>
            ))}
          </div>
        )}
      </section>
    );
  }
  return (
    <section className="kb-card" aria-label="KeelBot's questions">
      <div className="kb-card-h"><span className="kb-tag">Questions</span><b>KeelBot asks</b></div>
      {said ? (
        <div className="kb-done" role="status">
          <p>Your answers went to KeelBot:</p>
          <ol className="kb-answers" aria-label="Your answers">
            {said.map((x, i) => <li key={i}><span className="sub">{x.question}</span> → <b>{x.answer}</b></li>)}
          </ol>
        </div>
      ) : (
        <>
          <ClarifyForm questions={qs} picked={picked} typed={typed}
            onPick={(id, value) => setPicked((p) => ({ ...p, [id]: value }))} onType={(id, text) => setTyped((p) => ({ ...p, [id]: text }))} />
          <div className="row"><button type="button" className="btn sm primary" disabled={!ask} onClick={send}>Send my answers</button></div>
        </>
      )}
    </section>
  );
}
