"""The Database plugin against real servers: PostgreSQL and MySQL. Runs when KEEL_TEST_PG / KEEL_TEST_MYSQL name one
(CI starts both as service containers); skipped otherwise. Each test makes its own tables and drops them. Moved from
engine/tests with the plugin (plugins/db, keel_plugin_db)."""

import os
import uuid

import pytest

from keel_plugin_db import core as db

SERVERS = [("postgres", os.environ.get("KEEL_TEST_PG")), ("mysql", os.environ.get("KEEL_TEST_MYSQL"))]


def _admin(conn: db.Conn, sql: str):
    """Set up and clean up outside keel's rules (the test's own connection)."""
    c = db._connect(conn, "", read=False)
    try:
        cur = c.cursor()
        cur.execute(sql)
        c.commit()
    finally:
        c.close()


@pytest.fixture(params=[s for s in SERVERS], ids=[s[0] for s in SERVERS])
def server(request):
    kind, url = request.param
    if not url:
        pytest.skip(f"set KEEL_TEST_{'PG' if kind == 'postgres' else 'MYSQL'} to run against a real {kind}")
    conn = db.conn_of({"name": "local", "url": url, "env": "local"})
    t = f"kp_{uuid.uuid4().hex[:8]}"
    key = "serial primary key" if kind == "postgres" else "integer primary key auto_increment"
    _admin(conn, f"create table {t}_players (id {key}, name varchar(40), api_key varchar(40))")
    # a table-level foreign key: MySQL ignores one written on the column
    _admin(conn, f"create table {t}_scores (id {key}, player_id integer, value integer, "
                 f"foreign key (player_id) references {t}_players(id))")
    _admin(conn, f"insert into {t}_players (name, api_key) values ('Ada', 'k1'), ('Bo', 'k2'), ('Chen', 'k3')")
    _admin(conn, f"insert into {t}_scores (player_id, value) values (1, 10)")
    yield conn, t
    _admin(conn, f"drop table {t}_scores")
    _admin(conn, f"drop table {t}_players")


def test_test_schema_read_and_masking(server):
    conn, t = server
    info = db.test(conn)
    assert info["ok"] and info["server"].split()[0] in ("PostgreSQL", "MySQL") and info["tables"] >= 2
    tables = {x["name"]: x for x in db.schema(conn)["tables"]}
    assert [c["name"] for c in tables[f"{t}_players"]["columns"]] == ["id", "name", "api_key"]
    assert tables[f"{t}_players"]["columns"][0]["pk"] is True
    assert tables[f"{t}_scores"]["fks"] == [{"column": "player_id", "table": f"{t}_players", "ref": "id"}]
    r = db.query(conn, f"select name, api_key from {t}_players order by id", mask=True)
    assert r["rows"] == [["Ada", "•••"], ["Bo", "•••"], ["Chen", "•••"]] and r["masked"] == ["api_key"]
    assert db.query(conn, f"select count(*) from {t}_players where name like '%a%'")["rows"][0][0] >= 1


def test_a_change_is_counted_rolled_back_then_run(server):
    conn, t = server
    sql = (f"insert into {t}_scores (player_id, value) select p.id, 0 from {t}_players p "
           f"left join {t}_scores s on s.player_id = p.id where s.id is null")
    count = lambda: db.query(conn, f"select count(*) from {t}_scores")["rows"][0][0]
    assert db.query(conn, sql, allow_change=True)["changed"] == 2 and count() == 1
    assert db.query(conn, sql, allow_change=True, confirm=True)["changed"] == 2 and count() == 3


def test_the_server_itself_refuses_a_write_inside_a_read(server):
    conn, t = server
    # behind keel's own check: a read runs in a read-only transaction, so even a write that slipped through fails there
    c = db._connect(conn, "", read=True)
    try:
        with pytest.raises(Exception):
            db._run(c, conn, f"insert into {t}_scores (player_id, value) values (1, 1)", 1)
    finally:
        try:
            c.rollback()
        finally:
            c.close()
    assert db.query(conn, f"select count(*) from {t}_scores")["rows"][0][0] == 1


def test_a_wrong_password_says_what_to_check(server):
    conn, _ = server
    bad = db.Conn(conn.name, conn.kind, conn.url.replace("://app:app@", "://app:nope@").replace("://root:root@", "://root:nope@"), "local")
    out = db.test(bad)
    assert out["ok"] is False and "keel could not reach local" in out["error"] and "password" in out["hint"]


def test_a_test_says_the_server_its_tables_and_how_long_and_lists_the_databases(server):
    conn, t = server
    r = db.test(conn)
    assert r["ok"] and r["tables"] >= 2 and isinstance(r["ms"], int)
    assert r["server"].split()[0] in ("PostgreSQL", "MySQL", "MariaDB")
    names = [d["name"] for d in db.databases(conn)["databases"]]
    assert names and not {"information_schema", "performance_schema", "mysql", "sys"} & set(names)
    # a wrong password: the error never quotes it
    bad = db.conn_of({"name": "bad", "url": db.urlunsplit(db.urlsplit(conn.url)._replace(
        netloc=f"{db.urlsplit(conn.url).username}:Wr0ngPassw0rd@{db.urlsplit(conn.url).hostname}:{db.urlsplit(conn.url).port}")),
        "env": "local"})
    failed = db.test(bad)
    assert not failed["ok"] and "Wr0ngPassw0rd" not in failed["error"] + failed["hint"]


def test_a_cut_schema_keeps_the_projects_schema_first(server, monkeypatch):
    conn, t = server
    if conn.kind != "postgres":
        pytest.skip("MySQL reads only the connected database")
    _admin(conn, f"create schema aaa_{t}")
    try:
        for i in range(3):
            _admin(conn, f"create table aaa_{t}.x{i} (id integer)")
        monkeypatch.setattr(db, "MAX_TABLES", 2)
        out = db.schema(conn)
        assert out["truncated"] is True and out["total"] >= 5
        assert not [x["name"] for x in out["tables"] if x["name"].startswith(f"aaa_{t}.")]
    finally:
        _admin(conn, f"drop schema aaa_{t} cascade")


def test_json_and_intervals_come_back_readable(server):
    conn, _ = server
    if conn.kind == "postgres":
        r = db.query(conn, "select '{\"a\": 1}'::jsonb as j, interval '1 day 2 hours' as i")
        assert r["rows"] == [['{"a": 1}', "P1DT2H"]]
    else:
        r = db.query(conn, "select json_object('a', 1) as j, cast('10:30:00' as time) as i")
        assert r["rows"][0][1] == "10:30:00"


def test_a_jdbc_address_with_user_and_password_in_its_query_connects(server):
    conn, _ = server
    p = db.urlsplit(conn.url)
    jdbc = f"jdbc:{'postgresql' if conn.kind == 'postgres' else 'mysql'}://{p.hostname}:{p.port}{p.path}" \
           f"?user={p.username}&password={p.password}"
    assert db.test(db.conn_of({"name": "jdbc", "url": jdbc, "env": "local"}))["ok"] is True
