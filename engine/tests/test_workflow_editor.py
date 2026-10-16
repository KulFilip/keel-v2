"""The workflow editor's helpers (Build › Workflows): errors at their line, the file as keel writes it, the starter."""

import yaml

from keel_engine.workflows.editor import STEP_ORDER, error_lines, normalize, starter
from keel_engine.workflows.templates import templates
from keel_engine.workflows.validate import validate_yaml

BAD = """\
name: Bad
keel_rules: false
steps:
  - id: a
    kind: agent
    name: a
  - id: g
    kind: gate
    name: g
    back: nowhere
  - { id: c, kind: code, name: c, action: frobnicate }
  - id: g
    kind: gate
    name: again
"""


def lines_of(text):
    return error_lines(text, validate_yaml(text)["errors"])


def test_each_error_sits_at_the_step_and_key_it_names():
    got = {(x["line"], x["message"]) for x in lines_of(BAD)}
    assert (4, "Step 'a': an agent step needs an agent.") in got          # no agent key: the step's line
    assert (10, "Step 'g': back target 'nowhere' does not exist.") in got  # the back key
    assert (11, "Step 'c': unknown action 'frobnicate'.") in got           # a one-line step
    assert (12, "Step id 'g' is used more than once.") in got              # the second one


def test_a_message_with_several_fields_gives_a_line_each_and_a_syntax_error_its_line():
    text = "name: x\nsteps:\n  - id: a\n    kind: robot\n    name: a\n  - id: b\n    kind: agent\n"
    got = lines_of(text)
    assert [x["line"] for x in got] == [4, 6]
    assert got[0]["message"].startswith("steps.0.kind: ") and got[1]["message"] == "steps.1.name: Field required"
    broken = "name: x\nsteps:\n  - id: a\n   kind: agent\n"
    (only,) = lines_of(broken)
    assert only["line"] == 4 and only["message"].startswith("The YAML does not parse: ") and "\n" not in only["message"]


def test_a_valid_workflow_has_no_lines_and_the_api_answers_lines_and_formatted(client):
    assert lines_of(starter("x")) == []
    r = client.post("/workflows/validate", json={"yaml": BAD}).json()
    assert not r["ok"] and r["errors"] and {x["line"] for x in r["lines"]} >= {4, 10, 11, 12}
    assert r["formatted"].startswith("name: Bad\nkeel_rules: false\n\nsteps:")      # it parses: keel can tidy it
    ok = client.post("/workflows/validate", json={"yaml": "name: Ok\nkeel_rules: false\nsteps:\n- {name: r, id: r, kind: code, action: report}\n"}).json()
    assert ok["ok"] and ok["lines"] == []
    assert ok["formatted"] == "name: Ok\nkeel_rules: false\n\nsteps:\n\n  - id: r\n    kind: code\n    name: r\n    action: report\n"


def test_the_starter_is_valid_small_and_in_keel_style(client):
    for rules in (True, False):
        text = starter("My workflow", "ludus-engine-my-workflow", rules)
        r = validate_yaml(text)
        assert r["ok"], r["errors"]
        wf = r["workflow"]
        assert wf.id == "ludus-engine-my-workflow" and wf.name == "My workflow" and wf.keel_rules is rules
        kinds = [s.kind for s in wf.steps]
        assert "agent" in kinds and "gate" in kinds
        assert [s.id for s in wf.steps if s.per_ac] == ["red", "verify_red", "green", "verify_green"]
        assert text.startswith("# My workflow: a small workflow to start from.")
        assert normalize(text) == text                 # already as keel writes it
    # a name YAML would read otherwise is quoted
    odd = starter("yes: no #1")
    assert yaml.safe_load(odd)["name"] == "yes: no #1" and validate_yaml(odd)["ok"]
    got = client.get("/workflows/starter", params={"name": "Hotfix", "id": "p-hotfix", "keel_rules": "false"}).json()["yaml"]
    assert "id: p-hotfix\nname: Hotfix\nversion: 1\nkeel_rules: false\n" in got


def test_normalize_orders_keys_indents_and_keeps_the_head_comments():
    messy = ("# My flow\n# keeps this\nsteps:\n- name: b\n  kind: branch\n  id: b\n  no: end\n  when: {marker: X}\n"
             "- action: report\n  id: r\n  kind: code\n  name: report it\n  markers: [A, B]\nkeel_rules: false\nname: Mine\nid: mine\n")
    out = normalize(messy)
    assert out == ("# My flow\n# keeps this\n\nid: mine\nname: Mine\nkeel_rules: false\n\nsteps:\n\n"
                   "  - id: b\n    kind: branch\n    name: b\n    'no': end\n    when:\n      marker: X\n\n"
                   "  - id: r\n    kind: code\n    name: report it\n    action: report\n    markers: [A, B]\n")
    assert yaml.safe_load(out)["steps"][0]["no"] == "end"       # the bare no: key stays the key 'no', not false
    assert normalize(out) == out


def test_normalize_keeps_every_comment_by_leaving_a_commented_body_as_it_is():
    body = "name: Mine\n# why this step\nsteps:\n- {id: r, kind: code, name: r, action: report}  # one line\n"
    assert normalize(body) == body
    assert normalize("name: x\nsteps: [\n") == "name: x\nsteps: [\n"        # does not parse: unchanged
    # keel's own templates (comments everywhere) stay exactly as they are
    for t in templates():
        if t.yaml:
            assert normalize(t.yaml).rstrip("\n") == t.yaml.rstrip("\n")


def test_step_order_starts_with_the_documented_keys():
    assert STEP_ORDER[:4] == ("id", "kind", "name", "phase") and STEP_ORDER[-1] == "instructions"
    assert "from" in STEP_ORDER and "with" in STEP_ORDER
