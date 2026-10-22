"""A small Jira Server (REST v2) for the Product e2e: enough for keel Product's tickets. It runs in the e2e's own process
on the host; the keel container reaches it at host.docker.internal. No real Jira is ever called.

    jira = StubJira.start()        # jira.port, jira.issues {key: fields}, jira.links [(type, inward, outward)]
"""

from __future__ import annotations

import itertools
import json
import threading
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

TOKEN = "e2e-stub-pat-123"  # a test value for the stub only, keel:allow-secret
EPIC_LINK = "customfield_10014"
TYPES = [("Initiative", False), ("Epic", False), ("Story", False), ("Task", False), ("Sub-task", True)]


class StubJira:
    def __init__(self) -> None:
        self.issues: dict[str, dict] = {}
        self.links: list[tuple[str, str, str]] = []
        self.calls: list[tuple[str, str]] = []
        self._n = itertools.count(1)
        self._server: ThreadingHTTPServer | None = None

    @property
    def port(self) -> int:
        assert self._server is not None
        return self._server.server_address[1]

    @classmethod
    def start(cls) -> "StubJira":
        stub = cls()
        stub._server = ThreadingHTTPServer(("0.0.0.0", 0), stub._handler())
        threading.Thread(target=stub._server.serve_forever, daemon=True).start()
        return stub

    def stop(self) -> None:
        if self._server:
            self._server.shutdown()

    def of(self, type_: str) -> dict[str, dict]:
        return {k: f for k, f in self.issues.items() if (f.get("issuetype") or {}).get("name") == type_}

    def _handler(self):
        stub = self

        class H(BaseHTTPRequestHandler):
            def log_message(self, *a):  # noqa: D401 - quiet
                pass

            def _body(self) -> dict:
                if (self.headers.get("transfer-encoding") or "").lower() == "chunked":
                    data = b""
                    while True:
                        size = int(self.rfile.readline().strip() or b"0", 16)
                        if size == 0:
                            self.rfile.readline()
                            break
                        data += self.rfile.read(size)
                        self.rfile.readline()
                else:
                    data = self.rfile.read(int(self.headers.get("content-length") or 0))
                return json.loads(data or b"{}")

            def _send(self, code: int, body: object) -> None:
                out = json.dumps(body).encode()
                self.send_response(code)
                self.send_header("content-type", "application/json")
                self.send_header("content-length", str(len(out)))
                self.end_headers()
                self.wfile.write(out)

            def _authed(self) -> bool:
                if self.headers.get("authorization") == f"Bearer {TOKEN}":
                    return True
                self._send(401, {"errorMessages": ["not signed in"]})
                return False

            def do_GET(self):
                stub.calls.append(("GET", self.path))
                if not self._authed():
                    return
                path = self.path.split("?")[0]
                if path == "/rest/api/2/myself":
                    return self._send(200, {"name": "e2e", "key": "e2e", "displayName": "e2e"})
                if path.startswith("/rest/api/2/project/") and path.count("/") == 5:
                    return self._send(200, {"key": path.rsplit("/", 1)[1], "issueTypes": [{"name": n, "subtask": s} for n, s in TYPES]})
                if path == "/rest/api/2/field":
                    return self._send(200, [{"id": "summary", "name": "Summary", "custom": False, "schema": {"type": "string"}},
                                            {"id": EPIC_LINK, "name": "Epic Link", "custom": True, "schema": {"type": "any"}}])
                if path == "/rest/api/2/search":
                    return self._send(200, {"startAt": 0, "maxResults": 50, "total": 0, "issues": []})
                return self._send(404, {"errorMessages": [f"the stub has no {path}"]})

            def do_POST(self):
                stub.calls.append(("POST", self.path))
                if not self._authed():
                    return
                body = self._body()
                if self.path == "/rest/api/2/issue":
                    f = body.get("fields") or {}
                    if f.get("parent") and (f.get("issuetype") or {}).get("name") == "Story":
                        return self._send(400, {"errors": {"parent": "Field 'parent' cannot be set."}})   # Server: Epic Link
                    key = f"{(f.get('project') or {}).get('key', 'X')}-{next(stub._n)}"
                    stub.issues[key] = f
                    return self._send(201, {"id": key, "key": key})
                if self.path == "/rest/api/2/issueLink":
                    stub.links.append(((body.get("type") or {}).get("name"), (body.get("inwardIssue") or {}).get("key"),
                                       (body.get("outwardIssue") or {}).get("key")))
                    return self._send(201, {})
                return self._send(404, {"errorMessages": [f"the stub has no {self.path}"]})

        return H
