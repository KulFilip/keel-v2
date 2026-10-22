"""keel 0.18.38 what agents may do with each connection (its Access in Databases, the api's agent_access): none hides it
from agents, read is keel's read-only path, write_approve lets db_change run after the person's Yes in the Inbox,
staging and prod stay read only for agents whatever the key says, and ask_first asks once before the first query of a
flow. Plus what keel says of a connection it cannot reach now, the test's milliseconds, a server's databases and an
error text without the password. Fake model only; SQLite."""

import json
import threading
import time

from keel_engine import approvals, extensions
from keel_plugin_db import core, tools


def conn(name="local", env="local", access="read", ask_first=False, **kw):
    return {"name": name, "kind": "sqlite", "url": "sqlite:app.db", "env": env, "agent_access": access, "ask_first": ask_first, **kw}


def keyset(*conns):
    return {f"db:{c['name']}": json.dumps(c) for c in conns}


def opened(client, root, *conns, thread="t-1"):
    return extensions.open_call(project="demo", root=str(root), keys=keyset(*conns), plugins=["db"], who="agent:coder",
                                bus=client.bus, thread=thread)


def call(key, tool, **args):
    return extensions.call(key, tool, args)


def answered(client, key, tool, decision="once", **args):
    """Runs the tool in a thread, answers the person's question in the Inbox, and returns (the tool's text, the question)."""
    out = {}
    th = threading.Thread(target=lambda: out.setdefault("text", call(key, tool, **args)))
    th.start()
    broker = approvals.of(client.bus)
    deadline = time.time() + 10
    while not broker.pending("demo") and time.time() < deadline:
        time.sleep(0.02)
    q = broker.pending("demo")[0]
    broker.answer(q["id"], decision, "" if decision != "deny" else "not now")
    th.join(10)
    return out["text"], q


def count(root):
    import sqlite3

    c = sqlite3.connect(root / "app.db")
    try:
        return c.execute("select count(*) from scores").fetchone()[0]
    finally:
        c.close()


def test_none_is_not_offered_to_agents_at_all(client, scores):
    key = opened(client, scores, conn("secret", access="none"), conn("local"))
    listed = call(key, "db_connections")
    assert "secret" not in listed and "- local: SQLite, local" in listed
    assert call(key, "db_query", sql="select 1", connection="secret").startswith("Refused: There is no connection called secret")
    assert call(key, "db_query", sql="select count(*) from players").startswith("1 row from local")
    only = opened(client, scores, conn("secret", access="none"))
    assert call(only, "db_schema").startswith("Refused: This project has no database connection")


def test_read_reads_and_refuses_a_change(client, scores):
    key = opened(client, scores, conn("local"))
    assert "3 rows from local" in call(key, "db_query", sql="select name from players")
    text = call(key, "db_change", sql="DELETE FROM scores")
    assert text.startswith("Refused: Agents may only read local.") and "keel-query" in text
    assert count(scores) == 1
    assert not approvals.of(client.bus).pending("demo")


def test_write_approve_runs_a_change_only_after_the_persons_yes(client, scores):
    key = opened(client, scores, conn("local", access="write_approve"))
    assert "a change with db_change waits for the person's OK" in call(key, "db_connections")
    sql = "INSERT INTO scores (player_id, value) VALUES (2, 5)"
    text, q = answered(client, key, "db_change", "deny", sql=sql)
    assert text.startswith("Not run: the person said no") and count(scores) == 1
    assert q["title"] == "Change 1 row(s) in local?" and q["source"] == "plugin:db" and q["thread_id"] == "t-1"
    text, _ = answered(client, key, "db_change", sql=sql)
    assert text == "1 row(s) changed in local after the person's OK." and count(scores) == 2


def test_prod_is_read_only_for_agents_whatever_the_key_says(client, scores):
    live = conn("live", env="prod", access="write_approve")
    assert core.conn_of(live).agent_may == "read" and core.conn_of(conn("st", env="staging", access="write_approve")).agent_may == "read"
    key = opened(client, scores, live)
    assert "live: SQLite, prod, this project's own (read only, always)" in call(key, "db_connections")
    text = call(key, "db_change", sql="DELETE FROM scores", connection="live")
    assert text.startswith("Refused: live is a prod database: agents only read there, always.")
    assert count(scores) == 1 and not approvals.of(client.bus).pending("demo")


def test_ask_first_asks_once_per_flow_before_the_first_query(client, scores):
    c = conn("local", ask_first=True, scope="global")
    key = opened(client, scores, c, thread="t-ask")
    assert "shared with every project" in call(key, "db_connections") and "asked before your first query" in call(key, "db_connections")
    text, q = answered(client, key, "db_query", sql="select count(*) from players")
    assert text.startswith("1 row from local") and q["title"] == "May the agent coder query local (local)?"
    assert call(key, "db_query", sql="select count(*) from scores").startswith("1 row from local")   # no second question
    # another flow asks again; a no is kept for that flow
    other = opened(client, scores, c, thread="t-other")
    text, _ = answered(client, other, "db_schema", "deny")
    assert text == "Refused: the person said no to queries on local in this flow."
    assert call(other, "db_query", sql="select 1") == text
    # without a way to ask (an older caller), keel does not run it
    old = extensions.open_call(project="demo", root=str(scores), keys=keyset(conn("local", ask_first=True)), plugins=["db"], who="keelbot")
    assert call(old, "db_query", sql="select 1").startswith("Refused: the person said no")


def test_a_connection_keel_cannot_reach_now_says_why(client, scores):
    gone = {"name": "sess", "kind": "postgres", "url": "", "env": "local", "unavailable": "keel keeps the password of sess only while it runs."}
    key = opened(client, scores, gone, conn("local"))
    assert "- sess: not reachable now (keel keeps the password" in call(key, "db_connections")
    assert call(key, "db_query", sql="select 1", connection="sess").startswith("Refused: keel keeps the password of sess")


def test_a_test_has_its_milliseconds_and_sqlite_has_one_database(client, scores):
    r = client.post("/plugins/db/test", json={"root": str(scores), "connection": conn()}).json()
    assert r["ok"] and r["tables"] == 2 and isinstance(r["ms"], int)
    assert client.post("/plugins/db/databases", json={"root": str(scores), "connection": conn()}).json() == {"databases": [{"name": "main"}]}
    missing = client.post("/plugins/db/test", json={"root": str(scores), "connection": {**conn(), "url": "sqlite:nope.db"}}).json()
    assert missing["ok"] is False and "ms" in missing


def test_an_error_text_never_quotes_the_password():
    url = "postgres://app:Hunter2Pw@db:5432/x"  # keel:allow-secret
    text = core.scrub(f"connection to {url} failed: password Hunter2Pw rejected", url)
    assert "Hunter2Pw" not in text and "postgres://app:•••@db:5432/x" in text
    e = core._connect_error(core.conn_of({"name": "x", "url": url}), RuntimeError("FATAL: user app with Hunter2Pw"))
    assert "Hunter2Pw" not in str(e)
