"""Shared pieces of the keel MCP server that every mcp_* module needs (kept free of imports from them)."""
from __future__ import annotations

from urllib.parse import quote


def q(x: str) -> str:
    """URL-encode one path segment."""
    return quote(str(x), safe="")
