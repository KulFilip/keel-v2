"""The catalogs: fetch each source's index, verify it, keep the last good copy, and search it
(docs/plugins/13-step4-contract.md §3).

    <url>               v1/index.json (format 1), at most 5 MB
    <url>.minisig       signed by the source's key
    $KEEL_DATA/plugins/catalog/<id>.json, <id>.json.minisig   the last good copy (keel works offline with it)
    $KEEL_DATA/plugins/catalog/<id>.meta.json                 {fetched_at, tried_at, ok, problem}

Checks when reading an index: 1. the signature verifies with the source's key; 2. format is 1 (and it has an expires
date); 3. names follow keel's plugin name rule, versions keel's manifest version rule (1.0.0, or a pre-release like
0.1.0-beta.1, which sorts before its release), sha256 is 64 hex, URLs are https (§2); 4. a
plugin's publisher is listed. A failing entry (a plugin or one of its versions) is left out and listed as a problem;
the rest is used. Any other failure keeps the last good copy and shows the problem. An index older than the copy keel
has is refused, so nobody can hand keel an old catalog. An expired index still searches ("the catalog is old"), but
install and update wait until a refresh works.

Kinds (docs/plugins/23-rules-in-marketplace.md §2): every list is read through one table, kinds.TABLE: `plugins`
(.kplug, 200 MB), `workflows` (one signed workflow YAML each, at most 256 KB) and `rules` (one signed rule pack YAML
each, at most 64 KB) and `skills` (one signed SKILL.md each, at most 256 KB). Every entry may say its `kind` (`plugin` when it does not); a `revoked` entry too. An index
without these lists reads as before.
"""

from __future__ import annotations

import json
import logging
import re
import socket
import urllib.error
import urllib.request
from dataclasses import dataclass, field
from datetime import datetime, timezone
from pathlib import Path

from .. import config
from ..addons import NAME, satisfies
from ..pluginhost import SDK, manifest, state
from . import MarketError, kinds, local, sources
from .kinds import (Entry, Kind, RulesEntry, RulesVersion, SkillEntry, SkillVersion,  # noqa: F401 - their home was here
                    Version, WorkflowEntry, WorkflowVersion)
from .signing import PublicKey, SignatureError, verify

log = logging.getLogger("keel.marketplace")

FORMAT = 1
MAX_INDEX = 5 << 20
MAX_SIG = 64 << 10
MAX_PACKAGE = kinds.PLUGIN.max_size
TIMEOUT = 20
FRESH = 6 * 3600
TRUST = kinds.TRUST
CATEGORIES = kinds.PLUGIN.categories
WORKFLOW_CATEGORIES = kinds.WORKFLOW.categories
RULES_CATEGORIES = kinds.RULES.categories
SKILLS_CATEGORIES = kinds.SKILLS.categories
KINDS = kinds.NAMES
MAX_WORKFLOW = kinds.WORKFLOW.max_size
MAX_RULES = kinds.RULES.max_size
MAX_SKILL = kinds.SKILLS.max_size
RESERVED = kinds.RESERVED     # /api/marketplace/<these> are keel's routes, never a plugin's page
AGENT = kinds.AGENT
SHA256 = re.compile(r"^[0-9a-f]{64}$")
CHUNK = 1 << 16


# ------------------------------------------------------------------ downloads

class _Redirects(urllib.request.HTTPRedirectHandler):
    """Follow a redirect (GitHub release downloads have one) only to an address keel may read (§2)."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):
        why = sources.url_problem(newurl)
        if why:
            raise MarketError(502, f"The download was sent on to an address keel refuses: {why}.")
        return super().redirect_request(req, fp, code, msg, headers, newurl)


def download(url: str, *, limit: int, to: Path | None = None, timeout: float = TIMEOUT) -> bytes:
    """GET an https address (or http to this computer in tests), at most `limit` bytes. With `to`, the bytes go into that
    file instead (and b"" is returned). Raises MarketError in plain words."""
    url = sources.check_url(url, "download")
    req = urllib.request.Request(url, headers={"User-Agent": f"keel/{config.VERSION}", "Accept-Encoding": "identity"})
    opener = urllib.request.build_opener(_Redirects())
    host = url.split("/")[2]
    got = bytearray()
    out = open(to, "wb") if to else None
    try:
        with opener.open(req, timeout=timeout) as res:
            size = res.headers.get("Content-Length")
            if size and size.isdigit() and int(size) > limit:
                raise MarketError(502, f"{url} is {int(size):,} bytes, more than the {limit:,} bytes keel allows here.")
            total = 0
            while chunk := res.read(CHUNK):
                total += len(chunk)
                if total > limit:
                    raise MarketError(502, f"{url} is bigger than the {limit:,} bytes keel allows here, so keel stopped.")
                if out:
                    out.write(chunk)
                else:
                    got += chunk
    except urllib.error.HTTPError as exc:
        raise MarketError(502, f"{host} answered {exc.code} for {url}.") from None
    except (urllib.error.URLError, socket.timeout, TimeoutError, ConnectionError) as exc:
        reason = getattr(exc, "reason", None) or exc
        raise MarketError(502, f"keel cannot reach {host}: {reason}.", "Check the internet connection, then try again.") from None
    finally:
        if out:
            out.close()
    return bytes(got)


# ------------------------------------------------------------------ the index

@dataclass
class Publisher:
    title: str
    keys: list[PublicKey]
    verified: bool


@dataclass
class Index:
    source: str
    built: str
    expires: str
    publishers: dict[str, Publisher]
    plugins: dict[str, Entry]
    revoked: dict[tuple[str, str, str], str] = field(default_factory=dict)   # (kind, name, version) → why
    problems: list[str] = field(default_factory=list)
    workflows: dict[str, WorkflowEntry] = field(default_factory=dict)
    rules: dict[str, RulesEntry] = field(default_factory=dict)
    skills: dict[str, SkillEntry] = field(default_factory=dict)

    def expired(self) -> bool:
        return _when(self.expires) <= datetime.now(timezone.utc)

    def why_revoked(self, name: str, version: str, kind: str = "plugin") -> str | None:
        return self.revoked.get((kind, name, version))

    def entries(self, kind: str) -> dict:
        """One kind's entries by name (kinds.TABLE: plugin, workflow, rules, skills)."""
        return getattr(self, kinds.BY_NAME[kind].list)


def _when(text) -> datetime:
    if not isinstance(text, str) or not text.strip():
        raise ValueError("no date")
    d = datetime.fromisoformat(text.strip().replace("Z", "+00:00"))
    return d if d.tzinfo else d.replace(tzinfo=timezone.utc)


def _text(v, default: str = "") -> str:
    return v.strip() if isinstance(v, str) and v.strip() else default


def _version(kind: Kind, name: str, raw):
    """One version of an entry, checked: the checks every kind shares, then the kind's own (kinds.py)."""
    head = f"{kind.label}{name}: " if kind.label else ""
    if not isinstance(raw, dict):
        raise ValueError(f"{head}a version is not an object")
    v = raw.get("version")
    if not isinstance(v, str) or not manifest.VERSION.match(v):
        raise ValueError(f"{head}version {v!r} is not a version like 1.0.0 or 0.1.0-beta.1")
    where = f"{kind.label}{name} {v}"
    sha = raw.get("sha256")
    if not isinstance(sha, str) or not SHA256.match(sha):
        raise ValueError(f"{where}: sha256 is not 64 hex digits")
    url = raw.get("url")
    why = sources.url_problem(url)
    if why:
        raise ValueError(f"{where}: {why}")
    size = raw.get("size")
    if isinstance(size, bool) or not isinstance(size, int) or not 0 < size <= kind.max_size:
        raise ValueError(f"{where}: size must be a number of bytes up to {kind.max_size:,}")
    req = raw.get("requires") or {}
    if not isinstance(req, dict):
        raise ValueError(f"{where}: requires is not an object")
    own = kind.check_requires(req, where)
    keel = req.get("keel") or ""
    if not isinstance(keel, str) or not manifest.valid_spec(keel):
        raise ValueError(f"{where}: requires.keel {keel!r} is not a version range")
    needs = req.get("plugins") or {}
    if not isinstance(needs, dict):
        raise ValueError(f"{where}: requires.plugins is not an object")
    plugins: dict[str, str] = {}
    for dep, spec in needs.items():
        spec = "" if spec is None else spec
        if not isinstance(dep, str) or not NAME.match(dep) or not isinstance(spec, str) or not manifest.valid_spec(spec):
            raise ValueError(f"{where}: requires.plugins.{dep} is not a plugin name with a version range")
        plugins[dep] = spec.strip()
    own.update(kind.check_version(raw, req, where))
    return kind.version_type(version=v, released=_text(raw.get("released")), keel=keel.strip(), plugins=plugins,
                             url=url.strip(), sha256=sha, size=size, **own)


def _entry(kind: Kind, raw, publishers: dict[str, Publisher], source: str, problems: list[str]):
    """One entry of a kind's list, checked; a version that fails is left out and listed in problems."""
    if not isinstance(raw, dict):
        raise ValueError(f"a {kind.noun} is not an object")
    kind.precheck(raw)
    name = raw.get("name")
    if not isinstance(name, str) or not kind.name_rule.match(name):
        raise ValueError(f"{kind.noun} name {name!r} does not follow keel's name rule")
    kind.check_name(raw, name)
    pub = raw.get("publisher")
    if pub not in publishers:
        raise ValueError(f"{kind.label}{name}: its publisher {pub!r} is not listed")
    if not publishers[pub].keys:
        raise ValueError(f"{kind.label}{name}: its publisher {pub} has no valid key")
    own = kind.check_entry(raw, name)
    versions = []
    for item in raw.get("versions") or []:
        try:
            versions.append(_version(kind, name, item))
        except ValueError as exc:
            problems.append(f"left out: {exc}")
    if not versions:
        raise ValueError(f"{kind.label}{name}: it has no valid version")
    versions.sort(key=lambda x: version_order(x.version), reverse=True)
    category = raw.get("category") if raw.get("category") in kind.categories else "other"
    tags = [t.strip() for t in raw.get("tags") or [] if isinstance(t, str) and t.strip()]
    return kind.entry_type(name=name, title=_text(raw.get("title"), name), publisher=pub, category=category,
                           summary=_text(raw.get("summary")), tags=tags, repo=_text(raw.get("repo")),
                           versions=versions, source=source, **own)


def _list(data: dict, key: str) -> list:
    return data.get(key) if isinstance(data.get(key), list) else []


def _publishers(raw, problems: list[str]) -> dict[str, Publisher]:
    out: dict[str, Publisher] = {}
    for pid, p in (raw or {}).items() if isinstance(raw, dict) else []:
        if not isinstance(pid, str) or not NAME.match(pid) or not isinstance(p, dict):
            problems.append(f"left out: publisher {pid!r} is not valid")
            continue
        keys = []
        for k in p.get("keys") or []:
            try:
                keys.append(PublicKey.parse(k))
            except (SignatureError, TypeError):
                problems.append(f"publisher {pid}: a key is not a minisign public key")
        out[pid] = Publisher(_text(p.get("title"), pid), keys, p.get("verified") is True)
    return out


def parse_index(data, source: str) -> Index:
    """An index's content after its signature verified: the whole-index checks raise MarketError; a failing plugin or
    version is left out and listed in problems."""
    if not isinstance(data, dict):
        raise MarketError(502, "The catalog is not a JSON object.")
    if data.get("format") != FORMAT or isinstance(data.get("format"), bool):
        raise MarketError(502, f"The catalog's format is {data.get('format')!r}; this keel reads format {FORMAT}.",
                          "A newer keel may read it: update keel.")
    try:
        _when(data.get("expires"))
        _when(data.get("built"))
    except ValueError:
        raise MarketError(502, "The catalog has no valid built and expires dates.") from None
    problems: list[str] = []
    publishers = _publishers(data.get("publishers"), problems)
    lists: dict[str, dict] = {}
    for kind in kinds.TABLE:
        found: dict = {}
        for raw in _list(data, kind.list):
            try:
                e = _entry(kind, raw, publishers, source, problems)
            except ValueError as exc:
                problems.append(f"left out: {exc}")
                continue
            if e.name in found:
                problems.append(f"left out: {kind.label}{e.name} is listed twice")
                continue
            found[e.name] = e
        lists[kind.list] = found
    revoked: dict[tuple[str, str, str], str] = {}
    for r in _list(data, "revoked"):
        if isinstance(r, dict) and isinstance(r.get("name"), str) and isinstance(r.get("version"), str):
            kind = r.get("kind") if r.get("kind") in KINDS else "plugin"
            revoked[(kind, r["name"], r["version"])] = _text(r.get("why"), "revoked by the catalog")
    return Index(source, data["built"], data["expires"], publishers, revoked=revoked, problems=problems, **lists)


# ------------------------------------------------------------------ the copies on disk

def catalog_dir() -> Path:
    return state.plugins_dir() / "catalog"


def _files(sid: str) -> tuple[Path, Path, Path]:
    d = catalog_dir()
    return d / f"{sid}.json", d / f"{sid}.json.minisig", d / f"{sid}.meta.json"


def meta(sid: str) -> dict:
    f = _files(sid)[2]
    try:
        data = json.loads(f.read_text(encoding="utf-8")) if f.is_file() else {}
    except (OSError, UnicodeDecodeError, ValueError):
        data = {}
    return data if isinstance(data, dict) else {}


def _write_meta(sid: str, **changes) -> None:
    state.write_atomic(_files(sid)[2], json.dumps({**meta(sid), **changes}, indent=2) + "\n")


_cache: dict[str, tuple[tuple, Index]] = {}


def _source_key(src: dict) -> PublicKey | None:
    try:
        return PublicKey.parse(src["key"]) if src.get("key") else None
    except SignatureError:
        return None


def load(src: dict) -> Index | None:
    """The last good copy of a source's index, verified again with the source's key; None when there is none."""
    data_file, sig_file, _ = _files(src["id"])
    key = _source_key(src)
    if key is None or not data_file.is_file() or not sig_file.is_file():
        return None
    try:
        d, s = data_file.stat(), sig_file.stat()
        stamp = (d.st_mtime_ns, d.st_size, s.st_mtime_ns, s.st_size, key.line())
        hit = _cache.get(src["id"])
        if hit and hit[0] == stamp:
            return hit[1]
        raw = data_file.read_bytes()
        verify(raw, sig_file.read_text(encoding="utf-8"), [key])
        index = parse_index(json.loads(raw), src["id"])
    except (OSError, UnicodeDecodeError, ValueError, SignatureError, MarketError) as exc:
        log.warning("marketplace: the copy of source %s is not used: %s", src["id"], exc)
        return None
    _cache[src["id"]] = (stamp, index)
    return index


def _publisher_keys(index: Index, src: dict) -> None:
    """The official catalog's publisher keel may also be checked with the keel key in the image."""
    if src.get("official") and "keel" in index.publishers:
        extra = sources.keel_publisher_key()
        keys = index.publishers["keel"].keys
        if extra and extra not in keys:
            keys.append(extra)


def fetch(src: dict) -> Index:
    """Read one source now: download, verify, check, then keep it as the last good copy. Raises MarketError."""
    key = _source_key(src)
    if key is None:
        raise MarketError(409, sources.NOT_SET_UP if src.get("official") else f"Source {src['id']} has no valid key.")
    raw = download(src["url"], limit=MAX_INDEX)
    sig = download(src["url"] + ".minisig", limit=MAX_SIG)
    try:
        verify(raw, sig.decode("utf-8"), [key])
    except (SignatureError, UnicodeDecodeError) as exc:
        raise MarketError(502, f"The catalog's signature does not match the source's key: {exc}.",
                          "Someone may have changed the catalog on its way to keel; keel keeps its last good copy.") from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise MarketError(502, "The catalog is not valid JSON.") from None
    index = parse_index(data, src["id"])
    old = load(src)
    if old and _when(index.built) < _when(old.built):
        raise MarketError(502, f"The catalog was built {index.built}, before the copy keel has ({old.built}).",
                          "keel keeps the newer copy: an old catalog could hide a revoked version.")
    data_file, sig_file, _ = _files(src["id"])
    catalog_dir().mkdir(parents=True, exist_ok=True)
    data_file.write_bytes(raw)      # the pair is verified again on every load, so a torn pair is never used
    sig_file.write_text(sig.decode("utf-8"), encoding="utf-8")
    _cache.pop(src["id"], None)
    return index


def refresh(only: str | None = None, *, older_than: float | None = None) -> list[dict]:
    """Read each source that is on now (or only one; or only those whose copy is older than `older_than` seconds).
    A failure keeps the last good copy. Returns every source's status."""
    now = datetime.now(timezone.utc)
    for src in sources.read_sources():
        if (only and src["id"] != only) or not src["on"]:
            continue
        if older_than is not None:
            try:
                if (now - _when(meta(src["id"]).get("fetched_at"))).total_seconds() < older_than:
                    continue
            except ValueError:
                pass
        stamp = now.strftime("%Y-%m-%dT%H:%M:%SZ")
        if src.get("official") and not src.get("key"):
            _write_meta(src["id"], ok=False, problem=sources.NOT_SET_UP, tried_at=stamp)
            continue
        try:
            fetch(src)
            _write_meta(src["id"], ok=True, problem=None, fetched_at=stamp, tried_at=stamp)
        except MarketError as exc:
            log.warning("marketplace: source %s: %s", src["id"], exc)
            _write_meta(src["id"], ok=False, problem=str(exc), tried_at=stamp)
    return statuses()


def status(src: dict) -> dict:
    """{id, title, url, official, on, ok, problem, old, fetched_at, built, expires, plugins, problems}."""
    m = meta(src["id"])
    index = load(src)
    problem = m.get("problem")
    if src.get("official") and not src.get("key"):
        problem = sources.NOT_SET_UP
    elif index is None and not problem:
        problem = "not read yet: Refresh reads it"
    return {"id": src["id"], "title": src["title"], "url": src["url"], "official": bool(src.get("official")),
            "on": src["on"], "ok": index is not None and m.get("ok", True) is not False and not problem,
            "problem": problem, "old": bool(index and index.expired()), "fetched_at": m.get("fetched_at"),
            "built": index.built if index else None, "expires": index.expires if index else None,
            "plugins": len(index.plugins) if index else 0, "problems": list(index.problems) if index else [],
            "workflows": len(index.workflows) if index else 0}


def statuses() -> list[dict]:
    return [status(s) for s in sources.read_sources()]


def indexes() -> list[Index]:
    """The usable copies of the sources that are on, in the sources' order (the official one first)."""
    out = []
    for src in sources.read_sources():
        if src["on"] and (index := load(src)):
            _publisher_keys(index, src)
            out.append(index)
    return out


def lookup(name: str) -> tuple[Index, Entry] | None:
    """The first source that lists this plugin."""
    for index in indexes():
        if name in index.plugins:
            return index, index.plugins[name]
    return None


# ------------------------------------------------------------------ fits, and search

def why_not(index: Index, entry: Entry, v: Version, have: dict, seen: frozenset = frozenset()) -> str | None:
    """None when this version fits this keel: the SDK, keel's version, and each needed plugin installed with a fitting
    version or in the same catalog; else why not, in plain words."""
    if v.sdk != SDK:
        return f"needs plugin SDK {v.sdk}, this keel has {SDK}"
    if not satisfies(config.VERSION, v.keel):
        return f"needs keel {v.keel}, this is keel {config.VERSION}"
    if why := index.why_revoked(entry.name, v.version):
        return f"{entry.name} {v.version} is revoked: {why}"
    for dep, spec in sorted(v.plugins.items()):
        if dep in have and satisfies(have[dep].version, spec):
            continue
        dep_entry = index.plugins.get(dep)
        ok = dep_entry and dep not in seen and any(
            satisfies(x.version, spec) and not why_not(index, dep_entry, x, have, seen | {entry.name})
            for x in dep_entry.versions)
        if not ok:
            return f"needs {dep} {spec}".rstrip() + ", which is neither installed nor in this catalog"
    return None


def newest_fitting(index: Index, entry: Entry, have: dict, spec: str = "") -> Version | None:
    return next((v for v in entry.versions if satisfies(v.version, spec) and not why_not(index, entry, v, have)), None)


def version_order(version: str) -> tuple:
    """A sort key in semver's order: 0.9.0 < 1.0.0-alpha < 1.0.0-beta.2 < 1.0.0-beta.10 < 1.0.0 (build metadata after
    '+' does not count)."""
    core, _, pre = version.split("+", 1)[0].partition("-")
    numbers = tuple(int(p) if p.isdigit() else 0 for p in core.split("."))
    if not pre:
        return numbers, 1, ()
    # in a pre-release, numeric identifiers sort before words and by their value
    return numbers, 0, tuple((0, int(x), "") if x.isdigit() else (1, 0, x) for x in pre.split("."))


def newer(a: str, b: str) -> bool:
    """Whether version a is newer than b (a pre-release is older than its release)."""
    return version_order(a) > version_order(b)


def hit(index: Index, entry: Entry, have: dict) -> dict:
    """One plugin as search shows it."""
    pub = index.publishers[entry.publisher]
    best = newest_fitting(index, entry, have)
    mine = have.get(entry.name)
    revoked = None
    if mine and (why := index.why_revoked(entry.name, mine.version)):
        fixed = next((v.version for v in entry.versions if newer(v.version, mine.version)
                      and not index.why_revoked(entry.name, v.version)), None)
        revoked = {"version": mine.version, "why": why, "fixed": fixed}
    return {
        "name": entry.name, "title": entry.title, "publisher": entry.publisher, "publisher_title": pub.title,
        "verified": pub.verified, "category": entry.category, "summary": entry.summary, "tags": list(entry.tags),
        "trust": entry.trust, "repo": entry.repo, "source": index.source, "latest": entry.versions[0].version,
        "version": best.version if best else None, "permissions": best.permissions if best else {},
        "fits": best is not None, "why_not": None if best else why_not(index, entry, entry.versions[0], have),
        "installed": mine.version if mine else None, "installed_from": mine.source if mine else None,
        "update": best.version if best and mine and newer(best.version, mine.version) else None,
        "revoked": revoked, "old": index.expired(),
        "needs": dict(best.plugins) if best else {},    # 0.16.1: the cards say "needs Code"
    }


def _matches(entry: Entry | WorkflowEntry | RulesEntry, words: list[str]) -> bool:
    text = " ".join([entry.name, entry.title, entry.summary, *entry.tags]).lower()
    return all(w in text for w in words)


def matching(kind: str, q: str = "", category: str | None = None) -> list[tuple[Index, Entry | WorkflowEntry | RulesEntry]]:
    """The entries of one kind (plugin, workflow or rules) whose name, title, summary or tags hold each word of q (and that
    have this category), in the sources' order; a name two sources list comes from the first. One search for every
    kind (21-workflow-marketplace.md §2)."""
    words = [w for w in (q or "").lower().split() if w]
    seen: set[str] = set()
    out: list = []
    for index in indexes():
        for entry in index.entries(kind).values():
            if entry.name in seen:
                continue
            seen.add(entry.name)
            if category and entry.category != category:
                continue
            if _matches(entry, words):
                out.append((index, entry))
    return out


def lookup_kind(kind: str, name: str) -> tuple[Index, Entry | WorkflowEntry | RulesEntry] | None:
    """The first source that lists this name in this kind's list."""
    for index in indexes():
        found = index.entries(kind).get(name)
        if found:
            return index, found
    return None


def search(q: str = "", category: str | None = None) -> dict:
    """Every plugin of the usable catalogs whose name, title, summary or tags hold each word of q (and that has this
    category). A name listed by two sources comes from the first. {"plugins": [hit], "sources": [status]}."""
    have = local.have()
    hits = [hit(index, entry, have) for index, entry in matching("plugin", q, category)]
    exact = (q or "").strip().lower()
    hits.sort(key=lambda h: (h["name"] != exact, h["title"].lower(), h["name"]))
    return {"plugins": hits, "sources": statuses(), "categories": list(CATEGORIES)}
