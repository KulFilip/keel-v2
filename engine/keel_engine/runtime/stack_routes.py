"""The engine routes of a project's own stacks (keel 0.18.9, runtime/stack_edit.py). Only the api calls them, with keel's
internal token; each takes the project's folder as the engine sees it (`root`).

    GET  /stacks/suggest?root=&lane=          what keel reads in the project's files for a new stack
    POST /stacks/render {form}                the New stack form as a stack YAML
    POST /stacks/check {root?, yaml?, form?, replace?}   errors and warnings, the review, the YAML; saves nothing
    POST /stacks/save {root, yaml, replace?, source?, market?}   .keel/stacks/<name>.yml after the check
    POST /stacks/remove {root, name}          the project's own stack (its file or its pack folder)
    POST /stacks/off {root, name, off}        turn a stack off (or on) for the project (.keel/config.yml)
    GET  /stacks/installed?root=              .keel/stacks/.installed.json (marketplace installs)
"""

from __future__ import annotations

import asyncio
import os
from typing import Any

from fastapi import APIRouter
from pydantic import BaseModel

from . import stack_edit, stack_setup
from .service import EngineError

router = APIRouter()


def _root(root: str | None) -> str:
    if not root or not os.path.isdir(root):
        raise EngineError(400, f"The project folder {root} does not exist.", "Send the folder as the engine sees it.")
    return os.path.realpath(root)


class FormBody(BaseModel):
    form: dict[str, Any]


class CheckBody(BaseModel):
    root: str | None = None
    yaml: str | None = None
    form: dict[str, Any] | None = None
    replace: bool = False


class SaveBody(BaseModel):
    root: str
    yaml: str
    replace: bool = False
    source: str = "project"
    market: dict[str, Any] | None = None


class NameBody(BaseModel):
    root: str
    name: str


class OffBody(BaseModel):
    root: str
    name: str
    off: bool = True


@router.get("/stacks/suggest")
async def get_suggest(root: str, lane: str | None = None):
    return await asyncio.to_thread(stack_edit.suggest, _root(root), lane or None)


@router.post("/stacks/render")
async def post_render(body: FormBody):
    return {"yaml": stack_edit.render(body.form)}


@router.post("/stacks/check")
async def post_check(body: CheckBody):
    text = stack_edit.render(body.form) if body.form is not None else (body.yaml or "")
    out = await asyncio.to_thread(stack_edit.check, _root(body.root) if body.root else None, text, body.replace)
    return {**out, "yaml": text}


@router.post("/stacks/save")
async def post_save(body: SaveBody):
    if body.source not in ("project", "keelbot", "marketplace"):
        raise EngineError(400, f"source {body.source!r} is not project, keelbot or marketplace.")
    out = await asyncio.to_thread(stack_edit.save, _root(body.root), body.yaml, body.replace, body.source, body.market)
    stack_setup.SYSTEM.request(_root(body.root))     # keel 0.18.22 its setup.apt may have changed
    return out


@router.post("/stacks/remove")
async def post_remove(body: NameBody):
    out = await asyncio.to_thread(stack_edit.remove, _root(body.root), body.name)
    stack_setup.SYSTEM.request(_root(body.root))     # keel 0.18.22 its setup.apt may have changed
    return out


@router.post("/stacks/off")
async def post_off(body: OffBody):
    out = await asyncio.to_thread(stack_edit.set_off, _root(body.root), body.name, body.off)
    stack_setup.SYSTEM.request(_root(body.root))     # keel 0.18.22 its setup.apt may have changed
    return out


@router.get("/stacks/installed")
async def get_installed(root: str):
    return await asyncio.to_thread(stack_edit.installed, _root(root))
