"""The SQL reader's lexer: statements -> tokens, and the cursor over one statement (a part of sqlschema.py)."""

from __future__ import annotations

import re
from dataclasses import dataclass, field

# A column definition's type ends at the first of these (at depth 0).
TYPE_STOP = {
    "not", "null", "default", "primary", "unique", "references", "check", "constraint", "collate", "generated",
    "auto_increment", "autoincrement", "identity", "comment", "on", "as", "encode", "charset", "deferrable",
    "initially", "compression", "storage", "visible", "invisible", "sparse", "rowguidcol", "key", "masked", "with",
}
DEFAULT_STOP = TYPE_STOP - {"with", "key"}
TABLE_CONSTRAINT = {"constraint", "primary", "unique", "foreign", "check", "exclude", "like", "fulltext", "spatial", "period"}
DOWN_MARK = re.compile(r"^[ \t]*--[ \t]*(migrate:down|\+goose[ \t]+down)\b.*$", re.I | re.M)
UP_MARK = re.compile(r"^[ \t]*--[ \t]*(migrate:up|\+goose[ \t]+up)\b.*$", re.I | re.M)


# ------------------------------------------------------------------ lexing

@dataclass
class Tok:
    kind: str      # id (a bare word), qid (a quoted identifier), str, num, op
    val: str       # the identifier without its quotes, the string's content, the operator
    pos: int       # offset of the first character in the file
    end: int       # offset after the last character

    def word(self, *words: str) -> bool:
        return self.kind == "id" and self.val.lower() in words

    @property
    def ident(self) -> bool:
        return self.kind in ("id", "qid")


def _blank(text: str, a: int, b: int) -> str:
    """Spaces for text[a:b], newlines kept, so offsets and line numbers stay true."""
    return text[:a] + re.sub(r"[^\n]", " ", text[a:b]) + text[b:]


def strip_down_sections(text: str) -> str:
    """dbmate (`-- migrate:down`) and goose (`-- +goose Down`) keep the undo in the same file: drop it."""
    while (m := DOWN_MARK.search(text)):
        up = UP_MARK.search(text, m.end())
        text = _blank(text, m.start(), up.start() if up else len(text))
    return text


def tokens(text: str) -> list[list[Tok]]:
    """The statements of a file as token lists: comments dropped, split at a top-level `;` or a line that is only GO."""
    out: list[list[Tok]] = []
    cur: list[Tok] = []
    i, n = 0, len(text)

    def end_stmt():
        nonlocal cur
        if cur:
            out.append(cur)
        cur = []

    while i < n:
        c = text[i]
        if c in " \t\r\n\f":
            i += 1
        elif text.startswith("--", i) or (c == "#" and text[text.rfind("\n", 0, i) + 1:i].strip() == ""):
            j = text.find("\n", i)
            i = n if j < 0 else j
        elif text.startswith("/*", i):
            depth, i = 1, i + 2
            while i < n and depth:
                if text.startswith("/*", i):
                    depth, i = depth + 1, i + 2
                elif text.startswith("*/", i):
                    depth, i = depth - 1, i + 2
                else:
                    i += 1
        elif c == "'" or (c in "eEnN" and text.startswith("'", i + 1)):
            start = i
            i += 1 if c == "'" else 2
            escapes = c in "eE"
            buf = []
            while i < n:
                if escapes and text[i] == "\\" and i + 1 < n:
                    buf.append(text[i + 1])
                    i += 2
                elif text[i] == "'":
                    if text.startswith("''", i):
                        buf.append("'")
                        i += 2
                    else:
                        i += 1
                        break
                else:
                    buf.append(text[i])
                    i += 1
            cur.append(Tok("str", "".join(buf), start, i))
        elif c in '"`':
            j = i + 1
            while j < n and not (text[j] == c and not text.startswith(c * 2, j)):
                j += 2 if text.startswith(c * 2, j) else 1
            cur.append(Tok("qid", text[i + 1:j].replace(c * 2, c), i, min(j + 1, n)))
            i = j + 1
        elif c == "[" and (m := re.match(r"\[([^\]\n\[]*[A-Za-z_][^\]\n\[]*)\]", text[i:])) and not (i and text[i - 1].isalnum()):
            cur.append(Tok("qid", m.group(1), i, i + m.end()))
            i += m.end()
        elif c == "$" and (m := re.match(r"\$([A-Za-z_]\w*)?\$", text[i:])):
            close = text.find(m.group(0), i + m.end())
            j = n if close < 0 else close + m.end()
            cur.append(Tok("str", text[i + m.end():close if close >= 0 else n], i, j))
            i = j
        elif c.isdigit():
            m = re.match(r"\d+(\.\d+)?", text[i:])
            cur.append(Tok("num", m.group(0), i, i + m.end()))
            i += m.end()
        elif c.isalpha() or c == "_" or ord(c) > 127:
            m = re.match(r"[\w$]+", text[i:])
            w = m.group(0)
            line_start = text.rfind("\n", 0, i) + 1
            line_end = text.find("\n", i)
            line_end = n if line_end < 0 else line_end
            if w.lower() == "go" and not text[line_start:i].strip() and not text[i + len(w):line_end].strip():
                end_stmt()
            else:
                cur.append(Tok("id", w, i, i + len(w)))
            i += len(w)
        elif c == ";":
            end_stmt()
            i += 1
        else:
            cur.append(Tok("op", c, i, i + 1))
            i += 1
    end_stmt()
    return out


# ------------------------------------------------------------------ a cursor over one statement

class Cur:
    def __init__(self, toks: list[Tok], text: str):
        self.t, self.i, self.text = toks, 0, text

    def peek(self, k: int = 0) -> Tok | None:
        j = self.i + k
        return self.t[j] if 0 <= j < len(self.t) else None

    def done(self) -> bool:
        return self.i >= len(self.t)

    def next(self) -> Tok | None:
        tok = self.peek()
        self.i += 1
        return tok

    def at(self, *words: str) -> bool:
        """The next tokens are these keywords (a word may be "a|b")."""
        for k, w in enumerate(words):
            tok = self.peek(k)
            if not tok or not tok.word(*w.split("|")):
                return False
        return True

    def eat(self, *words: str) -> bool:
        if self.at(*words):
            self.i += len(words)
            return True
        return False

    def op(self, ch: str) -> bool:
        tok = self.peek()
        if tok and tok.kind == "op" and tok.val == ch:
            self.i += 1
            return True
        return False

    def name(self) -> tuple[str | None, str, Tok] | None:
        """A possibly qualified name: `a`, `s.a`, `"S"."A"`, `db.s.a` (the last two parts count)."""
        tok = self.peek()
        if not tok or not tok.ident:
            return None
        parts = [tok]
        self.i += 1
        while self.peek() and self.peek().kind == "op" and self.peek().val == "." and self.peek(1) and self.peek(1).ident:
            parts.append(self.peek(1))
            self.i += 2
        schema = parts[-2].val if len(parts) > 1 else None
        return schema, parts[-1].val, parts[-1]

    def group(self) -> list[Tok] | None:
        """The tokens inside the next (...), the cursor after its `)`; None when no `(` is next."""
        tok = self.peek()
        if not tok or tok.kind != "op" or tok.val != "(":
            return None
        depth, start = 0, self.i
        while not self.done():
            tok = self.next()
            if tok.kind == "op" and tok.val == "(":
                depth += 1
            elif tok.kind == "op" and tok.val == ")":
                depth -= 1
                if depth == 0:
                    return self.t[start + 1:self.i - 1]
        return self.t[start + 1:]

    def skip_value(self):
        """One token, or a whole (...) group."""
        if self.group() is None:
            self.next()

    def src(self, toks: list[Tok]) -> str:
        return re.sub(r"\s+", " ", self.text[toks[0].pos:toks[-1].end]).strip() if toks else ""


def split_top(toks: list[Tok]) -> list[list[Tok]]:
    """Split at commas outside parentheses."""
    out, cur, depth = [], [], 0
    for tok in toks:
        if tok.kind == "op" and tok.val in "([":
            depth += 1
        elif tok.kind == "op" and tok.val in ")]":
            depth -= 1
        if tok.kind == "op" and tok.val == "," and depth == 0:
            out.append(cur)
            cur = []
        else:
            cur.append(tok)
    if cur:
        out.append(cur)
    return out


def column_list(toks: list[Tok]) -> list[str]:
    """`(a, b DESC, lower(c), d(10))` -> ["a", "b", "lower(c)", "d"]."""
    out = []
    for item in split_top(toks):
        if not item:
            continue
        first = item[0]
        if first.ident and (len(item) == 1 or not (item[1].kind == "op" and item[1].val == "(")):
            out.append(first.val)
        elif first.ident and len(item) >= 4 and item[2].kind == "num" and item[3].val == ")":
            out.append(first.val)                             # MySQL prefix length: name(10)
        else:
            out.append("".join(t.val if t.kind != "str" else f"'{t.val}'" for t in item))
    return out
