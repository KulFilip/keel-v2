"""Engine data-loss bugs: shutdown, rewind on a dirty folder, two resumes at once."""
import asyncio

from keel_engine.events import EventBus
from keel_engine.runtime.service import Engine
from keel_engine.workflows.templates import get_template


def _body(repo) -> dict:
    return {"project_id": "demo", "root": str(repo), "workflow": get_template("feature"), "title": "Player ranks",
            "models": {"default": {"provider": "fake", "mode": "api", "model": "fake"}},
            "settings": {"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause"}, "mcp": [], "skills": {}}


async def _status(eng, tid) -> str:
    return (await eng._row(tid))["status"]


async def test_shutdown_keeps_a_running_flow_running_and_open_continues_it(tmp_path, monkeypatch, repo):
    monkeypatch.setenv("KEEL_FAKE_DELAY", "0.5")
    monkeypatch.setattr("keel_engine.runtime.service.CONTINUE_GRACE", 3600)
    eng = Engine(EventBus(), tmp_path / "eng")
    await eng.open(resume_running=False)
    tid = await eng.start_thread(_body(repo))
    await asyncio.sleep(0.3)
    assert tid in eng.tasks and await _status(eng, tid) == "running"
    await eng.close()
    eng2 = Engine(EventBus(), tmp_path / "eng")
    await eng2.open(resume_running=True)
    try:
        assert await _status(eng2, tid) == "running", "a restart must not turn a running flow into a stopped one"
        assert eng2.pending == {tid}
        launched = []
        monkeypatch.setattr(eng2, "_launch", lambda t, inp, cfg=None: launched.append(t))
        await eng2.continue_after_restart(tid, None, str(repo))
        assert launched == [tid]
    finally:
        await eng2.close()


async def test_an_explicit_stop_still_writes_stopped(tmp_path, monkeypatch, repo):
    monkeypatch.setenv("KEEL_FAKE_DELAY", "0.5")
    eng = Engine(EventBus(), tmp_path / "eng")
    await eng.open(resume_running=False)
    try:
        tid = await eng.start_thread(_body(repo))
        await asyncio.sleep(0.3)
        assert tid in eng.tasks
        await eng.stop(tid)
        assert await _status(eng, tid) == "stopped"
    finally:
        await eng.close()


# ---- bug 2: rewind must not destroy uncommitted work, and a bad checkpoint must not wipe agent memory

def _flow_with_commits(client, repo):
    from conftest import decide, start, to_loop
    tid = start(client, repo)
    s = to_loop(client, tid)
    s = decide(client, tid)                        # AC-1 done: the repo has test/feat commits now
    hist = client.get(f"/threads/{tid}/history").json()
    cp = next(c for c in hist if c["step"] == "spec")
    return tid, cp


def _tracked_file(repo):
    import subprocess
    rel = subprocess.run(["git", "ls-files"], cwd=repo, capture_output=True, text=True).stdout.split()[0]
    return repo / rel


def test_rewind_refuses_when_tracked_files_have_uncommitted_changes(client, repo):
    tid, cp = _flow_with_commits(client, repo)
    f = _tracked_file(repo)
    f.write_text("my unsaved work\n")
    r = client.post(f"/threads/{tid}/rewind", json={"checkpoint_id": cp["id"]})
    assert r.status_code == 409 and "uncommitted" in r.json()["error"] and f.name in r.json()["error"], r.text
    assert f.read_text() == "my unsaved work\n"
    assert client.get(f"/threads/{tid}").json()["status"] == "waiting", "a refused rewind changes nothing"


def test_rewind_with_a_clean_folder_still_goes_back(client, repo):
    tid, cp = _flow_with_commits(client, repo)
    (repo / "scratch-untracked.txt").write_text("untracked files are not touched by reset --hard\n")
    r = client.post(f"/threads/{tid}/rewind", json={"checkpoint_id": cp["id"]})
    assert r.status_code == 200, r.text
    assert (repo / "scratch-untracked.txt").exists()


def test_a_bad_checkpoint_id_leaves_agent_memory_and_calls_alone(client, repo):
    from conftest import start, wait
    tid = start(client, repo)
    wait(client, tid)
    eng = client.app.state.engine
    ctx = eng.ctxs[tid]
    ctx.done_calls["k"] = "result"
    ctx.auto_seen["q"] = 1
    client.portal.call(ctx.memory.start, "a", "fake", str(repo), None, False)
    r = client.post(f"/threads/{tid}/rewind", json={"checkpoint_id": "nope"})
    assert r.status_code == 404
    assert ctx.done_calls == {"k": "result"} and ctx.auto_seen == {"q": 1}
    row = client.portal.call(ctx.memory.get, "a")
    assert row is not None
