"""keel 0.18.55: the security holes an e2e test of the Database plugin found. Server functions hidden in strings,
MySQL's executable comments and file access, secrets masked by the column they come from (not only its name), SQLite
files outside the project, and a password with @ or / in an address."""

import json
import sqlite3

import pytest

from keel_plugin_db import core


def _db(tmp_path, name="a.db", script=""):
    c = sqlite3.connect(tmp_path / name)
    c.executescript(script or """
        create table players (id integer primary key, name text, password_hash text);
        insert into players (name, password_hash) values ('Ada', 'h1'), ('Bo', 'h2');""")
    c.commit()
    c.close()
    return core.Conn("x", "sqlite", f"sqlite:{name}")


# ------------------------------------------------------------------ S3: masked by the column a value comes from

@pytest.mark.parametrize("sql,hidden", [
    ("SELECT password_hash AS h FROM players", ["h"]),
    ("SELECT name, upper(password_hash) AS up FROM players", ["up"]),
    ("SELECT h FROM (SELECT password_hash AS h FROM players) AS x", ["h"]),
    ("WITH t AS (SELECT password_hash AS h FROM players) SELECT h AS k FROM t", ["k"]),
    ("SELECT name FROM players UNION ALL SELECT password_hash FROM players", ["name"]),
    ("SELECT * FROM players", ["password_hash"]),
])
def test_a_secret_column_is_masked_under_any_name(tmp_path, sql, hidden):
    c = _db(tmp_path)
    out = core.query(c, sql, root=str(tmp_path), mask=True)
    assert out["masked"] == hidden
    for col in hidden:
        i = out["columns"].index(col)
        assert all(r[i] == "•••" for r in out["rows"])
    assert "h1" not in json.dumps(out["rows"])


def test_a_plain_column_is_not_masked(tmp_path):
    out = core.query(_db(tmp_path), "SELECT name FROM players", root=str(tmp_path), mask=True)
    assert out["masked"] == [] and out["rows"] == [["Ada"], ["Bo"]]


# ------------------------------------------------------------------ S4: a SQLite file only inside the project

def test_a_sqlite_file_inside_the_project_works_relative_or_absolute(tmp_path):
    _db(tmp_path)
    assert core.query(core.Conn("x", "sqlite", "sqlite:a.db"), "SELECT 1", root=str(tmp_path))["rows"] == [[1]]
    assert core.query(core.Conn("x", "sqlite", f"sqlite:{tmp_path / 'a.db'}"), "SELECT 1", root=str(tmp_path))["rows"] == [[1]]


def test_a_sqlite_file_outside_the_project_is_refused(tmp_path):
    proj = tmp_path / "proj"
    proj.mkdir()
    outside = tmp_path / "other"
    outside.mkdir()
    _db(outside, "secret.db")
    (proj / "link.db").symlink_to(outside / "secret.db")
    for url in (f"sqlite:{outside / 'secret.db'}", "sqlite:../other/secret.db", "sqlite:link.db"):
        with pytest.raises(core.DbError) as e:
            core.query(core.Conn("x", "sqlite", url), "SELECT 1", root=str(proj))
        assert e.value.status == 403 and "project folder" in str(e.value), url
    with pytest.raises(core.DbError):
        core.query(core.Conn("x", "sqlite", f"sqlite:{outside / 'secret.db'}"), "SELECT 1", root="")


def test_keels_own_data_folder_is_refused_always(tmp_path, monkeypatch):
    data = tmp_path / "proj" / "data"
    data.mkdir(parents=True)
    _db(data, "keel.db")
    monkeypatch.setenv("KEEL_DATA", str(data))
    with pytest.raises(core.DbError) as e:
        core.query(core.Conn("x", "sqlite", "sqlite:data/keel.db"), "SELECT 1", root=str(tmp_path / "proj"))
    assert "keel's own" in str(e.value)
    with pytest.raises(core.DbError):
        core._sqlite_path(core.Conn("x", "sqlite", "sqlite:/data/keel.db"), "/")


# ------------------------------------------------------------------ S5: a password with @ and /

@pytest.mark.parametrize("url,shown", [
    ("postgres://app:p@ss/w@rd@localhost:5432/db", "postgres://app:•••@localhost:5432/db"),  # keel:allow-secret
    ("mysql://root:a/b@c@db:3306/x", "mysql://root:•••@db:3306/x"),                          # keel:allow-secret
    ("postgres://u:pw@h/db?application_name=a@b", "postgres://u:•••@h/db?application_name=a@b"),  # keel:allow-secret
    ("postgres://u@h:5432/d", "postgres://u@h:5432/d"),
])
def test_the_password_is_masked_up_to_the_last_at_before_the_host(url, shown):
    assert core.masked_url(url) == shown
