"""The Code Review plugin's engine route: the overview's diagrams (Database, System) for one review, from git alone.
The api (ReviewDiagramsService) calls it with the review's two commits and its changed files, and keeps the answer per
head commit."""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel, Field

from keel_engine.extensions import PartError

from . import diagrams

router = APIRouter()


class DiagramsBody(BaseModel):
    root: str
    base: str
    head: str
    files: list[dict[str, Any]] = Field(default_factory=list)
    live: dict[str, Any] | None = None          # the Database plugin's schema (read only), when the project has one
    live_name: str | None = None


@router.post("/plugins/review/{pid}/diagrams")
async def post_diagrams(pid: str, body: DiagramsBody):
    if not os.path.isdir(body.root):
        raise PartError(400, f"The project folder {body.root} does not exist.", "Send the folder as the engine sees it.")
    try:
        return await asyncio.to_thread(diagrams.build, os.path.realpath(body.root), body.base, body.head, body.files,
                                       body.live, body.live_name, pid)
    except ValueError as exc:
        raise PartError(400, str(exc), "Send the review's base and head commits.") from exc
