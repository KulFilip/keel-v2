"""keel-plugin new <name> [--parts …]: a plugin folder from a small template (manifest, content/, engine/, web/, README).

The result passes `keel-plugin lint` as it is, and `keel-plugin pack` makes a package of it. --parts picks the parts
(default engine,web,content: the same files as before the option). A plugin without an engine part gets an example
workflow and agent in content/, so keel has something to load (keel-plugin dev shows it in a running keel).
"""

from __future__ import annotations

from pathlib import Path

from . import PluginToolError
from .manifest import NAME

PARTS = ("engine", "web", "content")


def _title(name: str) -> str:
    return " ".join(w.capitalize() for w in name.split("-"))


def parts_of(text: str) -> tuple[str, ...]:
    """'content,web' → ('web', 'content'): the parts in keel's order. PluginToolError for an unknown part or none."""
    chosen = {p.strip() for p in text.split(",") if p.strip()}
    unknown = sorted(chosen - set(PARTS))
    if unknown or not chosen:
        raise PluginToolError(f"--parts {text!r}: choose from {', '.join(PARTS)}, for example --parts content "
                              "(an api part is built in a keel checkout; see the plugin guide)")
    return tuple(p for p in PARTS if p in chosen)


def _manifest_parts(package: str, parts: tuple[str, ...]) -> str:
    lines = {"engine": f"  engine: {{ path: engine, package: {package} }}", "web": "  web: { entry: web/index.js }",
             "content": "  content: content"}
    return "\n".join(lines[p] for p in parts)


def _tree(package: str, parts: tuple[str, ...]) -> str:
    lines = {"engine": f"engine/           {package}: the Python part (actions, agent tools, hooks)",
             "web": "web/              index.js: the web part (pages and slots), an ES module",
             "content": "content/          workflows, agents, skills"}
    return "\n".join(["keel-plugin.yml   the manifest: name, version, what it needs, its parts, its permissions"]
                     + [lines[p] for p in parts])


def _examples(name: str, title: str) -> dict[str, str]:
    """An example workflow and agent, for a plugin without an engine part."""
    return {
        f"content/workflows/{name}-flow.yaml": f"""\
# A workflow of {title}: one agent step. keel lists it with each project's workflows. Its id must not be one of keel's.
id: {name}-flow
name: {title}
keel_rules: false
version: 1
steps:
  - id: look
    kind: agent
    name: look at the project
    agent: {name}-agent
    phase: review
""",
        f"content/agents/{name}-agent.md": f"""\
---
name: {name}-agent
description: {title}'s agent. It reads the project and says what it is, in three short lines.
tools: Read, Grep, Glob
disallowedTools: Write, Edit
maxTurns: 5
---

You are {title}'s agent. Read the project's README and its top folders. Then say in three short lines what the project
is and how it is built. Change nothing.
""",
    }


def files(name: str, publisher: str, parts: tuple[str, ...] = PARTS) -> dict[str, str]:
    package = "keel_plugin_" + name.replace("-", "_")
    title = _title(name)
    out = {
        "keel-plugin.yml": f"""\
# The plugin's manifest (keel's docs/plugins/02-plugin-package.md). Check it with: keel-plugin lint .
schema: 1
name: {name}                   # the id: a-z, 0-9 and '-'; every name the plugin adds starts with it
title: {title}
version: 0.1.0
publisher: {publisher}                  # must match the key that signs your releases
summary: One sentence that says what {title} does for the person.
license: MIT

requires:
  sdk: 1                       # the plugin SDK major version
  # keel: ">=0.15.4"           # an extra limit on keel's version
  # plugins: {{ code: ">=1.0.0" }}   # other plugins it needs (on one line)

# Write each part on one line. Remove the parts you do not use.
parts:
{_manifest_parts(package, parts)}

per_project: false

permissions: {{}}                # what it may do; keel shows it before install (docs/plugins/03-security.md)
""",
        "README.md": f"""\
# {title}

A keel plugin. {title} does … (say it in one or two sentences).

```
{_tree(package, parts)}
```

## Check, pack and sign

```
keel-plugin lint .                                   the checks keel and the catalog run
keel-plugin pack . --out dist                        dist/{name}-0.1.0.kplug
keel-plugin sign dist/{name}-0.1.0.kplug --key-file you.key
```

Names stay in the plugin's box: actions `{name}:do`, events `{name}.done`, agent tools `{package[12:]}_read`,
tables `{package[12:]}_items`. Use only keel's plugin SDK, never keel's internal code. Nothing runs at install time.
""",
        f"engine/{package}/__init__.py": f'''\
"""{title}: the engine part. keel imports this package when it starts and reads ADDON."""

VERSION = "0.1.0"   # the same version as keel-plugin.yml

ADDON = {{
    "name": "{name}",
    "title": "{title}",
    "version": VERSION,
    "actions": {{}},     # "{name}:do": a function, for workflow steps
}}
''',
        "web/index.js": f"""\
// {title}: the web part. keel loads this ES module at start and calls setup() once.
// Build a bigger web part with Vite as an ES library; react and @keel/web-sdk come from keel's page.

export default {{
  name: "{name}",
  setup(sdk) {{
    // sdk.registerPage({{ id: "{name}", label: "{title}", group: "project", order: 90, component: MyPage }});
  }},
}};
""",
        "content/README.md": f"""\
# content/

Workflows (`workflows/*.yaml`), agents (`agents/*.md`) and skills (`skills/<name>/SKILL.md`) of {title}. keel finds
them after its own; a plugin cannot replace one of keel's with the same name.
""",
        ".gitignore": "__pycache__/\n*.pyc\ndist/\n*.kplug\n*.minisig\n*.key\n",
    }
    if "engine" not in parts:
        out.pop(f"engine/{package}/__init__.py")
    if "web" not in parts:
        out.pop("web/index.js")
    if "content" not in parts:
        out.pop("content/README.md")
    elif "engine" not in parts:
        out.update(_examples(name, title))
    return out


def new(name: str, where: Path, publisher: str = "you", parts: tuple[str, ...] = PARTS) -> Path:
    """Write the template into <where>/<name>; refuses a folder that is not empty."""
    if not NAME.match(name):
        raise PluginToolError(f"'{name}' is not a plugin name: a-z, 0-9 and '-', starts with a letter, 32 at most")
    if not NAME.match(publisher):
        raise PluginToolError(f"'{publisher}' is not a publisher id: a-z, 0-9 and '-', starts with a letter")
    root = where / name
    if root.exists() and any(root.iterdir()):
        raise PluginToolError(f"{root} is there already and not empty")
    for rel, text in files(name, publisher, parts).items():
        p = root / rel
        p.parent.mkdir(parents=True, exist_ok=True)
        p.write_text(text, encoding="utf-8")
    return root
