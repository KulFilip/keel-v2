"""keel 0.18.57 what a KeelBot turn knows besides the question: the "where to look" hints of an agent with hints on
(they never reached the prompt: the engine's AgentKnowledge model dropped `hints`), and the branch the project folder
is on (a flow on its own branch checks it out in the shared folder while a chat reads the code there).

The model is scripted (FakeRunner.run replaced) so the test can read the prompt."""

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
