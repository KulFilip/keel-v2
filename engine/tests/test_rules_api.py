"""0.16.2 Rules page and "Rules now": the engine's /rules endpoints (runtime/rules_view.py), the library, pack
install/edit/remove, config edits that keep the rest of .keel/config.yml, the dry-run, and a fake agent refused by a
pack while a flow runs."""

from pathlib import Path

import yaml

from conftest import start, to_loop, wait
from keel_engine.runtime import rules_view

CONFIG = """# my project
layout: repo
backend:
  dir: apps/api   # the api
guards:
  # keep build out
  read_block: ["**/build/**"]
commands:
  test: pytest -q
"""


def project(tmp_path) -> Path:
    r = tmp_path / "p"
    (r / ".keel").mkdir(parents=True)
    (r / ".keel/config.yml").write_text(CONFIG)
    return r


def test_view_lists_builtins_lists_packs_and_engines(client, tmp_path):
    r = project(tmp_path)
    v = client.get("/rules", params={"root": str(r)}).json()
    ids = {b["id"]: b for b in v["builtins"]}
    assert ids["env-files"]["can_off"] is False and ids["read-twice"]["can_off"] is True
    assert set(ids["force-push"]["enforced"]) == {"claude", "opencode", "codex", "copilot", "api"}
    lists = {x["key"]: x for x in v["lists"]}
    assert lists["guards.read_block"]["saved_in"] == ".keel/config.yml"
    assert lists["guards.protected"]["saved_in"].startswith("keel's default")
    assert lists["guards.read_guard_max_lines"]["value"] == 2000
    assert {e["engine"] for e in v["engines"]} == {"claude", "opencode", "codex", "copilot", "api"}
    assert any(b["bucket"] == "keel-rules" for b in v["buckets"])
    assert v["packs"] == [] and v["configured"] is True


def test_config_edits_keep_the_other_lines(client, tmp_path):
    r = project(tmp_path)
    out = client.put("/rules/config", json={"root": str(r), "patch": {
        "guards": {"read_guard_max_lines": 500, "bash_deny_always": ["terraform apply"]},
        "rules": {"off": ["read-twice"]}, "mcp": {"allow": ["deploy_preview"]}}})
    assert out.status_code == 200, out.text
    text = (r / ".keel/config.yml").read_text()
    assert text.startswith("# my project\nlayout: repo\nbackend:\n  dir: apps/api   # the api\n")
    assert "commands:\n  test: pytest -q" in text
    data = yaml.safe_load(text)
    assert data["guards"] == {"read_block": ["**/build/**"], "read_guard_max_lines": 500, "bash_deny_always": ["terraform apply"]}
    assert data["rules"] == {"off": ["read-twice"]} and data["mcp"] == {"allow": ["deploy_preview"]}
    v = out.json()
    assert next(b for b in v["builtins"] if b["id"] == "read-twice")["off"] is True
    # never-off rules and the .env protection cannot be taken away
    bad = client.put("/rules/config", json={"root": str(r), "patch": {"rules": {"off": ["env-files", "force-push"]}}})
    assert bad.status_code == 400 and "always stay on" in bad.json()["error"]
    bad = client.put("/rules/config", json={"root": str(r), "patch": {"guards": {"protected": ["**/secret.txt"]}}})
    assert bad.status_code == 400 and ".env" in bad.json()["error"]
    bad = client.put("/rules/config", json={"root": str(r), "patch": {"commands": {}}})
    assert bad.status_code == 400
    (r / ".keel/config.yml").unlink()
    assert client.put("/rules/config", json={"root": str(r), "patch": {"rules": {"push_gate": False}}}).status_code == 409


def test_library_install_edit_export_remove(client, tmp_path):
    r = project(tmp_path)
    lib = client.get("/rules/library").json()
    ids = [p["id"] for p in lib]
    assert {"strict-secrets", "no-new-dependencies", "migrations-only-in-flow", "frontend-not-api", "stack-spring",
            "stack-node", "stack-python"} <= set(ids)
    text = client.get("/rules/library/no-new-dependencies").json()["yaml"]
    out = client.post("/rules/packs", json={"root": str(r), "yaml": text})
    assert out.status_code == 200 and (r / ".keel/rules/no-new-dependencies.yaml").read_text() == text
    assert [p["id"] for p in out.json()["view"]["packs"]] == ["no-new-dependencies"]
    assert client.post("/rules/packs", json={"root": str(r), "yaml": text}).status_code == 409          # already there
    edited = text.replace("name: No new dependencies", "name: No packages")
    assert client.post("/rules/packs", json={"root": str(r), "yaml": edited, "replace": "no-new-dependencies"}).status_code == 200
    assert client.get("/rules/packs/no-new-dependencies", params={"root": str(r)}).json()["yaml"] == edited
    bad = client.post("/rules/packs", json={"root": str(r), "yaml": "id: x\nrules: []"})
    assert bad.status_code == 422 and bad.json()["errors"]
    v = client.delete("/rules/packs/no-new-dependencies", params={"root": str(r)}).json()
    assert v["packs"] == [] and not (r / ".keel/rules/no-new-dependencies.yaml").exists()
    assert client.delete("/rules/packs/no-new-dependencies", params={"root": str(r)}).status_code == 404


def test_check_and_dry_run(client):
    text = Path(rules_view.config.content_dir() / "rules" / "no-new-dependencies.yaml").read_text()
    calls = [{"tool": "Bash", "kind": "tool", "text": "npm install left-pad", "phase": "green", "agent": "implementer"},
             {"tool": "run_command", "command": "pnpm add zod", "phase": "none"},
             {"tool": "Bash", "kind": "tool", "text": "npm ci", "phase": "green"},
             {"tool": "Write", "kind": "write", "path": "web/package-lock.json", "phase": "green"},
             {"tool": "Read", "kind": "read", "path": "README.md", "phase": "green"},
             {"tool": "run_command", "kind": "guard", "text": "REFUSED: ...", "phase": "green"}]
    out = client.post("/rules/check", json={"yaml": text, "calls": calls}).json()
    assert out["ok"] and out["dry_run"]["checked"] == 5
    assert [b["target"] for b in out["dry_run"]["blocked"]] == ["npm install left-pad", "pnpm add zod", "web/package-lock.json"]
    bad = client.post("/rules/check", json={"yaml": "nope: ["}).json()
    assert not bad["ok"] and "YAML" in bad["errors"][0]


def test_a_pack_refuses_a_fake_agent_and_rules_now_shows_it(client, repo, monkeypatch):
    (Path(repo) / ".keel" / "rules").mkdir(parents=True, exist_ok=True)
    pack = Path(rules_view.config.content_dir() / "rules" / "no-new-dependencies.yaml").read_text()
    (Path(repo) / ".keel/rules/no-new-dependencies.yaml").write_text(pack)
    monkeypatch.setenv("KEEL_FAKE_COMMAND", "npm install left-pad")
    tid = start(client, repo)
    s = to_loop(client, tid)
    refused = client.bus.of(tid, "guard.refused")
    assert any("rule no-new-dependencies/no-install" in e["data"]["reason"] and e["data"].get("command") == "npm install left-pad"
               for e in refused), refused
    now = client.get(f"/threads/{tid}/rules-now").json()
    assert now["phase"] == s["phase"] and now["thread_id"] == tid
    assert any(p["pack"] == "no-new-dependencies" for p in now["packs"])
    assert now["engine"]["provider"] == "fake" and now["engine"]["protection"] == "before"
    assert {i["bucket"] for i in now["may"]} | {i["bucket"] for i in now["may_not"]} >= {"api-main", "api-test"}
    assert any(a["bucket"] == "keel-rules" for a in now["always"])


def test_rules_now_outside_a_phase(tmp_path):
    r = project(tmp_path)
    out = rules_view.now(str(r), "none")
    assert out["phase"] == "none" and not out["may_not"] and "always-on" in out["meaning"]
    red = rules_view.now(str(r), "red", lane="web", unlocks=[{"path": "a.kt", "phase": "red"}, {"path": "b", "phase": "green"}],
                         provider="copilot")
    assert red["engine"]["protection"] == "partial" and red["unlocks"] == [{"path": "a.kt", "phase": "red", "reason": None}]
    assert any(i["bucket"] == "api-test" for i in red["may_not"])          # web lane: the api's tests are out of scope


# ------------------------------------------------------------------ keel v1 subagent-stop: the result marker

def test_a_missing_result_marker_is_asked_for_once(client, repo, monkeypatch):
    from test_flows_base import answers, values, wf

    said = []

    def reviewer(req):
        said.append(req.feedback or "")
        return "Looks fine." if len(said) == 1 else "Looks fine: two small notes, nothing blocking.\nBLOCKING: no"
    answers(monkeypatch, {"reviewer": reviewer})
    tid = start(client, repo, workflow=wf([{"id": "rev", "kind": "agent", "name": "review", "agent": "reviewer",
                                             "markers": ["BLOCKING"]}]))
    s = wait(client, tid)
    assert s["status"] == "done", s
    assert len(said) == 2 and "Repeat your full answer" in said[1] and "BLOCKING: yes | no" in said[1]
    assert values(client, tid)["markers"]["rev"] == {"BLOCKING": "no"}
    assert [e["data"]["missing"] for e in client.bus.of(tid, "agent.reask")] == [["BLOCKING"]]


def test_the_marker_is_asked_for_only_once(client, repo, monkeypatch):
    from test_flows_base import answers, wf

    said = []
    answers(monkeypatch, {"reviewer": lambda req: said.append(1) or "Looks fine."})
    tid = start(client, repo, workflow=wf([{"id": "rev", "kind": "agent", "name": "review", "agent": "reviewer",
                                             "markers": ["BLOCKING"]}]))
    wait(client, tid)
    assert len(said) == 2


# ------------------------------------------------------------------ MCP: keel_rules, keel_rule_edit

class _Api:
    def __init__(self, view, now=None):
        self.view, self.now, self.sent = view, now, []

    def get(self, route, **_):
        if route == "/projects":
            return [{"id": "shop", "name": "shop"}]
        if route == "/projects/shop/flow":
            return {"thread": {"thread_id": "t1"}} if self.now else {}
        if route == "/threads/t1/rules-now":
            return self.now
        if route == "/rules/library":
            return [{"id": "no-new-dependencies"}]
        return self.view

    def post(self, route, body=None, **_):
        self.sent.append(("POST", route, body))
        return {"ok": "rules" in str(body), "errors": ["rules: a list"], "dry_run": {"blocked": [1, 2]}, "pack": {"id": "x"}}

    def put(self, route, body=None, **_):
        self.sent.append(("PUT", route, body))
        return {"pack": {"id": "x"}}

    def delete(self, route, **_):
        self.sent.append(("DELETE", route, None))


def test_mcp_rules_text_and_edits(tmp_path):
    from keel_engine import mcp_more

    root = str(project(tmp_path))
    view = rules_view.view(root)
    now = rules_view.now(root, "green")
    now["fired"] = [{"count": 2, "reason": "Adding a package is a person's decision."}]
    text = mcp_more.rules(_Api(view, now))
    assert "Always on:" in text and "env-files" in text and "read-twice" in text
    assert "Now (phase green)" in text and "stopped 2x" in text
    api = _Api(view)
    assert mcp_more.rule_edit(api, "add", yaml_text="id: x").startswith("keel did not save it")
    assert "would have refused 2" in mcp_more.rule_edit(api, "add", yaml_text="id: x\nrules: []")
    assert mcp_more.rule_edit(api, "off", rule="read-twice") == "read-twice is off."
    assert api.sent[-1] == ("PUT", "/projects/shop/rules/config", {"rules": {"off": ["read-twice"]}})
    assert "no rule pack nope" in mcp_more.rule_install(api, "nope")
