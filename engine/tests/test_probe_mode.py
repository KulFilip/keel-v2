from conftest import decide, start, wait


def test_child_mode(client, repo):
    tid = start(client, repo, workflow="spike", settings={"gates_mode": "every-ac", "cap_tokens": 0, "on_cap": "pause", "run_mode": "important"})
    s = wait(client, tid)
    for _ in range(10):
        print(s["status"], (s.get("waiting") or {}).get("step"), s["run_mode"])
        if s["status"] != "waiting":
            break
        w = s["waiting"]
        if w["step"] == "decide":
            s = decide(client, tid, payload={"choice": "spec"})
        else:
            s = decide(client, tid)
    kids = s.get("children") or []
    print("children", kids)
    for k in kids:
        c = wait(client, k["thread_id"])
        print("child", c["run_mode"], c["status"], (c.get("waiting") or {}).get("step"))
