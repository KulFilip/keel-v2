from keel_engine.runtime import spec_check
from conftest import decide, start, wait

GOOD = """# Leaderboard

## Request
Show ranks.

## Goal
Players see where they stand, so they come back to climb.

## User stories
- As a player, I want to see my rank, so that I know where I stand.

## Decisions
- user means a named entity

## Findings (evidence)
- Scores are stored per player in `src/scores/store.py:12`; no endpoint reads them yet.

## Acceptance criteria
- **AC-1** [API] Given scores, when GET /leaderboard is called, then it returns players ordered by rank.
- **AC-2** [WEB] Given the page, when it loads, then every player's rank is shown.

## Test layers
- AC-1: unit (the ranking), integration (GET /leaderboard); e2e: not needed
- AC-2: component test; e2e: not needed, one screen

## Validation and security rules
- Only public names are returned.

## Edge cases
- No players: an empty list.

## Risks and cost
- Two files, no migration, no deploy order.

## Definition of done
- [ ] Every criterion is green on its layers.

## Mockup
```
loading: [ spinner ]   empty: "No players yet"   filled: 1 ana 9   error: "Could not load"
```

## Request path
```
GET /leaderboard   NEW
```

## Out of scope
- login
"""
ACS = [{"id": "AC-1", "layer": "API", "title": "Given scores, when GET /leaderboard is called, then it returns players ordered by rank."},
       {"id": "AC-2", "layer": "WEB", "title": "Given the page, when it loads, then every player's rank is shown."}]


def test_a_complete_spec_has_nothing_missing():
    assert [f for f in spec_check.check(GOOD, ACS) if f["level"] == "fix"] == []
    assert spec_check.describe(spec_check.check(GOOD, ACS)) == "Spec check: nothing missing."


def test_a_screen_without_a_mockup_and_an_api_without_a_path_are_found():
    bad = GOOD.split("## Mockup")[0] + "## Out of scope\n- login\n"
    texts = [f["text"] for f in spec_check.check(bad, ACS) if f["level"] == "fix"]
    assert any("no Mockup" in t for t in texts) and any("no Request path" in t for t in texts)
    partial = GOOD.replace('empty: "No players yet"   filled: 1 ana 9   error: "Could not load"', "just a table")
    assert any("four states" in f["text"] for f in spec_check.check(partial, ACS))


def test_vague_and_incomplete_criteria_are_noted_not_blocked():
    acs = [{"id": "AC-1", "layer": "API", "title": "Given ties, when ranked, then either order is acceptable."},
           {"id": "AC-2", "layer": "API", "title": "The endpoint is fast."}]
    notes = [f["text"] for f in spec_check.check(GOOD, acs)]
    assert any("AC-1 is vague" in n for n in notes) and any("AC-2 has no “then”" in n for n in notes)
    assert all(f["level"] == "note" for f in spec_check.check(GOOD, acs) if "AC-" in f["text"])


def test_the_engine_sends_a_spec_back_once_when_something_clear_is_missing(client, repo, monkeypatch):
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan
    feedback = []

    def plan(req):
        if req.agent == "explorer" and req.phase == "spec" and req.step_name == "spec":
            feedback.append(req.feedback)
            path, content, answer, data = real(req)
            if len(feedback) == 1:      # the first spec has a [WEB] criterion and no mockup
                acs = [{"id": "AC-1", "layer": "WEB", "title": "Given the page, when it loads, then the rank shows."}]
                text = "# T\n\n## Acceptance criteria\n- **AC-1** [WEB] Given the page, when it loads, then the rank shows.\n"
                return path, text, answer, {"acs": acs, "spec": path}
            return path, content, answer, data
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)
    tid = start(client, repo, acs=None, settings={"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "spec_check": True})
    s = wait(client, tid)
    assert len(feedback) == 2 and "spec check found problems" in feedback[1] and "no Mockup" in feedback[1]
    assert "No “Goal” section" in feedback[1] and "No “Test layers” section" in feedback[1]
    assert s["waiting"]["step"] == "spec_gate"
    assert "Spec check" in s["waiting"]["detail"]


def test_cases_of_one_rule_split_into_criteria_are_sent_back_to_be_merged():
    # Real feature run: three criteria differing only in the percent; the first code already met all of them.
    acs = [{"id": "AC-5", "title": "Given a cart, when applyCoupon(cart, 50.5) is called, then it throws an error naming percent"},
           {"id": "AC-6", "title": "Given a cart, when applyCoupon(cart, -1) is called, then it throws an error naming percent"},
           {"id": "AC-7", "title": "Given a cart, when applyCoupon(cart, 101) is called, then it throws an error naming percent"},
           {"id": "AC-1", "title": "Given a cart with total 100, when applyCoupon(cart, 50) is called, then it returns 50"},
           {"id": "AC-2", "title": "Given the player's best score, when the user's rank is read, then it is shown"},
           {"id": "AC-3", "title": "Given a cart, when an item 'apple' is added twice, then its quantity is the sum"}]
    found = [f for f in spec_check.check("", acs) if "cases of one rule" in f["text"]]
    assert len(found) == 1 and found[0]["level"] == "fix"
    assert found[0]["text"].startswith("AC-5, AC-6, AC-7 differ only in their values")


def fixes(text, acs=ACS, outside=False):
    return [f["text"] for f in spec_check.check(text, acs, outside) if f["level"] == "fix"]


def test_a_spec_without_the_templates_sections_is_sent_back():
    """keel v1's template (content/templates/spec.md): Goal, User stories, Findings, Test layers, Validation and security
    rules, Edge cases, Risks and cost and Definition of done are asked for; the old thin layout is not enough."""
    thin = GOOD.split("## Goal")[0] + "## Acceptance criteria" + GOOD.split("## Acceptance criteria")[1].split("## Test layers")[0] \
        + "## Mockup" + GOOD.split("## Mockup")[1]
    found = fixes(thin)
    for name in ("Goal", "User stories", "Findings (evidence)", "Test layers", "Validation and security rules", "Edge cases",
                 "Risks and cost", "Definition of done"):
        assert any(f"No “{name}” section" in t for t in found), name
    assert not any("“Acceptance criteria”" in t for t in found)
    # a heading with only the template's comment is empty
    assert any("No “Goal” section" in t for t in fixes(GOOD.replace("Players see where they stand, so they come back to climb.",
                                                                  "<!-- why this exists -->")))


def test_every_criterion_needs_a_test_layer_and_stories_their_form():
    no_layer = GOOD.replace("- AC-2: component test; e2e: not needed, one screen\n", "")
    assert any(t.startswith("Test layers names no layer for AC-2") for t in fixes(no_layer))
    padded = [dict(a, id=a["id"].replace("AC-", "AC-00")) for a in ACS]          # AC-001 in the criteria, AC-1 in the layers
    assert not any("Test layers" in t for t in fixes(GOOD, padded))
    assert any("As a <role>, I want" in t for t in fixes(GOOD.replace("- As a player, I want to see my rank, so that I know "
                                                                     "where I stand.", "- Players see ranks.")))


def test_outside_facts_need_unverified_and_open_questions():
    assert not any("Unverified" in t for t in fixes(GOOD))
    assert any("Unverified and open questions" in t for t in fixes(GOOD, outside=True))
    cited = GOOD.replace("no endpoint reads them yet.", "no endpoint reads them yet; the payload: https://docs.example.com/eta")
    assert any("Unverified and open questions" in t for t in fixes(cited))
    answered = cited + "\n## Unverified and open questions\n- Unverified: the ETA is UTC; confirm with the vendor.\n"
    assert not any("Unverified" in t for t in fixes(answered))
    assert spec_check.outside_facts("", {"web_docs_text": "CONFIRMED ..."}) and not spec_check.outside_facts("Show ranks", {})
    assert spec_check.outside_facts("", {"seed": {"evidence": "see https://developers.example.com/webhooks"}})


def test_the_gate_names_what_is_missing_apart_from_the_warnings():
    shown = spec_check.describe([{"level": "fix", "text": "No “Goal” section"}, {"level": "note", "text": "AC-1 is vague"}])
    missing, warnings = shown.split("Spec check (warnings, you decide):")
    assert "Spec check, missing" in missing and "No “Goal” section" in missing and "AC-1 is vague" in warnings


def test_keels_spec_template_has_every_section_the_check_asks_for():
    text = open(spec_check.template_path()).read()
    names = [m.lower() for m in spec_check.sections(text)]
    for n in spec_check.SECTION_ORDER:
        assert n.lower() in names, n
    assert names.index("goal") < names.index("acceptance criteria") < names.index("test layers") < names.index("plan")
