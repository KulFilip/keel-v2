"""keel's master key and its database sit in the same data folder as the run/ keys; agents get no access to them either."""

from __future__ import annotations

import json

import pytest

from keel_engine import config, hook
from keel_engine.runtime import guard_ctx

PATHS = ["/data/master.key", "/data/keel.db", "/data/keel.db-wal", "/data/keel.db-shm",
         "/Users/me/.keel2/keel-v2/data/master.key", "/Users/me/.keel2/keel-v2/data/keel.db",
         "/home/me/.keel2/keel-lab/keel.db"]


def ctx(tmp_path, root) -> str:
    return guard_ctx.write_context(tmp_path / "ctx" / "guard.json", root=str(root), phase="green", ac=None, lane=None,
                                   unlocks=[], agent="implementer", thread="t1")


def judge(capsys, tool, ctx_path, **ti) -> tuple[int, str]:
    code = hook.pre_tool(json.dumps({"tool_name": tool, "tool_input": ti, "cwd": "/somewhere"}), ctx_path)
    return code, capsys.readouterr().err


@pytest.fixture
def root(tmp_path):
    r = tmp_path / "proj"
    r.mkdir()
    return r


@pytest.mark.parametrize("path", PATHS)
def test_no_tool_reads_searches_or_writes_the_master_key_or_the_database(capsys, tmp_path, root, path):
    c = ctx(tmp_path, root)
    for tool, ti in (("Read", {"file_path": path}), ("Grep", {"pattern": "x", "path": path}),
                     ("Write", {"file_path": path, "content": "x"}),
                     ("Edit", {"file_path": path, "old_string": "a", "new_string": "b"})):
        code, err = judge(capsys, tool, c, **ti)
        assert code == 2 and "keel's own key" in err, (tool, path, err)


def test_the_engines_own_data_folder_is_covered(capsys, tmp_path, root, monkeypatch):
    monkeypatch.setenv("KEEL_DATA", str(tmp_path / "elsewhere"))
    for name in ("master.key", "keel.db", "keel.db-wal"):
        code, err = judge(capsys, "Read", ctx(tmp_path, root), file_path=str(config.data_dir() / name))
        assert code == 2 and "keel's own key" in err, name


@pytest.mark.parametrize("command", [
    "cat /data/master.key",
    "sqlite3 /data/keel.db 'select * from connection'",
    "cp /data/keel.db /tmp/x.db",
    "xxd ~/.keel2/keel-v2/data/master.key",
    "sqlite3 /Users/me/.keel2/keel-v2/data/keel.db .dump",
    "base64 $KEEL_DATA/master.key",
    "base64 ${KEEL_DATA}/keel.db",
    "echo $KEEL_SECRET",
])
def test_no_command_reads_the_master_key_or_the_database(capsys, tmp_path, root, command):
    code, err = judge(capsys, "Bash", ctx(tmp_path, root), command=command)
    assert code == 2 and "keel's own keys" in err


@pytest.mark.parametrize("command", ["git grep keel.db", "cat src/master.key.md", "ls /data", "ls /database/keel.dbx"])
def test_ordinary_commands_still_pass(capsys, tmp_path, root, command):
    code, err = judge(capsys, "Bash", ctx(tmp_path, root), command=command)
    assert code == 0, err
