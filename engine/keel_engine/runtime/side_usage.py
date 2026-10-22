"""Tokens a flow's side agents spent for it outside its graph (the Supervisor plugin's turns).

The graph's state.usage holds only the flow's own agent calls. A side agent that works for a flow records its use
here, and the flow's token and dollar caps count it (Compiler._budget): the "Token cap reached" gate comes on time.

    record(thread_id, source, usage)   usage: {tokens_in, tokens_out, tokens_cached, cost_usd}; budget_tokens counts it
    total(thread_id) -> {"tokens": int, "cost_usd": float}
    of_source(thread_id, source) -> the same, for one source
"""

from __future__ import annotations

import logging

from . import db

log = logging.getLogger(__name__)


def _tokens(usage: dict) -> int:
    # the same weights as compiler.budget_tokens (a tenth of cache reads); not imported: the compiler imports this module
    return int(usage.get("tokens_in", 0)) + int(usage.get("tokens_out", 0)) + int(usage.get("tokens_cached", 0)) // 10


def record(thread_id: str, source: str, usage: dict) -> int:
    tokens = _tokens(usage)
    with db.connect() as conn:
        conn.execute("insert into side_usage (thread_id, source, tokens, cost_usd, at) values (?,?,?,?,?)",
                     (thread_id, source, tokens, float(usage.get("cost_usd") or 0.0), db.now()))
    return tokens


def _sum(sql: str, args: tuple) -> dict:
    try:
        with db.connect() as conn:
            row = conn.execute(sql, args).fetchone()
    except Exception:      # the cap check must never fail on its ledger
        log.exception("side usage unreadable")
        return {"tokens": 0, "cost_usd": 0.0}
    return {"tokens": int(row[0] or 0), "cost_usd": float(row[1] or 0.0)}


def total(thread_id: str) -> dict:
    return _sum("select sum(tokens), sum(cost_usd) from side_usage where thread_id = ?", (thread_id,))


def of_source(thread_id: str, source: str) -> dict:
    return _sum("select sum(tokens), sum(cost_usd) from side_usage where thread_id = ? and source = ?", (thread_id, source))
