"""keel_connect_github (admin): starts "Sign in with GitHub" and returns the code and the link for the person; the token
is never in the answer (the api never sends it)."""

import json

import httpx
from mcp.shared.memory import create_connected_server_and_client_session

from keel_engine import mcp_server
from test_mcp import call

TOKEN = "gho_fakefakefakefakefakefakefakefake1234"   # keel:allow-secret


class Api:
    def __init__(self, view):
        self.view = view
        self.posts: list[tuple[str, dict]] = []

    def __call__(self, req: httpx.Request) -> httpx.Response:
        if req.method == "POST" and req.url.path == "/api/github/login":
            self.posts.append((req.url.path, json.loads(req.content)))
            return httpx.Response(200, json=self.view)
        return httpx.Response(404, json={"error": f"No route {req.url.path}"})


def server(stub, level="admin"):
    return mcp_server.build_server(level=level, api=mcp_server.KeelApi("http://keel.test", transport=httpx.MockTransport(stub)))


async def test_it_returns_the_code_and_the_link_and_never_the_token():
    stub = Api({"id": "g1", "status": "waiting", "host": "ghe.example.com", "url": "https://ghe.example.com/login/device",
                "code": "AB12-CD34", "message": "Open the link", "login": None, "scopes": [], "via": None})
    text = await call(server(stub), "keel_connect_github", {"host": "ghe.example.com"})
    assert stub.posts == [("/api/github/login", {"host": "ghe.example.com"})]
    assert "AB12-CD34" in text and "https://ghe.example.com/login/device" in text and TOKEN not in text
    assert "never shown" in text


async def test_the_default_host_is_github_com_and_it_is_admin_only():
    stub = Api({"id": "g1", "status": "waiting", "host": "github.com", "url": "https://github.com/login/device", "code": "ZZ99-YY88",
                "message": "", "login": None, "scopes": [], "via": None})
    await call(server(stub), "keel_connect_github")
    assert stub.posts[-1][1] == {"host": "github.com"}
    for level in ("read", "write"):
        async with create_connected_server_and_client_session(server(stub, level)) as session:
            assert "keel_connect_github" not in {t.name for t in (await session.list_tools()).tools}
    assert mcp_server.tool_level("keel_connect_github") == "admin"
