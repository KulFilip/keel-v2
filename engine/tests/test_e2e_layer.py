"""0.18.57 B12: an e2e step is skipped, with a note, in a project with no UI and no HTTP layer (a library): a fix that
hunt-next handed over ran the e2e author on a 4-file library (it cost $0.32 and added e2e/...)."""

from pathlib import Path

from conftest import decide, start, wait
from test_flows_base import answers, values, wf
from test_v02 import commit_all, configure, log, write
from keel_engine.runtime import bug, project_shape, stacks


def child(client, s, workflow):
    kids = [c for c in s.get("children") or [] if c["workflow"] == workflow]
    assert len(kids) == 1, s.get("children")
    return kids[0]["thread_id"]


HUNT_SEED = {"title": "Ranks overflow", "recipe": "call rank() with 1001 scores", "symptoms": ["IndexError in rank()"],
             "needs_e2e": True}


def test_a_library_has_no_ui_or_http_layer(repo):
    yes, why = project_shape.ui_or_http(str(repo))
    assert not yes and "no frontend" in why


def test_a_server_framework_a_frontend_or_an_e2e_command_is_an_http_layer(repo, tmp_path):
    write(repo, "requirements.txt", "fastapi==0.110\nuvicorn\n")
    assert project_shape.ui_or_http(str(repo)) == (True, "requirements.txt names fastapi")
    (Path(repo) / "requirements.txt").unlink()
    write(repo, "requirements.txt", "fastapi-utils-free-helper\n")          # a word inside another name is not it
    assert not project_shape.ui_or_http(str(repo))[0]
    configure(repo, "version: 4\ncommands:\n  e2e: \"npx playwright test\"\n")
    assert project_shape.ui_or_http(str(repo)) == (True, "commands.e2e is set in .keel/config.yml")
    configure(repo, "version: 4\nfrontend: {dir: web}\n")
    write(repo, "web/src/main.tsx", "export {}\n")
    stacks.forget()
    assert project_shape.ui_or_http(str(repo))[0]
    shop = tmp_path / "shop"
    write(shop, "package.json", '{"name": "shop", "dependencies": {"express": "^4"}}')
    assert project_shape.ui_or_http(str(shop)) == (True, "package.json names express")
    go = tmp_path / "svc"
    write(go, "go.mod", "module svc\n")
    write(go, "main.go", 'package main\nimport "net/http"\nfunc main() { http.ListenAndServe(":8080", nil) }\n')
    import subprocess
    subprocess.run(["git", "init", "-q"], cwd=go)
    subprocess.run(["git", "add", "-A"], cwd=go)
    assert project_shape.ui_or_http(str(go)) == (True, "main.go serves HTTP")


def test_a_fix_from_hunt_next_skips_the_e2e_in_a_library(client, repo, monkeypatch):
    seen = answers(monkeypatch, {})
    w = wf([{"id": "hand", "kind": "code", "name": "hand to fix", "action": "start_flow", "flow": "fix", "then": "end",
             "seed": HUNT_SEED}])
    s = wait(client, start(client, repo, workflow=w))
    kid = child(client, s, "fix")
    wait(client, kid)
    decide(client, kid)
    s = decide(client, kid)
    assert s["waiting"]["step"] == "ship_plan"
    assert not any(r.agent == "e2e-author" for r in seen), "no e2e author in a library"
    assert not any(x.startswith("e2e(") for x in log(repo)) and not (Path(repo) / "e2e").exists()
    notes = {e["step"]: e["data"].get("note") for e in client.bus.of(kid, "step.finished") if e["data"].get("skipped")}
    assert "e2e" in notes and "no frontend, no HTTP server framework" in notes["e2e"], notes
    state = values(client, kid)
    assert any(x["step"] == "e2e" and "nothing to drive" in x["reason"] for x in state["data"]["ship_skipped"])
    assert "- Regression e2e: skipped: no frontend" in "\n".join(bug.section(state)), "the PR body says why"


def test_a_fix_in_a_project_with_an_http_layer_still_writes_the_regression_e2e(client, repo, monkeypatch):
    write(repo, "requirements.txt", "flask\n")
    commit_all(repo, "chore: serve the scores")
    seen = answers(monkeypatch, {})
    w = wf([{"id": "hand", "kind": "code", "name": "hand to fix", "action": "start_flow", "flow": "fix", "then": "end",
             "seed": HUNT_SEED}])
    s = wait(client, start(client, repo, workflow=w))
    kid = child(client, s, "fix")
    wait(client, kid)
    decide(client, kid)
    s = decide(client, kid)
    assert s["waiting"]["step"] == "ship_plan"
    assert any(r.agent == "e2e-author" for r in seen) and log(repo)[0].startswith("e2e(BUG-1)")


def _proven(repo) -> dict:
    from keel_engine.runtime import hunt
    r = hunt.new_run("demo", str(repo), thread_id="t", mode="auto", fast=False, scope={"mode": "all", "paths": []},
                     configured=["technical"], proposed=["technical"])
    hunt.update_run("demo", r["run"], lenses={**r["lenses"], "confirmed": ["technical"]})
    assert hunt.ingest("demo", str(repo), r["run"], "technical:api", [
        {"title": "rank overflows", "where": ["src/scores/__init__.py:10"], "symptom": "rank() of 1001 scores raises"}])["added"]
    assert hunt.record_verdict("demo", str(repo), r["run"], "F-001", {
        "verdict": "proven", "severity": "high", "runs": 2, "evidence": "IndexError",
        "recipe": {"file": "F-001.sh", "body": "python -c 'from scores import rank'"}}) is None
    assert hunt.write_report("demo", str(repo), r["run"])[0]
    return hunt.candidates("demo", r["run"])[0]


def test_a_hunt_finding_in_a_library_needs_no_end_to_end_test(repo):
    assert _proven(repo)["needs_e2e"] is False


def test_a_hunt_finding_in_a_web_project_still_needs_one(repo):
    write(repo, "requirements.txt", "flask\n")
    assert _proven(repo)["needs_e2e"] is True
