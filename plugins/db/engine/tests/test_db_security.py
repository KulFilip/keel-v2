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


# ------------------------------------------------------------------ S1: PostgreSQL functions, also inside strings

@pytest.mark.parametrize("sql", [
    "SELECT query_to_xml('select pg_read_file(''/etc/hostname'')', true, true, '')",
    "SELECT query_to_xml_and_xmlschema('select 1', true, true, '')",
    "SELECT query_to_xmlschema('select 1', true, true, '')",
    "SELECT cursor_to_xml('c', 1, true, true, '')",
    "SELECT cursor_to_xmlschema('c', true, true, '')",
    "SELECT table_to_xml('players', true, true, '')",
    "SELECT table_to_xml_and_xmlschema('players', true, true, '')",
    "SELECT database_to_xml(true, true, '')",
    "SELECT schema_to_xml('public', true, true, '')",
    "SELECT pg_ls_dir('.')",
    "SELECT * FROM pg_ls_waldir()",
    "SELECT * FROM pg_ls_logdir()",
    "SELECT * FROM pg_ls_tmpdir()",
    "SELECT dblink('host=x', 'select 1')",
    "SELECT dblink_exec('host=x', 'drop table t')",
    "SELECT lo_import('/etc/passwd')",
    "SELECT lo_export(1, '/tmp/x')",
    "SELECT pg_read_binary_file('/etc/passwd')",
    "SELECT pg_stat_file('/etc/passwd')",
    "SELECT pg_cancel_backend(1)",
    "SELECT pg_terminate_backend(1)",
    "SELECT pg_reload_conf()",
    "SELECT set_config('work_mem', '1GB', false)",
    "SELECT pg_catalog.pg_read_file('/etc/passwd')",
    # a string another function runs as SQL: refused for the name inside it
    "SELECT ts_stat('select pg_read_file(''/etc/hostname'')')",
    "SELECT my_runner('select pg_ls_dir(''.'')')",
    "SELECT query_to_xml($$select pg_read_file('/etc/hostname')$$, true, true, '')",
])
def test_server_functions_are_refused_also_inside_a_string(sql):
    kind, why = core.classify(sql, "postgres")
    assert kind == "never", (sql, why)
    assert "does not call" in why


def test_an_ordinary_read_with_strings_is_still_a_read():
    assert core.classify("SELECT 'hello' AS greeting, lower(name) FROM players WHERE name = 'pg'", "postgres") == ("read", "")


def test_the_docs_still_recommend_a_least_privilege_role():
    assert "least-privilege" in (core.__doc__ or "")


# ------------------------------------------------------------------ S2: MySQL's executable comments and file access

@pytest.mark.parametrize("sql", [
    "SELECT name FROM players /*!50000 INTO OUTFILE '/tmp/x' */",
    "UPDATE players SET name = 'a' /*!, password_hash = 'x' */ WHERE id = 1",
    "SELECT 1 /*M!100000 INTO OUTFILE '/tmp/x' */",
    "SELECT /*! LOAD_FILE('/etc/passwd') */ 1",
])
def test_mysql_executable_comments_are_refused(sql):
    for kind in ("mysql",):
        got, why = core.classify(sql, kind)
        assert got == "never" and "/*!" in why, (sql, why)


@pytest.mark.parametrize("sql", [
    "SELECT LOAD_FILE('/etc/passwd')",
    "SELECT name FROM players INTO OUTFILE '/tmp/x'",
    "SELECT name FROM players INTO DUMPFILE '/tmp/x'",
    "LOAD DATA INFILE '/tmp/x' INTO TABLE players",
    "LOAD DATA LOCAL INFILE '/tmp/x' INTO TABLE players",
])
def test_mysql_file_access_is_refused(sql):
    assert core.classify(sql, "mysql")[0] == "never", sql


def test_a_plain_mysql_comment_is_fine():
    assert core.classify("SELECT 1 /* just a note */", "mysql") == ("read", "")


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
