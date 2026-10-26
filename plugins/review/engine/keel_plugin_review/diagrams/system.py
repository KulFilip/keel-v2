"""The System tab: the parts of the system a change touches and how data moves between them, from the changed files'
paths and text (no model). The Map plugin's modules, when the project has a map, name the areas and count the parts the
change leaves alone.

    build(files, texts, db_tables, map_modules=None, all_paths=None) -> {nodes, edges, groups, externals, collapsed, source}

A node is a changed file (or, in a big change, the changed files of one layer in one area), with its layer: http,
consumer, cron, command, publisher, client, service, repository, model, migration, config, infra, ui, code. Edges come
from the code itself (a file that names another changed file's class uses it), then from the layer order inside an
area when the code says nothing; outside systems (the database, queues and topics, HTTP hosts, the scheduler, incoming
HTTP) come from what the files say.
"""

from __future__ import annotations

import re

from .detect import in_tests, kind_of
from .sql import DDL_IN_CODE

PER_FILE_MAX = 24
LAYER_ORDER = ["http", "consumer", "cron", "command", "ui", "service", "publisher", "client", "repository", "model", "migration",
               "config", "infra", "code"]
LAYER_WORD = {"http": "HTTP handler", "consumer": "message consumer", "cron": "scheduled job", "command": "command",
              "publisher": "publisher", "client": "HTTP client", "service": "service", "repository": "repository",
              "model": "model", "migration": "migration", "config": "config", "infra": "infra", "ui": "UI", "code": "code"}
GENERIC = {
    "src", "main", "java", "kotlin", "scala", "groovy", "php", "python", "py", "ts", "js", "lib", "libs", "app", "apps", "pkg",
    "internal", "cmd", "source", "sources", "http", "web", "api", "server", "core", "modules", "module", "packages", "package",
    "domain", "application", "infrastructure", "infra", "adapter", "adapters", "presentation", "ui", "components", "component",
    "pages", "page", "views", "view", "controllers", "controller", "handlers", "handler", "consumers", "consumer", "listeners",
    "listener", "subscribers", "subscriber", "commands", "command", "console", "jobs", "job", "cron", "scheduler", "schedule",
    "tasks", "task", "repositories", "repository", "repo", "repos", "dao", "daos", "entity", "entities", "model", "models",
    "migrations", "migration", "db", "database", "config", "configs", "conf", "resources", "messenger", "messagehandler",
    "messagehandlers", "eventlistener", "eventsubscriber", "service", "services", "kernel", "message", "messages", "events", "event",
    "dto", "dtos", "mapper", "mappers", "util", "utils", "common", "shared", "routes", "router", "endpoints", "rest", "graphql",
    "clients", "client", "gateway", "gateways", "integration", "integrations", "producers", "producer", "publishers", "publisher",
    "usecase", "usecases", "port", "ports", "impl", "store", "stores", "providers", "provider", "support", "base", "features",
    "feature", "backend", "frontend", "server", "services", "test", "tests", "spec", "specs", "hooks", "store",
}
PKG_ROOTS = {"com", "org", "net", "io", "de", "nl", "uk", "fr", "eu", "dev", "be", "se", "no", "dk", "ch", "at", "it", "es"}
SUFFIX = re.compile(r"(Controller|Resource|Endpoint|Handler|Consumer|Listener|Subscriber|Command|Cron|Job|Task|Scheduler|"
                    r"Publisher|Producer|Dispatcher|Emitter|Sender|Client|Gateway|Service|UseCase|Manager|Processor|"
                    r"Repository|Repo|Dao|Store|Entity|Model|Dto|Test|Tests|Spec|Request|Response|Event|Message|Factory|"
                    r"Router|Routes|Api|View|Page|Component|Provider|Policy|Mapper)+$")
SKIP_EXT = {"md", "txt", "rst", "adoc", "png", "jpg", "jpeg", "gif", "svg", "ico", "lock", "sum", "snap", "map", "woff", "woff2", "ttf", "pdf"}
SKIP_NAMES = {"package-lock.json", "yarn.lock", "pnpm-lock.yaml", "composer.lock", "poetry.lock", "uv.lock", "go.sum",
              "cargo.lock", "gemfile.lock", ".gitignore", "license", "changelog.md", "readme.md"}
CONFIG_NAME = re.compile(r"(^|/)(application[\w.-]*\.(ya?ml|properties)|settings\.py|config\.(ya?ml|json|toml|php|ts|js)|"
                         r"\.env[\w.-]*|messenger\.ya?ml|services\.ya?ml|[\w.-]+\.(ini|toml|properties|conf))$", re.I)
INFRA = re.compile(r"(^|/)(dockerfile[\w.-]*|docker-compose[\w.-]*\.ya?ml|compose[\w.-]*\.ya?ml|makefile|jenkinsfile|"
                   r"\.gitlab-ci\.ya?ml|\.github/workflows/[^/]+|(k8s|kubernetes|helm|charts|terraform|deploy|ops)/.+)$", re.I)

SIGNALS = [
    ("consumer", re.compile(r"@KafkaListener|@RabbitListener|@SqsListener|@JmsListener|#\[AsMessageHandler|"
                            r"MessageHandlerInterface|@EventPattern|@MessagePattern|@Subscribe\b|@Consumer\b|\.subscribe\(|"
                            r"implements\s+ShouldQueue|@celery\.task|@shared_task|basic_consume|consumer\.poll")),
    ("cron", re.compile(r"@Scheduled\b|#\[AsCronTask|#\[AsPeriodicTask|->cron\(|->everyMinute\(|->hourly\(|->daily\(|@Cron\(|"
                        r"cron\.schedule\(|crontab\(|@periodic_task|schedule\.every\(")),
]
NAME_LAYER = [
    ("consumer", re.compile(r"(Consumer|Listener|Subscriber|MessageHandler)$")),
    ("cron", re.compile(r"(Cron|CronJob|Scheduler|Scheduled\w*|Job)$")),
    ("publisher", re.compile(r"(Publisher|Producer|Dispatcher|Emitter|Sender|Outbox)$")),
    ("http", re.compile(r"(Controller|Resource|Endpoint|Routes?|Router|Api|ApiHandler|Views?)$")),
    ("command", re.compile(r"(Command|Cli|ConsoleCommand)$")),
    ("client", re.compile(r"(Client|Gateway|ApiClient|HttpClient|Connector)$")),
    ("repository", re.compile(r"(Repository|Repo|Dao|Store|Queries)$")),
    ("service", re.compile(r"(Service|UseCase|Manager|Processor|Handler|Calculator|Policy|Interactor|Facade)$")),
    ("model", re.compile(r"(Entity|Model|Record|Aggregate)$")),
]
CONTENT_LAYER = [
    ("http", re.compile(r"@RestController|@Controller\b|@(Get|Post|Put|Patch|Delete|Request)Mapping|#\[Route\(|Route::(get|post|put|patch|delete)|"
                        r"@(app|router|bp|api)\.(get|post|put|patch|delete|route)\(|app\.(get|post|put|patch|delete)\(\s*['\"]/")),
    ("publisher", re.compile(r"kafkaTemplate\.send|rabbitTemplate\.convertAndSend|->dispatch\(\s*new|MessageBusInterface|"
                             r"producer\.(send|produce)\(|\.publish\(|basic_publish|sqs\.send_message|SendMessageCommand")),
    ("command", re.compile(r"#\[AsCommand|extends\s+Command\b|@click\.command|argparse\.ArgumentParser|@Command\(")),
    ("client", re.compile(r"HttpClientInterface|RestTemplate|WebClient|GuzzleHttp|requests\.(get|post|put)|httpx\.|axios\.|"
                          r"Http::(get|post|put)|HttpClient\.newHttpClient|fetch\(\s*['\"`]https?:")),
    ("repository", re.compile(r"ServiceEntityRepository|JpaRepository|CrudRepository|@Repository\b|EntityManager|"
                              r"createQueryBuilder|\bSELECT\b[\s\S]{0,200}\bFROM\b|session\.query\(|\.objects\.(filter|get|create)")),
    ("model", re.compile(r"@Entity\b|#\[ORM\\Entity|models\.Model\b|__tablename__")),
]
TOPIC = [
    re.compile(r"@KafkaListener\(\s*(?:id\s*=\s*\"[^\"]*\"\s*,\s*)?topics?\s*=\s*\{?\s*\"([\w.\-:]+)\""),
    re.compile(r"@RabbitListener\(\s*queues?\s*=\s*\{?\s*\"([\w.\-:]+)\""),
    re.compile(r"\b(?:topic|topics|queue|queues|queue_name|queueName|exchange|routing_key|routingKey|channel|stream)\s*[:=]\s*\[?\s*['\"]([A-Za-z][\w.\-:]{2,})['\"]"),
    re.compile(r"(?:onQueue|send|publish|convertAndSend|subscribe)\(\s*['\"]([a-z][\w\-]*(?:[.:][\w\-]+)+)['\"]"),
]
URL = re.compile(r"https?://([a-z0-9][a-z0-9.\-]*\.[a-z]{2,})(?::\d+)?", re.I)
URL_KEY = re.compile(r"\b([A-Z][A-Z0-9_]*_(?:URL|URI|HOST|ENDPOINT|BASE_URL|API))\b")
IGNORED_HOSTS = re.compile(r"(^|\.)(w3\.org|xmlns\.com|schemas?\.\w+|json-schema\.org|localhost|example\.org|apache\.org|"
                           r"springframework\.org|symfony\.com|php\.net|python\.org|mozilla\.org|github\.com|githubusercontent\.com|"
                           r"googleapis\.com/auth|opensource\.org|semver\.org|keepachangelog\.com|schema\.org|ietf\.org)$", re.I)


def _stem(path: str) -> str:
    base = path.rsplit("/", 1)[-1]
    return base.split(".")[0] if not base.startswith(".") else base


def _singular(w: str) -> str:
    if w.endswith("ies") and len(w) > 4:
        return w[:-3] + "y"
    if w.endswith("s") and not w.endswith("ss") and len(w) > 3:
        return w[:-1]
    return w


def _title(w: str) -> str:
    w = re.sub(r"[_\-]+", " ", w).strip()
    return " ".join(p[:1].upper() + p[1:] for p in w.split()) if w else w


def area_of(path: str, layer: str, modules: list[str] | None = None) -> str:
    if layer == "migration":
        return "Database"
    if layer == "config":
        return "Config"
    if layer == "infra":
        return "Infra"
    parts = path.split("/")[:-1]
    i = 0
    while i < len(parts):
        p = parts[i]
        low = p.lower()
        if low in PKG_ROOTS and i + 1 < len(parts):
            i += 2
            continue
        if low not in GENERIC and not low.startswith(".") and not re.fullmatch(r"v\d+", low):
            if modules and p in modules and i == 0 and len(parts) > 1:
                i += 1
                continue
            return _title(_singular(p))
        i += 1
    stem = SUFFIX.sub("", _stem(path)) or _stem(path)
    stem = re.sub(r"^(test_|create_|add_|update_)", "", stem)
    first = re.split(r"(?<=[a-z0-9])(?=[A-Z])|_|-", stem)[0] if stem else stem
    return _title(_singular(first)) or "Code"


def layer_of(path: str, text: str | None) -> str | None:
    low = path.lower()
    base = low.rsplit("/", 1)[-1]
    ext = base.rsplit(".", 1)[-1] if "." in base else ""
    if base in SKIP_NAMES or ext in SKIP_EXT:
        return None
    if in_tests(path) or re.search(r"(test|tests|spec)\.\w+$|^test_|_test\.\w+$|\.test\.\w+$|\.spec\.\w+$", base):
        return "test"
    k = kind_of(path, text)
    if k:
        return "migration" if k[1] in ("migration", "schema") else "model"
    if INFRA.search(path):
        return "infra"
    if CONFIG_NAME.search(path) or (ext in ("yml", "yaml", "properties", "toml", "ini", "env") and "/" in path):
        return "config"
    if ext in ("tsx", "jsx", "vue", "svelte", "css", "scss", "html", "twig", "blade", "erb", "hbs"):
        return "ui"
    stem = _stem(path)
    t = text or ""
    for layer, rx in SIGNALS:
        if rx.search(t):
            return layer
    for layer, rx in NAME_LAYER:
        if rx.search(stem):
            return layer
    for layer, rx in CONTENT_LAYER:
        if rx.search(t):
            return layer
    if ext in ("json",):
        return "config"
    return "code"


def topics_in(text: str) -> list[str]:
    out: list[str] = []
    for rx in TOPIC:
        for m in rx.finditer(text or ""):
            name = m.group(1)
            if name.lower() in ("default", "true", "false", "null", "none", "sync", "async") or "/" in name:
                continue
            if name not in out:
                out.append(name)
    return out[:6]


def hosts_in(text: str) -> list[str]:
    out = []
    for m in URL.finditer(text or ""):
        h = m.group(1).lower()
        if IGNORED_HOSTS.search(h) or h.startswith(("127.", "0.0.")):
            continue
        if h not in out:
            out.append(h)
    return out[:4]


def _status(s: str) -> str:
    return {"A": "added", "D": "removed", "R": "changed", "C": "added"}.get((s or "M")[:1], "changed")


def build(files: list[dict], texts: dict[str, str | None], db_tables: list[str], map_modules: list[dict] | None = None,
          all_paths: list[str] | None = None, config_texts: dict[str, str] | None = None) -> dict:
    module_names = [m.get("name") for m in map_modules or [] if m.get("name")]
    parts: list[dict] = []
    skipped = 0
    tests = 0
    for f in files:
        path = f["path"]
        text = texts.get(path)
        layer = layer_of(path, text)
        if layer is None:
            skipped += 1
            continue
        if layer == "test":
            tests += 1
            continue
        parts.append({"path": path, "layer": layer, "status": _status(f.get("status", "M")), "text": text or "",
                      "area": area_of(path, layer, module_names), "stem": _stem(path)})
    per_file = len([p for p in parts if p["layer"] not in ("config", "infra")]) <= PER_FILE_MAX
    nodes: dict[str, dict] = {}
    by_path: dict[str, str] = {}
    for p in parts:
        if per_file or p["layer"] in ("migration",):
            nid = "n_" + re.sub(r"\W", "_", p["path"])
            label = p["stem"]
        else:
            nid = "g_" + re.sub(r"\W", "_", f"{p['area']}_{p['layer']}")
            label = LAYER_WORD[p["layer"]]
        n = nodes.setdefault(nid, {"id": nid, "label": label, "layer": p["layer"], "area": p["area"], "files": [], "status": p["status"]})
        n["files"].append(p["path"])
        if n["status"] != p["status"]:
            n["status"] = "changed"
        by_path[p["path"]] = nid
    for n in nodes.values():
        if len(n["files"]) > 1 and n["id"].startswith("g_"):
            n["label"] = f"{LAYER_WORD[n['layer']]} ×{len(n['files'])}"
    # many migrations: one node
    migs = [n for n in nodes.values() if n["layer"] == "migration"]
    if len(migs) > 4:
        keep = {"id": "g_db_migrations", "label": f"migrations ×{len(migs)}", "layer": "migration", "area": "Database",
                "files": [f for n in migs for f in n["files"]], "status": "changed"}
        for n in migs:
            del nodes[n["id"]]
            for fp in n["files"]:
                by_path[fp] = keep["id"]
        nodes[keep["id"]] = keep

    edges: dict[tuple[str, str], dict] = {}

    def edge(a: str, b: str, label: str = "", kind: str = "code"):
        if a != b and (a, b) not in edges:
            edges[(a, b)] = {"from": a, "to": b, "label": label, "kind": kind}

    # 1. the code: a file that names another changed file's class uses it
    stems = {p["stem"]: by_path[p["path"]] for p in parts if len(p["stem"]) >= 4 and p["layer"] not in ("migration", "config", "infra")}
    for p in parts:
        if p["layer"] in ("migration", "config", "infra"):
            continue
        for stem, nid in stems.items():
            if nid == by_path[p["path"]]:
                continue
            if re.search(rf"\b{re.escape(stem)}\b", p["text"]):
                edge(by_path[p["path"]], nid)
    # 2. the layer order inside an area, where the code said nothing
    rank = {name: i for i, name in enumerate(["http", "consumer", "cron", "command", "ui", "service", "publisher", "client",
                                               "repository"])}
    by_area: dict[str, list[dict]] = {}
    for n in nodes.values():
        by_area.setdefault(n["area"], []).append(n)
    linked = {e["from"] for e in edges.values()} | {e["to"] for e in edges.values()}
    for area, ns in by_area.items():
        chain = sorted((n for n in ns if n["layer"] in rank), key=lambda n: rank[n["layer"]])
        for a, b in zip(chain, chain[1:]):
            if a["layer"] == b["layer"]:
                continue
            if a["id"] in linked and b["id"] in linked:
                continue
            edge(a["id"], b["id"], "", "guess")

    # 3. outside systems
    externals: dict[str, dict] = {}

    def ext(eid: str, label: str, kind: str, detail: str = "") -> str:
        e = externals.setdefault(eid, {"id": eid, "label": label, "kind": kind, "detail": detail, "files": []})
        return eid

    layers = {n["layer"] for n in nodes.values()}
    ddl = {by_path[p["path"]] for p in parts if p["layer"] not in ("migration", "config") and DDL_IN_CODE.search(p["text"])}
    if db_tables or ddl or layers & {"repository", "migration", "model"}:
        ext("x_db", "Database", "db", ", ".join(db_tables[:6]) + (f" +{len(db_tables) - 6}" if len(db_tables) > 6 else ""))
        for n in nodes.values():
            if n["layer"] == "repository":
                edge(n["id"], "x_db", "reads / writes", "data")
            elif n["layer"] == "migration":
                edge(n["id"], "x_db", "changes the schema", "data")
            elif n["layer"] == "model":
                edge(n["id"], "x_db", "maps a table", "data")
            elif n["id"] in ddl:
                edge(n["id"], "x_db", "changes the schema", "data")
    for n in nodes.values():
        if n["layer"] == "http":
            edge(ext("x_http_in", "HTTP request", "http-in"), n["id"], "", "data")
        if n["layer"] == "cron":
            edge(ext("x_cron", "Scheduler", "cron"), n["id"], "on a schedule", "data")
        if n["layer"] == "command":
            edge(ext("x_cli", "CLI", "cli"), n["id"], "", "data")
        text = "\n".join(p["text"] for p in parts if by_path[p["path"]] == n["id"])
        for t in topics_in(text):
            qid = ext("x_q_" + re.sub(r"\W", "_", t), t, "queue")
            externals[qid]["files"].append(n["files"][0])
            if n["layer"] == "config":
                edge(n["id"], qid, "defines", "guess")
            elif n["layer"] == "consumer" or re.search(r"Listener\(|#\[AsMessageHandler|subscribe\(|consume", text):
                edge(qid, n["id"], "message", "data")
            else:
                edge(n["id"], qid, "message", "data")
        if n["layer"] in ("client", "service", "publisher", "consumer", "cron", "command", "http", "code"):
            for h in hosts_in(text):
                hid = ext("x_h_" + re.sub(r"\W", "_", h), h, "http-out")
                externals[hid]["files"].append(n["files"][0])
                edge(n["id"], hid, "HTTP", "data")
    # config: queues and hosts named there, linked when a changed part names the same
    for path, text in (config_texts or {}).items():
        for t in topics_in(text):
            qid = "x_q_" + re.sub(r"\W", "_", t)
            if qid in externals:
                externals[qid]["detail"] = externals[qid]["detail"] or f"in {path}"
        for key in URL_KEY.findall(text or ""):
            users = [n for n in nodes.values() if n["layer"] in ("client", "service", "code")
                     and key in "\n".join(p["text"] for p in parts if by_path[p["path"]] == n["id"])]
            for n in users:
                hid = ext("x_h_" + key.lower(), key, "http-out", f"set in {path}")
                edge(n["id"], hid, "HTTP", "data")

    groups: dict[str, dict] = {}
    for n in nodes.values():
        g = groups.setdefault(n["area"], {"id": "a_" + re.sub(r"\W", "_", n["area"]), "title": n["area"], "nodes": []})
        g["nodes"].append(n["id"])
    for g in groups.values():
        g["nodes"].sort(key=lambda nid: (LAYER_ORDER.index(nodes[nid]["layer"]), nodes[nid]["label"]))
    collapsed = None
    touched = {p["path"].split("/")[0] for p in parts}
    if module_names:
        rest = [m for m in module_names if m.split("/")[0] not in touched and m != "(root)"]
        if rest:
            collapsed = {"id": "x_rest", "label": f"{len(rest)} other module{'s' if len(rest) != 1 else ''} (unchanged)", "names": rest[:20]}
    elif all_paths:
        tops = sorted({p.split("/")[0] for p in all_paths if "/" in p and not p.startswith(".")} - touched)
        if tops:
            collapsed = {"id": "x_rest", "label": f"{len(tops)} other folder{'s' if len(tops) != 1 else ''} (unchanged)", "names": tops[:20]}
    return {
        "source": "map" if module_names else "paths",
        "nodes": sorted(nodes.values(), key=lambda n: (n["area"], LAYER_ORDER.index(n["layer"]), n["label"])),
        "edges": list(edges.values()),
        "groups": sorted(groups.values(), key=lambda g: (g["title"] in ("Config", "Infra", "Database"), g["title"])),
        "externals": list(externals.values()),
        "collapsed": collapsed,
        "tests": tests,
        "skipped": skipped,
        "per_file": per_file,
    }
