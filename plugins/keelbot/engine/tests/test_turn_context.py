"""keel 0.18.57 what a KeelBot turn knows besides the question: the "where to look" hints of an agent with hints on
(they never reached the prompt: the engine's AgentKnowledge model dropped `hints`), and the branch the project folder
is on (a flow on its own branch checks it out in the shared folder while a chat reads the code there).

The model is scripted (FakeRunner.run replaced) so the test can read the prompt."""

import subprocess

from keel_plugin_keelbot import helper

from test_memory import Script, new_session, turn


def test_hints_on_reach_keelbots_prompt(client, repo, monkeypatch):
    """The api sends the helper agent's knowledge with each turn; with hints on, the parts' prompt_context hook (the
    Graph plugin's "where to look" list) is asked and its text is in the prompt."""
    monkeypatch.setattr(helper.extensions, "prompt_context",
                        lambda agent, root, pid, query: ["WHERE-TO-LOOK"] if (agent.knowledge or {}).get("hints") else [])
    sc = Script(monkeypatch, "ok", "ok")
    sid = new_session(client, repo)["id"]
    on = {"helper": {"knowledge": {"sections": [], "code_graph": False, "memory": False, "hints": True}}}
    turn(client, sid, "Where is the cart total computed?", agents=on)
    assert "WHERE-TO-LOOK" in sc.reqs[0].prompt
    off = {"helper": {"knowledge": {"sections": [], "code_graph": False, "memory": False, "hints": False}}}
    turn(client, sid, "And the tax?", agents=off)
    assert "WHERE-TO-LOOK" not in sc.reqs[1].prompt


# ------------------------------------------------------------------ the project folder's branch

def git(repo, *args):
    return subprocess.run(["git", *args], cwd=repo, check=True, capture_output=True, text=True).stdout.strip()


FLOW = {"flows": [{"thread_id": "t-9", "title": "Euro prices", "workflow": "feature", "status": "running",
                   "branch": "feat/euro-prices", "where": "folder"}]}


def test_a_flow_that_switches_the_folders_branch_is_told_to_keelbot_and_the_person(client, repo, monkeypatch):
    sc = Script(monkeypatch, "ok", "ok", "ok")
    start = git(repo, "rev-parse", "--abbrev-ref", "HEAD")
    sid = new_session(client, repo)["id"]
    s = turn(client, sid, "Where is the cart total computed?")
    assert f"The project folder is on branch {start}" in sc.reqs[0].prompt
    assert s["messages"][-1]["data"]["folder_branch"] == start and "branch_switch" not in s["messages"][-1]["data"]

    git(repo, "checkout", "-q", "-b", "feat/euro-prices")       # a flow on its own branch, in the project folder
    assert client.get(f"/helper/sessions/{sid}").json()["folder_branch"] == "feat/euro-prices"
    s = turn(client, sid, "And the tax?", keel=FLOW)
    p = sc.reqs[1].prompt
    assert f"moved from branch {start} to feat/euro-prices" in p and 'the flow "Euro prices"' in p
    sw = s["messages"][-1]["data"]["branch_switch"]
    assert sw["from"] == start and sw["to"] == "feat/euro-prices" and sw["by"] == "Euro prices" and sw["at"]
    assert any(e["data"]["to"] == "feat/euro-prices" for e in client.bus.of(sid, "helper.branch"))

    s = turn(client, sid, "And shipping?", keel=FLOW)
    assert "moved from branch" not in sc.reqs[2].prompt, "told once"
    assert "branch_switch" not in s["messages"][-1]["data"]


def test_a_switch_while_keelbot_answers_is_kept_with_that_answer(client, repo, monkeypatch):
    start = git(repo, "rev-parse", "--abbrev-ref", "HEAD")

    def answer(req):
        git(repo, "checkout", "-q", "-b", "feat/euro-prices")
        return "the total is in cart.js"
    Script(monkeypatch, answer)
    sid = new_session(client, repo)["id"]
    s = turn(client, sid, "Where is the cart total computed?", keel=FLOW)
    d = s["messages"][-1]["data"]
    assert d["folder_branch"] == start
    assert d["branch_switch"]["during"] is True and d["branch_switch"]["to"] == "feat/euro-prices"


def test_a_side_session_has_its_own_branch_and_is_not_watched(client, repo, monkeypatch):
    sc = Script(monkeypatch, "ok")
    sid = new_session(client, repo, mode="side")["id"]
    s = turn(client, sid, "hello")
    assert "The project folder is on branch" not in sc.reqs[0].prompt
    assert "folder_branch" not in s["messages"][-1]["data"]
    assert "folder_branch" not in client.get(f"/helper/sessions/{sid}").json()
