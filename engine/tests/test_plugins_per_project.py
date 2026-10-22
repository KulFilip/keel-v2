"""A plugin that each project turns on (per_project: true) must be in keel's per-project list.

That list (GET /plugins, then Control › Plugins "Off | This project | All projects", the TUI's commands and the engine's
own on/off) comes from content/plugins/<name>/plugin.yml with installable: true. 0.18.33's Supervisor had none, so no
project could turn it on.
"""
from pathlib import Path

import pytest
import yaml

PLUGINS = Path(__file__).resolve().parents[2] / "plugins"
PER_PROJECT = sorted(
    m.parent.name for m in PLUGINS.glob("*/keel-plugin.yml") if (yaml.safe_load(m.read_text()) or {}).get("per_project")
)


def test_some_plugins_are_per_project():
    assert {"git", "review", "supervisor"} <= set(PER_PROJECT)


@pytest.mark.parametrize("name", PER_PROJECT)
def test_a_per_project_plugin_is_in_keels_per_project_list(name):
    manifest = yaml.safe_load((PLUGINS / name / "keel-plugin.yml").read_text())
    content = (manifest.get("parts") or {}).get("content")
    assert content, f"{name}: per_project needs a content part"
    plugin_yml = PLUGINS / name / content / "plugins" / manifest["name"] / "plugin.yml"
    assert plugin_yml.is_file(), f"{name}: missing {plugin_yml.relative_to(PLUGINS)}"
    raw = yaml.safe_load(plugin_yml.read_text())
    assert raw.get("name") == manifest["name"] and raw.get("installable") is True
