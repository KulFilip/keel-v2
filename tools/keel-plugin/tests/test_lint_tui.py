"""lint: contributes.tui, what a plugin adds to keel TUI (docs/plugins/25-tui-plugins.md), is data with rules: its
commands carry the plugin's name, they call only the plugin's own routes, a POST asks first, the panel only reads."""

from __future__ import annotations

from conftest import REPO, write

from keel_plugin import template


GOOD = """
contributes:
  tui:
    commands:
      - name: notes
        args: "<list|add>"
        summary: the notes
        sub:
          list: { summary: all notes, call: { path: "/projects/{pid}/notes/list" }, show: { items: ".", line: "{title}" } }
          add: { summary: add one, call: { method: POST, path: "/projects/{pid}/notes/add" }, confirm: "Add a note?" }
    panel: { title: Notes, key: n, every: 30, call: { path: "/projects/{pid}/notes/list" }, show: { items: ".", line: "{title}" } }
"""

BAD = """
contributes:
  tui:
    commands:
      - name: git
        summary: someone else's name
        call: { path: "/projects/{pid}/git/status" }
      - name: notes-push
        summary: sends without asking
        call: { method: POST, path: "/projects/{pid}/notes/push" }
      - name: notes-peek
        summary: another plugin's route
        call: { path: "/projects/{pid}/db/query" }
    panel: { title: Notes, key: f, call: { method: POST, path: "/projects/{pid}/notes/x" } }
"""


def manifest_with(tmp_path, extra: str):
    root = template.new("notes", tmp_path, parts=template.parts_of("content"))
    m = root / "keel-plugin.yml"
    write(m, m.read_text() + extra)
    return root


def test_a_plugins_tui_commands_and_panel_pass(tmp_path, run):
    code, out, _ = run("lint", manifest_with(tmp_path, GOOD))
    assert "contributes.tui" not in out, out


def test_the_rules_of_contributes_tui(tmp_path, run):
    code, out, _ = run("lint", manifest_with(tmp_path, BAD))
    assert code == 1
    for why in ["contributes.tui.commands: 'git' must be named notes or notes-<word>",
                "contributes.tui /notes-push changes something (POST): it needs a confirm question",
                "contributes.tui /notes-peek may only call the plugin's own routes (/projects/{pid}/notes/...), not /projects/{pid}/db/query",
                "contributes.tui.panel: the key is one letter, not one of keel TUI's own (a, b, c, f, u)",
                "contributes.tui.panel only reads (GET)"]:
        assert why in out, (why, out)


def test_the_git_plugins_tui_part_is_valid():
    from keel_plugin.manifest import load, _Check, _tui

    data = load((REPO / "plugins/git/keel-plugin.yml").read_text())
    c = _Check()
    _tui(c, "git", data["contributes"]["tui"])
    assert c.errors == []


# ------------------------------------------------------------------ 0.18.6 modes: a full-screen view, as data

GOOD_MODE = """
contributes:
  tui:
    commands:
      - name: notes
        summary: the notes
        sub:
          count: { summary: how many, call: { path: "/projects/{pid}/notes/count" } }
    modes:
      - name: notes
        title: Notes
        summary: the notes, full screen
        state:
          all: { path: "/projects/{pid}/notes/list" }
        list: { items: all, line: "{title}" }
        detail: { call: { path: "/projects/{pid}/notes/one?id={item.id}" }, text: "{body}" }
        keys:
          - { key: d, label: delete, confirm: "Delete {item.title}?", call: { method: POST, path: "/projects/{pid}/notes/delete" }, reload: true }
          - { key: a, label: add, ask: "The note", call: { method: POST, path: "/projects/{pid}/notes/add", body: { text: "{text}" } } }
          - { key: s, label: sort, pick: { title: Sort by, choices: [{ label: Title, value: title }] }, open: "{choice.value}" }
"""

BAD_MODE = """
contributes:
  tui:
    commands:
      - { name: notes, summary: one call, call: { path: "/projects/{pid}/notes/x" } }
    modes:
      - name: notes
        title: Notes
        summary: x
        state:
          item: { method: POST, path: "/projects/{pid}/notes/list" }
        list: { items: item }
        detail: { call: { path: "/projects/{pid}/db/query" }, diff: d, text: t }
        keys:
          - { key: q, label: quit, reload: true }
          - { key: d, label: delete, call: { method: POST, path: "/projects/{pid}/notes/delete" } }
          - { key: n, label: nothing }
      - name: git
        title: G
        summary: g
"""


def test_a_plugins_mode_passes(tmp_path, run):
    code, out, _ = run("lint", manifest_with(tmp_path, GOOD_MODE))
    assert "contributes.tui" not in out, out


def test_the_rules_of_a_mode(tmp_path, run):
    code, out, _ = run("lint", manifest_with(tmp_path, BAD_MODE))
    assert code == 1
    for why in ["/notes is a mode and a command: the command has sub (its words run outside the mode)",
                "contributes.tui mode /notes: the state's name 'item' is one word, not one of",
                "contributes.tui mode /notes state item only reads (GET)",
                "contributes.tui mode /notes: its list needs items and line",
                "contributes.tui mode /notes detail may only call the plugin's own routes (/projects/{pid}/notes/...), not /projects/{pid}/db/query",
                "contributes.tui mode /notes: its detail shows either a diff or a text",
                "contributes.tui mode /notes: a key is one letter or digit, not one of the mode's own (j, k, q)",
                "contributes.tui mode /notes key d changes something (POST): it needs confirm (a yes/no question) or ask (the person's own words)",
                "contributes.tui mode /notes key n does nothing: it needs a call, show, reload or open",
                "contributes.tui.modes: 'git' must be named notes or notes-<word>"]:
        assert why in out, (why, out)


def test_the_review_plugins_tui_part_is_valid():
    from keel_plugin.manifest import load, _Check, _tui

    data = load((REPO / "plugins/review/keel-plugin.yml").read_text())
    c = _Check()
    _tui(c, "review", data["contributes"]["tui"])
    assert c.errors == []
    assert [m["name"] for m in data["contributes"]["tui"]["modes"]] == ["review"]
