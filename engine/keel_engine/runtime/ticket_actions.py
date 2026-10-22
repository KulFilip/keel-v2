"""The code steps of the review-pr workflow (content/workflows/review-pr.yaml): someone else's change, a GitHub PR or a
branch, reviewed against a ticket and the team's definition of done. A port of keel v1's review-pr skill and its
`ticket prep / build / record / comment` commands.

    ticket_prep     the PR (number or URL) or branch and the ticket text, from data (pr, branch, base, ticket) or the
                    request; stops on a closed or draft PR, an empty diff, only lockfiles or generated files, only docs.
                    The checklist: the ticket's "Acceptance criteria" / "Definition of done" bullets (T1..) and the team's
                    .keel/dod.md (D1..; keel's starter list without one). Script checks decide what the added lines
                    prove (AUTO). The files ranked by risk, each with a `like:` neighbour, and one reviewer job per line
                    of the plan (data.ticket_jobs)
    ticket_build    compile + lint of the reviewed code in a throwaway git worktree (never the person's tree); only
                    messages that name a changed file count
    ticket_claims   the reviewers' result lines; one `check` job per not-met item and blocking finding
    ticket_record   the checks applied (rejected: the finding is dropped, the item becomes unclear), the verdict and the
                    report (next steps first); the share question (which sections go to the author)
    ticket_share    the text for the author from the ticked sections, shown at the post gate
    ticket_comment  `gh pr comment` with that text, only after the person chose post (never in run mode auto or on the
                    fake model, never without a PR)

Read-only for the code under review: nothing is committed, the reviewed refs are fetched under refs/keel/.
"""

from __future__ import annotations

import asyncio
import json
import os
import re
import shlex
import shutil
import tempfile
from pathlib import Path

from .. import config, rules
from ..rules import checks
from ..tools import git, testcmd
from ..tools.agent_tools import command_env
from . import md
from . import run_mode as run_modes
from . import tools as tool_runner
from . import verdict_actions as va

KEY = "ticket_review"
DOD = ".keel/dod.md"
ONE_AGENT_LINES = 400        # at or under this many changed lines, one agent does every job
BUG_GROUP_LINES = 800        # a larger diff splits the bug job into groups of about this size
MAX_BUG_AGENTS = 2
MAX_FILES = 40               # files a job lists (the riskiest first)
SECTIONS = {
    "summary": "the verdict and one sentence",
    "notmet": "checklist items not done",
    "blocking": "bugs that must be fixed",
    "unclear": "items the code could not confirm",
    "minor": "bugs that do not block",
    "build": "compile and lint issues",
    "quality": "pattern and language notes",
}
DEFAULT_SECTIONS = ["summary", "notmet", "blocking"]


def _result(ok: bool, note: str, detail: str = "", update: dict | None = None, stop: bool = False):
    from .actions import ActionResult
    return ActionResult(ok, note, detail, update or {}, stop=stop)


def _stop(note: str, detail: str = ""):
    return _result(False, note, detail, stop=True)


def _review(a) -> dict:
    return dict(a.data.get(KEY) or {})


def _env(a) -> dict:
    token = va.github_token(a.keys)
    return {**command_env(), **({"GH_TOKEN": token} if token else {})}


def _gh(root: str, args: str, env: dict, timeout: int = 60) -> tuple[int, str]:
    """One `gh` call in the project folder (tests replace it)."""
    return testcmd.run(root, f"gh {args}", timeout, env)


# ------------------------------------------------------------------ the input

PR_URL = re.compile(r"https?://[^\s/]+/[^\s/]+/[^\s/]+/pull/(\d+)", re.I)
PR_WORD = re.compile(r"^\s*(?:pr|pull request|pull)\s*[:#]?\s*#?(\d+)\b", re.I)
PR_HASH = re.compile(r"^\s*#(\d+)\s*$")
PR_BARE = re.compile(r"^\s*(\d+)\s*$")
BRANCH_WORD = re.compile(r"^\s*branch\s*[:=]?\s*(\S+)", re.I)


def parse_input(request: str, data: dict) -> dict:
    """{pr, branch, base, ticket, force} from the flow's data (the api's options) or, line by line, the request: the
    first line that names a PR (a number, #12, PR 12, a pull URL) or a branch (`branch: x`) is the source, the rest the
    ticket. data.ticket wins over the request's text."""
    out = {"pr": None, "branch": None, "base": str(data.get("base") or "").strip() or None,
           "force": bool(data.get("force")), "ticket": str(data.get("ticket") or "").strip()}
    raw_pr = str(data.get("pr") or "").strip()
    if raw_pr:
        m = PR_URL.search(raw_pr) or re.search(r"(\d+)", raw_pr)
        out["pr"] = int(m.group(1)) if m else None
    if str(data.get("branch") or "").strip():
        out["branch"] = str(data["branch"]).strip()
    lines = str(request or "").splitlines()
    rest = list(lines)
    if not out["pr"] and not out["branch"]:
        for n, line in enumerate(lines):
            m = PR_URL.search(line) or PR_WORD.match(line) or PR_HASH.match(line) or (PR_BARE.match(line) if n == 0 else None)
            b = BRANCH_WORD.match(line)
            if m:
                out["pr"] = int(m.group(1))
            elif b:
                out["branch"] = b.group(1).strip("`'\"")
            else:
                continue
            rest = lines[:n] + lines[n + 1:]
            break
    if not out["ticket"]:
        out["ticket"] = "\n".join(rest).strip()
    return out


# ------------------------------------------------------------------ the checklist

ITEM = re.compile(r"^\s*(?:[-*+]|\d+[.)])\s+(?:\[[ xX]\]\s+)?(.+?)\s*$")
DONE_HEADING = re.compile(r"^\s*(?:#{1,6}\s*|\*\*)?\s*(definition of done|dod|acceptance criteria|acceptance|done when|"
                          r"done criteria)\b", re.I)
HEADING = re.compile(r"^\s*#{1,6}\s|^\s*\*\*[^*]+\*\*\s*:?\s*$")
CHECKBOX = re.compile(r"^\s*[-*+]\s+\[[ xX]\]\s+(.+?)\s*$")


def _items_in(lines: list[str]) -> list[str]:
    out = []
    for line in lines:
        m = ITEM.match(line)
        if m:
            text = m.group(1).replace("**", "").strip()
            if len(text) > 2:
                out.append(text)
    return out


def ticket_items(text: str) -> list[str]:
    """The bullets under the ticket's first "Acceptance criteria" / "Definition of done" heading (up to the next heading);
    without such a heading, its checkbox lines. Nothing is made up from the description."""
    lines = str(text or "").splitlines()
    at = next((n for n, line in enumerate(lines) if DONE_HEADING.match(line)), None)
    if at is None:
        return [m.group(1).replace("**", "").strip() for line in lines if (m := CHECKBOX.match(line))]
    block = []
    for line in lines[at + 1:]:
        if HEADING.match(line):
            break
        block.append(line)
    return _items_in(block)


def team_items(root: str) -> tuple[list[str], str]:
    """The team's definition of done: .keel/dod.md, else keel's starter list (content/templates/dod.md)."""
    own = Path(root) / DOD
    path, source = (own, DOD) if own.is_file() else (config.content_dir() / "templates" / "dod.md", "keel's starter list")
    try:
        text = path.read_text()
    except OSError:
        return [], source
    text = re.sub(r"<!--.*?-->", "", text, flags=re.S)
    return _items_in(text.splitlines()), source


# ------------------------------------------------------------------ the diff

def split_files(patch: str) -> list[dict]:
    """Per-file sections of a unified diff, with the added lines and their new line numbers."""
    parts = [p for p in re.split(r"^(?=diff --git )", patch or "", flags=re.M) if p.startswith("diff --git ")]
    out = []
    for p in parts:
        m = re.match(r"^diff --git a/(\S+) b/(\S+)", p)
        added, at = [], 0
        lines = p.split("\n")
        for line in lines:
            h = re.match(r"^@@ -\d+(?:,\d+)? \+(\d+)", line)
            if h:
                at = int(h.group(1))
                continue
            if line.startswith(("+++", "---")):
                continue
            if line.startswith("+"):
                added.append((at, line[1:]))
                at += 1
            elif not line.startswith("-"):
                at += 1
        out.append({"file": m.group(2) if m else "?", "added_lines": added,
                    "added": sum(1 for x in lines if x.startswith("+") and not x.startswith("+++")),
                    "removed": sum(1 for x in lines if x.startswith("-") and not x.startswith("---"))})
    return out


NOISE = [
    (re.compile(r"(^|/)(package-lock\.json|npm-shrinkwrap\.json|yarn\.lock|pnpm-lock\.yaml|composer\.lock|Gemfile\.lock|"
                r"poetry\.lock|Pipfile\.lock|uv\.lock|Cargo\.lock|go\.sum|gradle\.lockfile|[^/]+\.lockfile)$"), "lockfile"),
    (re.compile(r"\.min\.(js|css)$|\.map$"), "minified"),
    (re.compile(r"(^|/)__snapshots__/|\.snap$"), "snapshot"),
    (re.compile(r"(^|/)(vendor|node_modules|dist|build|out|target|\.gradle)/"), "vendored or built"),
]
AUTH = re.compile(r"(auth|security|permission|access|login|session|token|password|role|acl|guard|policy)", re.I)
DOC = re.compile(r"\.(md|mdx|txt|rst|adoc)$|(^|/)docs?/", re.I)


def noise_of(cfg: dict, file: str) -> str | None:
    for rx, why in NOISE:
        if rx.search(file):
            return why
    return "generated" if rules.classify(cfg, file) == "generated" else None


def risk_of(cfg: dict, file: str) -> tuple[str, int]:
    """(bucket, rank): lower ranks first. A migration or the contract is where a mistake is hardest to take back."""
    bucket = rules.classify(cfg, file)
    if DOC.search(file):
        return "docs", 7
    if bucket == "protected-env":
        return bucket, 0
    if bucket == "migration":
        return bucket, 1
    if bucket == "contract":
        return bucket, 2
    test = bucket.endswith("-test") or bucket in ("e2e", "smoke")
    if not test and AUTH.search(file):
        return ("auth" if bucket == "other" else f"{bucket}, auth"), 2
    if bucket in ("api-main", "web-src"):
        return bucket, 3
    if bucket == "other":
        return bucket, 4
    return (bucket, 5) if test else (bucket, 6)


# ------------------------------------------------------------------ script checks (AUTO)

DEBUG = re.compile(r"\b(console\.(log|debug)\(|System\.out\.print|println\(|printStackTrace\(\)|var_dump\(|\bdd\(|"
                   r"debugger\b|pdb\.set_trace\(|breakpoint\(\))|\b(TODO|FIXME|XXX)\b")
SCHEMA_CODE = re.compile(r"(entity|entities|model|models|schema|repository|dao|table)", re.I)
CHECK_FOR = [
    (re.compile(r"secret|credential|password|api key|token", re.I), "secrets", "no secret pattern in the added lines"),
    (re.compile(r"(disabled|skipped|weakened|ignored).*test|test.*(disabled|skipped|weakened|ignored)", re.I), "disabled",
     "no disable or skip marker in the added lines"),
    (re.compile(r"dead code|commented-out|debug|todo", re.I), "debug", "no debug output or TODO in the added lines"),
]
TODO_FOR = {
    "secrets": "remove it from the code, rotate it (it is now in git history), and read it from the environment or the "
               "secret store",
    "disabled": "turn the test back on, or delete it and say why in the PR",
    "debug": "remove the debug output, and finish or delete the TODO",
}


def auto_checks(files: list[dict]) -> dict:
    """What a script can see in the added lines, with file:line evidence. It only ever proves a problem: a clean check
    hands the item to a reviewer with a hint. The one exception: a database item when nothing in the diff is a database
    change."""
    found: dict = {"secrets": [], "disabled": [], "debug": []}
    for f in files:
        lines = f["added_lines"]
        for hit in checks.scan_secrets("\n".join(t for _n, t in lines)):
            n = lines[hit["line"] - 1][0] if 0 < hit["line"] <= len(lines) else "?"
            found["secrets"].append(f"{f['file']}:{n} {hit['why']}")
        for n, text in lines:
            if any(rx.search("+" + text) for rx, _why in checks.DISABLED):
                found["disabled"].append(f"{f['file']}:{n} {text.strip()[:60]}")
            elif f["rank"] != 5 and DEBUG.search(text):
                found["debug"].append(f"{f['file']}:{n} {text.strip()[:60]}")
    found["db_change"] = any(f["bucket"] == "migration" or (SCHEMA_CODE.search(f["file"]) and f["rank"] <= 4) for f in files)
    return found


def apply_checks(items: list[dict], auto: dict) -> None:
    for it in items:
        for rx, key, clean in CHECK_FOR:
            if not rx.search(it["text"]):
                continue
            if auto[key]:
                more = f" (+{len(auto[key]) - 3} more)" if len(auto[key]) > 3 else ""
                it.update(verdict="not-met", evidence="; ".join(auto[key][:3]) + more, todo=TODO_FOR[key], auto=True)
            else:
                it["hint"] = clean
        if not it.get("auto") and re.search(r"migration|database|schema", it["text"], re.I) and not auto["db_change"]:
            it.update(verdict="met", evidence="no database change in the diff", auto=True)


# ------------------------------------------------------------------ routing and the plan

STOP_WORDS = {"the", "and", "with", "that", "this", "from", "when", "have", "has", "are", "not", "for", "every", "each",
              "any", "all", "new", "changed", "code", "should", "must", "into", "than", "only", "where", "there", "their",
              "them", "they"}


def _words(s: str) -> list[str]:
    return [re.sub(r"(ies|es|s)$", "", w) for w in re.split(r"[^a-z0-9]+", str(s).lower()) if len(w) > 3 and w not in STOP_WORDS]


def route(item: dict, ranked: list[dict]) -> list[str]:
    """The files most likely to bear on an item; nothing matching means the riskiest files, never nothing."""
    iw = set(_words(item["text"]))
    scored = []
    for i, f in enumerate(ranked):
        s = sum(1 for w in _words(f["file"]) if w in iw) * 3
        text = item["text"]
        if re.search(r"test", text, re.I) and f["rank"] == 5:
            s += 2
        if re.search(r"migration|database|schema", text, re.I) and f["bucket"] == "migration":
            s += 3
        if re.search(r"auth|permission|access", text, re.I) and "auth" in f["bucket"]:
            s += 3
        if re.search(r"doc|readme|text", text, re.I) and f["bucket"] == "docs":
            s += 2
        if s:
            scored.append((-s, i))
    picked = [ranked[i]["file"] for _s, i in sorted(scored)[:6]]
    return picked or [f["file"] for f in ranked[:4]]


def plan(ranked: list[dict], items: list[dict]) -> list[dict]:
    """One `all` job for a small change; else ticket, team, bugs (in up to two groups) and quality, in parallel."""
    lines = sum(f["added"] + f["removed"] for f in ranked)
    open_ = [it for it in items if not it.get("auto")]
    every = [f["file"] for f in ranked]
    if lines <= ONE_AGENT_LINES:
        return [{"job": "all", "items": [it["id"] for it in open_], "files": every}]
    jobs = []
    for kind, src in (("ticket", "ticket"), ("team", "team")):
        mine = [it["id"] for it in open_ if it["from"] == src]
        if mine:
            jobs.append({"job": kind, "items": mine, "files": every})
    code = [f for f in ranked if f["bucket"] != "docs"]
    groups: list[list[str]] = [[]]
    n = 0
    for f in code:
        size = f["added"] + f["removed"]
        if groups[-1] and n + size > BUG_GROUP_LINES and len(groups) < MAX_BUG_AGENTS:
            groups.append([])
            n = 0
        groups[-1].append(f["file"])
        n += size
    jobs += [{"job": "bugs", "items": [], "files": g} for g in groups if g]
    if code:
        jobs.append({"job": "quality", "items": [], "files": [f["file"] for f in code[:15]]})
    return jobs


STANDARDS = ["CONTRIBUTING.md", "CODING_STANDARDS.md", "STYLEGUIDE.md", "STYLE_GUIDE.md", "docs/CONTRIBUTING.md",
             "docs/coding-standards.md", "docs/STYLEGUIDE.md", ".github/CONTRIBUTING.md", "docs/knowledge/conventions.md",
             ".keel/knowledge/conventions.md"]
JOB_TEXT = {
    "all": "every item you are given, then bugs, then quality, in every file",
    "ticket": "only the items you are given (from the ticket), each against its files; also report scope creep",
    "team": "only the items you are given (the team's definition of done), each against its files",
    "bugs": "only problems the change introduces in these files that will really break",
    "quality": "only these files: do they follow this codebase's own patterns (the like: file) and the standards",
    "check": "one claim: read its lines and answer whether it is true",
}


# ------------------------------------------------------------------ ticket_prep

async def ticket_prep(a):
    return await asyncio.to_thread(_prep, a)


def _ref_ok(root: str, ref: str) -> bool:
    return git.git(root, "rev-parse", "--verify", "-q", f"{ref}^{{commit}}").returncode == 0


def _source_pr(a, n: int, force: bool) -> tuple[dict | None, str | None]:
    code, out = _gh(a.root, f"pr view {n} --json title,url,headRefName,baseRefName,author,state,isDraft", _env(a))
    if code != 0:
        return None, f"gh could not read PR {n}: {(out.strip().splitlines() or ['no output'])[0][:200]}"
    try:
        m = json.loads(out[out.find("{"):]) if "{" in out else {}
    except ValueError:
        m = {}
    src = {"pr": n, "url": m.get("url"), "title": m.get("title"), "head": m.get("headRefName"),
           "base": m.get("baseRefName"), "author": (m.get("author") or {}).get("login"), "state": m.get("state"),
           "draft": bool(m.get("isDraft"))}
    if not force and src["state"] and str(src["state"]).upper() != "OPEN":
        return None, f"PR #{n} is {str(src['state']).lower()}: nothing to review (data force: true reviews it anyway)."
    if not force and src["draft"]:
        return None, f"PR #{n} is a draft: review it when it is ready (data force: true reviews it anyway)."
    ref, base_ref = f"refs/keel/review-pr/{n}", f"refs/keel/review-pr/{n}-base"
    specs = [f"+pull/{n}/head:{ref}"] + ([f"+{src['base']}:{base_ref}"] if src["base"] else [])
    f = git.git(a.root, "fetch", "-q", "origin", "--", *specs)
    if f.returncode != 0 or not _ref_ok(a.root, ref):
        return None, f"could not fetch PR #{n} from origin: {(f.stderr or f.stdout or '').strip()[:200]}"
    if not src["base"] or not _ref_ok(a.root, base_ref):
        return None, f"could not fetch the base branch of PR #{n} ({src['base'] or 'unknown'})."
    return {**src, "ref": ref, "base_ref": base_ref}, None


def _source_branch(a, cfg: dict, branch: str, base: str | None) -> tuple[dict | None, str | None]:
    ref = branch
    if str(branch).startswith("-"):
        return None, f'"{branch}" is not a branch name (it starts with "-", which git would read as an option).'
    if not _ref_ok(a.root, ref):
        git.git(a.root, "fetch", "-q", "origin", "--", branch)
        ref = f"origin/{branch}"
        if not _ref_ok(a.root, ref):
            return None, f'No branch "{branch}" here or on origin.'
    base = base or va.base_ref(a.root, cfg)
    if not base or not _ref_ok(a.root, base):
        return None, f"The base ref {base or '(none)'} does not exist: pass base: <branch or commit>."
    head = git.git(a.root, "rev-parse", "--short", ref).stdout.strip()
    return {"pr": None, "branch": branch, "ref": ref, "base": base, "base_ref": base, "head": head, "title": None}, None


def _prep(a):
    if not git.is_repo(a.root):
        return _stop("Not a git repository: there is no PR or branch to review.")
    cfg = rules.load_config(a.root)
    want = parse_input(a.request or "", a.data)
    if not want["pr"] and not want["branch"]:
        return _stop("Which change should keel review? Name a PR or a branch.",
                     "Start the flow with the PR on the first line (a number, #12, PR 12 or its URL) or `branch: <name>`, "
                     "then the ticket text; or pass data pr / branch / ticket.")
    src, err = _source_pr(a, want["pr"], want["force"]) if want["pr"] else \
        _source_branch(a, cfg, want["branch"], want["base"])
    if err:
        return _stop(err)
    d = git.git(a.root, "diff", "--no-color", f"{src['base_ref']}...{src['ref']}")
    if d.returncode != 0:
        return _stop(f"git diff {src['base_ref']}...{src['ref']} failed: {(d.stderr or '').strip()[:200]}")
    every = split_files(d.stdout)
    if not every:
        return _stop("The diff is empty: nothing to review.")
    skipped, kept = [], []
    for f in every:
        why = noise_of(cfg, f["file"])
        (skipped if why else kept).append({**f, "why": why} if why else f)
    if not kept:
        kinds = ", ".join(dict.fromkeys(s["why"] for s in skipped))
        return _stop(f"Only {kinds} files changed: nothing to review.")
    for f in kept:
        f["bucket"], f["rank"] = risk_of(cfg, f["file"])
    ranked = sorted(kept, key=lambda f: (f["rank"], -(f["added"] + f["removed"])))
    if not want["force"] and all(f["bucket"] == "docs" for f in ranked):
        return _stop("Only documentation changed: a code review has nothing to judge (data force: true reviews it anyway).")

    from_ticket = ticket_items(want["ticket"])
    team, dod_source = team_items(a.root)
    items = [{"id": f"T{i + 1}", "from": "ticket", "text": t} for i, t in enumerate(from_ticket)] + \
            [{"id": f"D{i + 1}", "from": "team", "text": t} for i, t in enumerate(team)]
    apply_checks(items, auto_checks(ranked))
    for it in items:
        if not it.get("auto"):
            it["files"] = route(it, ranked)
    names = {f["file"] for f in ranked}
    for f in ranked:
        if f["bucket"] == "docs":
            continue
        folder = str(Path(f["file"]).parent)
        listed = git.git(a.root, "ls-tree", "--name-only", src["base_ref"], "" if folder == "." else folder + "/").stdout
        ext = Path(f["file"]).suffix
        sib = [x.strip() for x in listed.splitlines() if x.strip() and Path(x.strip()).suffix == ext and x.strip() not in names]
        if sib:
            f["like"] = sib[0]
    standards = [s for s in STANDARDS if git.git(a.root, "cat-file", "-e", f"{src['base_ref']}:{s}").returncode == 0]
    jobs = plan(ranked, items)
    title = src.get("title") or next((ln.lstrip("# ").strip() for ln in want["ticket"].splitlines() if ln.strip()), "") \
        or (f"PR #{src['pr']}" if src.get("pr") else src["branch"])
    review = {
        "title": title[:100], "source": src, "ticket": want["ticket"][:8000],
        "files": [{k: f[k] for k in ("file", "bucket", "added", "removed", "like") if k in f} for f in ranked],
        "skipped": [{"file": s["file"], "why": s["why"]} for s in skipped],
        "items": [{k: it.get(k) for k in ("id", "from", "text", "verdict", "evidence", "todo", "auto", "files", "hint")}
                  for it in items],
        "ticket_items": len(from_ticket), "team_items": len(team), "dod_source": dod_source, "standards": standards,
        "added": sum(f["added"] for f in ranked), "removed": sum(f["removed"] for f in ranked),
    }
    read = (f"git diff {src['base_ref']}...{src['ref']} -- <file>   ·   git show {src['ref']}:<file> | sed -n 'a,bp'"
            f"   ·   the base version: git show {src['base_ref']}:<file>")
    job_items = [_job_item(n, j, review, read) for n, j in enumerate(jobs, 1)]
    pack = render_pack(review, jobs)
    note = (f"Review of {_what(src)}: {len(ranked)} file(s), +{review['added']} -{review['removed']}; "
            f"{len(from_ticket)} ticket item(s), {len(team)} from {dod_source}; "
            f"{len(jobs)} reviewer job(s): {', '.join(j['job'] for j in jobs)}.")
    return _result(True, note, pack, {"data": {**a.data, KEY: review, "ticket_jobs": job_items, "ticket_pack": pack}})


def _what(src: dict) -> str:
    if src.get("pr"):
        return f"PR #{src['pr']}" + (f" by {src['author']}" if src.get("author") else "")
    return f"{src['branch']} vs {src['base']}"


def _job_item(n: int, job: dict, review: dict, read: str) -> dict:
    by_file = {f["file"]: f for f in review["files"]}
    files = []
    for name in job["files"][:MAX_FILES]:
        f = by_file.get(name) or {"file": name}
        files.append(f"{name} [{f.get('bucket', '?')}] +{f.get('added', 0)} -{f.get('removed', 0)}"
                     + (f"  like: {f['like']}" if f.get("like") else ""))
    if len(job["files"]) > MAX_FILES:
        files.append(f"… {len(job['files']) - MAX_FILES} more (lower risk)")
    by_item = {it["id"]: it for it in review["items"]}
    out = {"id": f"{job['job']}-{n}", "title": f"{job['job']} job", "job": job["job"], "what": JOB_TEXT[job["job"]],
           "read": read, "files": files,
           "items": [{"id": i, "text": by_item[i]["text"], "files": by_item[i].get("files") or [],
                      **({"script": by_item[i]["hint"]} if by_item[i].get("hint") else {})} for i in job["items"]],
           "answer": "result lines only (see your role), then TICKET-REVIEW: done"}
    auto = [f"{it['id']} AUTO {it['verdict']}: {it['evidence']}" for it in review["items"] if it.get("auto")]
    if auto and job["job"] in ("all", "ticket", "team"):
        out["decided"] = auto
    if job["job"] in ("all", "quality") and review.get("standards"):
        out["standards"] = [f"git show {review['source']['base_ref']}:{s}" for s in review["standards"]]
    return out


def render_pack(review: dict, jobs: list[dict]) -> str:
    """What prep found, in about a screen: shown in the step's detail."""
    src = review["source"]
    out = [f"{review['title']}", f"code      {_what(src)}: {len(review['files'])} file(s), +{review['added']} -{review['removed']}"]
    if review["skipped"]:
        out.append(f"skipped   {len(review['skipped'])} file(s): " + ", ".join(f"{s['file']} ({s['why']})" for s in review["skipped"][:4]))
    out.append(f"checklist {review['ticket_items']} from the ticket, {review['team_items']} from {review['dod_source']}")
    if not review["ticket_items"]:
        out.append('note      the ticket has no "Acceptance criteria" / "Definition of done" list: only the team items are judged')
    out += ["", "files, riskiest first"]
    out += [f"  {f['file']}  [{f['bucket']}] +{f['added']} -{f['removed']}" + (f"   like: {f['like']}" if f.get("like") else "")
            for f in review["files"]]
    out += ["", "items"]
    for it in review["items"]:
        tag = f"AUTO {it['verdict']}: {it['evidence']}" if it.get("auto") else "files " + ", ".join(it.get("files") or [])
        out += [f"  {it['id']:<4} {it['text'][:90]}", f"       {tag}"]
    out += ["", "plan      " + ", ".join(j["job"] for j in jobs)]
    return "\n".join(out)


# ------------------------------------------------------------------ ticket_build

async def ticket_build(a):
    return await asyncio.to_thread(_build, a)


def issues_in(output: str, files: list[str]) -> list[dict]:
    """Messages in a tool's output that name a changed file (eslint's stylish blocks too), at most 15."""
    out: list[dict] = []
    current = None
    for raw in str(output or "").splitlines():
        line = re.sub(r"\x1b\[[0-9;]*m", "", raw)
        hit = next((f for f in files if f in line or (len(Path(f).name) > 6 and "/" + Path(f).name in line)), None)
        if hit and re.fullmatch(r"\s*\S+\s*", line):
            current = hit
            continue
        if hit:
            m = re.search(re.escape(hit) + r"\D{0,3}(\d+)", line) or re.search(r"[:(](\d+)[,:)]", line)
            out.append({"file": hit, "line": int(m.group(1)) if m else None, "text": line.strip()[:200]})
        elif current:
            m = re.match(r"^\s+(\d+):\d+\s+(.*)$", line)
            if m:
                out.append({"file": current, "line": int(m.group(1)), "text": m.group(2).strip()[:200]})
            elif not line.strip():
                current = None
        if len(out) >= 15:
            break
    return out


LINKED = ("node_modules", "vendor")


def _build(a):
    review = _review(a)
    src = review.get("source") or {}
    result: dict = {"checks": [], "note": None}
    files = [f["file"] for f in review.get("files") or []]
    if not src.get("ref"):
        result["note"] = "the reviewed code is not available here: no build check"
    else:
        result = run_build(a, src["ref"], files)
    review["build"] = result
    broken = [c for c in result["checks"] if c["kind"] == "compile" and not c["ok"] and c["issues"]]
    lint = sum(len(c["issues"]) for c in result["checks"] if c["kind"] == "lint")
    if result.get("note") and not result["checks"]:
        note = f"Build check: {result['note']}."
    else:
        note = (f"Build check: {len(result['checks'])} check(s); "
                + (f"{len(broken)} compile check(s) fail on a changed file; " if broken else "compiles; ")
                + f"{lint} lint message(s) on changed files.")
    detail = "\n".join(f"{c['name']} ({c['kind']}): {'ok' if c['ok'] else 'FAIL'}"
                       + "".join(f"\n  {i['file']}:{i['line'] or '?'} {i['text']}" for i in c["issues"])
                       + (f"\n  {c['note']}" if c.get("note") else "") for c in result["checks"])
    return _result(True, note, detail, {"data": {**a.data, KEY: review}})


def run_build(a, ref: str, files: list[str]) -> dict:
    """Compile + lint of `ref` in a throwaway worktree. On the fake model only the project's own declared tools run and
    no compile command (the stacks' programs are not assumed to be installed)."""
    cfg = rules.load_config(a.root)
    result: dict = {"checks": [], "note": None}
    wt = Path(tempfile.mkdtemp(prefix="keel-review-pr-")) / "tree"
    add = git.git(a.root, "worktree", "add", "--detach", "-q", str(wt), ref)
    if add.returncode != 0:
        result["note"] = f"could not check the code out into a worktree: {(add.stderr or add.stdout or '').strip()[:200]}"
        shutil.rmtree(wt.parent, ignore_errors=True)
        return result
    try:
        backend = str((cfg.get("backend") or {}).get("dir") or "").strip().rstrip("/")
        frontend = str((cfg.get("frontend") or {}).get("dir") or "").strip().rstrip("/")
        for rel in {*LINKED, *(f"{d}/{x}" for d in (backend, frontend) if d for x in LINKED)}:
            src, dst = Path(a.root) / rel, wt / rel
            if src.is_dir() and not dst.exists():
                try:
                    dst.parent.mkdir(parents=True, exist_ok=True)
                    dst.symlink_to(src, target_is_directory=True)
                except OSError:
                    pass

        def touched(d: str) -> bool:
            return bool(d) and any(f == d or f.startswith(d + "/") for f in files)

        commands = cfg.get("commands") or {}
        steps = []
        if not a.fake:
            api, web = str(commands.get("api_compile") or "").strip(), str(commands.get("web_typecheck") or "").strip()
            if api and (touched(backend) or not backend or not (wt / backend).is_dir()):
                steps.append(("compile (api)", api, wt / backend if backend else wt))
            if web and touched(frontend):
                steps.append(("typecheck (web)", web, wt / frontend))
        env = command_env()
        for name, cmd, cwd in steps:
            code, out = testcmd.run(str(cwd if cwd.is_dir() else wt), cmd, 900, env)
            issues = [] if code == 0 else issues_in(out, files)
            result["checks"].append({"name": name, "kind": "compile", "ok": code == 0, "issues": issues,
                                     "note": None if code == 0 or issues else _old_problem(out)})
        # a server scan (sonar) is not a local check of this change
        declared = [t for t in tool_runner.resolve(str(wt), cfg, include_stacks=not a.fake) if t.name != "sonar"]
        present = tool_runner.existing(str(wt), files)
        for r in tool_runner.run_tools(str(wt), ("manual", "edit", "batch", "pre-commit"), present, cfg=cfg,
                                       tools=declared, skip_fix=True):
            if not r["available"]:
                result["checks"].append({"name": r["name"], "kind": "lint", "ok": True, "issues": [],
                                         "note": "not installed here"})
                continue
            issues = [] if r["ok"] else issues_in(r.get("output") or r.get("head") or "", files)
            result["checks"].append({"name": r["name"], "kind": "lint", "ok": r["ok"], "issues": issues,
                                     "note": None if r["ok"] or issues else _old_problem(r.get("output") or "")})
        if not result["checks"]:
            result["note"] = "no compile command and no lint tool is configured for this project" + \
                (" (fake model: only .keel/config.yml tools run)" if a.fake else "")
    finally:
        git.git(a.root, "worktree", "remove", "--force", str(wt))
        git.git(a.root, "worktree", "prune")
        shutil.rmtree(wt.parent, ignore_errors=True)
    return result


def _old_problem(out: str) -> str:
    last = (str(out).strip().splitlines() or ["(no output)"])[-1][:160]
    return f"failed, but no message names a changed file (an existing problem or a missing dependency here): {last}"


# ------------------------------------------------------------------ result lines

ITEM_VERDICTS = ("met", "not-met", "unclear")
SEVERITIES = ("blocking", "minor")


def _where(text: str) -> tuple[str | None, int | None]:
    m = re.match(r"^(.+?)(?::(\d+))?$", str(text or "").strip())
    if not m or m.group(1) in ("-", ""):
        return None, None
    return m.group(1), int(m.group(2)) if m.group(2) else None


def parse_lines(text: str) -> dict:
    """`T1 | met | src/A.kt:42 | why`, `F | blocking | where | what | to do`, `Q | where | rule | what | to do`, `S | ...`,
    `CHECK | confirmed | why`."""
    out: dict = {"items": [], "findings": [], "quality": [], "summary": [], "checks": [], "bad": []}
    for raw in str(text or "").splitlines():
        line = re.sub(r"^\s*[-*]\s+", "", raw).strip().strip("`")
        if "|" not in line:
            continue
        p = [x.strip() for x in line.split("|")]
        head = p[0].upper()
        if head == "S":
            out["summary"].append(" | ".join(p[1:])[:300])
        elif head == "CHECK":
            v = (p[1] if len(p) > 1 else "").lower()
            if v in ("confirmed", "rejected"):
                out["checks"].append({"verdict": v, "why": " | ".join(p[2:])[:300]})
        elif head == "Q":
            f, n = _where(p[1] if len(p) > 1 else "")
            out["quality"].append({"file": f, "line": n, "rule": (p[2] if len(p) > 2 else "")[:80],
                                   "text": (p[3] if len(p) > 3 else "")[:300], "todo": " | ".join(p[4:])[:300] or None})
        elif head == "F":
            sev = (p[1] if len(p) > 1 else "").lower()
            if sev not in SEVERITIES:
                out["bad"].append(f'finding with severity "{p[1] if len(p) > 1 else ""}"')
                continue
            f, n = _where(p[2] if len(p) > 2 else "")
            out["findings"].append({"severity": sev, "file": f, "line": n, "text": (p[3] if len(p) > 3 else "")[:400],
                                    "todo": " | ".join(p[4:])[:300] or None})
        elif re.fullmatch(r"[TD]\d+", head):
            v = (p[1] if len(p) > 1 else "").lower()
            if v not in ITEM_VERDICTS:
                out["bad"].append(f'{head} has verdict "{p[1] if len(p) > 1 else ""}"')
                continue
            ev = " ".join(x for x in p[2:4] if x and x != "-")
            out["items"].append({"id": head, "verdict": v, "evidence": ev[:400] or None,
                                 "todo": " | ".join(p[4:])[:300] or None})
    return out


def _merge_item(a: dict | None, b: dict) -> dict:
    """An item judged twice: evidence that it is met wins, then a not-met over an unclear."""
    rank = {"met": 3, "not-met": 2, "unclear": 1}
    return b if not a or rank.get(b["verdict"], 0) > rank.get(a["verdict"], 0) else a


async def ticket_claims(a):
    return await asyncio.to_thread(_claims, a)


def _claims(a):
    review = _review(a)
    got = {"items": [], "findings": [], "quality": [], "summary": [], "bad": []}
    for r in a.data.get("reviewers_results") or []:
        p = parse_lines(r.get("text") or "")
        for k in got:
            got[k] += p[k]
    known = {it["id"]: it for it in review.get("items") or []}
    by_item: dict = {}
    for it in got["items"]:
        if it["id"] not in known:
            got["bad"].append(f"unknown item {it['id']}")
            continue
        by_item[it["id"]] = _merge_item(by_item.get(it["id"]), it)
    findings = sorted(got["findings"], key=lambda f: SEVERITIES.index(f["severity"]))
    review["judged"] = by_item
    review["findings"] = findings
    review["quality"] = got["quality"][:12]
    review["summary"] = " ".join(got["summary"])[:600] or None
    review["bad_lines"] = got["bad"][:20]
    src = review.get("source") or {}
    read = f"git diff {src.get('base_ref')}...{src.get('ref')} -- <file>   ·   git show {src.get('ref')}:<file> | sed -n 'a,bp'"
    claims = []
    for iid, it in by_item.items():
        if it["verdict"] == "not-met" and not known[iid].get("auto"):
            claims.append({"kind": "item", "target": iid,
                           "claim": f"{iid} \"{known[iid]['text']}\" is NOT met: {it.get('evidence') or 'no evidence given'}"})
    for n, f in enumerate(findings):
        if f["severity"] == "blocking":
            at = f"{f['file']}:{f['line']}" if f.get("file") and f.get("line") else (f.get("file") or "-")
            claims.append({"kind": "finding", "target": n, "claim": f"blocking bug at {at}: {f['text']}"})
    checks = [{"id": f"check-{n}", "title": c["claim"][:80], "job": "check", "what": JOB_TEXT["check"], "read": read,
               "claim": c["claim"], "kind": c["kind"], "target": c["target"],
               "answer": "CHECK | confirmed | <why>  or  CHECK | rejected | <why>, then TICKET-REVIEW: done"}
              for n, c in enumerate(claims, 1)]
    note = (f"{len(by_item)} item verdict(s), {len(findings)} finding(s), {len(got['quality'])} quality note(s); "
            f"{len(checks)} claim(s) to check" + (f"; {len(got['bad'])} line(s) not understood" if got["bad"] else "") + ".")
    return _result(True, note, "\n".join(got["bad"][:20]), {"data": {**a.data, KEY: review, "ticket_checks": checks}})


# ------------------------------------------------------------------ ticket_record

async def ticket_record(a):
    return await asyncio.to_thread(_record, a)


def verdict_of(review: dict) -> dict:
    """Quality notes and lint never change the verdict; a compile error in a changed file always does."""
    items = review.get("items") or []
    findings = review.get("findings") or []
    not_met = sum(1 for it in items if it.get("verdict") == "not-met")
    unclear = sum(1 for it in items if it.get("verdict") == "unclear")
    blocking = sum(1 for f in findings if f["severity"] == "blocking")
    build = (review.get("build") or {}).get("checks") or []
    broken = sum(1 for c in build if c["kind"] == "compile" and not c["ok"] and c["issues"])
    lint = sum(len(c["issues"]) for c in build if c["kind"] == "lint")
    verdict = "not-done" if not_met or blocking or broken else "unclear" if unclear else "done"
    return {"verdict": verdict, "counts": {"met": len(items) - not_met - unclear, "not_met": not_met, "unclear": unclear,
                                           "blocking": blocking, "minor": len(findings) - blocking,
                                           "build_errors": broken, "lint": lint, "quality": len(review.get("quality") or [])}}


def _record(a):
    review = _review(a)
    judged = review.get("judged") or {}
    checks = {c["id"]: c for c in a.data.get("ticket_checks") or []}
    rejected_findings, unclear_items, confirmed = set(), {}, 0
    for r in a.data.get("check_results") or []:
        c = checks.get(r.get("item"))
        got = parse_lines(r.get("text") or "")["checks"]
        if not c or not got:
            continue
        if got[-1]["verdict"] == "confirmed":
            confirmed += 1
        elif c["kind"] == "finding":
            rejected_findings.add(c["target"])
        else:
            unclear_items[c["target"]] = got[-1]["why"]
    review["findings"] = [f for n, f in enumerate(review.get("findings") or []) if n not in rejected_findings]
    missing = []
    items = []
    for it in review.get("items") or []:
        it = dict(it)
        if it.get("auto") and it.get("verdict") == "not-met":
            items.append(it)
            continue
        got = judged.get(it["id"])
        if got:
            it.update(verdict=got["verdict"], evidence=got.get("evidence"), todo=got.get("todo"), auto=False)
            if it["id"] in unclear_items:
                it.update(verdict="unclear", evidence=f"a second look did not confirm it is missing: {unclear_items[it['id']]}",
                          todo="check it by hand, or ask the author")
        elif not it.get("auto"):
            missing.append(it["id"])
            it.update(verdict="unclear", evidence="no reviewer gave a verdict for it", todo="check it by hand")
        items.append(it)
    review["items"] = items
    review["missing"] = missing
    review.update(verdict_of(review))
    text = report_text(review)
    c = review["counts"]
    note = (f"{_word(review['verdict'])}: {c['met']} of {len(items)} item(s) met, {c['not_met']} not met, {c['unclear']} "
            f"unclear, {c['blocking']} blocking" + (f"; {len(missing)} item(s) had no verdict ({', '.join(missing)}): "
                                                     "marked unclear" if missing else "")
            + (f"; {len(rejected_findings)} finding(s) dropped by the check" if rejected_findings else "") + ".")
    data = {**a.data, KEY: review, "review_text": text, "share_questions": [share_question(review)]}
    return _result(True, note, "", {"show": text, "data": data})


def _word(verdict: str | None) -> str:
    return {"done": "DONE", "not-done": "NOT DONE", "unclear": "NEEDS A CHECK"}.get(str(verdict), str(verdict or "").upper())


def report(review: dict) -> dict:
    """The review as a to-do list: what is missing, what must be fixed, what to check by hand, what would be nice, what
    is done, and the next steps in order. The gate's text and the author's text both read this one shape."""
    def at(x):
        return f"{x['file']}:{x['line']}" if x.get("file") and x.get("line") else x.get("file")
    items = review.get("items") or []
    findings = review.get("findings") or []
    build = review.get("build") or {}
    checks = build.get("checks") or []
    missing = [{"id": it["id"], "title": it["text"], "problem": it.get("evidence") or "not done", "todo": it.get("todo"),
                "script": bool(it.get("auto"))} for it in items if it.get("verdict") == "not-met"]
    compile_rows = [{"where": at(x), "problem": f"{c['name']}: {x['text']}", "kind": "compile",
                     "todo": "make it build: nothing else can be checked until it does"}
                    for c in checks if c["kind"] == "compile" and not c["ok"] for x in c["issues"]]
    must_fix = compile_rows + [{"where": at(f), "problem": f["text"], "todo": f.get("todo"), "kind": "bug"}
                               for f in findings if f["severity"] == "blocking"]
    check = [{"id": it["id"], "title": it["text"], "problem": it.get("evidence") or "the code does not show it",
              "todo": it.get("todo") or "check it by hand, or ask the author"} for it in items if it.get("verdict") == "unclear"]
    nice = [{"where": at(f), "problem": f["text"], "todo": f.get("todo"), "kind": "bug"} for f in findings if f["severity"] == "minor"]
    nice += [{"where": at(x), "problem": f"{c['name']}: {x['text']}", "todo": None, "kind": "lint"}
             for c in checks if c["kind"] == "lint" for x in c["issues"]]
    nice += [{"where": at(q), "problem": q["text"], "todo": q.get("todo"), "rule": q.get("rule"), "kind": "quality"}
             for q in review.get("quality") or []]
    done = [{"id": it["id"], "title": it["text"]} for it in items if it.get("verdict") == "met"]
    notes = ([f"build check: {build['note']}"] if build.get("note") else []) + \
        [f"{c['name']}: {c['note']}" for c in checks if c.get("note")]

    def step(x, prefix):
        return f"{prefix}{x['where'] + ' - ' if x.get('where') else ''}{x.get('todo') or x['problem']}"
    nxt = [step(x, "Fix: ") for x in must_fix] + [f"Add: {x['id']} \"{x['title']}\" - {x['todo'] or x['problem']}" for x in missing] \
        + [f"Check: {x['id']} \"{x['title']}\" - {x['todo']}" for x in check]
    if nice:
        nxt.append(f"Optional: the {len(nice)} nice-to-have note(s) above")
    return {"word": _word(review.get("verdict")), "summary": review.get("summary"), "done_count": len(done),
            "total": len(items), "missing": missing, "must_fix": must_fix, "check": check, "nice": nice, "done": done,
            "notes": notes, "next": nxt}


def report_text(review: dict) -> str:
    r = report(review)
    out = [f"{review.get('title')} - {r['word']} · {r['done_count']} of {r['total']} checklist item(s) done"]
    if r["summary"]:
        out.append(r["summary"])
    out.append(f"Reviewed: {_what(review.get('source') or {})}")

    def block(title, rows, fmt):
        if rows:
            out.extend(["", title])
            for x in rows:
                out.extend(fmt(x))
    block(f"MISSING - from the ticket or the definition of done ({len(r['missing'])})", r["missing"], lambda x: [
        f"   {x['id']} {x['title']}", f"      problem: {x['problem']}" + (" (script)" if x["script"] else "")]
        + ([f"      to do:   {x['todo']}"] if x["todo"] else []))
    block(f"MUST FIX - bugs and build errors ({len(r['must_fix'])})", r["must_fix"], lambda x: [
        f"   {x['where'] + ' - ' if x['where'] else ''}{x['problem']}"] + ([f"      to do:   {x['todo']}"] if x["todo"] else []))
    block(f"CHECK BY HAND - the code cannot show it ({len(r['check'])})", r["check"], lambda x: [
        f"   {x['id']} {x['title']}", f"      why:     {x['problem']}", f"      to do:   {x['todo']}"])
    block(f"NICE TO HAVE - minor, does not block ({len(r['nice'])})", r["nice"], lambda x: [
        f"   {x['where'] + ' - ' if x['where'] else ''}{'(' + x['rule'] + ') ' if x.get('rule') else ''}{x['problem']}"
        + (f" -> {x['todo']}" if x["todo"] else "")])
    if r["done"]:
        out.extend(["", f"DONE ({len(r['done'])}) - " + ", ".join(x["id"] for x in r["done"])])
    if r["notes"]:
        out.extend(["", "notes"] + [f"   · {n}" for n in r["notes"]])
    out.extend(["", "NEXT STEPS" if r["next"] else "NEXT STEPS - nothing to do: ready to merge"])
    out.extend(f"   {n}. {x}" for n, x in enumerate(r["next"], 1))
    out.extend(["", "Nothing has been sent to the author. Choose share to make a text for them from the sections you tick."])
    return "\n".join(out)


def _section_rows(review: dict) -> dict[str, int]:
    r = report(review)
    return {"summary": 1, "notmet": len(r["missing"]), "blocking": sum(1 for x in r["must_fix"] if x["kind"] == "bug"),
            "unclear": len(r["check"]), "minor": sum(1 for x in r["nice"] if x["kind"] == "bug"),
            "build": sum(1 for x in r["must_fix"] if x["kind"] == "compile") + sum(1 for x in r["nice"] if x["kind"] == "lint"),
            "quality": sum(1 for x in r["nice"] if x["kind"] == "quality")}


def share_question(review: dict) -> dict:
    """Which sections go into the text for the author (several may be ticked; summary, not met and blocking by
    default). Sections with nothing in them are not offered."""
    rows = _section_rows(review)
    opts = [{"label": name, "description": about + ("" if name == "summary" else f" ({rows[name]})"),
             "recommended": name in DEFAULT_SECTIONS} for name, about in SECTIONS.items() if rows[name]]
    return {"id": "sections", "question": "Which sections go into the text for the author?",
            "why": "Only for share. The text is shown to you first; nothing is posted unless you choose post after that.",
            "options": opts, "multiple": True}


# ------------------------------------------------------------------ ticket_share + ticket_comment

async def ticket_share(a):
    return await asyncio.to_thread(_share, a)


def chosen_sections(answer: dict) -> list[str]:
    payload = (answer or {}).get("payload") or {}
    raw = payload.get("sections")
    if raw is None and isinstance(payload.get("answers"), dict):
        raw = payload["answers"].get("sections")
    if isinstance(raw, str):
        raw = [x for x in re.split(r"[,;\s]+", raw) if x]
    picked = [str(x).strip().lower() for x in raw or [] if str(x).strip().lower() in SECTIONS]
    return picked or list(DEFAULT_SECTIONS)


def comment_text(review: dict, sections: list[str]) -> str:
    want = set(sections)
    r = report(review)

    def code(w):
        return f"`{w}` " if w else ""

    def todo(t):
        return f"\n  - **To do:** {t}" if t else ""
    out: list[str] = []
    if "summary" in want:
        out += [f"**Review: {r['word'].lower()}** - {r['done_count']} of {r['total']} checklist items done."
                + (f" {r['summary']}" if r["summary"] else ""), ""]

    def lst(title, rows):
        if rows:
            out.extend([f"**{title}**", *rows, ""])
    if "notmet" in want:
        lst("Missing", [f"- {x['title']} - {x['problem']}{todo(x['todo'])}" for x in r["missing"]])
    if "blocking" in want:
        lst("Must fix", [f"- {code(x['where'])}{x['problem']}{todo(x['todo'])}" for x in r["must_fix"] if x["kind"] == "bug"])
    if "build" in want:
        lst("Build and lint", [f"- {code(x['where'])}{x['problem']}" for x in r["must_fix"] + r["nice"]
                               if x["kind"] in ("compile", "lint")])
    if "unclear" in want:
        lst("Please confirm", [f"- {x['title']} - {x['problem']}" for x in r["check"]])
    if "minor" in want:
        lst("Minor", [f"- {code(x['where'])}{x['problem']}{todo(x['todo'])}" for x in r["nice"] if x["kind"] == "bug"])
    if "quality" in want:
        lst("Code quality", [f"- {code(x['where'])}{'(' + x['rule'] + ') ' if x.get('rule') else ''}{x['problem']}{todo(x['todo'])}"
                             for x in r["nice"] if x["kind"] == "quality"])
    return "\n".join(out).strip() or "(nothing to share in the chosen sections)"


def _share(a):
    review = _review(a)
    sections = chosen_sections(a.data.get("share_answer") or {})
    text = comment_text(review, sections)
    pr = (review.get("source") or {}).get("pr")
    where = (f"Choose post to post it as one comment on PR #{pr}, or keep to copy it yourself." if pr else
             "This review is of a branch, not a PR: copy the text yourself (post has nothing to post to).")
    show = md.doc(md.section("The text for the author", f"Sections: {', '.join(md.code(x) for x in sections)}.",
                             "It is posted exactly as it shows here:", md.demote(text)),
                  md.section("What happens next", where))
    return _result(True, f"Text for the author ready: {', '.join(sections)}.", "",
                   {"show": show, "data": {**a.data, "review_comment": text, "review_sections": sections}})


async def ticket_comment(a):
    return await asyncio.to_thread(_comment, a)


def may_post(a) -> str | None:
    """Why keel posts nothing, or None. Run mode auto and the fake model never post (tests replace this)."""
    if run_modes.normalize((a.settings or {}).get("run_mode")) == "auto":
        return "run mode auto: keel posts nothing by itself"
    if a.fake:
        return "the reviewers ran on the fake model: keel posts nothing they made"
    return None


def _comment(a):
    review = _review(a)
    text = a.data.get("review_comment") or ""
    pr = (review.get("source") or {}).get("pr")
    copy = "Copy the text (shown at the last gate) into the PR yourself."
    if (a.data.get("post_answer") or {}).get("choice") != "post":
        return _result(True, f"Post was not chosen; nothing posted. {copy}", text)
    if not text:
        return _result(True, "No text for the author yet; nothing posted.")
    if not pr:
        return _result(True, f"This review is of a branch, not a PR: nothing to post to. {copy}", text)
    why = may_post(a)
    if why:
        return _result(True, f"{why[0].upper() + why[1:]}; nothing posted. {copy}", text)
    with tempfile.NamedTemporaryFile("w", suffix=".md", delete=False) as f:
        f.write(text)
        path = f.name
    try:
        code, out = _gh(a.root, f"pr comment {int(pr)} --body-file {shlex.quote(path)}", _env(a), 120)
    finally:
        try:
            os.unlink(path)
        except OSError:
            pass
    if code != 0:
        return _result(True, f"gh pr comment failed; nothing posted. {copy}", f"{out.strip()[-1500:]}\n\n{text}")
    url = next((ln.strip() for ln in out.splitlines() if ln.strip().startswith("http")), "")
    return _result(True, f"Posted the review on PR #{pr}" + (f": {url}" if url else "."), out[-1000:],
                   {"data": {**a.data, "review_posted": url or f"PR #{pr}"}})


ACTIONS = {"ticket_prep": ticket_prep, "ticket_build": ticket_build, "ticket_claims": ticket_claims,
           "ticket_record": ticket_record, "ticket_share": ticket_share, "ticket_comment": ticket_comment}
