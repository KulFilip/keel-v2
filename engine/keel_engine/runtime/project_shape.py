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



# ------------------------------------------------------------------ the hunt's lens fit (B11)

DB_DEPS = ("sqlalchemy", "psycopg", "psycopg2", "psycopg2-binary", "asyncpg", "pymysql", "mysqlclient", "peewee",
           "tortoise-orm", "alembic", "prisma", "@prisma/client", "typeorm", "sequelize", "mongoose", "mongodb", "knex",
           "drizzle-orm", "pg", "mysql2", "better-sqlite3", "spring-boot-starter-data-jpa", "spring-boot-starter-jdbc",
           "spring-data-jpa", "hibernate-core", "exposed-core", "jooq", "flyway-core", "liquibase-core",
           "gorm.io/gorm", "github.com/jackc/pgx", "github.com/lib/pq", "diesel", "sqlx", "sea-orm", "activerecord",
           "doctrine/orm", "doctrine/dbal", "Microsoft.EntityFrameworkCore")
AUTH_DEPS = ("passport", "jsonwebtoken", "jose", "next-auth", "@auth/core", "pyjwt", "authlib", "python-jose",
             "django-allauth", "flask-login", "spring-boot-starter-security", "spring-security-core",
             "spring-boot-starter-oauth2-resource-server", "devise", "bcrypt", "argon2-cffi", "golang-jwt", "jjwt-api",
             "lexik/jwt-authentication-bundle", "symfony/security-bundle")
MESSAGING_DEPS = ("kafkajs", "amqplib", "bullmq", "bull", "nats", "pika", "aio-pika", "celery", "kombu",
                  "confluent-kafka", "kafka-python", "spring-kafka", "spring-boot-starter-amqp", "spring-rabbit",
                  "github.com/segmentio/kafka-go", "github.com/rabbitmq/amqp091-go", "lapin", "rdkafka", "sidekiq",
                  "symfony/messenger", "@aws-sdk/client-sqs", "@google-cloud/pubsub")
MIGRATION_DIRS = ("migrations", "db/migrate", "db/migration", "alembic", "flyway", "prisma/migrations")
AUTH_PATH = re.compile(r"(^|/)(auth|security|login|oauth|session)s?(/|\.|_)", re.I)
CONCURRENT = re.compile(r"\b(threading|ThreadPoolExecutor|multiprocessing|asyncio\.gather|asyncio\.create_task|"
                        r"Promise\.all|worker_threads|synchronized|ReentrantLock|ExecutorService|CompletableFuture|"
                        r"@Async|launch\s*\{|async\s*\{|Mutex|RwLock|sync\.WaitGroup|go func|tokio::spawn|"
                        r"std::thread)")
CODE_EXT = (".kt", ".java", ".scala", ".ts", ".tsx", ".js", ".jsx", ".mjs", ".vue", ".svelte", ".py", ".php", ".go",
            ".rs", ".rb", ".ex", ".cs", ".swift", ".dart")
SMALL = 30           # a project with at most this many source files is small: only the lenses its code calls for


def signals(root: str) -> dict:
    """What the hunt's default lenses depend on: source files (count), http (and why), web, db, auth, concurrency,
    messaging, contract. Each value says why when it is set, so the lens gate can show it."""
    from . import stacks

    r = Path(root)
    cfg = rules.load_config(root)
    files = tracked_files(r)
    code = [f for f in files if f.endswith(CODE_EXT) and not any(p in SKIP for p in Path(f).parts)]
    http, why_http = ui_or_http(root)
    out: dict = {"files": len(code), "http": why_http if http else None,
                 "web": "it has a web layer" if stacks.web_layer(root, cfg) else None}
    db = deps_named(r, DB_DEPS)
    mig = next((d for d in MIGRATION_DIRS if any(f.startswith(d + "/") or f"/{d}/" in f"/{f}" for f in files)), None)
    out["db"] = f"{db[1]} names {db[0]}" if db else (f"it has {mig}/" if mig else None)
    auth = deps_named(r, AUTH_DEPS)
    path = next((f for f in code if AUTH_PATH.search(f)), None)
    out["auth"] = f"{auth[1]} names {auth[0]}" if auth else (f"{path} looks like auth code" if path else None)
    msg = deps_named(r, MESSAGING_DEPS)
    out["messaging"] = f"{msg[1]} names {msg[0]}" if msg else None
    contract = str((cfg.get("contract") or {}).get("file") or "").strip().lstrip("/")
    out["contract"] = contract if contract and ".." not in Path(contract).parts and (r / contract).is_file() else None
    conc = None
    for f in [f for f in code if "test" not in f.lower()][:400]:
        m = CONCURRENT.search(_text(r / f, 200_000))
        if m:
            conc = f"{f} uses {m.group(1).strip()}"
            break
    out["concurrency"] = conc
    return out
