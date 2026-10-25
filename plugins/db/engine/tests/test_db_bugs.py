"""keel 0.18.55: the other bugs an e2e test of the Database plugin found. Schemas cut in the wrong place, a JDBC
address's user, a connect that never answers, a broken SQLite file, an agent's limit, statement names, value shapes,
and a change of every row."""

import datetime as dt
import sqlite3
import time

import pytest

from conftest import conn, keys
from keel_plugin_db import core, tools


def _db(tmp_path, name="a.db", script=""):
    c = sqlite3.connect(tmp_path / name)
    c.executescript(script or """
        create table players (id integer primary key, name text, password_hash text);
        insert into players (name, password_hash) values ('Ada', 'h1'), ('Bo', 'h2');""")
    c.commit()
    c.close()
    return core.Conn("x", "sqlite", f"sqlite:{name}")


# ------------------------------------------------------------------ M3: a JDBC address's ?user=&password=

def test_a_jdbc_address_gives_its_user_and_password(monkeypatch):
    got = {}

    class Cur:
        def __enter__(self):
            return self

        def __exit__(self, *a):
            return False

        def execute(self, *a):
            pass

    class C:
        read_only = False

        def cursor(self, *a):
            return Cur()

    import psycopg
    import pymysql

    monkeypatch.setattr(psycopg, "connect", lambda **kw: got.setdefault("pg", kw) and C())
    monkeypatch.setattr(pymysql, "connect", lambda **kw: got.setdefault("my", kw) and C())
    core._connect(core.Conn("j", "postgres", "jdbc:postgresql://h:5432/d?user=app&password=pw%40x"), "", read=True)
    core._connect(core.Conn("j", "mysql", "jdbc:mysql://h:3306/d?user=app&password=pw2"), "", read=True)
    assert (got["pg"]["user"], got["pg"]["password"]) == ("app", "pw@x")
    assert (got["my"]["user"], got["my"]["password"]) == ("app", "pw2")


# ------------------------------------------------------------------ T1: an address that never answers

def test_a_connect_that_never_answers_stops_at_keels_timeout(monkeypatch):
    import psycopg

    monkeypatch.setattr(core, "CONNECT_S", 0.3)
    monkeypatch.setattr(psycopg, "connect", lambda **kw: time.sleep(4))
    t0 = time.monotonic()
    out = core.test(core.Conn("slow", "postgres", "postgres://u@10.255.255.1/d"))
    assert out["ok"] is False and "0.3 s" in out["error"]
    assert time.monotonic() - t0 < 2.5


# ------------------------------------------------------------------ L2: a broken SQLite file

def test_a_broken_sqlite_file_is_a_failed_test_not_an_error(tmp_path):
    (tmp_path / "bad.db").write_bytes(b"this is not a database at all, just some text" * 20)
    out = core.test(core.Conn("bad", "sqlite", "sqlite:bad.db"), str(tmp_path))
    assert out["ok"] is False and out["error"]


# ------------------------------------------------------------------ L3: an agent's limit

def test_an_agents_limit_that_is_not_a_number_is_no_crash_and_the_text_says_its_limit(scores):
    c = {"keys": keys(conn()), "root": str(scores)}
    out = tools.call(c, "db_query", {"sql": "SELECT name FROM players", "limit": "abc"})
    assert out.startswith("3 rows from local")
    out = tools.call(c, "db_query", {"sql": "SELECT name FROM players", "limit": 2})
    assert "at most 2" in out and "at most 200" not in out


# ------------------------------------------------------------------ L4: the real statement's name

@pytest.mark.parametrize("sql,word", [("LISTEN news", "LISTEN"), ("NOTIFY news", "NOTIFY"), ("DISCARD ALL", "DISCARD")])
def test_a_refused_statement_is_named_as_it_is(sql, word):
    kind, why = core.classify(sql, "postgres")
    assert kind == "never" and word in why and "ALIAS" not in why


# ------------------------------------------------------------------ L5: json and intervals

def test_json_is_json_and_an_interval_is_iso_8601():
    assert core._value({"a": 1, "b": [1, 2]}) == '{"a": 1, "b": [1, 2]}'
    assert core._value([1, "x"]) == '[1, "x"]'
    assert core._value(dt.timedelta(days=1)) == "P1D"
    assert core._value(dt.timedelta(hours=1, minutes=2, seconds=3.5)) == "PT1H2M3.5S"
    assert core._value(dt.timedelta(days=2, hours=3)) == "P2DT3H"
    assert core._value(dt.timedelta(0)) == "PT0S"
    assert core._value(dt.timedelta(days=-1)) == "-P1D"
    assert core._value(dt.timedelta(hours=10, minutes=30), "mysql") == "10:30:00"     # MySQL's TIME


# ------------------------------------------------------------------ L8: a change of every row

def test_an_update_or_delete_without_where_says_it_changes_every_row(tmp_path):
    c = _db(tmp_path)
    every = core.query(c, "UPDATE players SET name = 'x'", root=str(tmp_path), allow_change=True)
    assert every["every_row"] is True and every["changed"] == 2
    assert core.query(c, "DELETE FROM players", root=str(tmp_path), allow_change=True)["every_row"] is True
    some = core.query(c, "UPDATE players SET name = 'x' WHERE id = 1", root=str(tmp_path), allow_change=True)
    assert some["every_row"] is False
    assert core.query(c, "INSERT INTO players(name) VALUES ('C')", root=str(tmp_path), allow_change=True)["every_row"] is False
