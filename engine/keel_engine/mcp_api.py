"""The pieces every keel MCP module shares: the api client (KeelApi), its error, the project / flow lookups and a few
text helpers. This module imports nothing from the other mcp_* modules, so they can all import it."""
from __future__ import annotations

import copy
import os
from datetime import datetime
from typing import Any
from urllib.parse import quote

import httpx

API_TIMEOUT = 15


MCP_TOKEN_HEADER = "X-Keel-Mcp-Token"


class ApiError(Exception):
    def __init__(self, message: str, status: int | None = None):
        super().__init__(message)
        self.status = status     # the api's HTTP status, when it answered


def internal_token() -> str:
    """KEEL_INTERNAL_TOKEN, else the file KEEL_INTERNAL_TOKEN_FILE names (keel2 mcp in Docker: docker/keel-start writes it)."""
    tok = os.environ.get("KEEL_INTERNAL_TOKEN", "").strip()
    path = os.environ.get("KEEL_INTERNAL_TOKEN_FILE", "")
    if not tok and path:
        try:
            with open(path, encoding="utf-8") as f:
                tok = f.read().strip()
        except OSError:
            tok = ""
    return tok


class KeelApi:
    """The keel v2 api over HTTP (KEEL_API_URL). Public /api routes; the api only listens on 127.0.0.1."""

    def __init__(self, url: str | None = None, transport: httpx.BaseTransport | None = None):
        self.url = (url or os.environ.get("KEEL_API_URL") or "http://127.0.0.1:8080").rstrip("/")
        self.http = httpx.Client(base_url=self.url + "/api", timeout=API_TIMEOUT, transport=transport)
        # v0.16.1 the api checks the level: with the internal token (keel2 mcp has it, agents never do) this asks the api
        # for its level's token once and sends it as X-Keel-Mcp-Token; without it, no token, so the api treats it as read.
        # A dict, so the copies acting() makes share it.
        # v0.18.1 without the internal token, the token the engine gave this server (KEEL_MCP_TOKEN: keel's agents' own
        # server, read level), since the api answers no caller without one.
        self._proof = {"internal": internal_token(), "level": "read", "asked": False,
                       "given": os.environ.get("KEEL_MCP_TOKEN", "").strip()}
        # v0.16.0 who acts: every write the api gets from here says "via MCP · <client>: <tool>" (api McpAudit)
        self.client = "an MCP client"
        self.tool = ""

    def acting(self, client: str, tool: str) -> "KeelApi":
        """A copy for one tool call (the same HTTP client) that says who acts: two calls at once never swap names."""
        c = copy.copy(self)
        c.client, c.tool = client, tool
        return c

    def use_level(self, level: str) -> None:
        """The level to ask the api's token for (build_server sets it); asked on the first request."""
        self._proof.update(level=level, asked=False)
        self.http.headers.pop(MCP_TOKEN_HEADER, None)

    def _prove(self) -> None:
        p = self._proof
        if p["asked"]:
            return
        if not p["internal"]:
            if p["given"]:
                self.http.headers[MCP_TOKEN_HEADER] = p["given"]
                p["asked"] = True
            return
        try:
            res = self.http.post("/mcp/token", json={"level": p["level"]}, headers={"X-Keel-Token": p["internal"]})
        except httpx.HTTPError:
            return                                          # the api is not up yet: ask again on the next request
        if res.status_code != 200:
            return                                          # the api is starting or said no: ask again on the next request
        p["asked"] = True
        try:
            token = res.json().get("token") if res.status_code == 200 else None
        except ValueError:
            token = None
        if token:
            self.http.headers[MCP_TOKEN_HEADER] = token

    def _audit(self, method: str) -> dict:
        if method == "GET":
            return {}
        return {"X-Keel-Via": "mcp", "X-Keel-Client": self.client[:80], "X-Keel-Tool": self.tool[:80]}

    def _raw(self, method: str, path: str, timeout: float | None = None, **kw) -> httpx.Response:
        self._prove()
        try:
            res = self.http.request(method, path, headers=self._audit(method), **({"timeout": timeout} if timeout else {}), **kw)
        except httpx.HTTPError as exc:
            raise ApiError(f"keel's api does not answer at {self.url} ({type(exc).__name__}). Is keel running? (keel2 status)") from exc
        if res.status_code >= 400:
            try:
                body = res.json()
                msg = body.get("error") or res.text
                if body.get("hint"):
                    msg += f" ({body['hint']})"
            except ValueError:
                msg = res.text[:300]
            raise ApiError(f"{method} {path}: {res.status_code} {msg}", res.status_code)
        return res

    def _send(self, method: str, path: str, **kw) -> Any:
        res = self._raw(method, path, **kw)
        return res.json() if res.content else None

    def text(self, route: str, /, **params) -> str:
        return self._raw("GET", route, params={k: v for k, v in params.items() if v is not None}).text

    def put(self, path: str, body: dict) -> Any:
        return self._send("PUT", path, json=body)

    def patch(self, path: str, body: dict) -> Any:
        return self._send("PATCH", path, json=body)

    def delete(self, path: str) -> Any:
        return self._send("DELETE", path)

    def get(self, route: str, /, **params) -> Any:
        """GET a route; `params` are the query (a `path` query parameter is fine: the route is positional)."""
        return self._send("GET", route, params={k: v for k, v in params.items() if v is not None})

    def post(self, path: str, body: dict, timeout: float | None = None) -> Any:
        return self._send("POST", path, json=body, timeout=timeout)


# ---------------------------------------------------------------- helpers

def _project(api: KeelApi, project: str | None) -> dict:
    projects = api.get("/projects") or []
    want = project or os.environ.get("KEEL_PROJECT") or ""
    if want:
        for p in projects:
            if want in (p.get("id"), p.get("name")):
                return p
        raise ApiError(f'no project "{want}". keel knows: {", ".join(p["id"] for p in projects) or "none yet"}')
    if not projects:
        raise ApiError("keel has no project yet. Add one in the dashboard (Projects › Add).")
    cwd = os.path.realpath(os.getcwd())
    inside = [p for p in projects if p.get("root") and (cwd == p["root"] or cwd.startswith(p["root"].rstrip("/") + "/"))]
    if inside:
        return max(inside, key=lambda p: len(p["root"]))
    if getattr(api, "tool", "") and len(projects) > 1:
        # a write must not land on a project the caller did not pick: the folder matches none, so name the project
        raise ApiError(f"this folder is in none of keel's projects, so keel does not guess which one to change. Pass "
                       f'project (one of: {", ".join(p["id"] for p in projects)}).')
    return projects[0]


def _flow(api: KeelApi, pid: str) -> tuple[dict | None, dict | None]:
    view = api.get(f"/projects/{pid}/flow") or {}
    return view.get("thread"), view.get("workflow")


def _n(x: Any) -> str:
    try:
        return f"{int(x or 0):,}"
    except (TypeError, ValueError):
        return str(x)


def _when(at: str | None) -> datetime:
    try:
        return datetime.fromisoformat(str(at).replace("Z", "+00:00")).replace(tzinfo=None)
    except ValueError:
        return datetime.min


def _clock(at: str | None) -> str:
    d = _when(at)
    return d.strftime("%m-%d %H:%M:%S") if d != datetime.min else "--"


def cut(text: str, n: int) -> str:
    """At most n characters, cut at a word boundary, with "…" when something was left out."""
    text = str(text or "")
    if len(text) <= n:
        return text
    head = text[:n]
    at = max(head.rfind(" "), head.rfind("\n"))
    return (head[:at] if at > n // 2 else head).rstrip() + " …"


def q(x: str) -> str:
    """URL-encode one path segment."""
    return quote(str(x), safe="")
