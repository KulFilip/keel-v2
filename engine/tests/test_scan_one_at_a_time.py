"""Project scans take turns: a first code graph index costs 1.5-2 CPU cores and about 2 GB for minutes, and adding
several projects at once (keel2 add, All projects › Add) started one per project side by side."""

import asyncio
import threading
import time

from keel_engine.events import EventBus
from keel_engine.runtime import scan


async def test_scans_run_one_at_a_time(tmp_path, monkeypatch):
    lock = threading.Lock()
    now = {"running": 0, "most": 0}
    order = []

    def slow_index(root, pid, rebuild=False):
        with lock:
            now["running"] += 1
            now["most"] = max(now["most"], now["running"])
        order.append(pid)
        time.sleep(0.15)
        with lock:
            now["running"] -= 1
        return {"index": {"ok": True, "files": 1, "symbols": 1, "index_dir": None}}

    monkeypatch.setattr(scan.extensions, "hooks", lambda name: [("graph", slow_index)] if name == "on_scan" else [])
    scanner = scan.Scanner(EventBus())
    roots = []
    for name in ("a", "b", "c"):
        r = tmp_path / name
        r.mkdir()
        roots.append((name, str(r)))

    started = [await scanner.start(name, root) for name, root in roots]
    assert all(s["status"] == "indexing" for s in started)   # each row says indexing at once, also while it waits
    await asyncio.gather(*scanner.tasks.values())

    assert now["most"] == 1
    assert sorted(order) == ["a", "b", "c"]
    assert all(scan.status(name)["status"] == "ready" for name, _ in roots)


async def test_more_turns_when_asked(tmp_path, monkeypatch):
    lock = threading.Lock()
    now = {"running": 0, "most": 0}

    def slow_index(root, pid, rebuild=False):
        with lock:
            now["running"] += 1
            now["most"] = max(now["most"], now["running"])
        time.sleep(0.15)
        with lock:
            now["running"] -= 1
        return {}

    monkeypatch.setattr(scan.extensions, "hooks", lambda name: [("graph", slow_index)] if name == "on_scan" else [])
    scanner = scan.Scanner(EventBus(), parallel=3)
    for name in ("a", "b", "c"):
        (tmp_path / name).mkdir()
        await scanner.start(name, str(tmp_path / name))
    await asyncio.gather(*scanner.tasks.values())
    assert now["most"] == 3
