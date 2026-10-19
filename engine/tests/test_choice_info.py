"""keel 0.19.0 choice_info: every question with named choices says each one's button text, meaning, whether it needs a
reason and which one a plain approve takes; the reason rule is the one the engine enforces."""

import pytest

from keel_engine.runtime import choices, run_mode, ship
from keel_engine.runtime.compiler import answer_problem


def by_name(info):
    return {c["name"]: c for c in info}


def test_texts_come_from_the_gates_own_prose_in_each_of_its_forms():
    detail = ("Choose one:\n- retry: one more round, with your note\n- skip: move AC-2 to the end\n"
              "fix: you fixed it; the ladder runs again.\nexclude: leave it out.\n\n"
              "Hunt 1: 3 candidates. prove: one prover per candidate. stop: end here; the backlog keeps them.")
    got = choices.texts_from(detail, ["retry", "skip", "fix", "exclude", "prove", "stop"])
    assert got == {"retry": "one more round, with your note", "skip": "move AC-2 to the end",
                   "fix": "you fixed it; the ladder runs again.", "exclude": "leave it out.",
                   "prove": "one prover per candidate.", "stop": "end here; the backlog keeps them."}
    assert choices.texts_from("Stop: the flow stops", ["stop"]) == {}          # a sentence, not a choice line


def test_choice_info_keeps_the_order_marks_one_default_and_knows_the_flow():
    info = choices.choice_info(["skip", "edit", "retry", "stop"], context="blocked")
    assert [c["name"] for c in info] == ["skip", "edit", "retry", "stop"]
    assert [c["default"] for c in info] == [True, False, False, False]
    assert [c["label"] for c in info] == ["Skip this criterion", "Amend the spec first", "Try again", "Stop the flow"]
    assert set(info[0]) == {"name", "label", "description", "why", "default"}
    scope = by_name(choices.choice_info(["small", "trivial", "feature"], default="feature", context="change:scope_gate"))
    assert scope["feature"]["default"] and not scope["small"]["default"]
    # two flows share a step id: the flow-qualified entry wins
    assert by_name(choices.choice_info(["accept"], context="cover:decide"))["accept"]["why"] == "required"
    assert by_name(choices.choice_info(["fix"], context="diagnose:decide"))["fix"]["label"] == "Hand to the fix flow"
    # a gate under an include's prefix (ship's cover inside feature) is still known
    assert by_name(choices.choice_info(["accept"], context="feature:ship_cover_decide"))["accept"]["label"] == "Accept as uncovered"
    # a name nobody knows still gets a readable label
    assert choices.choice_info(["go_wild"])[0]["label"] == "Go wild"


@pytest.mark.parametrize("context,names,default,expect", [
    # (gate, choices, default, {name: (label, why)})
    ("usage", ["continue", "wait", "cheaper", "stop"], "continue",
     {"continue": ("Continue anyway", "none"), "wait": ("Wait for the reset", "none"),
      "cheaper": ("Use the cheaper model", "none"), "stop": ("Stop the flow", "optional")}),
    ("stuck", ["retry", "skip", "edit", "stop"], "retry",
     {"retry": ("Try again", "optional"), "skip": ("Skip this criterion", "none"), "edit": ("Amend the spec first", "optional")}),
    ("cannot-run", ["recheck", "skip", "stop"], "recheck", {"recheck": ("Check again", "none"), "stop": ("Stop the flow", "optional")}),
    ("feature:spec_gate", ["approve", "edit", "rewrite", "review", "order", "reject"], "approve",
     {"approve": ("Approve and freeze", "none"), "edit": ("Edit the criteria", "optional"), "reject": ("Start the interview again", "required")}),
    ("feature:contract_gate", ["approve", "change", "amend"], "approve",
     {"change": ("Change the contract", "optional"), "amend": ("Amend the spec first", "optional")}),
    ("feature:amend_gate", ["approve", "context", "change", "rebuild"], "approve", {"rebuild": ("Rebuild from here", "optional")}),
    ("feature:amend_loop", ["first", "skip", "edit", "stop"], "first", {"first": ("Build the other one first", "none"), "edit": ("Amend again", "optional")}),
    ("feature:e2e_tool", ["write", "check"], "write", {"write": ("Write without running", "none")}),
    ("fix:gate_r", ["investigate", "stop"], "investigate", {"investigate": ("Yes, investigate", "none")}),
    ("fix:gate_f", ["fix", "feature"], "fix", {"feature": ("A missing requirement", "none")}),
    ("cover:measure_failed", ["try_again", "go_on"], "try_again", {"try_again": ("Measure again", "none")}),
    ("change:scope_gate", ["small", "trivial", "feature"], "small", {"small": ("Small change", "optional")}),
    ("init:rung_gate", ["apply_fix", "retry", "skip", "stop"], "apply_fix", {"apply_fix": ("Apply the fix", "none"),
                                                                           "skip": ("Skip, not checked", "optional")}),
    ("init:git_repo", ["init", "retry", "go_on", "stop"], "init", {"init": ("Make the first commit", "none")}),
    ("cover:no_reports", ["go_on", "stop"], "go_on", {"go_on": ("Go on", "none")}),
    ("init:audit_now", ["skip", "hunt"], "skip", {"skip": ("Hand over now", "none"), "hunt": ("Start a bug hunt", "none")}),
    ("hunt:confirm_lenses", ["confirm", "stop"], "confirm", {"confirm": ("Run these lenses", "optional")}),
    ("hunt:triage", ["take", "close", "stop"], "take", {"close": ("Close a finding", "required"), "take": ("Take the top group", "none")}),
    ("item", ["approve", "skip"], "approve", {"skip": ("Skip this item", "required")}),
])
def test_each_gate_kind_has_its_labels_reasons_and_default(context, names, default, expect):
    info = by_name(choices.choice_info(names, default=default, context=context))
    assert [n for n, c in info.items() if c["default"]] == [default]
    for name, (label, why) in expect.items():
        assert (info[name]["label"], info[name]["why"]) == (label, why), name
        assert info[name]["description"]


def test_a_required_reason_is_enforced_where_choice_info_says_so():
    q = choices.for_question({"kind": "gate", "title": "triage", "options": ["approve"], "choices": ["take", "close", "stop"]},
                             "hunt:triage")
    assert answer_problem(q, "approve", None, None) is None                       # plain approve = take
    assert answer_problem(q, "approve", "", {"choice": "close"})[0] == 'Say why when you choose "Close a finding".'
    assert answer_problem(q, "approve", "a duplicate of G-01", {"choice": "close"}) is None
    assert answer_problem(q, "approve", None, {"choice": "close", "note": "dup"}) is None     # payload.note counts
    item = choices.for_question({"kind": "gate", "title": "g", "options": ["approve", "reject"], "choices": ["approve", "skip"]},
                                "item")
    assert answer_problem(item, "approve", None, {"choice": "skip"})
    assert answer_problem(item, "approve", None, {"choice": "skip", "reason": "generated code"}) is None
    assert answer_problem(item, "approve", None, {"skip": True}) is None          # the old payload keeps working
    # an optional reason is never enforced
    stuck = choices.for_question({"kind": "fix", "title": "s", "options": ["approve", "reject"], "choices": ["retry", "stop"]}, "stuck")
    assert answer_problem(stuck, "approve", None, {"choice": "stop"}) is None


def test_a_check_keeps_only_the_choices_still_offered():
    info = choices.choice_info(["skip", "edit", "retry", "stop"], context="blocked")
    kept = choices.keep(info, ["retry", "stop"])
    assert [(c["name"], c["default"]) for c in kept] == [("retry", True), ("stop", False)]


def test_the_feature_stuck_and_cannot_run_questions_carry_choice_info(tmp_path):
    from keel_engine.runtime import actions, feature_actions

    a = actions.ActionInput(root=str(tmp_path), phase="red", title="t", ac={"id": "AC-2", "layer": "API"},
                            acs=[{"id": "AC-1", "status": "todo"}, {"id": "AC-2", "status": "todo"}], fake=True, flow="feature",
                            state={"ac": "AC-2", "markers": {"red": {"BLOCKED": "no db"}}})
    r = feature_actions.stuck(a)
    info = by_name(r.ask["choice_info"])
    assert r.ask["choices"] == ["skip", "edit", "retry", "stop"] and info["skip"]["default"]
    assert info["skip"]["description"] == "move AC-2 to the end of the list and go on with the next criterion"
    r = actions.cannot_run(a, "npm test", "sh: npm: not found", "the red test")
    assert [c["name"] for c in r.ask["choice_info"]] == ["recheck", "skip", "stop"]
    assert r.ask["choice_info"][0]["label"] == "Check again" and r.ask["choice_info"][0]["default"]


def test_the_skip_menu_as_a_question_and_its_answers():
    units = [{"name": "lint", "band": "optional", "steps": ["lint"]}, {"name": "cover", "band": "deferred", "steps": ["cover"]}]
    q = ship.skip_question(units)
    assert q["id"] == "skip" and q["multiple"] is True
    assert [(o["label"], o["recommended"]) for o in q["options"]] == [("lint", False), ("cover", False)]
    assert q["options"][1]["description"].startswith("Deferred")
    payload = ship.skip_payload({"answers": {"skip": ["cover"]}, "reasons": {"cover": "CI covers it"}})
    assert ship.parse_skips(payload, units)[0] == [{"step": "cover", "band": "deferred", "reason": "CI covers it"}]
    no_reason = ship.skip_payload({"answers": {"skip": ["lint"]}})
    assert ship.parse_skips(no_reason, units)[2] == "skipping lint needs a reason"
    old = {"skip": {"lint": "no linter yet"}}
    assert ship.skip_payload(old) is old and ship.parse_skips(old, units)[0][0]["reason"] == "no linter yet"


def test_auto_mode_answers_a_multiple_question_with_every_recommended_option():
    q = {"kind": "clarify", "title": "three questions", "options": ["approve", "reject"], "questions": [
        {"id": "run", "question": "?", "options": [{"label": "this machine", "recommended": True}, {"label": "dev container"}]},
        {"id": "knowledge", "question": "?", "multiple": True,
         "options": [{"label": "domain", "recommended": True}, {"label": "data", "recommended": True}, {"label": "x"}]},
        {"id": "none", "question": "?", "multiple": True, "options": [{"label": "a"}]}]}
    got = run_mode.decide("auto", "clarify", q)
    assert got["payload"]["answers"] == {"run": "this machine", "knowledge": ["domain", "data"]}
