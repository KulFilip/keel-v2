"""keel-plugin workflow lint: the checks of a workflow for the marketplace (docs/plugins/21-workflow-marketplace.md §5),
without keel, and the Install review the catalog lists for it.

A marketplace workflow is one YAML file, `<name>-<version>.yaml` (or `workflows/<name>/<version>.yaml` in the
marketplace repo), at most 256 KB, signed like a plugin. The checks are the shape keel's engine needs (keel validates it
again at install): a name; `version`, when it is there, a whole number (keel reads it so; the marketplace version is in
the file name); steps with ids and kinds, agent steps with their agent, `run:` steps with a command; `back`, `no` and
`then` pointing at a step; `needs_plugins` plugin names. The review is keel's Install review (keel computes it again at
install and refuses a workflow whose agents, MCP servers, commands or edits are not the catalog's): steps, gates,
agents, mcp, commands, edits_files, keel_rules.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field
from pathlib import Path

from . import miniyaml
from .lint import KEEL_AGENTS
from .manifest import NAME, VERSION

MAX_SIZE = 256 << 10
KINDS = ("agent", "code", "gate", "branch", "parallel", "include")
# keel's agents that change files (keel-v2 api AgentCatalog.WRITERS and the tools in content/agents/*.md)
WRITERS = frozenset({"implementer", "test-author", "e2e-author", "lane-runner", "reproducer", "librarian", "prover"})
EDIT_ACTIONS = ("commit", "write_config")
END = "end"
FILE = re.compile(r"^(?P<name>[a-z][a-z0-9-]{0,31})-(?P<version>[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?)\.yaml$")


@dataclass
class WorkflowReport:
    target: str
    name: str | None = None              # the marketplace name (from the file name or --name)
    version: str | None = None           # the marketplace version
    title: str | None = None             # the workflow's own name
    review: dict | None = None
    needs_plugins: list[str] = field(default_factory=list)
    errors: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)

    @property
    def ok(self) -> bool:
        return not self.errors

    def text(self) -> str:
        head = f"keel-plugin workflow lint: {self.target}"
        if self.name and self.version:
            head += f" ({self.name} {self.version})"
        lines = [head]
        lines += [f"  error    {e}" for e in self.errors]
        lines += [f"  warning  {w}" for w in self.warnings]
        if self.review:
            r = self.review
            lines.append(f"  review   {r['steps']} steps, {r['gates']} gates, keel rules {'on' if r['keel_rules'] else 'off'}, "
                         f"{'changes files' if r['edits_files'] else 'changes no files'}")
            lines.append(f"  agents   {', '.join(r['agents']) or 'none'}")
            if r["mcp"]:
                lines.append(f"  mcp      {', '.join(r['mcp'])}")
            for c in r["commands"]:
                lines.append(f"  run:     {c}")
        if self.needs_plugins:
            lines.append(f"  needs    {', '.join(self.needs_plugins)}")
        lines.append("ok" if self.ok else f"{len(self.errors)} error(s)")
        return "\n".join(lines)


def name_version(path: Path) -> tuple[str | None, str | None]:
    """<name>-<version>.yaml, or workflows/<name>/<version>.yaml (the marketplace repo's own files)."""
    m = FILE.match(path.name)
    if m:
        return m.group("name"), m.group("version")
    if path.suffix == ".yaml" and VERSION.match(path.stem) and NAME.match(path.parent.name):
        return path.parent.name, path.stem
    return None, None


def _strings(value) -> list[str]:
    return [str(x) for x in value] if isinstance(value, list) else []


def review(doc: dict) -> dict:
    """keel's Install review of a workflow (keel-v2 api WorkflowService.review), as far as a tool without keel can:
    an agent this tool does not know counts as one that changes files."""
    steps = [s for s in doc.get("steps") or [] if isinstance(s, dict)]
    agents: list[str] = []
    for s in steps:
        if isinstance(s.get("agent"), str):
            agents.append(s["agent"])
    for s in steps:
        for lane in s.get("lanes") or []:
            if isinstance(lane, dict) and lane.get("kind", "agent") == "agent" and isinstance(lane.get("sub"), str):
                agents.append(lane["sub"])
    agents = list(dict.fromkeys(agents))
    tools = list(dict.fromkeys(t for s in steps for t in _strings(s.get("tools"))))
    mcp = [m for m in _strings(doc.get("mcp")) + [t.split(":")[1] if len(t.split(":")) > 1 else ""
                                                  for t in tools if t.startswith("mcp:")] if m.strip()]
    mcp = list(dict.fromkeys(mcp))
    actions = [s["action"] for s in steps if isinstance(s.get("action"), str)]
    commands = [a[len("run:"):].strip() for a in actions if a.startswith("run:")]
    edits = (any(a in WRITERS or a not in KEEL_AGENTS for a in agents) or any(a in EDIT_ACTIONS for a in actions)
             or bool(commands))
    keel_rules = doc.get("keel_rules", True)
    return {"steps": len(steps), "gates": sum(1 for s in steps if s.get("kind") == "gate"), "agents": agents,
            "mcp": mcp, "commands": commands, "edits_files": edits,
            "keel_rules": keel_rules if isinstance(keel_rules, bool) else True}


def lint_text(text: str, target: str, name: str | None = None, version: str | None = None) -> WorkflowReport:
    rep = WorkflowReport(target, name, version)
    if name is None or not NAME.match(name):
        rep.errors.append("the file name must be <name>-<version>.yaml (name: a-z, 0-9 and '-', 32 at most; "
                          "version like 1.2.0), or give --name and --version")
    if version is not None and not VERSION.match(version):
        rep.errors.append(f"version {version!r} is not a version like 1.2.0 or 1.2.0-beta.1")
    if len(text.encode("utf-8")) > MAX_SIZE:
        rep.errors.append(f"the file is bigger than {MAX_SIZE // 1024} KB")
    try:
        doc = miniyaml.loads(text)
    except miniyaml.YamlError as exc:
        rep.errors.append(f"the YAML does not read: {exc}")
        return rep
    if not isinstance(doc, dict):
        rep.errors.append("a workflow is a mapping with name and steps")
        return rep
    title = doc.get("name")
    if not isinstance(title, str) or not title.strip():
        rep.errors.append("name is missing (the workflow's name, as people see it)")
    else:
        rep.title = title.strip()
    if "version" in doc and (isinstance(doc["version"], bool) or not isinstance(doc["version"], int)):
        rep.errors.append(f"version: {doc['version']!r} is not a whole number: keel reads a workflow's version as one. "
                          "The marketplace version is in the file name: leave version out")
    if "keel_rules" in doc and not isinstance(doc["keel_rules"], bool):
        rep.errors.append("keel_rules must be true or false")
    if "mcp" in doc and not (isinstance(doc["mcp"], list) and all(isinstance(x, str) for x in doc["mcp"])):
        rep.errors.append("mcp must be a list of MCP server names")
    needs = doc.get("needs_plugins")
    if needs is not None:
        if not isinstance(needs, list) or not all(isinstance(x, str) and NAME.match(x) for x in needs):
            rep.errors.append("needs_plugins must be a list of plugin names")
        else:
            rep.needs_plugins = list(needs)
    steps = doc.get("steps")
    if isinstance(steps, list):       # YAML 1.1 reads an unquoted `no:` key (a branch's target) as false, as keel does
        steps = [{("no" if k is False else k): v for k, v in s.items()} if isinstance(s, dict) else s for s in steps]
        doc = {**doc, "steps": steps}
    if not isinstance(steps, list) or not steps:
        rep.errors.append("steps is missing: a workflow has a list of steps")
        return rep
    ids: list[str] = []
    for i, s in enumerate(steps):
        where = f"steps[{i}]"
        if not isinstance(s, dict):
            rep.errors.append(f"{where} is not a mapping")
            continue
        sid = s.get("id")
        if not isinstance(sid, str) or not sid.strip():
            rep.errors.append(f"{where} has no id")
        else:
            where = f"step {sid}"
            if sid in ids:
                rep.errors.append(f"{where}: two steps share this id")
            ids.append(sid)
        if s.get("kind") not in KINDS:
            rep.errors.append(f"{where}: kind {s.get('kind')!r} is not one of {', '.join(KINDS)}")
        if not isinstance(s.get("name"), str) or not s["name"].strip():
            rep.errors.append(f"{where}: name is missing")
        if s.get("kind") == "agent" and not isinstance(s.get("agent"), str):
            rep.errors.append(f"{where}: an agent step names its agent (agent: …)")
        if s.get("kind") == "include" and not isinstance(s.get("flow"), str):
            rep.errors.append(f"{where}: an include names the workflow it includes (flow: …)")
        action = s.get("action")
        if isinstance(action, str) and action.startswith("run:") and not action[4:].strip():
            rep.errors.append(f"{where}: run: needs a command")
    for s in steps:
        if not isinstance(s, dict):
            continue
        for key in ("back", "no", "then"):
            target = s.get(key)
            if isinstance(target, str) and target not in ids and target not in (END, "continue"):
                rep.errors.append(f"step {s.get('id')}: {key}: {target} is not a step of this workflow")
    rep.review = review(doc)
    if rep.review["commands"]:
        rep.warnings.append(f"it runs {len(rep.review['commands'])} shell command(s): keel's review shows them in red "
                            "before anyone installs it")
    unknown = [a for a in rep.review["agents"] if a not in KEEL_AGENTS]
    if unknown:
        rep.warnings.append(f"agents keel does not have by itself: {', '.join(unknown)} (they come with plugins or as "
                            "custom agents; keel refuses the install without them)")
    return rep


def lint(path: Path, name: str | None = None, version: str | None = None) -> WorkflowReport:
    n, v = name_version(path)
    try:
        text = path.read_text(encoding="utf-8")
    except UnicodeDecodeError:
        rep = WorkflowReport(str(path), name or n, version or v)
        rep.errors.append("the file is not UTF-8 text")
        return rep
    return lint_text(text, str(path), name or n, version or v)
