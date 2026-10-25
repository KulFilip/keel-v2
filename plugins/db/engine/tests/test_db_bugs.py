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


# ------------------------------------------------------------------ L4: the real statement's name

@pytest.mark.parametrize("sql,word", [("LISTEN news", "LISTEN"), ("NOTIFY news", "NOTIFY"), ("DISCARD ALL", "DISCARD")])
def test_a_refused_statement_is_named_as_it_is(sql, word):
    kind, why = core.classify(sql, "postgres")
    assert kind == "never" and word in why and "ALIAS" not in why
