"""keel's git credential helper (git_auth.py sets it per command with `-c credential.helper=!<python> -I <this file>`).

git asks it `get` with the request on stdin (protocol=https, host=github.com, ...). It answers with keel's GitHub login
ONLY when the request is https and its host is the one the login belongs to (KEEL_GIT_HOST: github.com, or the
Enterprise host of Connections › GitHub); for any other host, protocol or operation it answers nothing, so git goes
on without a password. The token is read from the file KEEL_GIT_TOKEN_FILE names (0600, removed after the command):
it is never in git's argv, its config or the environment.

Standard library only: it runs with `python -I` (no site packages, no PYTHONPATH).
"""

from __future__ import annotations

import os
import sys


def hostname(host: str) -> str:
    """A credential request's host without its port, lower case ("GHE.acme.com:8443" -> "ghe.acme.com")."""
    h = (host or "").strip().lower()
    if h.startswith("["):                       # [::1]:8443
        return h.split("]", 1)[0] + "]"
    return h.split(":", 1)[0]


def parse(text: str) -> dict[str, str]:
    out: dict[str, str] = {}
    for line in (text or "").splitlines():
        if "=" in line:
            k, v = line.split("=", 1)
            out[k.strip()] = v.strip()
    return out


def answer(op: str, request: str, env: dict) -> str:
    """What the helper prints for `git credential <op>` with `request` on stdin; "" = nothing (git asks no one else)."""
    if op != "get":
        return ""
    req = parse(request)
    want = hostname(env.get("KEEL_GIT_HOST", ""))
    if req.get("protocol", "").lower() != "https" or not want or hostname(req.get("host", "")) != want:
        return ""
    path = env.get("KEEL_GIT_TOKEN_FILE", "")
    try:
        with open(path, encoding="utf-8") as f:
            token = f.read().strip()
    except OSError:
        return ""
    if not token or "\n" in token:
        return ""
    return f"username=x-access-token\npassword={token}\n"


def main(argv: list[str]) -> int:
    op = argv[1] if len(argv) > 1 else ""
    request = sys.stdin.read()                  # read it all, for every operation: git writes it either way
    out = answer(op, request, dict(os.environ))
    if out:
        sys.stdout.write(out)
        sys.stdout.flush()
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv))
