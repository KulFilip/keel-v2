"""keel-plugin skills lint: the checks of a skill for the marketplace (keel 0.18.6), without keel, and the review the
catalog lists for it.

A marketplace skill is one SKILL.md, `<name>-<version>.md` (or `skills/<name>/<version>.md` in the marketplace repo), at
most 256 KB, signed like a plugin, and **shipped unchanged**: it is the text keel saves as one of a project's skills.

    ---
    name: changelog-entries        required: the marketplace name ([a-z0-9-], 64 at most)
    description: …                 required: one sentence, what it teaches and when an agent needs it
    version: 1.0.0                 optional: when it is there, the marketplace version
    ---
    # Changelog entries            the text an agent reads (required)

The review (keel's engine builds the same from the file, keel_engine.marketplace.kinds.skill_review): {tokens (its
size / 4), sections (its ## headings outside code fences, at most 40), description}.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import miniyaml
from .manifest import VERSION

MAX_SIZE = 256 << 10
MAX_SECTIONS = 40
NAME = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
KEYS = ("name", "description", "version", "license", "allowed-tools", "metadata", "agents", "user-invocable")
CATEGORIES = ("testing", "implementation", "review", "debugging", "knowledge", "authoring", "other")
FILE = re.compile(r"^(?P<name>[a-z0-9][a-z0-9-]{0,63})-(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.md$")


@dataclass
class SkillReport:
    target: str
    name: str | None = None
    version: str | None = None
    review: dict | None = None
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def text(self) -> str:
        head = f"keel-plugin skills lint: {self.target}"
        if self.name and self.version:
            head += f" ({self.name} {self.version})"
        lines = [head]
        lines += [f"  error    {e}" for e in self.errors]
        lines += [f"  warning  {w}" for w in self.warnings]
        if self.review is not None and not self.errors:
            r = self.review
            lines.append(f"  review: {r['tokens']} tokens · {len(r['sections'])} sections"
                         + (f" ({', '.join(r['sections'])})" if r["sections"] else "") + f" · {r['description']}")
        lines.append(f"  {len(self.errors)} errors, {len(self.warnings)} warnings" if self.errors or self.warnings
                     else "  ok: no problems found")
        return "\n".join(lines)


def split_front(text: str) -> tuple[dict | None, str]:
    """The front matter (the lines between the first two ---) and the text after it; (None, text) without one."""
    if not text.startswith("---"):
        return None, text
    lines = text.split("\n")
    end = next((i for i in range(1, len(lines)) if lines[i].strip() == "---"), None)
    if end is None:
        return None, text
    try:
        fm = miniyaml.loads("\n".join(lines[1:end]) + "\n") or {}
    except miniyaml.YamlError:
        return None, text
    return (fm if isinstance(fm, dict) else None), "\n".join(lines[end + 1:])


def review(text: str) -> dict:
    """{tokens, sections, description}: the same as keel's engine (marketplace/kinds.py skill_review)."""
    fm, body = split_front(text)
    sections: list[str] = []
    fenced = False
    for line in body.split("\n"):
        if line.lstrip().startswith("```"):
            fenced = not fenced
        elif not fenced and line.startswith("## ") and len(sections) < MAX_SECTIONS:
            sections.append(line[3:].strip())
    desc = (fm or {}).get("description")
    return {"tokens": len(text.encode("utf-8")) // 4, "sections": sections,
            "description": desc.strip() if isinstance(desc, str) else ""}


def name_version(path: Path) -> tuple[str | None, str | None]:
    """<name>-<version>.md, or skills/<name>/<version>.md."""
    m = FILE.match(path.name)
    if m:
        return m["name"], m["version"]
    if path.suffix == ".md" and VERSION.match(path.stem) and NAME.match(path.parent.name):
        return path.parent.name, path.stem
    return None, None


def lint(path: Path, name: str | None = None, version: str | None = None) -> SkillReport:
    found = name_version(path)
    name, version = name or found[0], version or found[1]
    r = SkillReport(str(path), name, version)
    if not name or not version:
        r.errors.append("the file name must be <name>-<version>.md (or skills/<name>/<version>.md), or give --name and "
                        "--version")
    elif not NAME.match(name):
        r.errors.append(f"'{name}' is not a skill name (a-z, 0-9 and '-', 64 at most)")
    elif not VERSION.match(version):
        r.errors.append(f"'{version}' is not a version like 1.0.0")
    data = path.read_bytes()
    if len(data) > MAX_SIZE:
        r.errors.append(f"the file is {len(data):,} bytes; a skill is at most {MAX_SIZE:,}")
        return r
    try:
        text = data.decode("utf-8")
    except UnicodeDecodeError:
        r.errors.append("the file is not UTF-8 text")
        return r
    fm, body = split_front(text)
    if fm is None:
        r.errors.append("it has no front matter: start with ---, name: <name>, description: <one sentence>, ---")
        return r
    for key in fm:
        if key not in KEYS:
            r.warnings.append(f"'{key}' is not a skill field keel reads ({', '.join(KEYS)})")
    if fm.get("name") != name:
        r.errors.append(f"its name is {fm.get('name')!r}; the marketplace name is {name!r}: they must be the same")
    if not isinstance(fm.get("description"), str) or not fm["description"].strip():
        r.errors.append("its front matter has no description (one sentence: what it teaches, when it is needed)")
    if fm.get("version") is not None and str(fm["version"]) != version:
        r.errors.append(f"its version is {fm['version']}; the marketplace version is {version}: they must be the same")
    if not body.strip():
        r.errors.append("it has no text after its front matter")
    r.review = review(text)
    return r


def category_of(name: str) -> str:
    """keel's own skills' category, from the name (the api's SkillService.kindOf, mapped onto the marketplace's)."""
    if name.endswith("-testing") or name == "playwright":
        return "testing"
    if name.endswith("-implementation") or name == "architecture":
        return "implementation"
    if name in ("debugging", "diagnose"):
        return "debugging"
    if name in ("security", "review"):
        return "review"
    if name in ("spec-clarify", "spec-writing"):
        return "authoring"
    return "knowledge" if name == "memory" else "other"


def _quoted(text: str) -> str:
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def add(sources: list[Path], market: Path, version: str, publisher: str, keel: str | None = None) -> list[str]:
    """Put SKILL.md files (a skill folder or the file) into a marketplace folder, unchanged, as skills/<name>/<version>.md,
    with their entry skills/<name>.yml (title from the first # heading, summary from the description, category from the
    name). Each must lint; nothing is signed here (sign each with keel-plugin sign and the publisher's key). Returns
    what it wrote."""
    if not NAME.match(publisher) or not VERSION.match(version):
        raise ValueError("--publisher must be a name and --version a version like 1.0.0")
    done: list[str] = []
    for src in sources:
        f = src / "SKILL.md" if src.is_dir() else src
        text = f.read_text(encoding="utf-8")
        fm, body = split_front(text)
        name = (fm or {}).get("name") if fm else None
        if not isinstance(name, str):
            raise ValueError(f"{f}: no front matter name")
        target = market / "skills" / name / f"{version}.md"
        target.parent.mkdir(parents=True, exist_ok=True)
        target.write_text(text, encoding="utf-8")
        report = lint(target)
        if report.errors:
            target.unlink()
            raise ValueError(f"{f}: " + "; ".join(report.errors))
        title = next((ln[2:].strip() for ln in body.split("\n") if ln.startswith("# ")), name.replace("-", " ").capitalize())
        desc = str(fm.get("description") or "").strip()
        summary = desc.split(". ")[0].rstrip(".") + "." if desc else title
        entry = [f"# keel's own skill {name} (content/skills in keel-v2), kept in this repo: skills/{name}/<version>.md",
                 f"name: {name}", f"title: {_quoted(title)}", f"publisher: {publisher}",
                 f"category: {category_of(name)}", f"summary: {_quoted(summary)}", f"tags: [{name.split('-')[0]}, keel]"]
        if keel:
            entry.append(f"keel: {_quoted(keel)}")
        (market / "skills" / f"{name}.yml").write_text("\n".join(entry) + "\n", encoding="utf-8")
        done += [str(target), str(market / "skills" / f"{name}.yml")]
    return done
