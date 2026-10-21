"""An engine without KEEL_INTERNAL_TOKEN refuses its routes (tests and local development open it on purpose)."""

from __future__ import annotations


def test_without_a_token_the_engine_refuses_unless_it_was_opened_on_purpose(client, monkeypatch):
    monkeypatch.delenv("KEEL_ENGINE_OPEN", raising=False)
    monkeypatch.delenv("KEEL_INTERNAL_TOKEN", raising=False)
    assert client.get("/health").status_code == 200
    for path in ("/templates", "/mcp/tools"):
        r = client.get(path)
        assert r.status_code == 401, path
        assert "KEEL_INTERNAL_TOKEN" in r.text
    r = client.post("/mcp/tools", json={})
    assert r.status_code == 401


def test_the_open_flag_serves_without_a_token(client, monkeypatch):
    monkeypatch.setenv("KEEL_ENGINE_OPEN", "1")
    monkeypatch.delenv("KEEL_INTERNAL_TOKEN", raising=False)
    assert client.get("/templates").status_code != 401


def test_with_a_token_only_the_right_header_passes(client, monkeypatch):
    monkeypatch.setenv("KEEL_ENGINE_OPEN", "1")        # the flag never beats a set token
    monkeypatch.setenv("KEEL_INTERNAL_TOKEN", "t0k3n")
    assert client.get("/templates").status_code == 401
    assert client.get("/templates", headers={"X-Keel-Token": "wrong"}).status_code == 401
    assert client.get("/templates", headers={"X-Keel-Token": "t0k3n"}).status_code != 401
