"""The Git plugin's engine routes: the person's own git calls (Code › Git, KeelBot's button). A PluginError or GitError
becomes a 4xx answer (the app maps the part's errors).

pr_status is the one exception: when GitHub did not answer (a transient GitError, after core's one retry) it answers
200 {pr: null, error: {message, hint, transient: true}}, so Source control can say "try again" instead of an error."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from keel_engine.extensions import PartError as PluginError

from . import core as g
from .core import github_token

router = APIRouter()


class PluginGit(BaseModel):
    """The person's own git call (Code › Git, KeelBot's button)."""
    root: str
    keys: dict[str, str] = Field(default_factory=dict)        # github: the token
    settings: dict[str, Any] = Field(default_factory=dict)    # commit_author, commit_coauthor
    branch: str = ""
    create: bool = False
    message: str = ""
    title: str = ""
    body: str = ""
    draft: bool = False
    stash: bool = False          # keel 0.18.9 switch: stash the folder's changes first
    path: str = ""
    sha: str = ""


def _pr_status(root: str, token: str | None) -> dict:
    try:
        return {"pr": g.pr_status(root, token)}
    except g.GitError as exc:
        if not exc.transient:
            raise
        return {"pr": None, "error": {"message": str(exc), "hint": exc.hint, "transient": True}}


@router.post("/plugins/git/{op}")
async def post_plugin_git(op: str, body: PluginGit):
    if not os.path.isdir(body.root):
        raise PluginError(404, "The project folder is gone.")
    token = github_token(body.keys)
    calls = {
        "status": lambda: g.status(body.root),
        "branches": lambda: g.branches(body.root),
        "log": lambda: g.log(body.root, 30),
        # keel 0.18.3 the uncommitted diff (keel TUI's /git diff): one file with path, else all of it
        "diff": lambda: {"diff": g.diff(body.root, body.path or None)},
        "switch": lambda: g.switch(body.root, body.branch, body.create, body.stash),
        "commit": lambda: g.commit(body.root, body.message, body.settings),
        "sync": lambda: g.sync(body.root, token),
        "push": lambda: g.push(body.root, token),
        "pr": lambda: g.pr(body.root, token, body.title, body.body, body.draft),
        "pr_status": lambda: _pr_status(body.root, token),
        "cleanup": lambda: g.cleanup(body.root),
    }
    if op not in calls:
        raise PluginError(404, f"Unknown git call {op}.")
    return await asyncio.to_thread(calls[op])
