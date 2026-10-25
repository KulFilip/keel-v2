"""Pure-function checks of the Database plugin's core: secrets masked in every shape of address, server-acting functions
refused in every kind of statement, and reads that do not buffer a whole result."""

import sqlite3

import pytest

from keel_plugin_db import core


@pytest.mark.parametrize("url,secret", [
    ("postgres://app:s3cret@localhost:5432/db", "s3cret"),
    ("postgres://app:pa/ss@localhost:5432/db", "pa/ss"),            # keel:allow-secret
    ("postgres://app:pa@ss@localhost:5432/db", "pa@ss"),            # keel:allow-secret
    ("postgres://app:p?a/s@s@host/db?sslmode=require", "p?a/s@s"),  # keel:allow-secret
    ("POSTGRES://app:Upper1@localhost/db", "Upper1"),
    ("jdbc:postgresql://localhost:5432/db?user=app&password=q1w2e3", "q1w2e3"),
    ("jdbc:postgresql://localhost/db?Password=q1w2e3&ssl=true", "q1w2e3"),
    ("mysql://localhost/db?user=a&PWD=zzz999", "zzz999"),
    ("jdbc:sqlserver://h:1433;databaseName=x;user=a;password=hunter2;", "hunter2"),
    ("postgres://host/db?token=abc123&secret=def456", "abc123"),
    ("jdbc:mysql://app:pw1234@db:3306/x?useSSL=false", "pw1234"),
])
def test_masked_url_hides_every_shape_of_password(url, secret):
    shown = core.masked_url(url)
    assert secret not in shown
    assert "•••" in shown


def test_masked_url_keeps_the_rest_and_leaves_clean_addresses_alone():
    assert core.masked_url("postgres://app:pw@localhost:5432/scores") == "postgres://app:•••@localhost:5432/scores"  # keel:allow-secret
    assert core.masked_url("postgres://app@localhost/db?sslmode=require") == "postgres://app@localhost/db?sslmode=require"
    assert core.masked_url("sqlite:data/app.db") == "sqlite:data/app.db"
    assert core.masked_url("jdbc:postgresql://h/db?user=a&ssl=true") == "jdbc:postgresql://h/db?user=a&ssl=true"
    assert core.masked_url("postgres://h/db?x=1&password=p&y=2") == "postgres://h/db?x=1&password=•••&y=2"  # keel:allow-secret


@pytest.mark.parametrize("sql", [
    "UPDATE t SET c = pg_read_file('/etc/passwd')",
    "INSERT INTO t(c) VALUES (pg_read_file('/etc/passwd'))",
    "DELETE FROM t WHERE pg_terminate_backend(pid)",
    "INSERT INTO t(c) SELECT lo_export(1, '/tmp/x')",
    "SELECT pg_read_file('/etc/passwd')",
])
def test_server_acting_functions_are_refused_in_every_kind_of_statement(sql):
    kind, why = core.classify(sql, "postgres")
    assert kind == "never" and "does not call" in why


def test_an_ordinary_change_is_still_a_change():
    assert core.classify("UPDATE t SET c = lower(c) WHERE id = 1", "postgres")[0] == "change"


class _Cur:
    description = [("a",)]
    rowcount = 3

    def __init__(self, log, name=None, cls=None):
        self.log = log
        self.log.append(("cursor", name, cls))

    def execute(self, sql):
        pass

    def fetchmany(self, n):
        self.log.append(("fetchmany", n))
        return [(i,) for i in range(n)]

    def fetchall(self):
        raise AssertionError("fetchall would pull the whole result")

    def close(self):
        pass


class _Conn:
    def __init__(self):
        self.log = []

    def cursor(self, *a, **kw):
        return _Cur(self.log, kw.get("name"), a[0] if a else None)


def test_a_postgres_read_streams_through_a_server_side_cursor():
    c = _Conn()
    cols, rows, truncated, _ = core._run(c, core.Conn("x", "postgres", "postgres://h/d"), "SELECT * FROM big", 5, stream=True)
    assert c.log[0] == ("cursor", "keel_read", None) and ("fetchmany", 6) in c.log
    assert len(rows) == 5 and truncated


def test_a_postgres_show_or_a_change_keeps_a_plain_cursor():
    pg = core.Conn("x", "postgres", "postgres://h/d")
    for sql, stream in (("SHOW server_version", True), ("UPDATE t SET a = 1", False)):
        c = _Conn()
        core._run(c, pg, sql, 5, stream=stream)
        assert c.log[0] == ("cursor", None, None)


def test_a_mysql_read_streams_through_an_unbuffered_cursor():
    pymysql_cursors = pytest.importorskip("pymysql.cursors")
    c = _Conn()
    core._run(c, core.Conn("x", "mysql", "mysql://h/d"), "SELECT * FROM big", 5, stream=True)
    assert c.log[0] == ("cursor", None, pymysql_cursors.SSCursor)


def test_sqlite_still_returns_the_first_rows_and_says_truncated(tmp_path):
    db = tmp_path / "a.db"
    k = sqlite3.connect(db)
    k.execute("CREATE TABLE t(a)")
    k.executemany("INSERT INTO t VALUES (?)", [(i,) for i in range(50)])
    k.commit()
    k.close()
    out = core.query(core.Conn("x", "sqlite", f"sqlite:{db}"), "SELECT a FROM t", root=str(tmp_path), limit=10)
    assert out["count"] == 10 and out["truncated"] is True
