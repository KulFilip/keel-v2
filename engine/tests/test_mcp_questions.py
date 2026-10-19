"""keel 0.19.0 MCP: what waits is shown from its data (questions with options, choices with choice_info), answers can
be lists and named choices with a reason, and a client with forms asks the person through elicitation."""

import json

import httpx
import pytest
from mcp.shared.memory import create_connected_server_and_client_session
from mcp.types import ElicitResult

from keel_engine import mcp_ask, mcp_server, mcp_tui
from keel_engine.runtime import choices
from test_mcp import THREAD, StubApi, call

QUESTIONS = [
    {"id": "run", "question": "Where does the app run while you develop?", "why": "keel runs the tests there.",
     "options": [{"label": "this machine", "description": "this computer", "recommended": True},
                 {"label": "dev container", "description": "the dev container", "recommended": False}]},
    {"id": "knowledge", "question": "Which knowledge sections should keel write?", "why": "more tokens now", "multiple": True,
     "options": [{"label": "domain", "description": "business words", "recommended": True},
                 {"label": "data", "description": "tables", "recommended": True},
                 {"label": "integrations", "description": "outside services", "recommended": False}]},
]
TRIAGE = choices.for_question({"step": "triage", "kind": "gate", "title": "triage", "options": ["approve"],
                               "choices": ["take", "close", "stop"],
                               "detail": "take: start hunt-next for the top group.\nclose: payload {id, as} and a note.\n"
                                         "stop: end here; the backlog stays for hunt-next."}, "hunt:triage")


class Recorder(StubApi):
    """The stub api plus the Inbox's act route and GET /threads/t-1."""

    def __call__(self, req):
        if req.method == "POST" and req.url.path == "/api/inbox/t-1/act":
            self.posts.append((req.url.path, json.loads(req.content)))
            return httpx.Response(200, json={**self.thread, "status": "running", "waiting": None})
        if req.method == "GET" and req.url.path == "/api/threads/t-1":
            return httpx.Response(200, json=self.thread)
        return super().__call__(req)


@pytest.fixture
def rec(monkeypatch):
    monkeypatch.delenv("KEEL_PROJECT", raising=False)
    monkeypatch.chdir("/")
    s = Recorder()
    s.api = mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(s))
    return s


async def test_status_and_next_show_the_choices_from_choice_info(rec):
    rec.thread = {**THREAD, "waiting": TRIAGE}
    text = await call(mcp_server.build_server(api=rec.api), "keel_status")
    assert 'take "Take the top group": start hunt-next for the top group.  [plain approve]' in text
    assert 'close "Close a finding": payload {id, as} and a note.  [needs a reason]' in text
    nxt = await call(mcp_server.build_server(api=rec.api), "keel_next")
    assert 'choose one (approve with payload {"choice": "<name>"}' in nxt and "[needs a reason]" in nxt


async def test_a_stuck_criterion_is_a_choice_not_approve_to_try_again(rec):
    stuck = choices.for_question({"step": "verify_red", "kind": "fix", "title": "AC-2 is blocked", "options": ["approve", "reject"],
                                  "choices": ["skip", "retry", "stop"], "detail": ""}, "blocked")
    rec.thread = {**THREAD, "waiting": stuck}
    nxt = await call(mcp_server.build_server(api=rec.api), "keel_next")
    assert "approve to try again" not in nxt and 'skip "Skip this criterion"' in nxt


async def test_questions_show_why_options_recommended_and_multiple(rec):
    rec.thread = {**THREAD, "waiting": {"step": "questions", "kind": "clarify", "title": "three questions", "options": ["approve", "reject"],
                                        "questions": QUESTIONS, "detail": ""}}
    text = await call(mcp_server.build_server(api=rec.api), "keel_status")
    assert "run: Where does the app run while you develop?  (pick one)" in text
    assert "why: keel runs the tests there." in text
    assert "- this machine (recommended): this computer" in text
    assert "knowledge: Which knowledge sections should keel write?  (pick any)" in text
    nxt = await call(mcp_server.build_server(api=rec.api), "keel_next")
    assert "answer the 2 question(s)" in nxt and "- integrations: outside services" in nxt


def test_the_inbox_shows_choices_and_question_options(rec):
    from keel_engine import mcp_more

    item = {"project_id": "shop", "thread_id": "t-1", "kind": "gate", "title": "triage", "options": ["approve"],
            "choices": TRIAGE["choices"], "choice_info": TRIAGE["choice_info"], "questions": QUESTIONS[:1], "detail": ""}

    class Api:
        def get(self, route, **_kw):
            return {"items": [item]}

    text = mcp_more.inbox(Api())
    assert 'close "Close a finding"' in text and "[needs a reason]" in text and "- this machine (recommended)" in text


async def test_answers_can_be_lists_and_a_choice_needs_its_reason(rec):
    rec.thread = {**THREAD, "waiting": {"step": "questions", "kind": "clarify", "title": "three questions",
                                        "options": ["approve", "reject"], "questions": QUESTIONS}}
    srv = mcp_server.build_server(write=True, api=rec.api)
    await call(srv, "keel_approve_gate", {"decision": "approve", "answers": {"run": "dev container", "knowledge": ["domain", "data"]}})
    assert rec.posts[-1][1]["payload"] == {"answers": {"run": "dev container", "knowledge": ["domain", "data"]}}

    rec.thread = {**THREAD, "waiting": TRIAGE}
    text = await call(srv, "keel_approve_gate", {"decision": "approve", "choice": "close"})
    assert '"Close a finding" needs a reason: pass why.' in text
    n = len(rec.posts)
    await call(srv, "keel_answer", {"choice": "close"})
    assert len(rec.posts) == n                                    # refused before it was sent
    await call(srv, "keel_answer", {"choice": "close", "why": "a duplicate",
                                    "answers": {"finding": "G-01", "as": "wontfix"}})
    path, body = rec.posts[-1]
    assert path == "/api/inbox/t-1/act"
    assert body["payload"] == {"answers": {"finding": "G-01", "as": "wontfix"}, "choice": "close"} and body["why"] == "a duplicate"
    text = await call(srv, "keel_approve_gate", {"decision": "approve", "choice": "bogus"})
    assert '"bogus" is not a choice here' in text


def test_the_form_maps_enums_lists_own_words_and_choice_labels():
    w = {**TRIAGE, "questions": QUESTIONS}
    model, to_answer = mcp_ask.form(w)
    schema = model.model_json_schema()["properties"]
    assert schema["q1"]["enum"] == ["this machine", "dev container"] and schema["q1"]["default"] == "this machine"
    assert schema["q2"]["type"] == "array" and schema["q2"]["items"]["enum"] == ["domain", "data", "integrations"]
    assert schema["q2"]["default"] == ["domain", "data"]
    assert schema["choice"]["enum"] == ["Take the top group", "Close a finding", "Stop here"]
    assert "needed for: Close a finding" in schema["why"]["title"]
    decision, why, payload = to_answer(model(q1="dev container", q2=["data"], q2_own_words="our events",
                                             choice="Close a finding", why="known"))
    assert decision == "approve" and why == "known"
    assert payload == {"answers": {"run": "dev container", "knowledge": ["data", "our events"]}, "choice": "close"}
    _, _, payload = to_answer(model(q1_own_words="in docker on a vm"))
    assert payload["answers"]["run"] == "in docker on a vm" and payload["choice"] == "take"


async def test_ask_person_through_elicitation_sends_the_answer(rec):
    rec.thread = {**THREAD, "waiting": {**TRIAGE, "questions": QUESTIONS}}
    seen = {}

    async def fill(context, params):
        seen["schema"] = params.requestedSchema
        return ElicitResult(action="accept", content={"q1": "dev container", "q2": ["domain"], "choice": "Close a finding",
                                                      "why": "a duplicate"})

    srv = mcp_server.build_server(write=True, api=rec.api)
    async with create_connected_server_and_client_session(srv, elicitation_callback=fill) as s:
        res = await s.call_tool("keel_answer", {"ask_person": True})
    assert not res.isError and "answered thread t-1" in res.content[0].text
    assert seen["schema"]["properties"]["choice"]["enum"][1] == "Close a finding"
    path, body = rec.posts[-1]
    assert path == "/api/inbox/t-1/act" and body["why"] == "a duplicate"
    assert body["payload"] == {"answers": {"run": "dev container", "knowledge": ["domain"]}, "choice": "close"}


async def test_ask_person_without_forms_or_declined_gives_the_question_as_text(rec):
    rec.thread = {**THREAD, "waiting": {"step": "questions", "kind": "clarify", "title": "three questions",
                                        "options": ["approve", "reject"], "questions": QUESTIONS}}
    srv = mcp_server.build_server(write=True, api=rec.api)
    text = await call(srv, "keel_answer", {"ask_person": True})
    assert "cannot show a form" in text and "run: Where does the app run" in text and "answers={<question id>" in text
    assert not rec.posts

    async def close(context, params):
        return ElicitResult(action="decline")

    async with create_connected_server_and_client_session(srv, elicitation_callback=close) as s:
        res = await s.call_tool("keel_answer", {"ask_person": True})
    assert "you closed the form" in res.content[0].text and not rec.posts


def test_keelbots_questions_come_back_as_the_answers_message():
    text = ('Which one?\n```keel-questions\n[{"id": "db", "question": "Which database?", "options": '
            '[{"label": "postgres", "recommended": true}, {"label": "sqlite"}]}, {"id": "parts", "question": "Which parts?", '
            '"multiple": true, "options": [{"label": "api", "recommended": true}, {"label": "web", "recommended": true}]}]\n```')
    hint = mcp_tui._buttons_hint(text, "c-7")
    assert "keel_keelbot_ask(chat='c-7'" in hint
    assert "Answers to your questions:\\n1. Which database?\\n   → postgres\\n2. Which parts?\\n   → api; web" in hint
    assert "- sqlite" in hint and "(pick any)" in hint


def test_a_findings_gate_reason_option_takes_the_own_words_as_its_reason():
    """0.18.22 per-finding decisions: "accept" needs a reason; the form's own words become "accept: <reason>"."""
    from keel_engine.runtime import finding_decisions
    qs = finding_decisions.questions([{"lens": "security", "text": "`a.py:1` no auth check"},
                                      {"lens": "security", "text": "`b.py:2` weak hash"}], can_amend=False)
    w = {"step": "security__fix", "kind": "gate", "title": "security: 2 blocking finding(s)", "options": ["approve", "reject"],
         "questions": qs}
    lines = "\n".join(mcp_ask.question_lines(qs))
    assert "fix (recommended)" in lines and 'needs a reason: "accept: <reason>"' in lines
    model, to_answer = mcp_ask.form(w)
    schema = model.model_json_schema()["properties"]
    assert schema["q1"]["enum"] == ["fix", "accept", "not a finding"] and schema["q1"]["default"] == "fix"
    assert "your reason for accept / not a finding" in schema["q1_own_words"]["title"]
    decision, _why, payload = to_answer(model(q1="fix", q2="not a finding", q2_own_words="md5 is only a cache key"))
    assert decision == "approve"
    assert payload["answers"] == {"f1": "fix", "f2": "not a finding: md5 is only a cache key"}
