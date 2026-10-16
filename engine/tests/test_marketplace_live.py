"""Changes that apply without a restart (keel_engine/marketplace/live.py, docs/plugins/22-one-plugins-page.md §5): a
plugin whose parts are only web and/or content comes and goes at once; a plugin with an engine, api or migrations part
waits for the restart, and so does a web plugin that needs one that waits. None of keel's own plugins is web/content
only today, so these tests make their own."""

import json

import pytest

from keel_engine import addons
from keel_engine.marketplace import install, live
from keel_engine.pluginhost import resolver, state
from keel_engine.workflows import templates
from test_plugin_content import AGENT, FLOW
from test_pluginhost import data, image, plugin  # noqa: F401 - fixtures and helpers

WEB = {"web": {"entry": "web/index.js"}}


def notes(image_root, name: str = "notes", version: str = "1.0.0", *, web: bool = True, needs: dict | None = None):
    """A web + content plugin in the image: the page of its web part, a workflow and an agent."""
    files = {"content/workflows/notes-flow.yaml": FLOW.format(id="notes-flow", name="notes flow", agent="notes-agent"),
             "content/agents/notes-agent.md": AGENT.format(name="notes-agent", about="the notes agent")}
    if web:
        files["web/index.js"] = "export default {}"
    parts = {"content": "content", **(WEB if web else {})}
    return plugin(image_root, name, version, parts=parts, files=files, sums=True, needs=needs)


def coded(image_root, name: str, version: str = "1.0.0", **kw):
    """A plugin with an engine part (it runs code inside keel)."""
    return plugin(image_root, name, version, package=f"keel_tmp_live_{name}", sums=True, **kw)


def resolved() -> dict:
    return json.loads((state.run_dir() / "resolved.json").read_text())


def loaded() -> list[str]:
    return [p["name"] for p in resolved()["plugins"]]


@pytest.fixture
def started(image, data):
    """keel starts: the resolver writes run/resolved.json and the engine reads it. Caches are cleared after the test."""

    def start():
        resolver.write(resolver.resolve())
        addons.reload_content()
        templates.clear_cache()

    yield start
    addons._plugin_content.cache_clear()
    templates.clear_cache()


def flows() -> list[str]:
    return [t.id for t in templates.templates()]


def test_a_web_and_content_plugin_goes_off_and_on_without_a_restart(image, started):
    notes(image)
    started()
    assert "notes-flow" in flows() and [c.name for c in addons.plugin_content()] == ["notes"]

    install.set_on("notes", False)
    out = live.apply(["notes"])
    assert out["applied"] == [{"name": "notes", "from": "1.0.0", "to": None, "web": True, "content": True}]
    assert out["names"] == {"notes": "applied"}
    assert out["pending_restart"] == {"pending": False, "changes": []}
    assert loaded() == [] and "notes-flow" not in flows() and addons.plugin_content() == ()
    assert (state.run_dir() / "env").read_text() == resolver.env_text(resolver.env_of([]))

    install.set_on("notes", True)
    out = live.apply(["notes"])
    assert out["applied"] == [{"name": "notes", "from": None, "to": "1.0.0", "web": True, "content": True}]
    assert loaded() == ["notes"] and "notes-flow" in flows()
    assert resolved()["plugins"][0]["web"] == {"entry": "web/index.js", "css": []}
    assert install.installed_view()["plugins"][0]["status"] == "loaded"


def test_a_plugin_with_code_waits_for_the_restart_and_the_file_stays_as_loaded(image, started):
    coded(image, "db")
    notes(image)
    started()
    before = resolved()

    install.set_on("db", False)
    out = live.apply(["db"])
    assert out["applied"] == [] and out["names"] == {"db": "restart"}
    assert out["pending_restart"]["changes"] == [{"name": "db", "now": "1.0.0", "next": None}]
    assert resolved() == before                                   # nothing rewritten: db is still loaded

    # a web/content change next to it applies; db still waits (resolved.json keeps it as loaded)
    install.set_on("notes", False)
    out = live.apply(["notes"])
    assert [a["name"] for a in out["applied"]] == ["notes"] and out["names"] == {"notes": "applied"}
    assert loaded() == ["db"]
    assert out["pending_restart"]["changes"] == [{"name": "db", "now": "1.0.0", "next": None}]
    assert "keel_tmp_live_db" in (state.run_dir() / "env").read_text()

    # turned on again before any restart: nothing to load, nothing waits
    install.set_on("db", True)
    assert live.apply(["db"])["names"] == {"db": "same"}
    assert install.pending_restart()["pending"] is False


@pytest.mark.parametrize("part", ["api", "migrations"])
def test_an_api_or_migrations_part_also_waits(image, started, part):
    parts = {"api": {"jars": ["api/x.jar"]}} if part == "api" else {"migrations": "migrations"}
    files = {"api/x.jar": "jar"} if part == "api" else {"migrations/V1__x.sql": "select 1;"}
    plugin(image, "tables", parts=parts, files=files, sums=True)
    started()
    install.set_on("tables", False)
    out = live.apply(["tables"])
    assert out["applied"] == [] and out["names"] == {"tables": "restart"} and loaded() == ["tables"]


def test_a_web_plugin_that_needs_a_plugin_which_waits_waits_too(image, started):
    started()                                                     # keel started with nothing
    coded(image, "db")
    notes(image, needs={"db": ">=1.0.0"})
    out = live.apply(["notes", "db"])
    assert out["applied"] == [] and out["names"] == {"notes": "restart", "db": "restart"}
    assert loaded() == []


def test_a_web_plugin_a_loaded_plugin_needs_stays_until_the_restart(image, started):
    notes(image)
    coded(image, "db", needs={"notes": ">=1.0.0"})
    started()
    install.set_on("notes", False)                                # db goes off with it: it needs notes
    out = live.apply(["notes"])
    assert out["applied"] == [] and out["names"] == {"notes": "restart"}
    assert loaded() == ["notes", "db"]


def test_an_update_of_a_web_plugin_applies_and_the_web_part_changes(image, started, data):
    notes(image)
    started()
    notes(image, version="1.1.0")                                 # the image's newest version is used
    out = live.apply(["notes"])
    assert out["applied"] == [{"name": "notes", "from": "1.0.0", "to": "1.1.0", "web": True, "content": True}]
    assert resolved()["plugins"][0]["version"] == "1.1.0"
    assert addons.plugin_content()[0].version == "1.1.0"


def test_a_content_only_plugin_says_it_has_no_web_part(image, started):
    notes(image, web=False)
    started()
    install.set_on("notes", False)
    assert live.apply(["notes"])["applied"] == [{"name": "notes", "from": "1.0.0", "to": None, "web": False,
                                                 "content": True}]


def test_without_a_resolved_file_nothing_applies(image):
    notes(image)
    out = live.apply(["notes"])
    assert out["applied"] == [] and out["names"] == {"notes": "restart"}
    assert not (state.run_dir() / "resolved.json").exists()


def test_the_route_applies_and_answers_what_waits(image, started, client):
    notes(image)
    coded(image, "db")
    started()
    install.set_on("notes", False)
    install.set_on("db", False)
    out = client.post("/marketplace/apply-live", json={"names": ["notes", "db"]}).json()
    assert [a["name"] for a in out["applied"]] == ["notes"]
    assert out["names"] == {"notes": "applied", "db": "restart"}
    assert out["pending_restart"]["pending"] is True
    assert client.post("/marketplace/apply-live").json()["applied"] == []
