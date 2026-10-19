"""keel 0.18.22 the security phase's verdicts: the audit writes `security`, the push gate reads it (no more "no scanner"),
the deps audit blocks only at security.deps.fail_on, and the dependency triage's "not reachable" clears a deps finding."""

from conftest import start, wait
from test_flows_feature import to
from test_v02 import commit_all, configure
from test_verdict_actions import ai, commit, config, proj, run, write  # noqa: F401  (proj is a fixture)
from keel_engine.models import fake as fake_mod
from keel_engine.runtime import blockers, security_actions, verdicts
from keel_engine.runtime.verdict_actions import record_verdict


def test_the_worst_severity_and_the_threshold():
    sa = security_actions
    assert sa.worst_severity("found 3 vulnerabilities (2 low, 1 moderate)") == "moderate"
    assert sa.worst_severity('{"severity": "critical"}') == "critical"
    assert sa.worst_severity("0 critical, 0 high, 4 low") == "low"
    assert sa.worst_severity("Severity: MEDIUM") == "moderate" and sa.worst_severity("exit 1") is None
    assert sa.fail_on({}) == "high" and sa.fail_on({"security": {"deps": {"fail_on": "medium"}}}) == "moderate"
    assert sa.fail_on({"security": {"deps": {"fail_on": "nonsense"}}}) == "high"
    assert sa.blocks("critical", "high") and sa.blocks(None, "high") and not sa.blocks("moderate", "high")


def test_the_deps_audit_blocks_only_at_fail_on(proj):
    write(proj, "package.json", '{"dependencies": {"left-pad": "1.0.0"}}\n')
    commit(proj, "build: add left-pad")
    config(proj, "commands: {deps_web: 'echo 2 moderate; false'}\nfrontend: {dir: ''}\n")
    r = run("verify_deps", ai(proj))
    assert r.ok and "below fail_on high: web: worst moderate" in r.note
    assert verdicts.latest("p1", "deps")["ok"] is True
    config(proj, "commands: {deps_web: 'echo 2 moderate; false'}\nfrontend: {dir: ''}\nsecurity: {deps: {fail_on: moderate}}\n")
    r = run("verify_deps", ai(proj))
    assert not r.ok and "fail_on moderate" in r.note
    config(proj, "commands: {deps_web: 'echo broken; false'}\nfrontend: {dir: ''}\n")
    assert not run("verify_deps", ai(proj)).ok, "no severity in the output: keel stays strict"


def test_the_push_gate_reads_the_security_verdicts(repo):
    configure(repo, "version: 4\ncoverage: {enabled: false}\nsecurity: {required: [security]}\n")
    root = str(repo)
    b = {x["gate"]: x for x in blockers.push_blockers(root, project="demo")}
    assert "not run on this branch" in b["security"]["why"] and "0.4.0" not in b["security"]["why"]
    record_verdict("demo", "security", False, {"summary": "security audit: 1 blocking finding(s)"}, root=root)
    assert blockers.push_blockers(root, project="demo")[-1]["why"] == "security audit: 1 blocking finding(s)"
    record_verdict("demo", "security", True, {"summary": "security audit: clean"}, root=root)
    assert "security" not in {x["gate"] for x in blockers.push_blockers(root, project="demo")}
    write(repo, "src/x.py", "x = 1\n")
    commit_all(repo, "feat: more")
    stale = {x["gate"]: x for x in blockers.push_blockers(root, project="demo")}["security"]
    assert stale["why"].startswith("the security verdict is for ")
    # not required: the same, as a warning
    configure(repo, "version: 4\ncoverage: {enabled: false}\n")
    record_verdict("demo", "security", True, {"summary": "security audit: clean"}, root=root)
    assert "security" not in {x["gate"] for x in blockers.push_warnings(root, project="demo")}


def test_the_triage_clears_an_unreachable_deps_finding(repo):
    root = str(repo)
    record_verdict("demo", "deps", False, {"summary": "web audit failed", "manifests": ["package.json"]}, root=root)
    triage = ("- `lodash 4.17.20` — CVE-1, high. Reachable: no, only the build script uses it. Not blocking.\n"
              "- `minimist 1.2.0` — dev-only, not bundled.\nDEPS: clean")
    data, note = security_actions.after_review("demo", root, [({"id": "deps", "agent": "dependency-triager"}, triage)])
    assert [c["advisory"] for c in data["deps_triage"]["cleared"]] == ["lodash 4.17.20", "minimist 1.2.0"]
    assert "only the build script" in data["deps_triage"]["cleared"][0]["reason"] and not data["deps_triage"]["blocking"]
    v = verdicts.latest("demo", "deps")
    assert v["ok"] and v["detail"]["cleared"] and v["detail"]["manifests"] == ["package.json"] and "cleared" in note
    # a reachable one keeps the verdict failing
    record_verdict("demo", "deps", False, {"summary": "web audit failed"}, root=root)
    data, _ = security_actions.after_review("demo", root, [({"id": "deps", "agent": "dependency-triager"},
                                                            "- `jackson 2.13` — high. Reachable: yes. Blocking.\nDEPS: findings")])
    assert data["deps_triage"]["blocking"] and not verdicts.latest("demo", "deps")["ok"]


def test_a_clean_audit_writes_the_security_verdict(client, repo, monkeypatch):
    real = fake_mod._plan
    monkeypatch.setattr(fake_mod, "_plan", lambda req: (None, "", "Checked the routes.\nSECURITY: clean", {})
                        if req.agent == "security-auditor" else real(req))
    tid = start(client, repo)
    to(client, tid, wait(client, tid), "ship_final_review")
    v = verdicts.latest("demo", "security")
    assert v and v["ok"] and v["detail"]["summary"] == "security audit: clean"


def test_accepted_findings_make_the_security_verdict_pass(client, repo, monkeypatch):
    real = fake_mod._plan
    found = "- `src/scores/ac_1.py:1` any user reads any rank.\nSECURITY: findings"
    monkeypatch.setattr(fake_mod, "_plan", lambda req: (None, "", found, {})
                        if req.agent == "security-auditor" else real(req))
    tid = start(client, repo)
    s = to(client, tid, wait(client, tid), "security__fix")
    assert verdicts.latest("demo", "security")["ok"] is False
    from conftest import decide
    decide(client, tid, payload={"answers": {"f1": "accept: tracked in ticket 7"}})
    v = verdicts.latest("demo", "security")
    assert v["ok"] and v["detail"]["accepted"][0]["why"] == "tracked in ticket 7"
