"""Which files hold the database: migrations by framework, whole-schema files, ORM mappings, and the reader for each.

    kind_of(path, text=None) -> (kind, role) | None
        kind: sql, doctrine, laravel, alembic, django, rails, typeorm, liquibase-xml, liquibase-yaml, prisma, entity
        role: migration (applied in order), schema (the whole schema at once), mapping (an ORM class: not read)
    read(kind, path, text) -> list[Op]
    order_key(path) -> a sort key that puts migrations in the order they run
"""

from __future__ import annotations

import re

from . import othermig, php, pymig, sql
from .ops import Op

MIG_DIRS = {"migration", "migrations", "migrate", "changelog", "changelogs", "versions", "flyway", "liquibase"}
TEST_DIRS = {"test", "tests", "__tests__", "testdata", "test-data", "fixtures", "spec", "specs", "e2e", "testing"}
SKIP_DIRS = {"node_modules", "vendor", ".git", "build", "dist", "target", ".venv", "venv", "__pycache__", ".gradle"}


def _parts(path: str) -> list[str]:
    return [p.lower() for p in path.split("/")[:-1]]


def in_tests(path: str) -> bool:
    return any(p in TEST_DIRS for p in _parts(path)) or bool(re.search(r"(^|/)src/test/", path))


def kind_of(path: str, text: str | None = None) -> tuple[str, str] | None:
    parts = _parts(path)
    if any(p in SKIP_DIRS for p in parts):
        return None
    base = path.rsplit("/", 1)[-1]
    low = base.lower()
    in_mig = any(p in MIG_DIRS for p in parts)
    ext = low.rsplit(".", 1)[-1] if "." in low else ""
    if low in ("schema.prisma",):
        return "prisma", "schema"
    if ext == "sql":
        if re.match(r"u\d", low) and "__" in low or low.endswith((".down.sql", "_down.sql")) or low.startswith("down"):
            return None                                                  # undo scripts
        if low in ("schema.sql", "structure.sql", "init.sql", "ddl.sql"):
            return "sql", "schema"
        if in_mig or re.match(r"^[vr]\d*[\d._]*__.+\.sql$", low) or re.match(r"^\d{3,}[-_.]", low):
            return "sql", "migration"
        return None
    if ext == "php":
        if re.match(r"^version\d+\.php$", low) or (text and "extends AbstractMigration" in text):
            return "doctrine", "migration"
        if ("database/migrations" in path) or (in_mig and text and re.search(r"Schema::(create|table)\(", text)):
            return "laravel", "migration"
        if text and re.search(r"#\[ORM\\(Entity|Table)|@ORM\\(Entity|Table)", text):
            return "entity", "mapping"
        return None
    if ext == "py":
        if in_mig and re.match(r"^\d{4}_\w+\.py$", low) and (text is None or "migrations.Migration" in text):
            return "django", "migration"
        if ("versions" in parts or "alembic" in parts) and (text is None or "from alembic import op" in text or "op." in text):
            return "alembic", "migration"
        if text and ("from alembic import op" in text and "def upgrade" in text):
            return "alembic", "migration"
        if text and (re.search(r"class \w+\((models\.Model|Base|db\.Model|DeclarativeBase)\)", text) and
                     ("__tablename__" in text or "models.Model" in text)):
            return "entity", "mapping"
        return None
    if ext == "rb":
        if "db/migrate" in path or (in_mig and re.match(r"^\d+_\w+\.rb$", low)):
            return "rails", "migration"
        if path.endswith("db/schema.rb"):
            return "rails", "schema"
        return None
    if ext in ("ts", "js", "mjs", "cjs"):
        if in_mig and (text is None or re.search(r"MigrationInterface|exports\.up|function\s+up|async\s+up\s*\(", text)):
            return "typeorm", "migration"
        if text and re.search(r"@Entity\s*\(", text) and ext == "ts":
            return "entity", "mapping"
        return None
    if ext in ("xml", "yaml", "yml") and ("changelog" in low or "changelog" in "/".join(parts) or "liquibase" in "/".join(parts)):
        if text is None or "databaseChangeLog" in text:
            return ("liquibase-xml" if ext == "xml" else "liquibase-yaml"), "migration"
        return None
    if ext in ("java", "kt") and text and re.search(r"@(jakarta\.persistence\.|javax\.persistence\.)?Entity\b", text):
        return "entity", "mapping"
    if ext == "cs" and text and re.search(r"\[Table\(|: DbContext\b", text):
        return "entity", "mapping"
    return None


def django_app(path: str) -> str:
    parts = path.split("/")
    i = len(parts) - 1
    while i > 0 and parts[i - 1] != "migrations":
        i -= 1
    return parts[i - 2] if i >= 2 else "app"


def read(kind: str, path: str, text: str) -> list[Op]:
    if kind == "sql":
        return sql.parse(text)
    if kind == "doctrine":
        return php.doctrine(text)
    if kind == "laravel":
        return php.laravel(text)
    if kind == "alembic":
        return pymig.alembic(text)
    if kind == "django":
        return pymig.django(text, django_app(path))
    if kind == "rails":
        return othermig.rails(text)
    if kind == "typeorm":
        return othermig.js_sql(text)
    if kind == "liquibase-xml":
        return othermig.liquibase_xml(text)
    if kind == "liquibase-yaml":
        return othermig.liquibase_yaml(text)
    if kind == "prisma":
        return othermig.prisma(text)
    return []


FRAMEWORK = {"sql": "SQL", "doctrine": "Doctrine", "laravel": "Laravel", "alembic": "Alembic", "django": "Django",
             "rails": "Rails", "typeorm": "TypeORM / Knex", "liquibase-xml": "Liquibase", "liquibase-yaml": "Liquibase",
             "prisma": "Prisma", "entity": "ORM mapping"}


def _natural(s: str):
    return [int(x) if x.isdigit() else x.lower() for x in re.split(r"(\d+)", s)]


def order_key(path: str):
    """Flyway V1_2__ by version (R__ repeatables last), timestamps and numbers by value, else by name."""
    base = path.rsplit("/", 1)[-1]
    m = re.match(r"^[Vv]([\d._]+)__", base)
    if m:
        return (0, [int(x) for x in re.split(r"[._]", m.group(1)) if x.isdigit()], base)
    if re.match(r"^[Rr]__", base):
        return (2, [], base)
    return (1, _natural(base), path)


def alembic_order(files: list[tuple[str, str]]) -> list[tuple[str, str]]:
    """Alembic's chain: down_revision -> revision, from the first; files outside the chain at the end by name."""
    rev: dict[str, tuple[str, str]] = {}
    down: dict[str, str | None] = {}
    for path, text in files:
        r = re.search(r"^revision\s*(?::\s*\w+\s*)?=\s*['\"]([\w-]+)['\"]", text, re.M)
        d = re.search(r"^down_revision\s*(?::[^=]*)?=\s*(None|['\"]([\w-]+)['\"])", text, re.M)
        if r:
            rev[r.group(1)] = (path, text)
            down[r.group(1)] = d.group(2) if d and d.group(2) else None
    if not rev:
        return sorted(files, key=lambda f: order_key(f[0]))
    children: dict[str | None, list[str]] = {}
    for r, d in down.items():
        children.setdefault(d, []).append(r)
    out, seen = [], set()
    queue = sorted(children.get(None, []))
    while queue:
        r = queue.pop(0)
        if r in seen:
            continue
        seen.add(r)
        out.append(rev[r])
        queue.extend(sorted(children.get(r, [])))
    rest = [f for f in files if f not in out]
    return out + sorted(rest, key=lambda f: order_key(f[0]))
