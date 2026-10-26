"""What kind of project this is, from its files (0.18.57): a web UI, an HTTP server, or neither (a library, a CLI).

    ui_or_http(root)  (yes, why): a frontend (stacks.has_web_layer), an HTTP server framework in a dependency manifest,
                      a server entry point (manage.py, artisan, bin/console, a Go file that serves net/http), an API
                      contract file, or a health check / e2e command in .keel/config.yml. No: an end-to-end test has
                      nothing to drive, so an e2e step is skipped (compiler._skipped) instead of writing e2e/ into a
                      library.

The stack packs' `detect` blocks are not used here: they say which language a project is in (the django pack matches
any pyproject.toml), not whether it serves anything. The answer is kept for a minute per root.
"""

from __future__ import annotations

import json
import re
from pathlib import Path

from .. import rules
from ..tools import git

# HTTP server frameworks, by the name a dependency manifest gives them
HTTP_DEPS = (
    # node
    "express", "fastify", "@nestjs/core", "koa", "hono", "@hapi/hapi", "next", "nuxt", "@remix-run/node",
    "@sveltejs/kit", "restify", "h3", "elysia", "@adonisjs/core",
    # python
    "fastapi", "flask", "django", "starlette", "aiohttp", "tornado", "sanic", "litestar", "falcon", "bottle",
    "pyramid", "quart", "djangorestframework",
    # jvm
    "spring-boot-starter-web", "spring-boot-starter-webflux", "spring-webmvc", "spring-webflux", "ktor-server-core",
    "ktor-server-netty", "micronaut-http-server", "quarkus-rest", "quarkus-resteasy", "javalin", "vertx-web",
    "dropwizard-core", "http4k-server",
    # go
    "github.com/gin-gonic/gin", "github.com/labstack/echo", "github.com/gofiber/fiber", "github.com/go-chi/chi",
    "github.com/gorilla/mux", "github.com/julienschmidt/httprouter",
    # rust, ruby, php, .NET
    "actix-web", "axum", "rocket", "warp", "poem", "rails", "sinatra", "hanami", "grape", "roda",
    "laravel/framework", "symfony/http-kernel", "symfony/framework-bundle", "slim/slim", "cakephp/cakephp",
    "Microsoft.AspNetCore",
)
# a text manifest names its dependencies in these files (package.json and composer.json are read as JSON)
TEXT_MANIFESTS = ("pyproject.toml", "setup.py", "setup.cfg", "Pipfile", "build.gradle", "build.gradle.kts", "pom.xml",
                  "go.mod", "Cargo.toml", "Gemfile")
JSON_MANIFESTS = ("package.json", "composer.json")
SERVER_FILES = ("manage.py", "artisan", "bin/console", "Procfile")
CONFIG_KEYS = ("api_health_check", "web_health_check", "e2e")
GO_SERVES = re.compile(r"\bhttp\.(ListenAndServe|HandleFunc|NewServeMux|Handle)\b")
SKIP = {"node_modules", "build", ".git", ".venv", "venv", "dist", "target", ".gradle", "vendor", "__pycache__"}


def _dirs(root: Path) -> list[Path]:
    """The root and one folder down (a monorepo's apps), as stack detection looks."""
    try:
        kids = sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".") and p.name not in SKIP)
    except OSError:
        kids = []
    return [root, *kids]


def _text(f: Path, limit: int = 400_000) -> str:
    try:
        return f.read_text(errors="replace")[:limit] if f.is_file() else ""
    except OSError:
        return ""


def _json_deps(f: Path) -> set[str]:
    try:
        doc = json.loads(f.read_text()) if f.is_file() else {}
    except (OSError, ValueError):
        return set()
    if not isinstance(doc, dict):
        return set()
    return {str(k) for key in ("dependencies", "devDependencies", "require", "require-dev")
            for k in (doc.get(key) or {}) if isinstance(doc.get(key), dict)}


def _named(text: str, names: tuple[str, ...]) -> str | None:
    """The first of `names` a manifest's text names as a word of its own (flask, not flask-like-helper)."""
    for n in names:
        if re.search(rf"(?<![\w.@/-]){re.escape(n)}(?![\w-])", text, re.I):
            return n
    return None


def deps_named(root: str | Path, names: tuple[str, ...]) -> tuple[str, str] | None:
    """(dependency, manifest) for the first dependency of `names` a manifest in the root or one folder down names."""
    r = Path(root)
    for d in _dirs(r):
        for m in JSON_MANIFESTS:
            hit = next((n for n in names if n in _json_deps(d / m)), None)
            if hit:
                return hit, str((d / m).relative_to(r))
        for m in (*TEXT_MANIFESTS, "requirements.txt", "requirements-dev.txt"):
            hit = _named(_text(d / m), names)
            if hit:
                return hit, str((d / m).relative_to(r))
        for f in sorted(d.glob("*.csproj"))[:5]:
            hit = _named(_text(f), names)
            if hit:
                return hit, str(f.relative_to(r))
    return None


def tracked_files(root: str | Path) -> list[str]:
    """The project's tracked files (git ls-files); [] when it is not a git repository."""
    r = git.git(str(root), "ls-files")
    return [f for f in r.stdout.splitlines() if f.strip()] if r.returncode == 0 else []


def _go_serves(root: Path, files: list[str], budget: int = 400) -> str | None:
    for f in [f for f in files if f.endswith(".go") and not f.endswith("_test.go")][:budget]:
        if GO_SERVES.search(_text(root / f, 200_000)):
            return f
    return None


def _http_layer(root: str, cfg: dict) -> str | None:
    """Why the project has an HTTP layer (or a web UI), None when nothing says so."""
    from . import stacks

    r = Path(root)
    cmds = cfg.get("commands") or {}
    key = next((k for k in CONFIG_KEYS if str(cmds.get(k) or "").strip()), None)
    if key:
        return f"commands.{key} is set in .keel/config.yml"
    if stacks.web_layer(root, cfg):
        return "it has a web layer (a frontend or a web test command)"
    hit = deps_named(r, HTTP_DEPS)
    if hit:
        return f"{hit[1]} names {hit[0]}"
    for d in _dirs(r):
        for name in SERVER_FILES:
            if (d / name).is_file():
                return f"{(d / name).relative_to(r)} starts a server"
    contract = str((cfg.get("contract") or {}).get("file") or "").strip().lstrip("/")
    if contract and ".." not in Path(contract).parts and (r / contract).is_file():
        return f"it has an API contract ({contract})"
    go = _go_serves(r, tracked_files(r))
    if go:
        return f"{go} serves HTTP"
    return None


def ui_or_http(root: str | None) -> tuple[bool, str]:
    """(yes, why): does the project have a UI or an HTTP layer an end-to-end test could drive? Yes when it cannot
    tell (no root): keel never drops a step on a guess."""
    if not root or not Path(root).is_dir():
        return True, "the project folder is not readable here"
    why = _http_layer(root, rules.load_config(root))
    return (True, why) if why else (False, "no frontend, no HTTP server framework, no API contract and no e2e command")

