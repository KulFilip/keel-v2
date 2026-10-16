"""v0.18.1 keel's api answers no caller without a credential (api auth/LocalAuth, docs/plans/agent-clients.md section 0).

The e2e suites call their throw-away keel as keel2 does: with keel's internal token, read from the container
(/data/run/internal-token, written by docker/keel-start). The browser walks sign in first through a one-time link
(POST /api/web/code). An older keel (parity's released one) has no sign-in: the token is ignored there and the link is
just its page."""

from __future__ import annotations

import json
import subprocess
import time
import urllib.error
import urllib.request

_tokens: dict[str, str] = {}


def token(container: str, wait: float = 120.0) -> str:
    """The container's internal token ("" when it has none: a keel older than 0.16.1)."""
    if container in _tokens:
        return _tokens[container]
    deadline = time.time() + wait
    while True:
        r = subprocess.run(["docker", "exec", container, "cat", "/data/run/internal-token"], capture_output=True, text=True)
        if r.returncode == 0 and r.stdout.strip():
            _tokens[container] = r.stdout.strip()
            return _tokens[container]
        if time.time() > deadline:
            return ""
        time.sleep(1)


def headers(container: str) -> dict[str, str]:
    t = token(container)
    return {"X-Keel-Token": t} if t else {}


def forget(container: str) -> None:
    """A container started again makes a new token."""
    _tokens.pop(container, None)


def signin_url(base: str, container: str) -> str:
    """A one-time link that signs a browser in (60 s); `base` itself for a keel without sign-in."""
    req = urllib.request.Request(base.rstrip("/") + "/api/web/code", data=b"{}", method="POST",
                                 headers={"content-type": "application/json", **headers(container)})
    try:
        with urllib.request.urlopen(req, timeout=15) as r:
            return base.rstrip("/") + json.loads(r.read().decode())["path"]
    except (urllib.error.URLError, KeyError, ValueError):
        return base
