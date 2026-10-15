"""Rule packs in the marketplace (docs/plugins/23-rules-in-marketplace.md): find one and read what the catalog says
about it. Nothing here installs: a pack goes into a project through the rules session's api (`POST …/rule-packs`),
which the Rules tab calls once that format is final. So there is no fetch route yet either.

    search(q, category)       {rules: [Hit], sources, categories}
    detail(name)              Hit + {versions, checks}

Choosing a version: the newest that is not revoked (revoked by kind `rules`) and whose `requires.keel` fits this keel.
Refused (Hit.refused): an old (expired) catalog, or no version for this keel. A pack only refuses (it can never allow
what keel's own rules forbid), so its trust is `content`: the rule "allow unverified publishers" does not block it.
"""

from __future__ import annotations

from .. import config
from ..addons import NAME, satisfies
from . import MarketError, catalog, kinds
from .catalog import Index, RulesEntry, RulesVersion

KIND = kinds.RULES.name
TRUST = "content"
CHECKS = [
    "the catalog's signature matches the source's key",
    "the version is not revoked and the catalog is not old",
    "the download is not bigger than the catalog says (at most 64 KB), and its sha256 is the catalog's",
    "the file's signature matches a key of its publisher",
    "the file is a rule pack keel can read, and its review (rules by kind, phases, lanes) is the catalog's",
    "a pack only refuses: it can never allow what keel's own rules forbid",
]


def why_not(index: Index, entry: RulesEntry, v: RulesVersion) -> str | None:
    """None when this version is for this keel: not revoked and keel's version fits; else why not, in plain words."""
    if why := index.why_revoked(entry.name, v.version, KIND):
        return f"{entry.name} {v.version} is revoked: {why}"
    if not satisfies(config.VERSION, v.keel):
        return f"needs keel {v.keel}, this is keel {config.VERSION}"
    return None


def choose(index: Index, entry: RulesEntry) -> RulesVersion | None:
    return next((v for v in entry.versions if why_not(index, entry, v) is None), None)


def _refused(index: Index, entry: RulesEntry, best: RulesVersion | None) -> dict | None:
    if index.expired():
        return {"error": f"The catalog {index.source} is old: it expired at {index.expires}.",
                "hint": "Refresh it (Control › Plugins › Sources and rules › Refresh). keel installs nothing from an "
                        "old catalog."}
    if best is None:
        return {"error": f"No version of {entry.title} can be installed: {why_not(index, entry, entry.versions[0])}.",
                "hint": "Wait for a new version, or update keel."}
    return None


def hit(index: Index, entry: RulesEntry) -> dict:
    """One rule pack as search shows it."""
    pub = index.publishers[entry.publisher]
    best = choose(index, entry)
    shown = best or entry.versions[0]
    return {
        "name": entry.name, "kind": KIND, "title": entry.title, "publisher": entry.publisher,
        "publisher_title": pub.title, "verified": pub.verified, "version": best.version if best else None,
        "summary": entry.summary, "category": entry.category, "tags": list(entry.tags),
        "review": shown.view()["review"], "requires": shown.requires(), "fits": best is not None,
        "refused": _refused(index, entry, best), "source": index.source, "repo": entry.repo,
        "latest": entry.versions[0].version, "old": index.expired(),
        "why_not": None if best else why_not(index, entry, entry.versions[0]), "trust": TRUST,
    }


def search(q: str = "", category: str | None = None) -> dict:
    """{rules: [Hit], sources: [status], categories: [str]}; an exact name first, then by title."""
    hits = [hit(index, entry) for index, entry in catalog.matching(KIND, q, category)]
    exact = (q or "").strip().lower()
    hits.sort(key=lambda h: (h["name"] != exact, h["title"].lower(), h["name"]))
    return {"rules": hits, "sources": catalog.statuses(), "categories": list(catalog.RULES_CATEGORIES)}


def detail(name: str) -> dict:
    """Hit + {versions: [{version, released, requires, review, url, size, sha256, revoked, fits, why_not}] (newest
    first), checks: [str]}. 400 a bad name, 404 a name no catalog lists."""
    if not isinstance(name, str) or not NAME.match(name):
        raise MarketError(400, f"'{name}' is not a rule pack name.")
    found = catalog.lookup_kind(KIND, name)
    if found is None:
        raise MarketError(404, f"There is no rule pack {name} in the catalogs keel reads.",
                          "Refresh the catalogs (Control › Plugins › Sources and rules), or check the name.")
    index, entry = found
    out = hit(index, entry)
    out["versions"] = [{**v.view(), "revoked": index.why_revoked(name, v.version, KIND),
                        "fits": why_not(index, entry, v) is None, "why_not": why_not(index, entry, v)}
                       for v in entry.versions]
    out["checks"] = list(CHECKS)
    return out
