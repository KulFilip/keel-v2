"""keel's rules (first ported from keel v1), as data plus small functions.

The tables live in `data/keel_rules.json` (the api reads a byte-identical copy). Keeping them as data
means a golden test can compare them one to one, and the functions below carry the behaviour that
the tables alone do not express.
"""

from __future__ import annotations

import copy
import json
import re
from dataclasses import dataclass, field
from functools import lru_cache
from pathlib import Path
from typing import Any


_DATA = json.loads((Path(__file__).parent / "data" / "keel_rules.json").read_text())

PHASES: list[str] = _DATA["PHASES"]
TRANSITIONS: dict[str, list[str]] = _DATA["TRANSITIONS"]
LADDER: list[str] = _DATA["LADDER"]
RAILS: dict[str, list[str]] = _DATA["RAILS"]
MATRIX: dict[str, dict[str, str]] = _DATA["MATRIX"]
COMMIT_RULES: dict[str, dict[str, Any]] = _DATA["COMMIT_RULES"]
FLOW_START: dict[str, str] = _DATA["FLOW_START"]
EMPTY_STATE: dict[str, Any] = _DATA["EMPTY"]
RED_ACCEPT: list[str] = _DATA["red_accept"]
RED_REJECT: list[str] = _DATA["red_reject"]

# A phase without a MATRIX row fails closed (keel v1 learned this the hard way: falling back to
# allow-all disabled every guard for a newly added phase).
CLOSED = {"other": "allow", "*": "deny"}

ALWAYS_DENY = {
    "protected-env": "holds secrets. Ask the user to change it.",
    "generated": "is generated. Change the source and rerun codegen.",
    "keel-rules": "holds keel's rules for this project. Agents never change their own rules; the person does (Rules page).",
}

# The project's rule files: an agent that could edit them could switch off the guard that judges it.
RULE_FILES = [re.compile(r"^\.keel/config\.ya?ml$"), re.compile(r"^\.keel/rules/")]

LANE_OF = {"api-main": "api", "api-test": "api", "migration": "api", "web-src": "web", "web-test": "web"}
LANE_SCOPED_PHASES = {"red", "green"}

# Files a `setup` commit may carry (keel v1 SETUP_PATHS).
SETUP_PATHS = [re.compile(p) for p in (r"^\.keel/", r"^docs/RUNNING\.md$", r"^docs/knowledge/", r"^CLAUDE\.md$", r"^\.gitignore$")]
MEMORY_PATHS = [re.compile(r"^docs/knowledge/"), re.compile(r"^\.keel/")]

# keel v1 config defaults that the rules read.
DEFAULT_CONFIG: dict[str, Any] = {
    "backend": {"dir": "apps/api", "build": "./gradlew", "migrations": "src/main/resources/db/migration", "schema_snapshot": ""},
    "frontend": {"dir": "apps/web", "package_manager": "pnpm", "generated": "src/api/generated"},
    "contract": {"file": "contracts/openapi.yaml"},
    "e2e": {"dir": "e2e", "web_url": "http://localhost:5173", "api_url": "http://localhost:8080"},
    "smoke": {"dir": "smoke", "max_seconds": 60},
    "specs": {"dir": "specs"},
    "commands": {},
    "loops": {"red_accept": RED_ACCEPT, "red_reject": RED_REJECT, "stall_repeats": 3},
    "gates": {"mode": "every-ac", "bug_gates": True},
    "change": {"max_inline_acs": 3, "must_escalate": ["contract", "migration", "auth"], "size_limits_files": 10,
               "size_limits_lines": 300, "auth_paths": ["**/security/**", "**/auth/**"]},
    "commit": {"author_name": "", "author_email": ""},   # empty: runtime/actions.py commit_ident decides
    "guards": {
        "protected": ["**/.env", "**/.env.*", "!**/.env.example"],
        "generated": ["**/generated/**", "**/build/generated/**"],
        "read_block": ["**/build/**", "**/node_modules/**", "**/playwright-report/**", "**/target/**"],
        "bash_deny_always": ["git push --force", "git push -f", "--no-verify", "-x test", "-x check"],
        "bash_deny_in_flow": ["git commit", "git reset --hard", "git rebase -i"],
        # keel v1 guards.read_guard_max_lines: a whole-file read of a bigger file is refused (offset/limit pass); 0 = off
        "read_guard_max_lines": 2000,
    },
    # keel's own switches (Rules page): `off` names built-in rules (BUILTINS, only can_off ones) or `pack/<id>`;
    # the push gate refuses an agent's push while push_blockers reports something (keel v1 gates.pushBlockers).
    "rules": {"off": [], "push_gate": True, "push_gate_commands": ["git push", "gh pr create"]},
    "mcp": {"allow": []},
}

# What a project's config cannot take away: these always run, whatever guards.bash_deny_* say.
NEVER_DENY_ALWAYS = ["git push --force", "git push -f", "--no-verify"]
NEVER_DENY_IN_FLOW = ["git reset --hard", "git rebase -i"]
SKIP_TEST_FLAGS = ["-x test", "-x check"]

# keel's built-in rules as the Rules page lists them. can_off: the project may switch it off (rules.off); the others
# protect secrets, history or keel's own record and stay on (docs/plans/0.17.2.md decision 6).
BUILTINS: list[dict] = [
    {"id": "phase-matrix", "kind": "edit", "phases": "in a flow", "can_off": False,
     "words": "Each phase lets agents change only some kinds of files: tests in RED, code in GREEN, nothing in a review."},
    {"id": "env-files", "kind": "edit, read, shell", "phases": "always", "can_off": False,
     "words": ".env files hold secrets: agents never read, print or change them (setup may write the env file)."},
    {"id": "keel-rules-files", "kind": "edit", "phases": "always", "can_off": False,
     "words": "Agents never change .keel/config.yml or .keel/rules/: an agent may not change its own rules."},
    {"id": "migrations-immutable", "kind": "edit", "phases": "always", "can_off": False,
     "words": "An existing database migration is never changed; a new migration file is added instead."},
    {"id": "force-push", "kind": "shell", "phases": "always", "can_off": False,
     "words": "git push --force and git push -f are refused: they can delete other people's work."},
    {"id": "no-verify", "kind": "shell", "phases": "always", "can_off": False,
     "words": "--no-verify is refused: it skips the checks keel relies on."},
    {"id": "commit-in-flow", "kind": "shell", "phases": "in a flow", "can_off": False,
     "words": "In a flow keel makes every commit after its checks; an agent's own git commit is refused."},
    {"id": "history-rewrite", "kind": "shell", "phases": "in a flow", "can_off": False,
     "words": "git reset --hard and git rebase -i are refused in a flow: they throw work away."},
    {"id": "secrets-at-write", "kind": "edit", "phases": "always", "can_off": False,
     "words": "An edit that adds what looks like a secret (a key, a token, a password) is refused before it is written."},
    {"id": "disabled-tests", "kind": "edit", "phases": "always", "can_off": False,
     "words": "A test may not be switched off: skip, only, @Disabled, xit and the like are refused in test files."},
    {"id": "generated", "kind": "edit", "phases": "always", "can_off": True,
     "words": "Generated files are not edited by hand: change the source and run the generator."},
    {"id": "read-build-output", "kind": "read", "phases": "always", "can_off": True,
     "words": "Build output (build/, node_modules/, target/ ...) is not read: it wastes the agent's context."},
    {"id": "skip-test-flags", "kind": "shell", "phases": "always", "can_off": True,
     "words": "-x test and -x check are refused: they skip the tests in a Gradle build."},
    {"id": "new-dependency", "kind": "shell", "phases": "in a flow", "can_off": True,
     "words": "Installing a new package is a decision for the spec and a gate, not for an agent."},
    {"id": "read-twice", "kind": "read", "phases": "always", "can_off": True,
     "words": "Reading the same unchanged file twice in one step is refused: the agent already has it."},
    {"id": "big-file-read", "kind": "read", "phases": "always", "can_off": True,
     "words": "A big file (more lines than read_guard_max_lines) is read in parts, with offset and limit."},
    {"id": "push-gate", "kind": "shell", "phases": "always", "can_off": True,
     "words": "An agent's git push or gh pr create is refused while keel's push blockers say the branch is not ready."},
    {"id": "mcp-writes", "kind": "mcp", "phases": "in a flow", "can_off": True,
     "words": "In a flow, an MCP tool that can change things runs only when mcp.allow names it."},
]
BUILTIN_IDS = {b["id"] for b in BUILTINS}
CAN_OFF = {b["id"] for b in BUILTINS if b["can_off"]}


def is_off(cfg: dict | None, rule_id: str) -> bool:
    """Is a built-in rule (or `pack/<id>`) switched off in the project's `rules.off`? A never-off rule never is."""
    off = ((cfg or {}).get("rules") or {}).get("off") or []
    if rule_id in BUILTIN_IDS and rule_id not in CAN_OFF:
        return False
    return rule_id in off


def _merge(base: dict, over: dict) -> dict:
    out = copy.deepcopy(base)
    for k, v in (over or {}).items():
        if isinstance(v, dict) and isinstance(out.get(k), dict):
            out[k] = _merge(out[k], v)
        else:
            out[k] = v
    return out


def make_config(overrides: dict | None = None) -> dict:
    return _merge(DEFAULT_CONFIG, overrides or {})


def load_config(root: str | Path | None) -> dict:
    """The project's `.keel/config.yml` merged over keel's defaults (defaults when absent), with its layout applied:
    `layout` and `paths` (keel_engine/layout.py), `specs.dir` the folder new specs go to and `specs.dirs` every spec
    folder the guard protects (a mixed project has .keel/specs and docs/specs)."""
    if not root:
        return make_config()
    from .. import layout

    data = layout.raw_config(root)
    cfg = make_config(data)
    cfg["configured"] = (Path(root) / ".keel" / "config.yml").is_file()
    cfg["packs"], cfg["pack_errors"] = load_packs(root)
    lay = layout.resolve(root, data)
    cfg["layout"] = lay.name
    cfg["paths"] = {"specs": lay.specs, "knowledge": lay.knowledge, "adr": lay.adr, "runbook": lay.runbook,
                    "claude": lay.claude}
    cfg["specs"] = {**cfg["specs"], "dir": lay.specs, "dirs": list(lay.spec_dirs)}
    return cfg


# ---------------------------------------------------------------- phases

def read_only(phase: str | None) -> bool:
    """A phase in which nothing may be edited (review)."""
    row = MATRIX.get(phase or "")
    return bool(row) and set(row.values()) == {"deny"}


def can_transition(frm: str, to: str) -> bool:
    if frm == to:
        return True
    return to in TRANSITIONS.get(frm, [])


# ---------------------------------------------------------------- classify

@lru_cache(maxsize=256)
def glob2re(pattern: str) -> re.Pattern:
    out, i = "", 0
    while i < len(pattern):
        c = pattern[i]
        if c == "*":
            if i + 1 < len(pattern) and pattern[i + 1] == "*":
                out += ".*"
                i += 1
                if i + 1 < len(pattern) and pattern[i + 1] == "/":
                    i += 1
            else:
                out += "[^/]*"
        elif c == "?":
            out += "[^/]"
        elif c in ".+^${}()|[]\\":
            out += "\\" + c
        else:
            out += c
        i += 1
    return re.compile("^" + out + "$")


def match_glob(file: str, patterns: list[str]) -> bool:
    f = re.sub(r"^\./", "", str(file))
    for p in patterns or []:
        if p.startswith("!"):
            continue
        if glob2re(p).match(f) or glob2re(p).match("/" + f):
            return True
    return False


def negated(file: str, patterns: list[str]) -> bool:
    f = re.sub(r"^\./", "", str(file))
    return any(p.startswith("!") and glob2re(p[1:]).match(f) for p in patterns or [])


_TEST_PATH = [
    re.compile(r"(^|/)(test|tests|__tests__|spec)/"),
    re.compile(r"(^|/)test_[^/]+\.py$"),
    re.compile(r"_test\.(py|go|rb|exs?)$"),
    re.compile(r"_spec\.rb$"),
    re.compile(r"\.(test|spec)\.(ts|tsx|js|jsx)$"),
    re.compile(r"Test\.(kt|java|php)$"),
    re.compile(r"Tests\.(kt|java)$"),
    re.compile(r"(^|/)src/test/"),
    re.compile(r"(^|/)src/integrationTest/"),
]


def _rel(path: str, root: str | None = None) -> str:
    p = str(path)
    if root and Path(p).is_absolute():
        try:
            p = str(Path(p).resolve().relative_to(Path(root).resolve()))
        except ValueError:
            pass
    return re.sub(r"^\./", "", p.replace("\\", "/"))


def classify(cfg: dict | None, path: str) -> str:
    """Which bucket a repo-relative file belongs to (keel v1 guards.classify)."""
    cfg = cfg if cfg and "guards" in cfg else make_config(cfg)
    rel = _rel(path, cfg.get("root"))

    def in_dir(d: str | None) -> bool:
        if not d:
            return False
        d = d.rstrip("/")
        return rel == d or rel.startswith(d + "/")

    is_test = any(r.search(rel) for r in _TEST_PATH)
    guards = cfg["guards"]
    if match_glob(rel, guards["protected"]) and not negated(rel, guards["protected"]):
        return "protected-env"
    if any(r.search(rel) for r in RULE_FILES):
        return "keel-rules"
    if match_glob(rel, guards["generated"]) and not is_off(cfg, "generated"):
        return "generated"
    if cfg["contract"].get("file") and rel == cfg["contract"]["file"]:
        return "contract"
    if re.search(r"openapi\.(ya?ml|json)$", rel):
        return "contract"
    if in_dir(cfg["specs"].get("dir")) or any(in_dir(d) for d in cfg["specs"].get("dirs") or []):
        return "specs"
    if in_dir(cfg["e2e"].get("dir")):
        return "e2e"
    if in_dir(cfg["smoke"].get("dir")):
        return "smoke"
    if in_dir(cfg["backend"].get("dir")):
        if cfg["backend"].get("migrations") and cfg["backend"]["migrations"] in rel:
            return "migration"
        return "api-test" if is_test else "api-main"
    if in_dir(cfg["frontend"].get("dir")):
        return "web-test" if is_test else "web-src"
    if re.search(r"(^|/)db/migration/", rel):
        return "migration"
    # Outside the configured folders, decide by the kind of file: a project that never ran init (or is not laid out
    # like apps/api + apps/web) must still have its production code protected. keel v1 called all of it "other".
    name = rel.rsplit("/", 1)[-1].lower()
    ext = "." + name.rsplit(".", 1)[-1] if "." in name else ""
    if TOOL_CONFIG.search(name):
        return "api-test" if is_test else "other"
    if ext in WEB_EXT:
        return "web-test" if is_test else "web-src"
    if is_test:
        return "api-test"
    if ext in CODE_EXT:
        return "api-main"
    return "other"


# Source files by extension (production code unless the path says test); UI files go to the web buckets.
CODE_EXT = {".js", ".mjs", ".cjs", ".ts", ".mts", ".cts", ".py", ".go", ".rs", ".java", ".kt", ".scala", ".groovy", ".rb",
            ".php", ".cs", ".fs", ".vb", ".swift", ".m", ".mm", ".c", ".cc", ".cpp", ".cxx", ".h", ".hpp", ".ex", ".exs",
            ".erl", ".clj", ".dart", ".lua", ".r", ".jl", ".sol", ".zig", ".nim", ".ml", ".hs", ".elm"}
WEB_EXT = {".tsx", ".jsx", ".vue", ".svelte", ".astro", ".css", ".scss", ".sass", ".less", ".html", ".htm"}
# Build and tool configuration is not production code (vite.config.ts, build.gradle.kts, eslint.config.js ...).
TOOL_CONFIG = re.compile(r"(^|\.)(config|conf|rc)\.(js|mjs|cjs|ts|mts|cts)$|^(build|settings)\.gradle(\.kts)?$|"
                         r"^(setup|conftest|manage|noxfile|fabfile)\.py$|^\.?(eslint|prettier|babel|jest|vite|vitest|"
                         r"webpack|rollup|tailwind|postcss|playwright|tsconfig)")


# ---------------------------------------------------------------- edit guard

@dataclass
class Verdict:
    ok: bool
    bucket: str = ""
    reason: str = ""
    note: str = ""
    path: str = ""      # the file a shell write targeted, when a command was refused for it


def _hint(phase: str, bucket: str) -> str:
    if phase == "red" and bucket in ("api-main", "web-src"):
        return " Write the failing test first; production code belongs to GREEN."
    if phase == "green" and bucket in ("api-test", "web-test"):
        return " Tests are frozen in GREEN. If the test itself is wrong, reject at the gate and go back to RED."
    if phase == "bug-investigate":
        return " Production code is locked until Gate F is approved."
    if phase.startswith("hunt-"):
        return " A hunt proves findings; it never fixes them."
    if bucket == "contract":
        return " Contract changes belong to the contract phase."
    return ""


def edits_code(phase: str) -> bool:
    """Does this phase let an agent change more than notes (a bucket besides "other" not denied)? Gate phases do not."""
    return any(rule != "deny" for bucket, rule in MATRIX.get(phase, CLOSED).items() if bucket not in ("other", "*"))


def unlocked(unlocks: list[dict] | None, rel: str, phase: str) -> bool:
    """keel v1: an unlock {path, phase} lets exactly that path bypass the matrix in that phase."""
    return any(_rel(u.get("path", "")) == rel and u.get("phase") == phase for u in unlocks or [])


def check_edit(phase: str, path: str, cfg: dict | None = None, *, exists: bool = False,
               lane: str | None = None, flow_active: bool = True, unlocks: list[dict] | None = None) -> Verdict:
    """May a file be written in this phase? `exists` = the file is already there (for new-only rules)."""
    cfg = cfg if cfg and "guards" in cfg else make_config(cfg)
    bucket = classify(cfg, path)
    rel = _rel(path, cfg.get("root"))
    env_file = str(cfg.get("setup", {}).get("env_file") or ".env.local").removeprefix("./")
    if bucket == "protected-env" and rel == env_file and phase == "setup":
        return Verdict(True, bucket, note="setup may write the env file")
    if bucket == "keel-rules" and phase == "setup" and RULE_FILES[0].search(rel):
        return Verdict(True, bucket, note="setup writes .keel/config.yml")
    if bucket in ALWAYS_DENY:
        return Verdict(False, bucket, f"{rel} {ALWAYS_DENY[bucket]}")
    if bucket == "migration" and exists:
        return Verdict(False, bucket, f"{rel} is an existing migration and is immutable. Add a new migration file instead.")
    if unlocked(unlocks, rel, phase):
        return Verdict(True, bucket, note="unlocked")
    v = pack_verdict(cfg, "edit", phase, rel, lane)
    if v:
        return Verdict(False, bucket, v.reason)
    if not flow_active or phase in (None, "", "none"):
        return Verdict(True, bucket)
    rules = MATRIX.get(phase, CLOSED)
    rule = rules.get(bucket) or rules.get("*") or "deny"
    if phase in LANE_SCOPED_PHASES and lane and LANE_OF.get(bucket) and LANE_OF[bucket] != lane and rule != "deny":
        return Verdict(False, bucket, f'{rel}: this is the "{lane}" lane, so {bucket} is out of scope in phase "{phase}".')
    if rule == "allow":
        return Verdict(True, bucket)
    if rule == "new-only":
        if not exists:
            return Verdict(True, bucket)
        return Verdict(False, bucket, f'{rel}: in phase "{phase}" only new {bucket} files may be created, not edits to existing ones.')
    if rule == "delete-only":
        if not exists:
            return Verdict(False, bucket, f'{rel}: phase "{phase}" may only delete unreachable lines from existing files, not create new ones.')
        return Verdict(True, bucket, note="delete-only: removals are allowed, additions are refused at commit")
    return Verdict(False, bucket, f'{rel}: editing {bucket} is blocked in phase "{phase}".{_hint(phase, bucket)}')


def check_read(path: str, cfg: dict | None = None, *, full: str | Path | None = None, ranged: bool = False,
               phase: str | None = None) -> Verdict:
    """May a file be read? `full`: the file on disk, for the big-file rule; `ranged`: the read names offset or limit."""
    cfg = cfg if cfg and "guards" in cfg else make_config(cfg)
    bucket = classify(cfg, path)
    rel = _rel(path, cfg.get("root"))
    if bucket == "protected-env":
        return Verdict(False, bucket, f"Reading {rel} is blocked so secrets stay out of the conversation.")
    if match_glob(rel, cfg["guards"]["read_block"]) and not is_off(cfg, "read-build-output"):
        return Verdict(False, bucket, f"{rel} is build output; reading it wastes context. Read the source instead.")
    v = pack_verdict(cfg, "read", phase, rel)
    if v:
        return Verdict(False, bucket, v.reason)
    n = too_long(cfg, full) if full is not None and not ranged else 0
    if n:
        return Verdict(False, bucket, f"{rel} has {n} lines (more than read_guard_max_lines "
                                      f"{cfg['guards'].get('read_guard_max_lines')}). Read the part you need with offset and "
                                      "limit, or search it (grep) first.")
    return Verdict(True, bucket)


def too_long(cfg: dict, full: str | Path) -> int:
    """The file's line count when it is over guards.read_guard_max_lines (0 = off, or rule big-file-read off), else 0."""
    try:
        limit = int((cfg.get("guards") or {}).get("read_guard_max_lines") or 0)
    except (TypeError, ValueError):
        return 0
    if limit <= 0 or is_off(cfg, "big-file-read"):
        return 0
    try:
        p = Path(full)
        if not p.is_file() or p.stat().st_size > 64 * 1024 * 1024:
            return 0
        with p.open("rb") as f:
            n = sum(chunk.count(b"\n") for chunk in iter(lambda: f.read(1 << 20), b""))
    except OSError:
        return 0
    return n if n > limit else 0


# ---------------------------------------------------------------- per-agent knowledge (strict mode)

# The knowledge base sections an agent can be given (docs/knowledge/<section>.md, or .keel/knowledge/ in a keel or
# external layout). index.md is not a section.
KNOWLEDGE_SECTIONS = ["architecture", "domain", "conventions", "data", "integrations", "journeys"]
_KNOWLEDGE_FILE = re.compile(r"(?:^|[/\s'\"])(?:docs|\.keel)/knowledge/(" + "|".join(KNOWLEDGE_SECTIONS) + r")\.md\b")


def check_knowledge(path_or_command: str, agent: str, allowed: list[str] | None, strict: bool) -> Verdict:
    """Strict mode: an agent may not read a knowledge section it was not given. Not strict, it is only told."""
    if not strict or allowed is None:
        return Verdict(True)
    for m in _KNOWLEDGE_FILE.finditer(str(path_or_command or "").replace("\\", "/")):
        if m.group(1) not in allowed:
            return Verdict(False, "knowledge", f"knowledge section {m.group(1)} is not given to {agent or 'this agent'} (strict)")
    return Verdict(True)


# ---------------------------------------------------------------- shell guard

_ENV_PRINTERS = {"cat", "less", "more", "head", "tail", "grep", "egrep", "fgrep", "bat", "xxd", "od", "strings", "awk", "nl"}


def _bare(w: str) -> str:
    return re.sub(r"[^A-Za-z0-9_./-]+$", "", re.sub(r"^[^A-Za-z0-9_./-]+", "", w))


def prints_env_file(command: str) -> str | None:
    for segment in re.split(r"[\n;]|&&|\|\||\|", str(command or "")):
        words = segment.split()
        for i, w in enumerate(words):
            if re.sub(r"^.*/", "", _bare(w)) not in _ENV_PRINTERS:
                continue
            if i + 1 < len(words) and _bare(words[i + 1]).startswith("<<"):
                continue
            for arg in words[i + 1:]:
                a = _bare(arg)
                if a.startswith("<<"):
                    break
                m = re.search(r"(?:^|/)(\.env(?:\.[A-Za-z0-9_-]+)?)$", a)
                if m and m.group(1) != ".env.example":
                    return m.group(1)
    return None


_FLAGS_WITH_VALUE = {"--prefix", "--registry", "--workspace", "-w", "--filter", "-C", "--directory", "--cwd",
                     "-r", "--requirement", "--index-url", "--extra-index-url", "-t", "--target", "--python"}


def adds_dependency(cmd: str) -> str | None:
    bare = re.sub(r"\"[^\"]*\"|'[^']*'", " ", str(cmd))
    for m in re.finditer(r"\b(npm|pnpm|yarn|bun|pip|pip3|poetry|gem|cargo|go|uv)\b([^&|;]*)", bare):
        words = (m.group(2) or "").split()
        at = next((i for i, w in enumerate(words) if w in ("install", "i", "add", "get")), -1)
        if at == -1:
            continue
        rest = words[at + 1:]
        i = 0
        while i < len(rest):
            a = rest[i]
            if a in _FLAGS_WITH_VALUE:
                i += 2
                continue
            if a.startswith("-") or a.startswith(("./", "../", "/", "~")) or a == "." or \
                    re.search(r"\.(txt|lock|json|toml|cfg|ini)$", a):
                i += 1
                continue
            return a
    return None


def runs_command(cmd: str, command: str) -> bool:
    """Does a shell line run `command` (its words in order, at the start of a segment)? `keel prune` is not `keel pr`."""
    words = str(command or "").split()
    if not words:
        return False
    rx = r"(?:^|[;&|(]|\bthen|\bdo)\s*(?:\S+=\S+\s+)*" + r"\s+".join(re.escape(w) for w in words) + r"(?=\s|$|[;&|)])"
    return bool(re.search(rx, str(cmd)))


def push_gate(cfg: dict, cmd: str, blockers: list[dict] | None) -> Verdict | None:
    """keel v1 H10/H17: a push or a PR while push_blockers reports something. Only in a project that adopted keel."""
    r = cfg.get("rules") or {}
    if not blockers or not cfg.get("configured") or r.get("push_gate") is False or is_off(cfg, "push-gate"):
        return None
    hit = next((c for c in r.get("push_gate_commands") or [] if runs_command(cmd, c)), None)
    if not hit:
        return None
    first = blockers[0]
    more = f" ({len(blockers) - 1} more: {', '.join(b.get('gate', '') for b in blockers[1:])})" if len(blockers) > 1 else ""
    return Verdict(False, reason=f'"{hit}" waits for keel\'s push gate: {first.get("gate")}: {first.get("why")}. '
                                 f'{str(first.get("fix") or "").rstrip(".")}.{more}')


def check_bash(phase: str, command: str, cfg: dict | None = None, *, root: str | None = None,
               exists=lambda rel: False, unlocks: list[dict] | None = None,
               push_blockers: list[dict] | None = None) -> Verdict:
    cfg = cfg if cfg and "guards" in cfg else make_config(cfg)
    cmd = str(command or "")
    skip_flags = is_off(cfg, "skip-test-flags")
    for pat in NEVER_DENY_ALWAYS + [p for p in cfg["guards"]["bash_deny_always"] if p not in NEVER_DENY_ALWAYS]:
        if skip_flags and pat in SKIP_TEST_FLAGS:
            continue
        if pat in cmd:
            return Verdict(False, reason=f'"{pat}" is not allowed: it skips checks that keel relies on.')
    env = prints_env_file(cmd)
    if env:
        return Verdict(False, reason=f"Printing {env} would put secrets in the conversation.")
    v = pack_verdict(cfg, "bash", phase, cmd)
    if v:
        return v
    v = push_gate(cfg, cmd, push_blockers)
    if v:
        return v
    if phase in (None, "", "none"):
        return Verdict(True)
    if re.search(r"^\s*git\s+commit\b", cmd) or re.search(r"&&\s*git\s+commit\b", cmd):
        return Verdict(False, reason=f'Commits are made by the engine\'s commit step, which checks them against phase "{phase}".')
    for pat in NEVER_DENY_IN_FLOW + [p for p in cfg["guards"]["bash_deny_in_flow"] if p not in NEVER_DENY_IN_FLOW]:
        if pat in cmd:
            return Verdict(False, reason=f'"{pat}" is blocked during a keel flow.')
    dep = None if is_off(cfg, "new-dependency") else adds_dependency(cmd)
    if dep:
        return Verdict(False, reason=f'adding "{dep}" is a dependency decision. Put it in the spec and take it through the gate.')
    m = re.search(r"(?:>|>>|sed\s+-i(?:\s+\S+)?|tee|perl\s+-pi)\s+([^\s;|&]+)", cmd)
    if m:
        target = m.group(1).strip("\"'")
        if not target.startswith("/dev/"):
            v = check_edit(phase, target, cfg, exists=exists(target), unlocks=unlocks)
            if not v.ok:
                return Verdict(False, v.bucket, f"Shell write to {v.reason}", path=_rel(target))
    return Verdict(True)


def check_content(rel: str, text: str, cfg: dict | None = None) -> Verdict:
    """Secrets and disabled-test markers in the text an edit adds (rules/checks.py check_content)."""
    from .checks import check_content as _check

    why = _check(rel, text, cfg)
    return Verdict(False, "content", why) if why else Verdict(True)


# ---------------------------------------------------------------- commits

@dataclass
class CommitVerdict:
    ok: bool
    reason: str = ""
    bad: list[tuple[str, str]] = field(default_factory=list)


def commit_type_for(phase: str) -> str:
    return {
        "red": "red", "bug-repro": "red", "green": "green", "refactor": "refactor", "bug-fix": "fix",
        "review-fix": "fix", "coverage-fix": "coverage", "contract": "contract", "e2e": "e2e", "smoke": "smoke",
        "trivial": "trivial", "spec": "docs", "close": "docs", "ac": "ac", "memory": "memory", "setup": "setup",
        "lint-fix": "lint",
    }.get(phase, "fix")


def commit_prefix(ctype: str, ident: str = "") -> str:
    fixed = {"coverage": "test(coverage)", "smoke": "test(smoke)", "memory": "docs(memory)", "setup": "chore(setup)",
             "lint": "chore(lint)"}
    if ctype in fixed:
        return fixed[ctype]
    word = {"red": "test", "green": "feat", "refactor": "refactor", "fix": "fix", "contract": "contract",
            "e2e": "e2e", "trivial": "refactor", "docs": "docs", "ac": "feat"}.get(ctype, "chore")
    return f"{word}({ident})" if ident else word


def _layout_paths(cfg: dict | None) -> tuple[list[re.Pattern], list[re.Pattern]]:
    """MEMORY_PATHS and SETUP_PATHS plus the knowledge folder and runbook the project's layout names (load_config's
    `paths`: memory.dir or setup.runbook in a repo layout; .keel/ is covered already)."""
    p = (cfg or {}).get("paths") or {}
    extra_k = [re.compile("^" + re.escape(p["knowledge"].rstrip("/")) + "/")] if p.get("knowledge") else []
    extra_r = [re.compile("^" + re.escape(p["runbook"]) + "$")] if p.get("runbook") else []
    return MEMORY_PATHS + extra_k, SETUP_PATHS + extra_k + extra_r


def check_commit(ctype: str, files: list[str], cfg: dict | None = None) -> CommitVerdict:
    """The bucket rules of `keel commit <type>` for a staged file list (diff-level checks are not here)."""
    rule = COMMIT_RULES.get(ctype)
    if not rule:
        return CommitVerdict(False, f'unknown commit type "{ctype}". Types: {", ".join(COMMIT_RULES)}')
    if not files:
        return CommitVerdict(False, "nothing to commit.")
    buckets = [(f, classify(cfg, f)) for f in files]
    bad = [(f, b) for f, b in buckets if b in rule["deny"]]
    if bad:
        tail = {"red": "Move the production code to the green commit.",
                "green": "Test files belong to the red commit. If a test is wrong, reject the AC at the gate."}.get(ctype, "Remove them from this commit.")
        lines = "\n".join(f"  {f}  ({b})" for f, b in bad)
        return CommitVerdict(False, f"a {ctype} commit may not contain these files:\n{lines}\n{tail}", bad)
    if rule.get("trivial"):
        risky = [(f, b) for f, b in buckets if b in ("contract", "migration")]
        if risky:
            return CommitVerdict(False, "this is not a trivial change: it touches " + ", ".join(f"{f} ({b})" for f, b in risky), risky)
    memory_paths, setup_paths = _layout_paths(cfg)
    if rule.get("memoryOnly"):
        stray = [f for f in files if not any(p.search(f) for p in memory_paths)]
        if stray:
            return CommitVerdict(False, "a memory commit may only touch docs/knowledge/ and .keel/memory.json:\n" + "\n".join("  " + s for s in stray),
                                 [(s, "other") for s in stray])
    if rule.get("setupOnly"):
        stray = [f for f in files if not any(p.search(f) for p in setup_paths)]
        if stray:
            return CommitVerdict(False, "a setup commit may only touch what an init writes (.keel/, docs/RUNNING.md, docs/knowledge/, CLAUDE.md, .gitignore):\n"
                                 + "\n".join("  " + s for s in stray), [(s, "other") for s in stray])
    return CommitVerdict(True)


# ---------------------------------------------------------------- red classification

def classify_failure(output: str, cfg: dict | None = None) -> dict:
    """Is a failing test run a real RED (assertion) or a broken setup? An assertion signal wins."""
    loops = (cfg or {}).get("loops", {})
    accept = loops.get("red_accept", RED_ACCEPT)
    reject = loops.get("red_reject", RED_REJECT)
    low = str(output).lower()
    for pat in accept:
        if str(pat).lower() in low:
            return {"kind": "assertion", "matched": pat}
    for pat in reject:
        if str(pat).lower() in low:
            return {"kind": "setup", "matched": pat}
    return {"kind": "assertion"}


def red_accept(output: str) -> bool:
    return classify_failure(output)["kind"] == "assertion"


def red_reject(output: str) -> bool:
    return classify_failure(output)["kind"] == "setup"


# ---------------------------------------------------------------- gates

def ac_lane(ac: dict | None) -> str:
    return "web" if str((ac or {}).get("layer") or "API").upper() == "WEB" else "api"


def gate_due(mode: str, acs: list[dict], ac_id: str, skipped: dict | None = None, lane: str = "api") -> dict:
    """Is a human gate due after this AC? (keel v1 state.gateDue). `acs` in flow order."""
    ac = next((a for a in acs if a.get("id") == ac_id), None)
    if not ac:
        return {"due": True}
    if ac.get("gate") == "skip":
        return {"due": False, "why": f"{ac_id} is tagged [gate: skip] in the spec"}
    sk = (skipped or {}).get(lane)
    if sk:
        return {"due": False, "why": f"gates are skipped for this {'flow' if sk == 'flow' else 'lane'}"}
    mode = mode or "every-ac"
    # An already-met AC has no gate of its own (its approval was the question), so it never holds the lane's last gate.
    acs = [a for a in acs if a.get("status") != "already-met" or a.get("id") == ac_id]
    ids = sorted(a["id"] for a in acs)
    if mode == "every-ac":
        return {"due": True}
    if mode == "end-of-lane":
        mine = [i for i in ids if ac_lane(next(a for a in acs if a["id"] == i)) == ac_lane(ac)]
        return {"due": True} if mine and mine[-1] == ac_id else {"due": False, "why": "gate mode is end-of-lane"}
    if mode == "end":
        return {"due": True} if ids and ids[-1] == ac_id else {"due": False, "why": "gate mode is end"}
    return {"due": True}


# Rule packs (.keel/rules/*.yaml): imported last, they use the names above.
from .packs import load_packs, pack_verdict, parse_pack, validate_pack  # noqa: E402,F401
