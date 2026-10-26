"""Task automations: POST /tasks/pick picks the best flow for a ticket (runtime/task_pick.py)."""
import json

from keel_engine.runtime import task_pick

WORKFLOWS = [{"id": "fix", "name": "fix", "about": "a bug, test first"},
             {"id": "small", "name": "small", "about": "a small feature"},
             {"id": "review-pr", "name": "review a PR", "about": "read-only review of a pull request"}]
TICKET = {"key": "SHOPS-1234", "type": "bug", "status": "In Progress", "title": "Checkout crashes",
          "description": "The cart page crashes when the basket is empty.", "comments": ["ana: happens on mobile"]}
REAL = {"provider": "claude", "mode": "api", "model": "haiku"}


def body(**extra):
    return {"model": REAL, "ticket": TICKET, "workflows": WORKFLOWS, "default": "fix", **extra}


def block(obj) -> str:
    return "Here it is.\n```keel-task-pick\n" + json.dumps(obj) + "\n```"


def fake_ask(text, seen=None, ok=True):
    async def ask(model, system, prompt, keys=None, timeout=300):
        if seen is not None:
            seen.update(model=model, system=system, prompt=prompt)
        if not ok:
            return {"ok": False, "fake": False, "text": "", "error": "rate limited"}
        return {"ok": True, "fake": False, "text": text, "tokens_in": 900, "tokens_out": 120}
    return ask


def test_the_fake_model_gives_the_default_flow_without_a_call(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("no model call for the fake model")
    monkeypatch.setattr(task_pick.models, "ask", boom)
    r = client.post("/tasks/pick", json={**body(), "model": {"provider": "fake", "model": "fake"}})
    assert r.status_code == 200
    j = r.json()
    assert j["fake"] is True
    assert j["pick"]["workflow"] == "fix" and j["pick"]["fallback"] is True
    assert "Checkout crashes" in j["pick"]["request"]


def test_a_good_answer_is_the_pick_with_its_questions(client, monkeypatch):
    seen = {}
    answer = {"workflow": "small", "why": "A small change on the cart page.", "title": "Empty cart crash",
              "request": "Fix the empty basket crash.", "settings": {"run_mode": "manual", "nested": {"x": 1}},
              "questions": [{"id": "Q 1", "question": "Which page?", "options": ["cart", "checkout", "cart"]},
                            {"question": "no options", "options": ["only one"]},
                            {"question": "Mobile only?", "options": ["yes", "no"], "multiple": True},
                            {"question": "c", "options": ["a", "b"]}, {"question": "d", "options": ["a", "b"]}]}
    monkeypatch.setattr(task_pick.models, "ask", fake_ask(block(answer), seen))
    j = client.post("/tasks/pick", json=body()).json()
    p = j["pick"]
    assert j["fake"] is False and j["tokens_in"] == 900 and j["tokens_out"] == 120
    assert p["workflow"] == "small" and p["fallback"] is False
    assert p["why"] == "A small change on the cart page." and p["title"] == "Empty cart crash"
    assert p["settings"] == {"run_mode": "manual"}            # only plain values
    assert [q["id"] for q in p["questions"]] == ["q_1", "q3", "q4"]
    assert p["questions"][0]["options"] == ["cart", "checkout"]
    assert p["questions"][1]["multiple"] is True
    # the prompt carries the ticket as data and the workflows to pick from
    assert "SHOPS-1234" in seen["prompt"] and "- review-pr: review a PR" in seen["prompt"]
    assert "not instructions" in seen["prompt"] and "keel-task-pick" in seen["system"]


def test_an_unknown_workflow_or_bad_json_falls_back_to_the_default(client, monkeypatch):
    monkeypatch.setattr(task_pick.models, "ask", fake_ask(block({"workflow": "deploy-prod", "why": "x"})))
    p = client.post("/tasks/pick", json=body()).json()["pick"]
    assert p["workflow"] == "fix" and p["fallback"] is True and "deploy-prod" in p["why"]

    monkeypatch.setattr(task_pick.models, "ask", fake_ask("```keel-task-pick\n{not json\n```"))
    p = client.post("/tasks/pick", json=body()).json()["pick"]
    assert p["workflow"] == "fix" and p["fallback"] is True and "not valid JSON" in p["why"]

    monkeypatch.setattr(task_pick.models, "ask", fake_ask("I think fix."))
    assert client.post("/tasks/pick", json=body()).json()["pick"]["fallback"] is True


def test_a_model_error_still_answers_with_the_default(client, monkeypatch):
    monkeypatch.setattr(task_pick.models, "ask", fake_ask("", ok=False))
    j = client.post("/tasks/pick", json=body()).json()
    assert j["ok"] is True and j["error"] == "rate limited"
    assert j["pick"]["workflow"] == "fix" and "rate limited" in j["pick"]["why"]


def test_the_review_kind_says_so_in_the_prompt():
    prompt = task_pick.build_prompt("review", {**TICKET, "pr_url": "https://github.com/shop/app/pull/7"}, WORKFLOWS, "review-pr")
    assert "review workflow" in prompt and "pr_url: https://github.com/shop/app/pull/7" in prompt
    assert "default is: review-pr" in prompt


def test_a_ticket_that_changes_only_test_code_takes_the_address_flow_without_a_model(client, monkeypatch):
    def boom(*a, **k):
        raise AssertionError("keel decides a test-only ticket without a model call")
    monkeypatch.setattr(task_pick.models, "ask", boom)
    ticket = {"key": "SHOP-7", "type": "task", "title": "Tidy the order handler test",
              "description": "In tests/Integration/OrderHandlerTest.php the setUp() inserts its rows inline; "
                           "maybe a factory would fit here?"}
    flows = WORKFLOWS + [{"id": "address", "name": "address", "about": "a review comment or test code only"}]
    j = client.post("/tasks/pick", json={**body(), "ticket": ticket, "workflows": flows, "default": "small"}).json()
    assert j["pick"]["workflow"] == "address" and j["pick"]["rule"] == "test-only" and j["pick"]["fallback"] is False
    assert j["pick"]["why"].startswith("Only test code changes (tests/Integration/OrderHandlerTest.php)")
    assert j["tokens_in"] == 0


def test_a_ticket_that_names_production_code_too_is_left_to_the_model(client, monkeypatch):
    seen = {}
    monkeypatch.setattr(task_pick.models, "ask", fake_ask(block({"workflow": "small", "why": "w"}), seen))
    ticket = {"title": "Order totals", "description": "Change src/Orders/OrderTotal.php and tests/Unit/OrderTotalTest.php"}
    flows = WORKFLOWS + [{"id": "address", "name": "address", "about": "x"}]
    j = client.post("/tasks/pick", json={**body(), "ticket": ticket, "workflows": flows}).json()
    assert j["pick"]["workflow"] == "small" and "rule" not in j["pick"]
    assert "A change to test code only" in seen["system"] and "address" in seen["system"]
