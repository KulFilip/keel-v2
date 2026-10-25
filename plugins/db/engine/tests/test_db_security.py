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


# ------------------------------------------------------------------ S5: a password with @ and /

@pytest.mark.parametrize("url,shown", [
    ("postgres://app:p@ss/w@rd@localhost:5432/db", "postgres://app:•••@localhost:5432/db"),  # keel:allow-secret
    ("mysql://root:a/b@c@db:3306/x", "mysql://root:•••@db:3306/x"),                          # keel:allow-secret
    ("postgres://u:pw@h/db?application_name=a@b", "postgres://u:•••@h/db?application_name=a@b"),  # keel:allow-secret
    ("postgres://u@h:5432/d", "postgres://u@h:5432/d"),
])
def test_the_password_is_masked_up_to_the_last_at_before_the_host(url, shown):
    assert core.masked_url(url) == shown
