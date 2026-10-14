"""Where keel keeps its files in a project: keel v1's `layout:` key in .keel/config.yml (keel v1 0.79).

  repo      the spec folder from `specs.dir`, else docs/specs or specs; docs/knowledge, docs/adr, docs/RUNNING.md
            and a block in CLAUDE.md, committed like code.
  keel      all of it under .keel/ (.keel/specs, .keel/knowledge, .keel/adr, .keel/RUNNING.md, .keel/CLAUDE.md),
            hidden from git through .git/info/exclude.
  external  the same paths, but .keel is a symlink to ~/.keel/projects/<id>/ outside the clone. keel follows the
            link; when its target is not visible here (a folder keel2 did not mount) `missing` says what to do.

Without a `layout:` key (default_name): a .keel link is external, a project with keel files in docs/ stays repo,
and a new project gets NEW_PROJECT.

keel writes where the layout says. It reads from every place that exists, the layout's own first: a project that
moved half of its files (both .keel/specs and docs/specs) shows both. The api has the same resolver
(api knowledge/Layout.kt).
"""

from __future__ import annotations

import os
from dataclasses import dataclass
from pathlib import Path

import yaml

LAYOUTS = ("repo", "keel", "external")
REPO = {"specs": "docs/specs", "knowledge": "docs/knowledge", "adr": "docs/adr", "runbook": "docs/RUNNING.md",
        "claude": "CLAUDE.md"}
HIDDEN = {"specs": ".keel/specs", "knowledge": ".keel/knowledge", "adr": ".keel/adr", "runbook": ".keel/RUNNING.md",
          "claude": ".keel/CLAUDE.md"}
REPO_SPEC_DIRS = ("docs/specs", "specs")
# keel's files in the repo layout's places: a project without a `layout:` key that has one of them stays `repo`
LEGACY_FILES = ("docs/specs", "docs/knowledge", "docs/adr", "docs/RUNNING.md")
# The layout of a project with no `layout:` key and no keel files yet: `.keel/` (layout keel), the user's default since
# 0.15.9, when keel's file history in the database came (these files are outside git).
NEW_PROJECT = "keel"


@dataclass(frozen=True)
class Layout:
    name: str
    specs: str                  # where a new spec goes
    knowledge: str              # where the knowledge sections go
    adr: str
    runbook: str
    claude: str                 # the file with keel's CLAUDE.md block
    spec_dirs: tuple[str, ...]  # every spec folder to read, `specs` first (it is listed even before it exists)
    knowledge_dirs: tuple[str, ...]
    adr_dirs: tuple[str, ...]
    runbooks: tuple[str, ...]   # the runbooks that exist, the layout's first
    link: str | None = None     # external: where .keel points
    missing: str | None = None  # external: the link's target is not visible here, in words

    @property
    def hidden(self) -> bool:
        """keel's files are outside git (keel, external): a docs / memory / setup commit has nothing to commit."""
        return self.name != "repo"

    def knowledge_file(self, root: str | Path, section: str) -> str:
        """The section's file to read: the layout's own, else one in another knowledge folder, else the layout's."""
        for d in self.knowledge_dirs:
            if (Path(root) / d / f"{section}.md").is_file():
                return f"{d}/{section}.md"
        return f"{self.knowledge}/{section}.md"

    def runbook_file(self) -> str:
        return self.runbooks[0] if self.runbooks else self.runbook


def raw_config(root: str | Path) -> dict:
    """The project's .keel/config.yml as written (no defaults), {} when it is missing or unreadable."""
    try:
        data = yaml.safe_load((Path(root) / ".keel" / "config.yml").read_text())
    except (OSError, yaml.YAMLError):
        return {}
    return data if isinstance(data, dict) else {}


def missing_text(target: str) -> str:
    return f"this project keeps keel's files in {target}; add that folder too: keel2 add {target}"


def _sub(cfg: dict, sec: str, key: str) -> str | None:
    """A folder or file the config names, relative to the project. One that is absolute, starts with ~ or climbs out
    with .. is ignored (a cloned repo's config must not point keel at files outside it)."""
    v = (cfg.get(sec) or {}).get(key) if isinstance(cfg.get(sec), dict) else None
    if not v:
        return None
    raw = str(v).strip()
    if raw.startswith(("/", "~", "\\")) or ".." in raw.replace("\\", "/").split("/"):
        return None
    return raw.strip("/") or None


def _existing(root: Path, first: str, others: tuple[str, ...] | list[str], is_file: bool = False) -> tuple[str, ...]:
    out: list[str] = [first]
    for d in others:
        if d and d not in out and ((root / d).is_file() if is_file else (root / d).is_dir()):
            out.append(d)
    return tuple(out)


def has_legacy_files(root: Path) -> bool:
    """keel's files sit in the repo layout's places already (docs/specs, docs/knowledge, …, or a spec in specs/)."""
    if any((root / p).exists() for p in LEGACY_FILES):
        return True
    return (root / "specs").is_dir() and any((root / "specs").glob("*.md"))


def default_name(root: Path, linked: bool, cfg: dict | None = None) -> str:
    """The layout of a project whose config has no `layout:` key: a .keel link is external (the config may sit behind
    it, out of sight), keel files in docs/ or a config that names keel's folders (specs.dir, memory.dir,
    setup.runbook) keep `repo` (existing projects never move by themselves), else the new projects' default."""
    if linked:
        return "external"
    if has_legacy_files(root) or any(_sub(cfg or {}, s, k) for s, k in (("specs", "dir"), ("memory", "dir"), ("setup", "runbook"))):
        return "repo"
    return NEW_PROJECT


def resolve(root: str | Path, cfg: dict | None = None) -> Layout:
    """The layout of the project at `root`. `cfg` is the raw config when the caller has read it already."""
    r = Path(root)
    keel = r / ".keel"
    link = missing = None
    if keel.is_symlink():
        link = os.readlink(keel)
        if not os.path.isabs(link):
            link = os.path.normpath(os.path.join(r, link))
        if not keel.is_dir():
            missing = missing_text(link)
    cfg = raw_config(r) if cfg is None else cfg
    name = str(cfg.get("layout") or "").strip()
    if name not in LAYOUTS:
        name = default_name(r, link is not None, cfg)
    if name == "repo":
        set_dir = _sub(cfg, "specs", "dir")
        specs = set_dir or next((d for d in REPO_SPEC_DIRS if (r / d).is_dir()), REPO["specs"])
        p = {**REPO, "specs": specs, "knowledge": _sub(cfg, "memory", "dir") or REPO["knowledge"],
             "runbook": _sub(cfg, "setup", "runbook") or REPO["runbook"]}
    else:
        p = dict(HIDDEN)
    spec_dirs = _existing(r, p["specs"], [_sub(cfg, "specs", "dir") or "", *REPO_SPEC_DIRS, HIDDEN["specs"]])
    knowledge_dirs = _existing(r, p["knowledge"], [REPO["knowledge"], HIDDEN["knowledge"]])
    adr_dirs = _existing(r, p["adr"], [REPO["adr"], HIDDEN["adr"]])
    runbooks = tuple(x for x in _existing(r, p["runbook"], [REPO["runbook"], HIDDEN["runbook"]], is_file=True)
                     if (r / x).is_file())
    return Layout(name, p["specs"], p["knowledge"], p["adr"], p["runbook"], p["claude"], spec_dirs, knowledge_dirs,
                  adr_dirs, runbooks, link, missing)


EXCLUDE = ["/.keel", "/.keel/"]


def hide(root: str | Path, lay: Layout | None = None) -> bool:
    """keel and external: hide .keel/ from git for this clone only (.git/info/exclude, never committed), as keel v1
    does. True when the lines are there (added now or before); False for repo, or when root is not a git repo.
    Untracked files only: a .keel/config.yml committed before stays tracked (`git rm -r --cached .keel` untracks it)."""
    from .tools import git

    lay = lay or resolve(root)
    if not lay.hidden:
        return False
    return git.exclude(str(root), EXCLUDE, f"keel (layout {lay.name}): keel's files stay out of git")
