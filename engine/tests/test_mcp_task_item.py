"""keel_answer for a task item: the api reads action + note (and 0.18.52 a proposal's answers)."""
from keel_engine import mcp_more


class Api:
    def __init__(self):
        self.posts = []

    def post(self, path, body=None, timeout=None):
        self.posts.append((path, body))
        return {}


def test_a_task_item_answer_sends_the_button_as_action_with_the_note_and_answers():
    api = Api()
    out = mcp_more.answer(api, "approve", item_id="42", choice="start", why="go", answers={"q1": "yes"})
    assert out == "task item 42: start."
    path, body = api.posts[-1]
    assert path == "/inbox/tasks/42/act"
    assert body["action"] == "start" and body["note"] == "go" and body["answers"] == {"q1": "yes"}


def test_without_a_choice_the_decision_is_the_action():
    api = Api()
    mcp_more.answer(api, "reject", item_id="7")
    assert api.posts[-1][1] == {"action": "reject", "decision": "reject"}
