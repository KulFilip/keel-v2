"""The gates record every flow state carries ({"mode", "log", "skipped"}) and how the actions read it."""
from __future__ import annotations

import copy


def default_gates() -> dict:
    return {"mode": "every-ac", "log": [], "skipped": {}}


def _first(sources) -> dict:
    for s in sources:
        g = s.get("gates")
        if g:
            return g
    return default_gates()


def deep_gates(*sources) -> dict:
    """A deep copy of the first non-empty ``gates`` among the given states (a fresh default when none has any)."""
    return copy.deepcopy(_first(sources))


def shallow_gates(*sources) -> dict:
    """A shallow copy of the first non-empty ``gates`` among the given states (a fresh default when none has any)."""
    return dict(_first(sources))
