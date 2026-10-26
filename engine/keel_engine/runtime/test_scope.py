"""What a change targets, for the flows that must not force a test-first loop on it.

- test-only changes: every file a change names is a test file (by the project's path roles, rules.classify). A review
  comment on a test ("a helper would fit here") has no behaviour for a failing test to describe, so it takes the
  ``address`` flow (one agent, code and tests writable, the tests run, one look) instead of RED/GREEN.
- refactor criteria: "no behaviour change", "refactor", "extract", "rename" with nothing new to observe. Their proof is
  that the existing tests pass before and after; no RED test is written for them (a test of the source text would be
  the only "failing test" left to write).
- source-inspecting tests: a test that reads a source file as text (a regex over setUp()) proves the shape of the code,
  not its behaviour. The test-author is told not to write one, and keel's red check sends one back.
- frozen files: the files a criterion or its plan names that keel's rules freeze in the step's phase (test code in
  GREEN). The agent is told before it starts, and a guard that keeps putting the same file back asks the person.
"""
from __future__ import annotations

import re
from pathlib import Path

from .. import rules
from ..tools import git

TEST_BUCKETS = ("api-test", "web-test", "e2e", "smoke")
SOURCE_EXT = ("php", "kt", "kts", "java", "ts", "tsx", "js", "jsx", "mjs", "cjs", "py", "go", "rb", "cs", "scala",
              "swift", "rs", "vue", "svelte", "ex", "exs", "dart", "groovy")
# a file path (or a bare file name) with a code extension; a trailing :12 or :12-20 is the line the comment is on
NAMED_FILE = re.compile(r"(?<![\w@.-])((?:[\w@.-]+/)*[\w@-]+(?:\.[\w-]+)*\.(?:" + "|".join(SOURCE_EXT) + r"))(?![\w-])")


# ---------------------------------------------------------------- test-only changes

def named_files(text: str | None) -> list[str]:
    """The code files a text names (a path or a bare file name), each once, in order."""
    return list(dict.fromkeys(m.group(1).removeprefix("./") for m in NAMED_FILE.finditer(str(text or ""))))


def is_test_file(cfg: dict | None, path: str) -> bool:
    return rules.classify(cfg, path) in TEST_BUCKETS


def test_only(cfg: dict | None, files: list[str]) -> bool:
    """Is every one of these files a test file? False for no files: nothing says the change is test-only."""
    files = [f for f in files if str(f or "").strip()]
    return bool(files) and all(is_test_file(cfg, f) for f in files)


TEST_ONLY_WHY = "only test code changes"


# ---------------------------------------------------------------- refactor criteria

REFACTOR_TAG = re.compile(r"\[\s*refactor\s*\]", re.I)
REFACTOR = re.compile(r"\b(refactor\w*|no (?:observable )?behaviou?r change\w*|without changing (?:the |its |any )?"
                      r"behaviou?r|behaviou?r (?:stays|remains|is) (?:the same|unchanged)|extract\w*|renam\w+|"
                      r"restructur\w*|de-?duplicat\w*|tid(?:y|ies|ied) up|clean(?:s|ed)? up|inlin(?:e|es|ed) )", re.I)
# words that say a criterion adds something a caller or a user can see: then it is not a refactor
NEW_BEHAVIOUR = re.compile(r"\b(returns?|responds?|answers?|shows?|displays?|rejects?|accepts?|fails? with|errors? "
                           r"(?:when|if)|status \d{3}|new (?:endpoint|field|page|screen|button|column|option)|adds? an? "
                           r"(?:endpoint|field|page|screen|button|column|option)|sends?|emits?|logs? an?)\b", re.I)


def is_refactor(ac: dict | None) -> bool:
    """A criterion that changes no behaviour: tagged [refactor] (or kind refactor), or worded as a refactor with nothing
    new for a caller to see. Its proof is the existing tests, before and after."""
    if not ac:
        return False
    if str(ac.get("kind") or "").lower() == "refactor":
        return True
    title = str(ac.get("title") or "")
    if REFACTOR_TAG.search(title):
        return True
    return bool(REFACTOR.search(title)) and not NEW_BEHAVIOUR.search(title)


REFACTOR_NOTE = ("{id} is a refactor: no behaviour changes, so it has no test of its own. Its proof is that the existing "
                 "tests pass before the change (keel ran them) and after it (keel runs them again after you). Change the "
                 "structure only; do not change what a test or a caller can observe, and do not write a test that reads "
                 "the source code to check its shape.")


# ---------------------------------------------------------------- source-inspecting tests

# a call that reads a file's text
READS_FILE = re.compile(r"\b(file_get_contents|file\s*\(|fopen|SplFileObject|readFileSync|readFile|fs\.promises\.readFile|"
                        r"Files\.(?:readString|readAllLines|readAllBytes|lines|newBufferedReader)|readText|readLines|"
                        r"readBytes|FileReader|Scanner\s*\(\s*(?:new\s+)?File|read_text|read_bytes|open\s*\(|"
                        r"io\.open|os\.ReadFile|ioutil\.ReadFile|File\.read|IO\.read|File\.ReadAllText|"
                        r"Source\.fromFile|getResourceAsStream)\b", re.I)
# what tells the file read is the code under test: a source extension, the class's own file, the test's own folder
# (a fixture read next to the test, __DIR__ . '/fixtures/order.json', is not one)
SOURCE_REF = re.compile(r"\.(?:" + "|".join(SOURCE_EXT) + r")\b['\"`)]|getFileName\s*\(|__FILE__|__filename|"
                        r"['\"`/]src/|\binspect\.getsource|getsourcefile", re.I)
# the person asked for a check of the code's text (a lint-like rule): then reading source is the point
LINT_ASK = re.compile(r"\b(lint\w*|static (?:check|analysis)|architecture (?:test|rule)|arch ?unit|source (?:code )?"
                      r"(?:must|should) not|forbid\w* (?:import|call|usage)|no file may (?:import|call|use)|grep)\b", re.I)


def asks_for_source_check(*texts: str | None) -> bool:
    return any(LINT_ASK.search(str(t or "")) for t in texts)


def source_reads(root: str, files: list[str]) -> list[dict]:
    """[{file, line, text}] for each added line of these test files that reads a source file as text (a read call and a
    source reference on the same line or the next one)."""
    out: list[dict] = []
    for rel in files:
        p = Path(root) / rel
        try:
            if not p.is_file() or p.stat().st_size > 1_000_000:
                continue
            new = p.read_text(errors="replace")
        except OSError:
            continue
        old = None
        if git.is_repo(root) and git.tracked_in_head(root, rel):
            r = git.git(root, "show", f"HEAD:{rel}")
            old = r.stdout if r.returncode == 0 else None
        have = set((old or "").split("\n")) if old else set()
        lines = new.split("\n")
        for n, line in enumerate(lines):
            if line in have or not READS_FILE.search(line):
                continue
            window = line + " " + (lines[n + 1] if n + 1 < len(lines) else "")
            if SOURCE_REF.search(window):
                out.append({"file": rel, "line": n + 1, "text": line.strip()[:200]})
    return out


SOURCE_READ_NOTE = ("A test must check behaviour (what a caller or a user sees), not the source code's text. {where} "
                    "reads a source file as text and matches it, which proves only how the code is written today and "
                    "breaks on any harmless edit. Write a test that runs the code and checks its result. If the "
                    "criterion changes no behaviour (a refactor, an extract, a rename), write no new test and say so in "
                    "one line: its proof is that the existing tests pass before and after.")


# ---------------------------------------------------------------- frozen files

def frozen_why(phase: str, bucket: str) -> str:
    """Why a bucket is frozen in a phase, in plain words."""
    if phase == "green" and bucket in ("api-test", "web-test"):
        return "test code is frozen while making tests pass"
    if phase == "red" and bucket in ("api-main", "web-src"):
        return "production code is frozen while writing the failing test"
    if phase in ("refactor", "integration", "bug-fix") and bucket in ("api-test", "web-test"):
        return f"test code is frozen in phase {phase}"
    return f"{bucket} files are frozen in phase {phase}"


def _tracked(root: str) -> list[str]:
    if not git.is_repo(root):
        return []
    return [f for f in git.git(root, "ls-files").stdout.splitlines() if f.strip()]


def resolve(root: str, names: list[str], tracked: list[str] | None = None) -> list[str]:
    """Repo paths for file names: a path that exists stays; a bare or partial name maps to the one tracked file that ends
    with it (none or several: left out)."""
    out: list[str] = []
    files = None
    for name in names:
        if (Path(root) / name).is_file():
            out.append(name)
            continue
        files = files if files is not None else (tracked if tracked is not None else _tracked(root))
        hits = [f for f in files if f == name or f.endswith("/" + name)]
        if len(hits) == 1:
            out.append(hits[0])
    return list(dict.fromkeys(out))


def unlockable(phase: str, rel: str, cfg: dict) -> bool:
    """Is this a test file refused in this phase only by the phase matrix, so an unlock of it for the phase would let it
    pass? Only test code counts: a change to a test is what a test-frozen phase (GREEN) cannot make, while production
    code frozen in RED is the rule working (the person is never asked to allow it). A secret file, keel's rules or an
    existing migration stay refused whatever is unlocked."""
    if not is_test_file(cfg, rel) or rules.check_edit(phase, rel, cfg, exists=True).ok:
        return False
    return rules.check_edit(phase, rel, cfg, exists=True, unlocks=[{"path": rel, "phase": phase}]).ok


def frozen_named(root: str, phase: str, texts: list[str | None], unlocks: list[dict] | None,
                 cfg: dict | None = None) -> list[dict]:
    """[{path, bucket, why}] for the files these texts name that keel freezes in this phase (and nobody unlocked)."""
    cfg = cfg or rules.load_config(root)
    out = []
    for rel in resolve(root, named_files("\n".join(str(t or "") for t in texts))):
        if rules.unlocked(unlocks, rel, phase) or not unlockable(phase, rel, cfg):
            continue
        bucket = rules.classify(cfg, rel)
        out.append({"path": rel, "bucket": bucket, "why": frozen_why(phase, bucket)})
    return out


FROZEN_LINE = re.compile(r"^\W*FROZEN:\s*`?([^\s`]+)`?", re.M | re.I)


def frozen_said(text: str | None) -> list[str]:
    """The files an agent named in FROZEN: <file> lines (it cannot do its step without changing them)."""
    return list(dict.fromkeys(m.group(1).strip().rstrip(".,;") for m in FROZEN_LINE.finditer(str(text or ""))))


def frozen_note(files: list[dict], phase: str) -> str:
    """The step prompt's heads-up: the files its criterion names that this phase freezes."""
    if not files:
        return ""
    names = ", ".join(f"`{f['path']}`" for f in files)
    why = "; ".join(dict.fromkeys(f["why"] for f in files))
    return (f"Heads-up: this criterion names {names}, which keel's rules freeze in phase {phase} ({why}). keel puts "
            "back any change to it after your step, so do not try to change it or work around it. If the criterion "
            "cannot be met without changing it, stop at once and end your answer with one line per file, "
            "`FROZEN: <file>`: keel then asks the person whether to allow that file in this phase.")


def named_in(path: str, texts: list[str | None]) -> bool:
    """Does one of these texts name this file (its path, its file name, or its class name of 6+ characters)?"""
    text = "\n".join(str(t or "") for t in texts)
    if not text.strip():
        return False
    name = path.rsplit("/", 1)[-1]
    stem = name.rsplit(".", 1)[0]
    if path in text or name in text:
        return True
    return len(stem) >= 6 and re.search(rf"(?<![\w]){re.escape(stem)}(?![\w])", text) is not None
