"""Scenario (0.18.12): the spring-petclinic e2e, replayed on the fake model.

The real run: the explorer tagged the owner page's criteria [WEB]; the project's page tests are Java MockMvc tests, so
the guard put them in the api lane and refused them for a [WEB] criterion in red. The red agent asked to re-tag them
[API]; the amendment was approved, but the criteria lines and keel's own list still said [WEB], so red was refused
again: "the amendment changed nothing" twice, then "AC-004 is blocked" four times, until the driver stopped.
"""

from pathlib import Path

from conftest import decide, start, to_loop, wait
from test_flows_base import values
from test_flows_feature import by_step
from test_v02 import commit_all, configure, write
from keel_engine.models import fake as fake_mod
from keel_engine.runtime import feature_actions

SPEC = "docs/specs/player-ranks.md"
ONE_WEB = [{"id": "AC-1", "layer": "API", "title": "Player ranks: the main case works"},
           {"id": "AC-2", "layer": "WEB", "title": "Player ranks: the ranks page shows each player's rank"}]
RETAG = ("\n## Amendments\n\n### 2026-10-18 — AC-2\nWas: tagged [WEB] (wording unchanged).\n"
         "Now: tagged [API]. Behaviour and wording stay as approved.\n"
         "Why: the page is server-rendered; its tests are backend tests, which keel reads as api-test, not [WEB].\n")


def web_project(repo):
    """A project with web tests of its own, so the explorer's [WEB] tag stays (the retag is the amendment's)."""
    configure(repo, "version: 4\ncommands:\n  web_test_ac: npx vitest run -t {AC}\n")


def red_asks_retag(monkeypatch):
    """AC-2's first red answers AMEND (re-tag it [API]); the amendment explorer writes the retag block."""
    monkeypatch.setattr(fake_mod, "default_acs", lambda title: [dict(a) for a in ONE_WEB])
    reds = []

    def red(req, real):
        reds.append(req)
        if req.ac["id"] == "AC-2" and len([r for r in reds if r.ac["id"] == "AC-2"]) == 1:
            return None, "", ("The page is server-rendered; its tests are Java tests that keel puts in the api lane.\n"
                              "AMEND: re-tag AC-2 as [API]"), {}
        return real(req)

    def amend(req, real):
        old = (Path(req.root) / SPEC).read_text()
        return SPEC, old.rstrip() + "\n" + RETAG, "Amendment written.\nREOPEN: none\nCONTRACT: no", {}
    seen = by_step(monkeypatch, {"red": red, "spec amendment": amend})
    return seen, reds


def test_an_approved_retag_changes_the_criterion_the_spec_and_the_guard(client, repo, monkeypatch):
    web_project(repo)
    seen, reds = red_asks_retag(monkeypatch)
    tid = start(client, repo)
    s = to_loop(client, tid)
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-1"
    assert [a["layer"] for a in s["acs"]] == ["API", "WEB"]
    s = decide(client, tid)
    w = s["waiting"]
    assert w["step"] == "amend_gate", w
    assert "On approval keel changes the criteria lines too: AC-2 [WEB] → [API]" in w["detail"]
    s = decide(client, tid)
    # applied: keel's list, the spec's criteria line (the block stays as the record), and the next red round
    assert [a["layer"] for a in s["acs"]] == ["API", "API"]
    text = (Path(repo) / SPEC).read_text()
    assert "- **AC-2** [API] Player ranks: the ranks page shows" in text and "Was: tagged [WEB]" in text
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-2", s
    again = [r for r in reds if r.ac["id"] == "AC-2"]
    assert len(again) == 2 and again[1].ac["layer"] == "API" and again[1].toolbox.lane == "api"
    assert "Current criterion: AC-2 [API]" in again[1].prompt
    assert any("criteria changed by the amendment: AC-2 [WEB] → [API]" in x for x in s["gate_log"])
    assert [n for n in seen if n.step_name == "spec amendment"].__len__() == 1, "no second amendment round"
    assert values(client, tid)["acs"][1]["layer"] == "API"


def test_an_amendment_restates_a_criterion_in_full_and_keel_rewrites_it():
    spec = ("# Ranks\n\n## Acceptance criteria\n\n- **AC-1** [API] scores are saved\n- **AC-2** [WEB] the board shows\n"
            "  the ranks of every player\n- **AC-3** [WEB] the board has an empty state\n\n## Plan\n\nAC-2 [WEB] first.\n"
            "\n## Amendments\n\n### 2026-10-18 — AC-2, AC-3\nWas: - **AC-2** [WEB] the board shows the ranks\n"
            "Now:\n- **AC-2** [API] the ranks page shows the ranks,\n  ties share a rank\n- **AC-3** [API] (wording unchanged)\n"
            "Why: measured.\n")
    text, changed = feature_actions.apply_amendments(spec)
    assert changed == ["AC-2 [WEB] → [API]", "AC-2 reworded", "AC-3 [WEB] → [API]"]
    assert "- **AC-2** [API] the ranks page shows the ranks, ties share a rank\n- **AC-3** [API] the board has an empty state" in text
    assert "Was: - **AC-2** [WEB] the board shows the ranks" in text, "the block is the record: it stays"
    assert "AC-2 [WEB] first." in text, "only the criteria lines change"
    assert feature_actions.apply_amendments(text) == (text, []), "applying it again changes nothing"
    # free words under Now: are not a criterion line: nothing is guessed
    loose = "### d — AC-1\nWas: the main case works.\nNow: the main case works for ties too.\nWhy: ties."
    assert feature_actions.amended_criteria(loose) == {}
    ranged = "### d — AC-001, AC-004\nNow: AC-001 to AC-003 are tagged [API].\nWhy: [WEB] is wrong here."
    assert feature_actions.amended_criteria(ranged) == {i: {"layer": "API"} for i in ("AC-001", "AC-002", "AC-003")}


# ------------------------------------------------------------------ B: no web layer, no [WEB] criteria

def petclinic(root: Path) -> str:
    """A server-rendered Spring MVC app like spring-petclinic: Gradle, Thymeleaf pages, Java MockMvc tests."""
    for rel, body in {"gradlew": "#!/bin/sh\n", "build.gradle": "plugins { id 'java' }\n",
                      "src/main/resources/templates/owners/ownerDetails.html": "<html></html>\n",
                      "src/main/resources/static/resources/css/petclinic.css": "body {}\n",
                      "src/test/java/org/x/owner/OwnerControllerTests.java": "class OwnerControllerTests {}\n"}.items():
        (root / rel).parent.mkdir(parents=True, exist_ok=True)
        (root / rel).write_text(body)
    return str(root)


def test_a_project_has_a_web_layer_only_with_web_tests_a_frontend_or_a_web_stack(tmp_path):
    from keel_engine.runtime import stacks

    root = petclinic(tmp_path / "petclinic")
    assert stacks.has_web_layer(root) is False
    cmd = petclinic(tmp_path / "with-cmd")
    (Path(cmd) / ".keel").mkdir()
    (Path(cmd) / ".keel/config.yml").write_text("version: 4\ncommands:\n  web_test_module: npx vitest run\n")
    assert stacks.has_web_layer(cmd) is True
    front = petclinic(tmp_path / "with-front")
    (Path(front) / "apps/web").mkdir(parents=True)          # frontend.dir's default
    assert stacks.has_web_layer(front) is True
    ts = petclinic(tmp_path / "with-ts")
    (Path(ts) / "tsconfig.json").write_text("{}\n")           # keel's ts-react stack (lane: web)
    assert stacks.has_web_layer(ts) is True


def test_the_spec_prompt_says_page_tests_are_backend_tests_without_a_web_layer(tmp_path):
    from keel_engine.runtime import prompts

    def spec_prompt(root):
        return prompts.task_prompt(agent="explorer", phase="spec", step_name="spec", title="Visits", root=root, ac=None,
                                   acs=[], feedback=None)
    assert prompts.NO_WEB in spec_prompt(petclinic(tmp_path / "p"))
    web = petclinic(tmp_path / "w")
    (Path(web) / "tsconfig.json").write_text("{}\n")
    assert prompts.NO_WEB not in spec_prompt(web)


def test_without_a_web_layer_keel_tags_web_criteria_api_and_says_so(client, repo, monkeypatch):
    monkeypatch.setattr(fake_mod, "default_acs", lambda title: [dict(a) for a in ONE_WEB])
    seen = by_step(monkeypatch, {})
    tid = start(client, repo)
    s = wait(client, tid)
    w = s["waiting"]
    assert w["step"] == "spec_gate"
    assert [a["layer"] for a in s["acs"]] == ["API", "API"]
    assert "keel tagged these [API]: this project has no separate web tests (its pages are tested by backend tests): AC-2" \
        in w["detail"]
    assert "- **AC-2** [API] Player ranks: the ranks page shows" in (Path(repo) / SPEC).read_text()
    assert sorted(r.item["id"] for r in seen if r.item) == ["api", "data"], "no web explorer"
    spec = [r for r in seen if r.step_name == "spec"][0]
    assert "This project has no separate web tests" in spec.prompt
    s = to_loop(client, tid, s)
    assert s["waiting"]["step"] == "ac_gate" and s["ac"] == "AC-1"
