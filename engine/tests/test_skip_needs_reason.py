"""`payload.skip: true` skips a for_each item like the choice "skip": its reason is required too."""
from keel_engine.runtime.compiler import answer_problem

ITEM_GATE = {"kind": "gate", "title": "check the item", "options": ["approve"], "choices": ["approve", "skip"],
             "choice_info": [{"name": "approve", "label": "Approve", "why": "none", "default": True},
                             {"name": "skip", "label": "Skip this item", "why": "required"}]}


def test_skip_true_without_a_reason_is_refused():
    assert answer_problem(ITEM_GATE, "approve", None, {"choice": "skip"})[0].startswith("Say why")
    assert answer_problem(ITEM_GATE, "approve", None, {"skip": True})[0].startswith("Say why")
    assert answer_problem(ITEM_GATE, "approve", "not our code", {"skip": True}) is None
    assert answer_problem(ITEM_GATE, "approve", None, {"skip": True, "reason": "duplicate"}) is None
    assert answer_problem(ITEM_GATE, "approve", None, None) is None
