"""markers.matches for a step's `when` without equals / in: the value must be set."""
import pytest

from keel_engine.runtime import markers
from keel_engine.runtime.compiler import Compiler


@pytest.mark.parametrize("value", [False, 0, "", [], {}, None])
def test_an_empty_or_false_value_does_not_hold(value):
    assert markers.matches(value, {"data": "x"}) is False
    assert Compiler._holds({"data": "x"}, [value]) is False


@pytest.mark.parametrize("value", [True, 1, "yes", ["a"], {"k": 1}])
def test_a_set_value_holds(value):
    assert markers.matches(value, {"data": "x"}) is True


def test_equals_still_compares_the_text():
    assert markers.matches(False, {"data": "x", "equals": "false"}) is True
    assert markers.matches(False, {"data": "x", "equals": "true"}) is False
    assert markers.matches(0, {"data": "x", "in": ["0", "1"]}) is True
