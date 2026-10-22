"""One UTC timestamp format for the whole engine: 2026-01-02T03:04:05Z."""
from __future__ import annotations

from datetime import datetime, timezone


def utc_iso() -> str:
    return datetime.now(timezone.utc).isoformat(timespec="seconds").replace("+00:00", "Z")
