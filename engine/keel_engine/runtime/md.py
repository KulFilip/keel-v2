"""Markdown for gate details: the dashboard renders a gate's text as Markdown, keel's TUI and MCP show it as text.

A gate detail is a small document: a `## heading` per part, paragraphs for the explanation, lists only for real lists,
tables for field and change summaries, a short **bold** verdict line. Code is always code: a path, a field, a command,
a key or an id is `inline code`; a diff, JSON, SQL, a log or command output is a fenced block with its language. Raw
diff or JSON never goes into Markdown text without a fence (underscores would turn into italics, `-` lines into list
items), so every builder uses these helpers:

    code("vat_updated_at")            -> `vat_updated_at`
    fence(diff_text, "diff")          -> ```diff ... ``` (a longer fence when the text holds one)
    section("In plain words", body)   -> "## In plain words\\n\\n<body>"
    table(["field", "change"], rows)  -> a Markdown table, cells escaped
    cut(text, n)                      -> at most n characters, an open fence closed again
"""

from __future__ import annotations

import re

FENCE_LINE = re.compile(r"^\s*(`{3,}|~{3,})")
LANGS = {".json": "json", ".yaml": "yaml", ".yml": "yaml", ".sql": "sql", ".kt": "kotlin", ".kts": "kotlin", ".java": "java",
         ".ts": "ts", ".tsx": "tsx", ".js": "js", ".jsx": "jsx", ".py": "python", ".sh": "bash", ".md": "markdown",
         ".xml": "xml", ".toml": "toml", ".go": "go", ".rs": "rust", ".css": "css", ".html": "html"}


def code(text) -> str:
    """`text` as inline code; a backtick inside gets a longer delimiter."""
    s = str(text).replace("\n", " ")
    if not s:
        return ""
    run = max((len(m) for m in re.findall(r"`+", s)), default=0)
    tick = "`" * (run + 1)
    pad = " " if s.startswith("`") or s.endswith("`") else ""
    return f"{tick}{pad}{s}{pad}{tick}"


def fence(text: str, lang: str = "text") -> str:
    """The text in a fenced block: ```lang … ```. The fence is longer than any fence line inside the text."""
    body = str(text or "").replace("\r\n", "\n").rstrip("\n")
    run = max((len(m.group(1)) for line in body.split("\n") if (m := FENCE_LINE.match(line)) and m.group(1)[0] == "`"),
              default=0)
    tick = "`" * max(3, run + 1)
    return f"{tick}{lang}\n{body}\n{tick}"


def lang_of(path: str | None) -> str:
    m = re.search(r"(\.[A-Za-z0-9]+)$", str(path or ""))
    return LANGS.get(m.group(1).lower(), "text") if m else "text"


def section(title: str, *parts: str) -> str:
    body = "\n\n".join(p.strip("\n") for p in parts if p and p.strip())
    return f"## {title}\n\n{body}".rstrip()


def verdict(text: str) -> str:
    t = text.strip()
    return f"**Verdict: {t}{'' if t.endswith(('.', '!', '?')) else '.'}**"


def cell(text) -> str:
    """A table cell: one line, a pipe escaped."""
    return str(text if text is not None else "").replace("\n", " ").replace("|", "\\|").strip() or " "


def table(head: list[str], rows: list[list], limit: int = 40) -> str:
    out = ["| " + " | ".join(cell(h) for h in head) + " |", "|" + "|".join("---" for _ in head) + "|"]
    out += ["| " + " | ".join(cell(c) for c in r) + " |" for r in rows[:limit]]
    if len(rows) > limit:
        out.append(f"\n… and {len(rows) - limit} more rows.")
    return "\n".join(out)


def bullets(items: list[str]) -> str:
    return "\n".join(f"- {x}" for x in items)


def safe_words(text: str) -> str:
    """Prose from outside keel (a schema description, an agent's line): words with `_` or `*` become inline code, so
    Markdown does not read them as italics or bold."""
    s = str(text or "").replace("`", "'")
    return re.sub(r"[^\s()\[\],;]*[_*][^\s()\[\],;]*", lambda m: code(m.group(0)), s)


def doc(*parts: str) -> str:
    return "\n\n".join(p.strip("\n") for p in parts if p and p.strip())


def cut(text: str, limit: int, note: str = "… (cut; see the repository for the rest)") -> str:
    """At most `limit` characters; a fenced block the cut lands in is closed again, then the note."""
    if len(text) <= limit:
        return text
    head = text[:limit]
    head = head[:head.rfind("\n")] if "\n" in head else head
    open_fence = None
    for line in head.split("\n"):
        m = FENCE_LINE.match(line)
        if not m:
            continue
        if open_fence is None:
            open_fence = m.group(1)
        elif line.strip() == open_fence[0] * len(line.strip()) and len(line.strip()) >= len(open_fence):
            open_fence = None
    return head + (f"\n{open_fence}" if open_fence else "") + f"\n\n{note}"


def unfence(text: str) -> str:
    """For plain-text views (TUI, MCP): the fence lines dropped, the code kept."""
    return "\n".join(line for line in str(text or "").split("\n") if not re.match(r"^\s*(`{3,}|~{3,})[\w+#.-]*\s*$", line))


def diff_blocks(diff: str) -> list[str]:
    """A git diff as one labelled ```diff block per file: "`path` (+3 / -1)" then the fence."""
    chunks, cur = [], []
    for line in str(diff or "").replace("\r\n", "\n").split("\n"):
        if line.startswith("diff --git ") and cur:
            chunks.append(cur)
            cur = []
        cur.append(line)
    if cur and any(x.strip() for x in cur):
        chunks.append(cur)
    out = []
    for ch in chunks:
        m = re.match(r"diff --git a/(.+?) b/(.+)$", ch[0])
        path = m.group(2) if m else next((x[6:] for x in ch if x.startswith("+++ b/")), "")
        add = sum(1 for x in ch if x.startswith("+") and not x.startswith("+++"))
        rem = sum(1 for x in ch if x.startswith("-") and not x.startswith("---"))
        label = f"{code(path)} (+{add} / -{rem})" if path else f"(+{add} / -{rem})"
        out.append(f"{label}\n\n{fence(chr(10).join(ch).strip(chr(10)), 'diff')}")
    return out


def new_file_block(path: str, body: str, limit: int = 200) -> str:
    lines = str(body or "").splitlines()
    shown = "\n".join("+" + x for x in lines[:limit]) + (f"\n+… ({len(lines) - limit} more lines)" if len(lines) > limit else "")
    return f"new file {code(path)} (+{len(lines)} lines)\n\n{fence(shown, 'diff')}"


def demote(text: str) -> str:
    """Markdown from the spec or an agent inside a gate section: its headings two levels down, under the gate's parts."""
    out, opened = [], None
    for line in str(text or "").split("\n"):
        m = FENCE_LINE.match(line)
        if m:
            opened = None if opened and line.strip().startswith(opened) else (opened or m.group(1))
        elif not opened:
            line = re.sub(r"^(#{1,5})(\s)", lambda h: "#" * min(6, len(h.group(1)) + 2) + h.group(2), line)
        out.append(line)
    return "\n".join(out)
