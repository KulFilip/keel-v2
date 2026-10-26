"""0.18.57 B11: the hunt follows the layout (with layout keel / external its report goes to .keel/hunts/<run>/ and is not
committed) and proposes the lenses the project calls for (a 4-file library got all 11, routes and browsers included).
hunt and hunt-next cut no branch of their own (own_branch: false; the api reads it)."""

import subprocess

import yaml
from conftest import decide, start, wait
from test_flows_base import values
from test_flows_hunt import HUNTERS, SETTINGS, git_log, proof, start_hunt
from test_v02 import commit_all, write
from keel_engine import layout
from keel_engine.runtime import hunt
from keel_engine.workflows.templates import get_template


def keel_layout(repo):
    """The project keeps keel's files under .keel/, out of git (layout keel)."""
    write(repo, ".keel/config.yml", "version: 4\nlayout: keel\n")
    assert layout.hide(repo)


# ------------------------------------------------------------------ lenses

def test_a_small_library_gets_a_few_lenses_that_fit_it(repo):
    lenses, why = hunt.fit_lenses(str(repo), hunt.settings(str(repo)))
    assert lenses == ["technical", "test-integrity"]
    assert "source file(s)" in why and "no UI or HTTP layer" in why and "no database" in why


def test_a_service_with_a_database_and_threads_gets_the_lenses_its_code_calls_for(repo):
    write(repo, "requirements.txt", "flask\nsqlalchemy\npyjwt\n")
    write(repo, "migrations/001_scores.sql", "create table scores (id int);\n")
    commit_all(repo, "feat: serve the scores")
    lenses, why = hunt.fit_lenses(str(repo), hunt.settings(str(repo)))
    assert lenses == ["exploration", "observability", "security", "behavioral", "technical", "concurrency",
                      "idempotency", "reachability", "test-integrity", "data-migration"]
    assert "requirements.txt names flask" in why and "requirements.txt names sqlalchemy" in why
    # a library with a broker: concurrency, idempotency and messaging, still no route lenses
    (repo / "requirements.txt").write_text("celery\n")
    (repo / "migrations/001_scores.sql").unlink()
    write(repo, "src/scores/pool.py", "import threading\n")
    commit_all(repo, "refactor: a worker pool")
    lenses, _ = hunt.fit_lenses(str(repo), hunt.settings(str(repo)))
    assert lenses == ["technical", "concurrency", "idempotency", "test-integrity", "messaging"]
    # threads alone: concurrency
    (repo / "requirements.txt").unlink()
    commit_all(repo, "chore: no broker")
    assert hunt.fit_lenses(str(repo), hunt.settings(str(repo)))[0] == ["technical", "concurrency", "test-integrity"]


def test_the_hunt_proposes_the_fitting_lenses_unless_the_project_names_its_own(client, repo, monkeypatch):
    tid = start(client, repo, workflow="hunt", title="Bug hunt", settings={**SETTINGS, "hunt_scope": "all"})
    s = wait(client, tid)
    assert s["waiting"]["step"] == "confirm_lenses"
    assert values(client, tid)["data"]["proposed_lenses"] == ["technical", "test-integrity"]
    assert "the ones this project calls for" in s["waiting"]["detail"] and "no UI or HTTP layer" in s["waiting"]["detail"]
    q = next(x for x in s["waiting"]["questions"] if x["id"] == "lenses")
    assert {o["label"] for o in q["options"] if o["recommended"]} == {"technical", "test-integrity"}
    assert len(q["options"]) >= 11, "every lens can still be ticked"
    client.post(f"/threads/{tid}/stop")
    wait(client, tid)
    # hunt.lenses in .keel/config.yml is the project's own set
    write(repo, ".keel/config.yml", "version: 4\nhunt: {lenses: [security, exploration]}\n")
    commit_all(repo, "chore: keel config")
    tid = start(client, repo, workflow="hunt", title="Bug hunt", settings={**SETTINGS, "hunt_scope": "all"})
    s = wait(client, tid)
    assert values(client, tid)["data"]["proposed_lenses"] == ["security", "exploration"]
    assert "the ones this project calls for" not in s["waiting"]["detail"]


# ------------------------------------------------------------------ layout

def test_with_layout_keel_the_report_stays_in_keel_and_is_not_committed(client, repo, monkeypatch):
    keel_layout(repo)
    provers = {"F-001": lambda n: proof("F-001", "proven", "critical"), "F-002": lambda n: proof("F-002", "false"),
               "F-003": lambda n: proof("F-003", "proven", "moderate")}
    tid, _seen, _ = start_hunt(client, repo, monkeypatch, mode="auto", provers=provers, groups=[])
    wait(client, tid)
    before = git_log(repo)
    s = decide(client, tid, "approve", payload={"choice": "confirm"})
    assert s["waiting"]["step"] == "triage", s
    run_id = values(client, tid)["data"]["hunt"]["run"]
    assert (repo / ".keel" / "hunts" / run_id / "report.md").is_file()
    assert not (repo / "docs" / "hunts").exists()
    assert git_log(repo) == before, "nothing committed"
    assert subprocess.run(["git", "status", "--porcelain"], cwd=repo, capture_output=True, text=True).stdout == ""
    note = [e["data"]["note"] for e in client.bus.of(tid, "step.finished") if e["step"] == "commit"][-1]
    assert "outside git" in note and "layout keel" in note
    run = hunt.get_run("demo", run_id)
    assert run["report"] == f".keel/hunts/{run_id}/report.md"
    assert hunt.report_committed(str(repo), run) == (True, "")
    # hunt-next takes the top finding: the report needs no commit first
    s = decide(client, tid, "approve", payload={"choice": "take"})
    n = wait(client, s["children"][0]["thread_id"])
    assert n["status"] == "done" and n["children"][0]["workflow"] == "fix", n


def test_layout_repo_still_commits_the_report_and_a_set_report_dir_wins(repo):
    assert hunt.settings(str(repo))["report_dir"] == "docs/hunts"           # the demo keeps docs/specs: layout repo
    keel_layout(repo)
    assert hunt.settings(str(repo))["report_dir"] == ".keel/hunts"
    (repo / ".keel" / "config.yml").write_text("version: 4\nlayout: keel\nhunt: {report_dir: reports/hunts}\n")
    assert hunt.settings(str(repo))["report_dir"] == "reports/hunts"
    assert not hunt.kept_out_of_git(str(repo), "reports/hunts/H-1")
    assert hunt.kept_out_of_git(str(repo), ".keel/hunts/H-1")


# ------------------------------------------------------------------ branch

def test_hunt_and_hunt_next_cut_no_branch_of_their_own():
    for name in ("hunt", "hunt-next"):
        assert yaml.safe_load(get_template(name).yaml).get("own_branch") is False, name
    assert yaml.safe_load(get_template("fix").yaml).get("own_branch") is None
