"""The explorer's questions before a spec (keel v1's clarify loop, as buttons).

The explorer cannot talk to the user during its run. It ends its answer with one fenced block:

    ```keel-questions
    [{"id": "identity", "question": "...", "why": "...",
      "options": [{"label": "A · Named entity", "description": "...", "recommended": true}, ...]}]
    ```

keel 0.18.9: a question with "multiple": true takes several options (the person ticks each that applies); its answer
comes back as a list.

keel 0.18.22: an option keel itself offers may say it needs a reason ("why": "required", a findings gate's "accept"). Its
answer is "<label>: <reason>" (split_answer reads it back; reason_problem refuses one without a reason).

keel shows the questions on the spec gate, the user clicks, and the answers go back to the same explorer session.
"""
from __future__ import annotations

import json
import re

MAX_QUESTIONS = 4
STEP_QUESTIONS = 6      # an agent step with `asks: true` (the feature's interview: one question per open lens)
MAX_ROUNDS = 2          # after this many rounds the explorer must decide (recommended options) and write the spec

BLOCK = re.compile(r"```[ \t]*keel-questions[ \t]*\n(.*?)\n[ \t]*```", re.S | re.I)
PREFIX = "Answers to your questions:"


def parse_questions(text: str, limit: int = MAX_QUESTIONS) -> list[dict]:
    """The valid questions (at most `limit`) in the last keel-questions block of a text; [] when there is none or it is
    broken."""
    blocks = BLOCK.findall(text or "")
    if not blocks:
        return []
    try:
        raw = json.loads(blocks[-1])
    except ValueError:
        return []
    if isinstance(raw, dict):
        raw = raw.get("questions")
    out: list[dict] = []
    for i, q in enumerate(raw if isinstance(raw, list) else []):
        if not isinstance(q, dict) or not str(q.get("question") or "").strip():
            continue
        opts = []
        for o in (q.get("options") or [])[:4]:
            if isinstance(o, str):
                o = {"label": o}
            if isinstance(o, dict) and str(o.get("label") or "").strip():
                opts.append({"label": str(o["label"]).strip()[:120], "description": str(o.get("description") or "").strip()[:300],
                             "recommended": bool(o.get("recommended"))})
        if opts and not any(o["recommended"] for o in opts):
            opts[0]["recommended"] = True
        opts.sort(key=lambda o: not o["recommended"])       # the recommended option first (stable: the rest keep order)
        qid = re.sub(r"[^a-z0-9_-]+", "-", str(q.get("id") or f"q{i + 1}").lower()).strip("-") or f"q{i + 1}"
        out.append({"id": qid, "question": str(q["question"]).strip()[:300], "why": str(q.get("why") or "").strip()[:300],
                    "options": opts, **({"multiple": True} if q.get("multiple") is True else {})})
        if len(out) == limit:
            break
    ids = [q["id"] for q in out]
    for n, q in enumerate(out):                       # ids must be unique: they key the answers
        if ids.count(q["id"]) > 1:
            q["id"] = f"{q['id']}-{n + 1}"
    return out


def describe(questions: list[dict]) -> str:
    """Plain text of the questions (the gate's detail, and the fallback for a client without the form)."""
    lines = []
    for n, q in enumerate(questions, 1):
        lines.append(f"{n}. {q['question']}")
        if q.get("why"):
            lines.append(f"   why it matters: {q['why']}")
        for o in q.get("options") or []:
            lines.append(f"   - {o['label']}{' (recommended)' if o.get('recommended') else ''}{' [pick any]' if q.get('multiple') else ''}"
                         + (f" [say why: \"{o['label']}: <reason>\"]" if o.get("why") == "required" else "")
                         + (f": {o['description']}" if o.get("description") else ""))
    return "\n".join(lines)


def answers_text(questions: list[dict], answers: dict | None, note: str, round_no: int, spec: bool = True,
                 rounds: int = MAX_ROUNDS) -> str:
    """What the explorer reads next. An unanswered question gets its recommended option, and says so. `spec`: the
    asker writes the spec next (the spec step); else it finishes its own step (an `asks` step: the interview, a spike's
    frame). `rounds`: the asker's rounds of questions (an `asks` step with `rounds`: the clarify flow asks round after
    round until nothing is open)."""
    answers = answers or {}
    lines = [PREFIX]
    for n, q in enumerate(questions, 1):
        raw = answers.get(q["id"])
        # several options (a "multiple" question): one line with each
        given = "; ".join(str(x).strip() for x in raw if str(x).strip()) if isinstance(raw, list) else str(raw or "").strip()
        if given:
            lines.append(f"{n}. {q['question']}\n   → {given}")
        else:
            rec = next((o for o in q.get("options") or [] if o.get("recommended")), None)
            pick = rec["label"] if rec else "your best judgement"
            lines.append(f"{n}. {q['question']}\n   → not answered: use {pick} and write it under Assumptions")
    if note.strip():
        lines.append(f"Also, in the user's words: {note.strip()}")
    if not spec and rounds > MAX_ROUNDS and round_no < rounds:
        lines.append(f"Round {round_no} of at most {rounds} is answered. Write your list again with these answers in it, "
                     "then ask the next round about what is still open (never again what is answered), or end with "
                     "NO_QUESTIONS: <why, in one line> when nothing is.")
    elif not spec:
        lines.append("Now finish your step with these answers." + (" This was the last round of questions: do not ask "
                     "again, take the recommended option for anything still open and say so." if round_no >= rounds
                     else " Ask again only if an answer opens a new, bigger question."))
    elif round_no >= MAX_ROUNDS:
        lines.append("This was the last round of questions. Do not ask again: decide what is still open "
                     "(recommended options), write it under Assumptions, and write the spec now.")
    else:
        lines.append("Now write the spec. Put each answer into the spec as a sentence under Decisions. "
                     "Ask again only if an answer opens a new, bigger question.")
    return "\n".join(lines)


def answers_message(questions: list[dict], answers: dict | None) -> str:
    """The answers as one chat message, the way keel's question card sends them to KeelBot (the web's QuestionsCard,
    keel2's buttons): "Answers to your questions:" then each question with its answer (a list joined with "; ")."""
    answers = answers or {}
    lines = [PREFIX]
    for n, q in enumerate(questions, 1):
        raw = answers.get(q["id"])
        given = "; ".join(str(x).strip() for x in raw if str(x).strip()) if isinstance(raw, list) else str(raw or "").strip()
        lines.append(f"{n}. {q['question']}\n   → {given or '(not answered: use the recommended one)'}")
    return "\n".join(lines)


_SEP = re.compile(r"^\s*(?:[:\u2014\u2013-]|\()\s*")


def split_answer(question: dict, raw) -> tuple[str | None, str]:
    """(the option an answer picks, the words after it): "accept" -> ("accept", ""), "accept: known issue" ->
    ("accept", "known issue"), "Not a finding - it is checked in X" -> ("not a finding", ...). Own words that name no
    option -> (None, the words). Labels match without case; the longest label wins."""
    text = str(raw or "").strip()
    low = text.lower()
    for label in sorted((str(o.get("label") or "") for o in question.get("options") or []), key=len, reverse=True):
        if not label:
            continue
        if low == label.lower():
            return label, ""
        if low.startswith(label.lower()):
            rest = text[len(label):]
            m = _SEP.match(rest)
            if m:
                return label, rest[m.end():].strip().rstrip(")").strip()
    return None, text


def reason_problem(questions: list[dict] | None, answers: dict | None, why: str | None) -> str | None:
    """The refusal for an answer that picks an option needing a reason ("why": "required") and gives none: not after the
    label ("accept: <reason>") and not in the answer's own why. None when every such pick has its reason."""
    if (why or "").strip():
        return None
    for q in questions or []:
        raw = (answers or {}).get(q.get("id"))
        if raw is None or isinstance(raw, list):
            continue
        label, said = split_answer(q, raw)
        opt = next((o for o in q.get("options") or [] if o.get("label") == label), None)
        if opt and opt.get("why") == "required" and not said:
            return f'"{q.get("question")}": "{label}" needs a reason ("{label}: <reason>").'
    return None


# 0.18.28 an answer that is a question or confusion ("what do you mean", "?", "explain"): the person did not understand
# the question. It is no answer, so the asker must not read it as one, and keel must not fall back to the recommended
# option for it: keel asks that question again, once, in plain words with examples (Compiler._clarify_gate).
_CONFUSED = re.compile(
    r"^\s*\?+\s*$|what\s+do\s+you\s+mean|what\s+does\s+.{0,60}\bmean\b|what\s+is\s+meant|\bmeaning\b|"
    r"(?:i\s+)?(?:do\s*n[o']?t|dont|do\s+not|don't)\s+(?:understand|get\s+it|know\s+what)|not\s+sure\s+what|"
    r"\bexplain\b|\bunclear\b|\bconfus|^\s*(?:huh|what|sorry|pardon)\s*[?!.]*\s*$|can\s+you\s+clarify|"
    r"\bno\s+idea\b|which\s+one\s+do\s+you\s+mean", re.I)


def is_confused(raw, question: dict | None = None) -> bool:
    """Is this answer a question or confusion rather than an answer? An option's label (or "<label>: ...") never is;
    own words that ask back are ("what do you mean", "?", "explain", "I don't understand", a sentence ending in "?")."""
    if isinstance(raw, list):
        return False
    text = str(raw or "").strip()
    if not text:
        return False
    if question and split_answer(question, text)[0]:
        return False
    return bool(_CONFUSED.search(text)) or text.endswith("?")


def explained(question: dict, said: str = "") -> dict:
    """The question again in plain words: what it decides (its why), each option as an example of what it means, and
    the person's own words back. Marked "explained" so it is asked this way once."""
    opts = question.get("options") or []
    examples = [f'"{o["label"]}"' + (f" means {o['description'].rstrip('.')}" if o.get("description") else "")
                for o in opts if o.get("label")]
    why = str(question.get("why") or "").strip().rstrip(".")
    lines = [str(question.get("question") or "").strip(), ""]
    if said:
        lines.append(f'You asked: "{said.strip()[:200]}". Here it is in plain words.')
    lines.append(f"What it decides: {why}." if why else "It decides how the feature behaves in this case.")
    if examples:
        lines.append("For example: " + "; ".join(examples) + ".")
    lines.append("Pick one, or answer in your own words (\"not sure\" is fine: keel then writes it down as an open "
                 "question instead of guessing).")
    return {**question, "question": "\n".join(lines).strip(), "explained": True, "asked_back": str(said or "")[:200]}

