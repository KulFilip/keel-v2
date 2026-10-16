#!/usr/bin/env python3
"""A keel with only its core, end to end (docs/plugins/16-steps5-7-contract.md, step 6), on a throw-away keel only: the
container keel-core on 127.0.0.1:8097 with its own volume keel-core-data. It never touches the person's own keel.

    python3 e2e/core/e2e.py --image keel-v2:s6-core --full-image keel-v2:s6 [--keep] [--only core,off]

  core  the core image (EDITION=core): no plugin inside, none loaded
  off   the full image with KEEL_PLUGINS=off: every plugin inside, none loaded

Each run starts keel-core on a fresh volume with a small git project at /workspace and the fake model (KEEL_FAKE=1),
checks the api (health, the edition, /api/plugin-host and /api/features list no plugin), runs two flows on the fake
model (init, and change, which waits at a gate) and walks the web app in headless Chromium (e2e/core/walk.mjs, through
`npx -y -p playwright@1`): every menu page, #/projects and both flows. No page may log a console error, fail a request
or ask a plugin's route, no link may lead to a page this keel does not have, and the menu's Project group is
its "No pages yet" box. The container and the volume are removed after each run (--keep: the last one stays).
"""

from __future__ import annotations

import argparse
import json
import os
import shutil
import subprocess
import sys
import tempfile
import time
import urllib.error
import urllib.request
from pathlib import Path

NAME, VOLUME, PORT = "keel-core", "keel-core-data", 8097
HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
import keelauth  # noqa: E402  (e2e/keelauth.py: keel's sign-in, v0.17.5)
PROJECT = "shop"
CHECKS: list[str] = []

FIXTURE = {
    "README.md": "# Shop\n\nA tiny shop: prices with tax, in Python.\n\nRun the tests: `python -m pytest -q`\n",
    "shop/__init__.py": "",
    "shop/price.py": (
        "def with_tax(cents: int, rate: float) -> int:\n"
        '    """The price with tax, rounded to a cent."""\n'
        "    if cents < 0:\n"
        '        raise ValueError("a price is never negative")\n'
        "    return round(cents * (1 + rate))\n"
    ),
    "tests/test_price.py": (
        "import pytest\n\nfrom shop.price import with_tax\n\n\n"
        "def test_tax_is_added():\n    assert with_tax(1000, 0.21) == 1210\n\n\n"
        "def test_a_negative_price_is_refused():\n    with pytest.raises(ValueError):\n        with_tax(-1, 0.21)\n"
    ),
    "docs/adr/0001-python.md": "# 1. Python\n\nThe shop is plain Python: no framework, no database yet.\n",
}


def sh(*args: str, check: bool = True, cwd: Path | None = None) -> str:
    r = subprocess.run(list(args), capture_output=True, text=True, cwd=cwd)
    if check and r.returncode != 0:
        raise RuntimeError(f"{' '.join(args)} failed ({r.returncode}): {(r.stderr or r.stdout)[-1500:]}")
    return r.stdout + r.stderr


def http(method: str, path: str, body: object | None = None, timeout: float = 30) -> tuple[int, dict, str]:
    data = None if body is None else json.dumps(body).encode()
    req = urllib.request.Request(f"http://127.0.0.1:{PORT}{path}", data=data, method=method,
                                 headers={**({"content-type": "application/json"} if data else {}), **keelauth.headers(NAME)})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as r:
            return r.status, dict(r.headers), r.read().decode(errors="replace")
    except urllib.error.HTTPError as e:
        return e.code, dict(e.headers), e.read().decode(errors="replace")


def api(method: str, path: str, body: object | None = None, ok: tuple[int, ...] = (200,)):
    code, headers, text = http(method, "/api" + path, body)
    if code not in ok:
        raise AssertionError(f"{method} /api{path} → {code}: {text[:500]}")
    kind = {k.lower(): v for k, v in headers.items()}.get("content-type", "")
    return json.loads(text) if text and "json" in kind else text


def check(cond: bool, what: str) -> None:
    if not cond:
        raise AssertionError("FAILED: " + what)
    CHECKS.append(what)
    print("  ✓", what)


def wait_until(what: str, fn, timeout: float = 240.0, every: float = 2.0):
    deadline, last = time.time() + timeout, None
    while time.time() < deadline:
        try:
            last = fn()
        except Exception as e:  # noqa: BLE001 - keel is starting; keep trying
            last = e
        if last and not isinstance(last, Exception):
            return last
        time.sleep(every)
    raise AssertionError(f"timed out waiting for {what} (last: {str(last)[:300]})")


def ours_only() -> None:
    """keel-core is a throw-away keel of this test: replace it, never anything else."""
    if sh("docker", "ps", "-a", "--filter", f"name=^{NAME}$", "--format", "{{.Names}}", check=False).strip():
        print(f"{NAME} exists already; it is this test's throw-away keel and is replaced")


def clean() -> None:
    sh("docker", "rm", "-f", NAME, check=False)
    keelauth.forget(NAME)
    sh("docker", "volume", "rm", VOLUME, check=False)


def fixture(root: Path) -> Path:
    """The shop: a git repo with a little Python and its tests, one commit."""
    repo = root / PROJECT
    for rel, text in FIXTURE.items():
        f = repo / rel
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_text(text)
    git = ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false"]
    sh(*git, "init", "-q", "-b", "main", cwd=repo)
    sh(*git, "add", "-A", cwd=repo)
    sh(*git, "commit", "-q", "-m", "The shop: prices with tax", cwd=repo)
    return repo


def start(image: str, ws: Path, env: dict[str, str]) -> None:
    """keel-core from this image on a fresh volume, the project at /workspace, the fake model."""
    clean()
    args = ["docker", "run", "-d", "--name", NAME, "-p", f"127.0.0.1:{PORT}:8080", "-v", f"{VOLUME}:/data",
            "-v", f"{ws}:/workspace", "-e", "KEEL_FAKE=1", "-e", f"KEEL_PROJECT_NAME={PROJECT}"]
    for k, v in env.items():
        args += ["-e", f"{k}={v}"]
    sh(*args, image)
    wait_until(f"{NAME} ({image}) to be healthy", lambda: api("GET", "/health"), timeout=300)


def env_of(name: str) -> str:
    out = sh("docker", "inspect", "-f", "{{range .Config.Env}}{{println .}}{{end}}", NAME)
    return next((line.split("=", 1)[1] for line in out.splitlines() if line.startswith(name + "=")), "")


def where(pid: str, tid: str) -> str:
    th = api("GET", f"/projects/{pid}/flows/{tid}")
    th = th.get("thread", th) if isinstance(th, dict) else {}
    return th.get("status") or ""


def flows(pid: str) -> list[str]:
    """Two flows on the fake model: init (the ladder and the knowledge base) to its end, then change, which waits at its
    first gate. Returns their links (#/flow/<thread>)."""
    fake = {"provider": "fake", "mode": "api", "model": "fake"}
    api("PUT", "/settings/general", {"cheaper_model": fake})
    links = []
    for wf, title, stop in (("init", "Get to know the shop", ("done", "failed", "waiting", "stopped")),
                            ("change", "Prices in euros", ("waiting",))):
        body = {"workflow_id": wf, "title": title, "allow_fake": True, "allow_dirty": True}
        if wf == "change":
            body["acs"] = [{"id": "AC-1", "layer": "API", "title": "A price shows in euros"}]
        res = api("POST", f"/projects/{pid}/flows", body)
        tid = res.get("thread_id") or (res.get("thread") or {}).get("thread_id")
        check(bool(tid), f"the {wf} flow started on the fake model")
        try:
            status = wait_until(f"the {wf} flow to stop", lambda: (s := where(pid, tid)) in stop and s, timeout=300)
            print(f"    {wf}: {status}")
        except AssertionError as e:
            print(f"  ! {e} (the walk shows it running)")
        links.append(f"#/flow/{tid}")
    return links


def walk(out: Path, extra: list[str], label: str) -> None:
    print(f"   the web, in headless Chromium ({label})")
    cmd = ["npx", "-y", "-p", "playwright@1", "node", str(HERE / "walk.mjs"), f"http://127.0.0.1:{PORT}", str(out), *extra]
    env = {**os.environ, "KEEL_SIGNIN": keelauth.signin_url(f"http://127.0.0.1:{PORT}", NAME)}
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=1500, env=env)
    line = next((x for x in reversed(r.stdout.splitlines()) if x.startswith("{")), "")
    if not line:
        raise AssertionError(f"walk.mjs gave no answer ({r.returncode}): {(r.stderr or r.stdout)[-2000:]}")
    res = json.loads(line)
    (out / f"walk-{label}.json").write_text(json.dumps(res, indent=1))
    bad = [c for c in res["checks"] if not c["ok"]]
    for c in res["checks"]:
        print(("  ✓ " if c["ok"] else "  ✗ ") + c["what"] + ("" if c["ok"] else f"\n      {c['detail']}" + (f"\n      {c['shot']}" if c.get("shot") else "")))
    CHECKS.extend(c["what"] for c in res["checks"] if c["ok"])
    if bad:
        raise AssertionError(f"FAILED: {len(bad)} web check(s) ({label}); details in {out / f'walk-{label}.json'}")


def run(label: str, image: str, env: dict[str, str], ws: Path, out: Path, core_image: bool) -> None:
    print(f"\n{label}: {image}{''.join(f' {k}={v}' for k, v in env.items())}")
    start(image, ws, env)
    h = api("GET", "/health")
    check(h.get("status") in ("ok", "UP", None) or bool(h), f"keel answers /api/health (version {h.get('version', '?')})")
    edition = env_of("KEEL_EDITION")
    check(edition == ("core" if core_image else "full"), f"the image says its edition: KEEL_EDITION={edition}")
    baked = sh("docker", "exec", NAME, "sh", "-c", "ls /opt/keel-v2/plugins 2>/dev/null || true").split()
    if core_image:
        check(baked == [], "the core image has no plugin inside (/opt/keel-v2/plugins is empty)")
    else:
        check(len(baked) >= 10, f"the full image has its plugins inside ({len(baked)}), none of them loads")
    host = api("GET", "/plugin-host")
    check(host.get("plugins") == [], f"/api/plugin-host lists no plugin (mode {host.get('mode')})")
    f = api("GET", "/features")
    check(f.get("plugins") == [] and f.get("addons") == [], "/api/features: no plugin, no add-on")
    projects = wait_until("the project at /workspace", lambda: api("GET", "/projects") or None, timeout=60)
    pid = projects[0]["id"]
    check(len(projects) == 1, f"keel found the project at /workspace ({pid})")
    for path in ("workflows", "agents", "flow"):
        api("GET", f"/projects/{pid}/{path}")
    check(True, "core works: the project's workflows, agents and flow")
    links = flows(pid)
    walk(out, links, label)


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument("--image", default="keel-v2:s6-core", help="the core image (EDITION=core)")
    ap.add_argument("--full-image", default="keel-v2:s6", help="the full image, started with KEEL_PLUGINS=off")
    ap.add_argument("--only", default="core,off")
    ap.add_argument("--keep", action="store_true", help="leave the last keel-core running (and its volume)")
    ap.add_argument("--out", default="", help="where the walk's results and screenshots go (default: a temp folder)")
    a = ap.parse_args()
    ours_only()
    tmp = Path(tempfile.mkdtemp(prefix="s6_core_e2e_"))
    out = Path(a.out) if a.out else tmp / "out"
    out.mkdir(parents=True, exist_ok=True)
    want = [s.strip() for s in a.only.split(",") if s.strip()]
    t0 = time.time()
    ok = False
    try:
        for s in want:
            ws = tmp / f"ws-{s}"
            repo = fixture(ws)
            if s == "core":
                run("core", a.image, {}, repo, out, core_image=True)
            elif s == "off":
                run("off", a.full_image, {"KEEL_PLUGINS": "off"}, repo, out, core_image=False)
            else:
                raise SystemExit(f"unknown run {s} (core, off)")
            if s != want[-1] or not a.keep:
                clean()
        print(f"\nPASSED: {len(CHECKS)} checks ({', '.join(want)}) in {time.time() - t0:.0f} s; results in {out}")
        ok = True
        return 0
    except Exception as e:  # noqa: BLE001
        print(f"\n{e}", file=sys.stderr)
        print(sh("docker", "logs", "--tail", "60", NAME, check=False)[-5000:], file=sys.stderr)
        return 1
    finally:
        if not (a.keep and ok):
            clean()
        if not a.out:
            # keep the screenshots of a failed run
            shutil.rmtree(tmp / "ws-core", ignore_errors=True)
            shutil.rmtree(tmp / "ws-off", ignore_errors=True)
            if ok:
                shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    sys.exit(main())
