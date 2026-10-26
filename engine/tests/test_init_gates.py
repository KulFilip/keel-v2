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
    assert w["title"] == "four questions" and "1. Where does the app run" in w["detail"] and "3. Which knowledge sections" in w["detail"]
    # 0.19.0 a clarify form with fixed ids; an old client's typed answer (send back with words) still works
    # 0.18.22 the layout is asked too while the config names none
    assert w["kind"] == "clarify" and [q["id"] for q in w["questions"]] == ["run", "services", "knowledge", "layout"]
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


def test_a_rerun_keeps_the_sections_that_exist(tmp_path):
    # 0.18.22 keel v1: confirming again adds; a section that exists is kept, not rebuilt, unless it is ticked
    root = str(tmp_path)
    (tmp_path / ".keel").mkdir()
    (tmp_path / ".keel" / "config.yml").write_text("layout: keel\ninit:\n  knowledge_sections: [conventions, data]\n")
    (tmp_path / ".keel" / "knowledge").mkdir()
    (tmp_path / ".keel" / "knowledge" / "conventions.md").write_text("# conventions\n")
    d = init_gates.defaults(root)
    assert d["write_sections"] == ["data"] and d["knowledge_sections"] == ["conventions", "data"]
    qs = {q["id"]: q for q in init_gates.clarify_questions(root)}
    know = {o["label"]: o for o in qs["knowledge"]["options"]}
    assert not know["conventions"]["recommended"] and "kept" in know["conventions"]["description"]
    assert [o for o in know if know[o]["recommended"]] == ["data"]
    assert "layout" not in qs, "the config names a layout: not asked again"
    a = init_gates.from_answers(root, {"knowledge": ["domain"]})
    assert a["write_sections"] == ["domain"] and a["knowledge_sections"] == ["domain", "conventions"]
    a = init_gates.from_answers(root, {"knowledge": ["conventions"]})
    assert a["write_sections"] == ["conventions"], "ticked: written again"
    assert init_gates.answers(root, "3 none")["write_sections"] == [] and \
        init_gates.answers(root, "3 none")["knowledge_sections"] == ["conventions"]
    text = init_gates.plan(root, init_gates.defaults(root))
    assert "Write the knowledge sections data" in text and "Kept as they are (they exist): conventions" in text
    assert "only its init: block is written" in text
    # every section there and chosen before: a re-run writes none
    (tmp_path / ".keel" / "knowledge" / "data.md").write_text("# data\n")
    assert init_gates.defaults(root)["write_sections"] == []


def test_a_rerun_records_the_new_answers_in_the_config(tmp_path):
    from keel_engine.runtime import actions

    (tmp_path / ".keel").mkdir()
    f = tmp_path / ".keel" / "config.yml"
    f.write_text("# mine\nversion: 4\ncommands:\n  unit_tests: make test\ninit:\n  knowledge_sections: [conventions]\n")
    a = actions.ActionInput(root=str(tmp_path), phase="setup", title="init", ac=None, acs=[], fake=True, flow="init",
                            init={"runs_on": "this machine", "services": "none", "knowledge_sections": ["conventions", "data"],
                                  "write_sections": ["data"], "said": "x"})
    r = actions.write_config(a)
    cfg = yaml.safe_load(f.read_text())
    assert "init: block" in r.note and f.read_text().startswith("# mine\n")
    assert cfg["init"] == {"runs_on": "this machine", "services": "none", "knowledge_sections": ["conventions", "data"]}
    assert cfg["commands"] == {"unit_tests": "make test"}
    assert "left as it is" in actions.write_config(a).note


def test_the_layout_is_asked_and_written(tmp_path):
    from keel_engine.runtime import actions

    root = str(tmp_path)
    qs = {q["id"]: q for q in init_gates.clarify_questions(root)}
    opts = qs["layout"]["options"]
    assert [o["label"] for o in opts] == ["keel", "repo"] and opts[0]["recommended"] and all(o["description"] for o in opts)
    a = init_gates.from_answers(root, {"layout": "repo"})
    assert a["layout"] == "repo"
    assert init_gates.answers(root, "1 this machine · 4 repo")["layout"] == "repo"
    text = init_gates.plan(root, a)
    assert "Layout: repo — keel's files go in docs/" in text and "under docs/knowledge/" in text
    act = actions.ActionInput(root=root, phase="setup", title="init", ac=None, acs=[], fake=True, flow="init", init=a)
    actions.write_config(act)
    cfg = yaml.safe_load((tmp_path / ".keel" / "config.yml").read_text())
    assert cfg["layout"] == "repo" and "layout" not in cfg["init"] and "write_sections" not in cfg["init"]


def test_the_plan_shows_ports_env_names_and_every_rung(tmp_path):
    root = str(tmp_path)
    (tmp_path / "compose.yml").write_text(
        "services:\n  db:\n    image: postgres\n    ports: ['5433:5432']\n    environment:\n      POSTGRES_PASSWORD: secret\n"
        "  api:\n    build: .\n    environment: [API_KEY=abc, PORT]\n")
    (tmp_path / ".env.example").write_text("# comment\nDATABASE_URL=postgres://u:p@h/db\nexport STRIPE_KEY=sk_live_x\n")
    text = init_gates.plan(root, init_gates.defaults(root))
    assert "db (5433:5432)" in text and "api (no published port)" in text
    assert "DATABASE_URL, STRIPE_KEY, POSTGRES_PASSWORD, API_KEY, PORT" in text
    assert "secret" not in text and "sk_live" not in text and "abc" not in text, "names only, never values"
    assert " 1. Toolchain: $ check: git" in text and "12. Hook self-test" in text
    # 0.18.57 the default answer "use compose.yml" starts the services (it was skipped as "no commands.services")
    assert "8. Services up and healthy: $ docker compose up -d --wait" in text
    assert "Nothing is deployed, published or deleted." in text


# 0.18.57 e2e: a PHP project whose README says the tests run only in the app container got a plan with a bare
# vendor/bin/phpunit, "Where does the app run?" had no compose-service answer, and "services: use compose.yml" was
# skipped by the ladder as "no commands.services"
COMPOSE = ("services:\n  app:\n    build: .\n    volumes:\n      - .:/var/www/html\n"
           "  db:\n    image: postgres:16\n    ports: ['5432:5432']\n")


def _php_shop(tmp_path, readme: str | None = None):
    (tmp_path / "compose.yml").write_text(COMPOSE)
    (tmp_path / "composer.json").write_text('{"require-dev": {"phpunit/phpunit": "^11"}}\n')
    if readme is not None:
        (tmp_path / "README.md").write_text(readme)
    return str(tmp_path)


def _write(root, init):
    from keel_engine.runtime.actions import ActionInput, _write_config

    _write_config(ActionInput(root=root, phase="setup", title="keel init", ac=None, acs=[], fake=True, flow="init",
                              init=init))
    return yaml.safe_load((Path(root) / ".keel" / "config.yml").read_text())


def test_docs_that_run_the_tests_in_a_container_make_init_run_them_there(tmp_path):
    from keel_engine.runtime import container, ladder

    root = _php_shop(tmp_path, "# Shop\n\nThe tests run only in the app container:\n\n"
                               "    docker compose exec app vendor/bin/phpunit\n")
    hint = init_gates.container_hint(root)
    assert hint["service"] == "app" and hint["from_docs"] and hint["source"] == "README.md:3"
    qs = {q["id"]: q for q in init_gates.clarify_questions(root)}
    run = qs["run"]["options"]
    assert run[0]["label"] == "compose service app" and run[0]["recommended"] and "README.md:3" in run[0]["description"]
    d = init_gates.defaults(root)
    assert d["runs_on"] == "compose service app" and d["services"] == "use compose.yml"
    plan = init_gates.plan(root, d)
    assert "api_test_module: docker compose exec -T app vendor/bin/phpunit" in plan
    assert "$ docker compose exec -T app vendor/bin/phpunit" in plan and "$ docker compose up -d --wait" in plan
    assert "$ vendor/bin/phpunit\n" not in plan + "\n" and "no commands.services" not in plan
    cfg = _write(root, init_gates.from_answers(root, {}))
    cmds = cfg["commands"]
    assert cmds["api_test_module"] == "docker compose exec -T app vendor/bin/phpunit"
    assert cmds["api_test_ac"] == "docker compose exec -T app vendor/bin/phpunit --filter '{AC_ID}'"
    assert cmds["services"] == "docker compose up -d --wait" and cfg["init"]["runs_on"] == "compose service app"
    assert container.in_container(root) and container.preflight_commands(root)
    # the services start before the first command that needs the container; the toolchain is docker, not php
    rungs = ladder.plan(root)
    order = [r["n"] for r in rungs]
    assert order.index(8) < order.index(2) and order.index(8) < order.index(6)
    assert next(r for r in rungs if r["n"] == 8)["cmd"] == "docker compose up -d --wait"
    assert "docker" in rungs[0]["cmd"]


def test_the_compose_answer_is_read_from_labels_and_own_words(tmp_path):
    root = _php_shop(tmp_path, "Run everything inside the `app` container (php is not installed on the host).\n")
    assert init_gates.container_hint(root)["service"] == "app"
    assert init_gates.from_answers(root, {"run": "compose service app"})["runs_on"] == "compose service app"
    assert init_gates.from_answers(root, {"run": "in the app container"})["runs_on"] == "compose service app"
    assert init_gates.answers(root, "1 the db container · 2 use it")["runs_on"] == "compose service db"
    assert init_gates.answers(root, "1 dev container")["runs_on"] == "dev container"
    assert "compose service app" in init_gates.questions(root)


def test_a_compose_app_service_is_offered_but_not_recommended_without_docs(tmp_path):
    root = _php_shop(tmp_path)
    hint = init_gates.container_hint(root)
    assert hint["service"] == "app" and not hint["from_docs"]
    run = {q["id"]: q for q in init_gates.clarify_questions(root)}["run"]["options"]
    assert [o["label"] for o in run if o["recommended"]] == ["this machine"] and "compose service app" in [o["label"] for o in run]
    cfg = _write(root, init_gates.from_answers(root, {}))
    assert cfg["commands"]["api_test_module"] == "vendor/bin/phpunit"
    assert cfg["commands"]["services"] == "docker compose up -d --wait"


def test_services_use_compose_is_honoured_by_an_existing_config(tmp_path):
    from keel_engine.runtime import ladder

    root = _php_shop(tmp_path)
    (tmp_path / ".keel").mkdir()
    (tmp_path / ".keel" / "config.yml").write_text("commands:\n  unit_tests: 'true'\ninit:\n  services: use compose.yml\n")
    rung8 = next(r for r in ladder.plan(root) if r["n"] == 8)
    assert rung8["status"] == "waiting" and rung8["cmd"] == "docker compose up -d --wait"
    # a re-run that chose the compose service moves the existing bare test commands into it
    cfg = _write(root, init_gates.from_answers(root, {"run": "compose service app"}))
    assert cfg["commands"]["unit_tests"] == "docker compose exec -T app true"
