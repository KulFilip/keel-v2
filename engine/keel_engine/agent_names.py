"""Agent names that changed, and how an old one still reaches its agent.

keel gave the four review agents names that say when each one runs. A workflow, a setting or a call that
still says the old name gets the new agent: workflows (keel's, a project's own, the marketplace's) are read through
`canonical`, per-agent dicts (models, skills, knowledge) through `canonical_keys`, so nothing that was saved under an
old name is lost. Old names are never listed as agents of their own. The api has the same table
(api/src/main/kotlin/keel/api/agents/AgentNames.kt).
"""

from __future__ import annotations

from typing import Any, Mapping

# old name -> new name
RENAMED: dict[str, str] = {
    "ac-reviewer": "criterion-reviewer",     # one acceptance criterion's red and green commits, during a flow
    "code-reviewer": "branch-reviewer",      # the whole branch diff, once, at the end of a flow
    "reviewer": "lens-reviewer",             # a diff against the spec, one lens at a time
    "ticket-reviewer": "pr-reviewer",        # someone else's pull request (the review-pr flow)
}

OLD_NAMES = frozenset(RENAMED)


def canonical(name: str | None) -> str | None:
    """The agent's current name: an old name gives its new one, any other name stays as it is."""
    if not name:
        return name
    return RENAMED.get(name, name)


def is_old(name: str | None) -> bool:
    return bool(name) and name in RENAMED


def canonical_keys(d: Mapping[str, Any] | None) -> dict[str, Any]:
    """A per-agent dict with every old-name key moved to its new name; when both are there, the new name's value wins."""
    out: dict[str, Any] = {}
    for k, v in (d or {}).items():
        if k not in RENAMED:
            out[k] = v
    for k, v in (d or {}).items():
        if k in RENAMED:
            out.setdefault(RENAMED[k], v)
    return out


def lookup(d: Mapping[str, Any] | None, agent: str | None) -> Any:
    """d[agent] under its new name, else under its old name (a value saved before the rename)."""
    if not d or not agent:
        return None
    new = canonical(agent)
    if new in d:
        return d[new]
    return next((d[old] for old, n in RENAMED.items() if n == new and old in d), None)
