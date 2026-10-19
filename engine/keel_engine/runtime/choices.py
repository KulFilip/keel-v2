"""choice_info: a waiting question's named choices as data a button can show (keel 0.19.0).

A gate with named choices kept only the names (`choices`) and wrote what each one does into its text ("- retry: ...").
Every client then read the meaning back out of the prose. Now each question that has `choices` also has `choice_info`,
in the same order:

    {"name": "retry", "label": "Try again", "description": "one more round, with your note for the agent",
     "why": "optional", "default": true}

`name` is what the resume sends as payload.choice; `label` is a short button text; `description` is the one line of
meaning (the gate's own prose when it has some, else this catalogue's); `why` says whether a note is "required" (the
answer is refused without one: compiler.answer_problem reads this), "optional" (a handler reads it: the next agent's
prompt, a record, the stop reason) or "none" (nothing reads it); `default` marks the one choice a plain approve takes.

`choices` and the prose stay as they were, for old clients and the MCP text.
"""
from __future__ import annotations

import re

REQUIRED, OPTIONAL, NONE = "required", "optional", "none"

# name -> (label, why, description): what a choice means when nothing more specific is known
GENERIC: dict[str, tuple[str, str, str]] = {
    "approve": ("Approve", NONE, "go on"),
    "retry": ("Try again", OPTIONAL, "one more round, with your note for the agent"),
    "recheck": ("Check again", NONE, "run the check again"),
    "skip": ("Skip this criterion", NONE, "move it to the end of the list and go on with the next criterion"),
    "edit": ("Amend the spec first", OPTIONAL, "amend the spec first (your note says what is wrong)"),
    "stop": ("Stop the flow", OPTIONAL, "stop the flow here (the commits so far stay)"),
    "reject": ("Send it back", REQUIRED, "send it back with what to change"),
    "rebuild": ("Rebuild from here", OPTIONAL, "start again in a new flow with what was learned"),
    "change": ("Change it", OPTIONAL, "it is close but wrong; your note says how"),
}

# (context, name) -> (label, why, description). The context is the gate's step id, or the kind of a check's question
# (stuck, blocked, cannot-run, usage, item). The why values follow what each handler reads.
CATALOGUE: dict[tuple[str, str], tuple[str, str, str]] = {
    # a provider's plan window nearly used (Compiler._provider_window)
    ("usage", "continue"): ("Continue anyway", NONE, "use the plan anyway (the provider may refuse when it is full)"),
    ("usage", "wait"): ("Wait for the reset", NONE, "sleep until the window resets, then go on"),
    ("usage", "cheaper"): ("Use the cheaper model", NONE, "switch to the cheaper model in settings"),
    ("usage", "stop"): ("Stop the flow", OPTIONAL, "end the flow here"),
    # a check that keeps failing, a blocked agent, a command that cannot start (the criterion's skip reads no note)
    ("stuck", "skip"): ("Skip this criterion", NONE, GENERIC["skip"][2]),
    ("blocked", "skip"): ("Skip this criterion", NONE, GENERIC["skip"][2]),
    ("cannot-run", "skip"): ("Skip this criterion", NONE, GENERIC["skip"][2]),
    ("cannot-run", "recheck"): ("Check again", NONE, "run the check again after you fixed .keel/config.yml"),
    # a for_each item's gate (A5): skipping an item is recorded with its reason
    ("item", "approve"): ("Approve", NONE, "approve this item and go on"),
    ("item", "skip"): ("Skip this item", REQUIRED, "skip this item; the reason is recorded"),
    # feature
    ("feature:spec_gate", "approve"): ("Approve and freeze", NONE, "freeze the spec, commit it, go to the contract"),
    ("feature:spec_gate", "edit"): ("Edit the criteria", OPTIONAL, "change the criteria your note names, then come back here"),
    ("feature:spec_gate", "rewrite"): ("Rewrite a section", OPTIONAL, "rewrite the section your note names"),
    ("feature:spec_gate", "review"): ("Review it first", NONE, "an adversarial read first, shown here"),
    ("feature:spec_gate", "order"): ("Plan again", OPTIONAL, "the criteria are right but the plan under them is not"),
    ("feature:spec_gate", "reject"): ("Start the interview again", REQUIRED, "the spec misses the intent: the interview starts again"),
    ("feature:contract_gate", "approve"): ("Approve the contract", NONE, "commit the contract delta and go on to the criteria"),
    ("feature:contract_gate", "change"): ("Change the contract", OPTIONAL, "the contract agent writes it again with your note"),
    ("feature:contract_gate", "amend"): ("Amend the spec first", OPTIONAL,
                                 "the spec is wrong, not the contract: the draft goes back and the spec is amended"),
    ("feature:ready_gate", "ship"): ("Ship it", NONE, "ship runs its whole sequence now and stops next at the final review"),
    ("feature:ready_gate", "diff"): ("Show me the diff first", NONE, "the branch diff is shown, then this question again"),
    ("feature:ready_gate", "wrong"): ("Something is not right", REQUIRED,
                                      "say what; the spec gets a dated amendment and the criteria it reopens are built again"),
    ("feature:ready_gate", "stop"): ("Stop here", OPTIONAL, "stop before ship; the branch and its commits stay"),
    ("feature:e2e_tool", "write"): ("Write without running", NONE, "the specs are written and committed but not run"),
    ("feature:e2e_tool", "check"): ("Check again", NONE, "you set commands.e2e now; keel looks again"),
    ("feature:amend_loop", "first"): ("Build the other one first", NONE, "build the other criterion first, then this one"),
    ("feature:amend_loop", "skip"): ("Skip this criterion", NONE, GENERIC["skip"][2]),
    ("feature:amend_loop", "edit"): ("Amend again", OPTIONAL, "write the amendment again with your note"),
    ("feature:amend_gate", "approve"): ("Commit the amendment", NONE, "commit the amendment, then back to the criteria"),
    ("feature:amend_gate", "context"): ("Add what was missing", OPTIONAL, "tell keel what it was missing; the block is written again"),
    ("feature:amend_gate", "change"): ("Change the amendment", OPTIONAL, "the block is close but wrong; say how"),
    ("feature:amend_gate", "rebuild"): ("Rebuild from here", OPTIONAL, "the spec itself is wrong; a new feature flow starts"),
    # ship
    ("ship:memory_gate", "update"): ("Update it", NONE, "a librarian updates the stale sections (it costs tokens)"),
    ("ship:memory_gate", "skip"): ("Skip it", REQUIRED, "keep the knowledge base as it is; the reason goes in the PR body"),
    # fix and diagnose
    ("fix:gate_r", "investigate"): ("Yes, investigate", NONE, "this is the bug: find its cause"),
    ("fix:gate_r", "stop"): ("Stop here", NONE, "stop; the reproducing test stays on the branch"),
    ("fix:gate_f", "fix"): ("Fix it this way", NONE, "the plan is right: fix the cause narrowly"),
    ("fix:gate_f", "feature"): ("A missing requirement", NONE, "not a bug: start a feature flow with the evidence"),
    ("diagnose:decide", "fix"): ("Hand to the fix flow", NONE, "start the fix flow with the recipe"),
    ("diagnose:decide", "feature"): ("Hand to the feature flow", NONE, "start the feature flow with the evidence"),
    ("diagnose:decide", "unresolved"): ("Leave it unresolved", OPTIONAL, "record the investigation as unresolved (your note is kept)"),
    # cover
    ("cover:measure_failed", "try_again"): ("Measure again", NONE, "run the coverage command again"),
    ("cover:measure_failed", "go_on"): ("Go on without it", NONE, "go on to the coverage verdict without a measurement"),
    ("cover:decide", "test"): ("Write a test", OPTIONAL, "a test covers the group"),
    ("cover:decide", "delete"): ("Delete the lines", OPTIONAL, "the lines cannot be reached: delete them"),
    ("cover:decide", "accept"): ("Accept as uncovered", REQUIRED,
                                 "leave it uncovered; the reason is shown at the final review and in the PR body"),
    # change
    ("change:scope_gate", "small"): ("Small change", OPTIONAL,
                              "the test-first loop per criterion, one gate at the end (against a feature recommendation, "
                              "say why: it is recorded as an escalation override)"),
    ("change:scope_gate", "trivial"): ("Trivial change", NONE, "one refactor commit; existing tests stay untouched"),
    ("change:scope_gate", "feature"): ("Make it a feature", NONE, "hand the criteria to a feature flow"),
    # init
    ("init:rung_gate", "fix"): ("I fixed it, run again", OPTIONAL, "you fixed it (or want more doctor rounds); the ladder runs again"),
    ("init:rung_gate", "exclude"): ("Leave this rung out", OPTIONAL, "leave this rung out of the ladder (setup.ladder_exclude)"),
    ("init:rung_gate", "accept"): ("Keep it, not checked", OPTIONAL, "keep it, marked as not checked (setup.not_checked)"),
    ("init:audit_now", "skip"): ("Hand over now", NONE, "hand over now; nothing checked behaviour"),
    ("init:audit_now", "hunt"): ("Start a bug hunt", NONE, "start a bug hunt now (semi mode, whole project); it changes no code"),
    # hunt
    ("hunt:confirm_lenses", "confirm"): ("Run these lenses", OPTIONAL, "sweep with the lenses ticked (or named in your note)"),
    ("hunt:confirm_lenses", "stop"): ("Stop the hunt", NONE, "end here; nothing is swept"),
    ("hunt:sweep_gate", "prove"): ("Prove them", NONE, "one prover per candidate, with the symptom only"),
    ("hunt:sweep_gate", "stop"): ("Stop here", NONE, "end here; the backlog keeps the candidates"),
    ("hunt:verdicts_gate", "report"): ("Write the report", NONE, "group shared causes and render the report"),
    ("hunt:verdicts_gate", "stop"): ("Stop here", NONE, "end here"),
    ("hunt:triage", "take"): ("Take the top group", NONE, "start hunt-next for the top group"),
    ("hunt:triage", "close"): ("Close a finding", REQUIRED, "close one finding as fixed, accepted or wontfix; say why"),
    ("hunt:triage", "stop"): ("Stop here", NONE, "end here; the backlog stays for hunt-next"),
}


def _spoken(name: str) -> str:
    return name.replace("_", " ").capitalize()


def _known(context: str | None, name: str) -> tuple[str, str, str]:
    """The catalogue's entry for a name: the exact context, else a workflow gate under an include's prefix (ship's cover
    in feature is "feature:ship_cover_decide" for "cover:decide"), else GENERIC, else the name in words."""
    ctx = str(context or "")
    hit = CATALOGUE.get((ctx, name))
    if not hit and ":" in ctx:
        step = ctx.split(":", 1)[1]
        hit = next((v for (k, n), v in CATALOGUE.items() if n == name and ":" in k
                    and (step == k.replace(":", "_") or step.endswith("_" + k.replace(":", "_")))), None)
    return hit or GENERIC.get(name) or (_spoken(name), OPTIONAL, "")


def texts_from(detail: str | None, names: list[str]) -> dict[str, str]:
    """What a gate's own prose says each choice does: "- retry: ..." lines, "retry: ..." lines, or several on one line
    ("prove: ... stop: ..."). A choice the prose does not name is left out."""
    text = str(detail or "")
    if not names or not text:
        return {}
    alt = "|".join(re.escape(n) for n in sorted(names, key=len, reverse=True))
    # a name starts a line (after an optional "- ") or follows a sentence's end
    marker = re.compile(rf"(?:(?<=\n)|^|(?<=[.!?] ))[ \t]*(?:[-*][ \t]+)?({alt}):[ \t]+", re.M)
    found = list(marker.finditer(text))
    out: dict[str, str] = {}
    for n, m in enumerate(found):
        end = found[n + 1].start() if n + 1 < len(found) else len(text)
        said = text[m.end():end].split("\n", 1)[0].strip()
        if said and m.group(1) not in out:
            out[m.group(1)] = said[:300]
    return out


def choice_info(names: list[str], texts: dict[str, str] | None = None, default: str | None = None,
                needs_why: dict[str, str] | None = None, context: str | None = None) -> list[dict]:
    """One entry per name, in order. `texts` (the gate's prose) wins over the catalogue's description; `needs_why`
    overrides the why of a name; `default` is the plain approve's choice (else the first)."""
    texts, needs_why = texts or {}, needs_why or {}
    names = [str(n) for n in names]
    pick = default if default in names else (names[0] if names else None)
    out = []
    for name in names:
        label, why, about = _known(context, name)
        out.append({"name": name, "label": label, "description": texts.get(name) or about,
                    "why": needs_why.get(name, why), "default": name == pick})
    return out


def for_question(question: dict, context: str | None = None, default: str | None = None,
                 needs_why: dict[str, str] | None = None) -> dict:
    """The question with its choice_info, from its `choices` and its own text (a question without choices: unchanged)."""
    names = [str(c) for c in question.get("choices") or []]
    if not names:
        return question
    return {**question, "choice_info": choice_info(names, texts_from(question.get("detail"), names), default, needs_why,
                                                   context)}


def keep(info: list[dict] | None, names: list[str]) -> list[dict]:
    """The entries of the names still offered, in their order, the first of them the default (a check's plain approve
    takes its first choice; past a limit some choices are left out)."""
    by = {c.get("name"): c for c in info or []}
    return [{**by[n], "default": k == 0} for k, n in enumerate(names) if n in by]


def picked(question: dict, decision: str, payload: dict | None) -> dict | None:
    """The choice_info entry an answer takes: payload.choice, else the default on approve (reject on a plain send-back
    when the gate has an exit named reject)."""
    info = question.get("choice_info") or []
    name = (payload or {}).get("choice")
    if name is None and decision == "reject":
        name = "reject"
    if name is None and decision == "approve":
        return next((c for c in info if c.get("default")), None)
    return next((c for c in info if c.get("name") == str(name)), None)
