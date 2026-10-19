"""keel init asks its three questions with defaults, shows the real plan, and records the answers."""
from pathlib import Path

import yaml

from conftest import decide, start, wait
from keel_engine.runtime import init_gates


def test_questions_plan_and_answers_reach_the_config(client, repo):
    tid = start(client, repo, workflow="init", title="keel init")
    s = wait(client, tid)
    while s["status"] == "waiting" and s["waiting"]["step"] != "questions":
        s = decide(client, tid)
    w = s["waiting"]
    assert w["title"] == "three questions" and "1. Where does the app run" in w["detail"] and "3. Which knowledge sections" in w["detail"]
    # 0.19.0 a clarify form with fixed ids; an old client's typed answer (send back with words) still works
    assert w["kind"] == "clarify" and [q["id"] for q in w["questions"]] == ["run", "services", "knowledge"]
    assert w["labels"] == {"approve": "Use these answers", "reject": "Use my answers"}
    s = decide(client, tid, "reject", why="1 dev container, 3 conventions and data")
    w = s["waiting"]
    assert w["step"] == "plan_gate"
    assert "knowledge sections conventions, data" in w["detail"] and "runs_on: dev container" in w["detail"]
    assert "chore(setup): keel init" in w["detail"]
    while s["status"] == "waiting":
        s = decide(client, tid)
    cfg = yaml.safe_load((Path(repo) / ".keel" / "config.yml").read_text())
    assert cfg["init"]["knowledge_sections"] == ["conventions", "data"] and cfg["init"]["runs_on"] == "dev container"


def test_answers_are_read_from_free_text(tmp_path):
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")
    d = init_gates.defaults(str(tmp_path))
    assert d["services"] == "use docker-compose.yml" and d["knowledge_sections"] == init_gates.SECTIONS
    a = init_gates.answers(str(tmp_path), "later; I run them myself; sections: none")
    assert a["runs_on"] == "decide later" and a["services"] == "I run them myself" and a["knowledge_sections"] == []
    assert "docker-compose.yml exists" in init_gates.questions(str(tmp_path))


def test_numbered_answers_are_read_per_question(tmp_path):
    # 0.18.17 a word counts only in its own part: "later" in part 3 is not runs_on, "3 none" means no sections
    root = str(tmp_path)
    a = init_gates.answers(root, "1 this machine · 2 none · 3 none (the knowledge base is refreshed later)")
    assert a["runs_on"] == "this machine" and a["services"] == "none" and a["knowledge_sections"] == []
    a = init_gates.answers(root, "1. decide later; 2. I run them myself; 3. conventions, data")
    assert a["runs_on"] == "decide later" and a["services"] == "I run them myself"
    assert a["knowledge_sections"] == ["conventions", "data"]
    a = init_gates.answers(root, "1 dev container\n3 none")
    assert a["runs_on"] == "dev container" and a["services"] == "none" and a["knowledge_sections"] == []
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")
    a = init_gates.answers(root, "2 use it · 3 domain")
    assert a["runs_on"] == "this machine" and a["services"] == "use docker-compose.yml" and a["knowledge_sections"] == ["domain"]
    # an old unnumbered answer is still read as a whole
    a = init_gates.answers(root, "this machine, conventions only, sections are refreshed later")
    assert a["runs_on"] == "this machine" and a["knowledge_sections"] == ["conventions"]
    assert init_gates.answers(root, "no sections")["knowledge_sections"] == []


def test_init_starts_one_librarian_per_chosen_section(client, repo, monkeypatch):
    from keel_engine.models import fake as fake_mod
    real = fake_mod._plan
    got = []

    def plan(req):
        if req.agent == "librarian":
            got.append(req.section)
        return real(req)
    monkeypatch.setattr(fake_mod, "_plan", plan)
    tid = start(client, repo, workflow="init", title="keel init")
    s = wait(client, tid)
    while s["status"] == "waiting":
        s = decide(client, tid, "reject", why="3 conventions, data") if s["waiting"]["step"] == "questions" else decide(client, tid)
    assert s["status"] == "done", s
    assert sorted(got) == ["conventions", "data"]


def test_clarify_answers_reach_the_config(client, repo):
    tid = start(client, repo, workflow="init", title="keel init")
    s = wait(client, tid)
    while s["status"] == "waiting" and s["waiting"]["step"] != "questions":
        s = decide(client, tid)
    s = decide(client, tid, payload={"answers": {"run": "dev container", "services": "I run them myself",
                                                 "knowledge": ["conventions", "data"]}})
    w = s["waiting"]
    assert w["step"] == "plan_gate"
    assert "knowledge sections conventions, data" in w["detail"] and "runs_on: dev container" in w["detail"]
    assert "services: I run them myself" in w["detail"]


def test_clarify_questions_recommend_the_defaults(tmp_path):
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")
    qs = {q["id"]: q for q in init_gates.clarify_questions(str(tmp_path))}
    assert [o["label"] for o in qs["run"]["options"]] == ["this machine", "dev container", "decide later"]
    assert [o["label"] for o in qs["run"]["options"] if o["recommended"]] == ["this machine"]
    assert [o["label"] for o in qs["services"]["options"] if o["recommended"]] == ["use docker-compose.yml"]
    assert qs["knowledge"]["multiple"] is True
    assert [o["label"] for o in qs["knowledge"]["options"] if o["recommended"]] == init_gates.SECTIONS
    fast = {q["id"]: q for q in init_gates.clarify_questions(str(tmp_path), fast=True)}
    assert not any(o["recommended"] for o in fast["knowledge"]["options"])
    bare = {q["id"]: q for q in init_gates.clarify_questions(str(tmp_path / "none"))}
    assert [o["label"] for o in bare["services"]["options"]] == ["none", "I run them myself", "generate a compose file"]


def test_from_answers_maps_labels_lists_and_own_words(tmp_path):
    (tmp_path / "docker-compose.yml").write_text("services: {}\n")
    root = str(tmp_path)
    assert init_gates.from_answers(root, {}) == init_gates.defaults(root)
    a = init_gates.from_answers(root, {"run": "decide later", "services": "use docker-compose.yml", "knowledge": []})
    assert a["runs_on"] == "decide later" and a["services"] == "use docker-compose.yml" and a["knowledge_sections"] == []
    a = init_gates.from_answers(root, {"run": "in a devcontainer please", "knowledge": "only conventions and data"})
    assert a["runs_on"] == "dev container" and a["knowledge_sections"] == ["conventions", "data"] and a["said"]
    assert init_gates.from_answers(root, {"knowledge": ["DATA", "nope"]})["knowledge_sections"] == ["data"]
    assert init_gates.from_answers(root, {"services": "generate one"}, fast=True)["services"] == "generate a compose file"


def test_plan_shows_the_configured_test_commands(tmp_path):
    # 0.18.17 the plan read only detection and said "none found" while .keel/config.yml named the commands
    (tmp_path / "backend").mkdir()
    (tmp_path / ".keel").mkdir()
    (tmp_path / ".keel" / "config.yml").write_text(
        "version: 4\nbackend: {dir: backend}\ncommands:\n  api_test_module: vendor/bin/phpunit\n"
        "  api_test_ac: vendor/bin/phpunit --filter '{AC_ID}'\n")
    text = init_gates.plan(str(tmp_path), init_gates.defaults(str(tmp_path)))
    assert "test command: cd backend && vendor/bin/phpunit" in text
    assert "one criterion: cd backend && vendor/bin/phpunit --filter '{AC_ID}'" in text and "none found" not in text


def test_detection_finds_a_backend_one_folder_down(tmp_path):
    from keel_engine.runtime import actions
    from keel_engine.tools import testcmd

    root = str(tmp_path)
    (tmp_path / "frontend").mkdir()
    (tmp_path / "frontend" / "package.json").write_text('{"scripts": {"build": "vite build"}}')
    (tmp_path / "backend").mkdir()
    (tmp_path / "backend" / "composer.json").write_text('{"require-dev": {"phpunit/phpunit": "^11"}}')
    assert testcmd.detected_dir(root) == "backend"
    assert testcmd.detected(root) == "cd backend && vendor/bin/phpunit"
    assert testcmd.detected(root, "AC-6") == "cd backend && vendor/bin/phpunit --filter 'AC6'"
    assert testcmd.config_commands(root) == {"api_test_ac": "vendor/bin/phpunit --filter '{AC_ID}'",
                                             "api_test_module": "vendor/bin/phpunit"}
    text = init_gates.plan(root, init_gates.defaults(root))
    assert "test command: cd backend && vendor/bin/phpunit" in text and "dir: backend" in text
    cfg = actions._detect(root)
    assert cfg["backend"]["dir"] == "backend" and cfg["commands"]["api_test_module"] == "vendor/bin/phpunit"
    # two backends and none named like one: no guess
    (tmp_path / "frontend").rename(tmp_path / "svc")
    (tmp_path / "svc" / "pom.xml").write_text("<project/>")
    (tmp_path / "backend").rename(tmp_path / "other")
    assert testcmd.detected_dir(root) == "" and testcmd.detected(root) is None


def test_detection_uses_the_projects_own_stack_pack(tmp_path):
    from keel_engine.tools import testcmd

    root = str(tmp_path)
    (tmp_path / "pom.xml").write_text("<project/>")
    (tmp_path / ".keel" / "stacks").mkdir(parents=True)
    (tmp_path / ".keel" / "stacks" / "mine.yml").write_text(
        "name: mine\nlane: api\ncommands:\n  api_test_module: make test\n  api_test_ac: make test T='{AC}'\n")
    assert testcmd.detected(root) == "make test" and testcmd.detected(root, "AC-2") == "make test T='AC-2'"
    assert testcmd.config_commands(root) == {"api_test_ac": "make test T='{AC}'", "api_test_module": "make test"}
    assert "test command: make test" in init_gates.plan(root, init_gates.defaults(root))
