"""KeelBot sessions, messages and folders in the engine DB (helper_sessions, helper_messages, helper_folders): the first part of helper.py."""

from __future__ import annotations

import json
import re
import uuid
from pathlib import Path

from keel_engine.models import catalog
from keel_engine.runtime import db
from keel_engine import models, rules
from keel_engine.tools import worktrees

MODES = ("ask", "edit", "fix", "side")
AGENT = "helper"
# keel 0.18.19 the person changed the mode in the middle of a chat (keel TUI /mode, Shift+Tab). Claude and Codex resume
# their own session, which still holds the old mode's rules: the next turn's prompt starts with a note of the change,
# as opencode's plan mode does when the person switches agents (from opencode (MIT), core/src/plugin/plan.ts).
MODE_NAMES = {"ask": "Ask mode (read only)", "edit": "Edit mode", "fix": "Fix mode", "side": "a side session (your own worktree)"}
MODE_NOW = {
    "ask": ("you may not change anything (no edits, no command that changes files or git), even what you offered or "
            "began before: give the person the exact command instead."),
    "edit": ("you may change files in the project folder and run commands that change something, each command after "
             "the person's OK. What Ask mode did not let you do, you may do now, if the person still wants it."),
    "fix": ("you may change only what the flow's phase allows, for the gate the flow waits at; keel's guard refuses "
            "the rest."),
    "side": ("you may change files again, in your own worktree only; each command that changes something waits for "
             "the person's OK."),
}
FIELDS = ("id", "project", "root", "mode", "title", "model_json", "engine_session", "status", "error", "thread_id",
          "tokens_in", "tokens_out", "tokens_cached", "cost_usd", "turns", "created_at", "updated_at", "grants_json", "phase",
          "worktree", "branch", "base_sha", "folder", "ctx_tokens")
FOLDER_FIELDS = ("id", "project", "name", "created_at", "updated_at")
FOLDER_NAME_MAX = 60
class HelperError(Exception):
    def __init__(self, status: int, message: str, hint: str = ""):
        super().__init__(message)
        self.status = status
        self.hint = hint



# ------------------------------------------------------------------ sessions and messages (the engine DB)

def _session(row) -> dict:
    s = dict(zip(FIELDS, row))
    s["model"] = db.loads(s.pop("model_json"), {})
    s["grants"] = db.loads(s.pop("grants_json"), [])
    s["ctx_window"] = catalog.context_window(s["model"].get("provider", ""), s["model"].get("model", ""))
    return s


def fix_phase(flow: dict | None) -> str:
    """The phase a Fix chat works in. At a gate the flow's own phase often lets only notes change (phase "gate" at the
    AC gate), yet a fix there is the work under review: so KeelBot takes the phase of the nearest earlier step whose
    rules let code change (at the AC gate "green"; the api sends `phases_before`, nearest first), else the flow's own."""
    f = flow or {}
    phase = str(f.get("phase") or "none")
    for ph in [phase, *(f.get("phases_before") or [])]:
        if ph and rules.edits_code(str(ph)):
            return str(ph)
    return phase


def create(project: str, root: str, mode: str = "ask", model: dict | None = None, title: str = "",
           thread_id: str | None = None, flow: dict | None = None) -> dict:
    if mode not in MODES:
        raise HelperError(400, f"Unknown KeelBot mode {mode!r}.", f"Use one of: {', '.join(MODES)}.")
    if not Path(root).is_dir():
        raise HelperError(400, f"The project folder {root} does not exist.")
    if mode == "fix" and not thread_id:
        raise HelperError(400, "Fix mode needs the flow that waits.", "Open it while a flow of this project waits at a gate.")
    sid = "h_" + uuid.uuid4().hex[:16]
    wt: dict = {}
    if mode == "side":
        short = sid[2:10]
        try:
            wt = worktrees.add(str(Path(root).resolve()), f"helper-{short}", f"keel/helper/{short}")
        except worktrees.WorktreeError as exc:
            raise HelperError(409, str(exc), exc.hint) from exc
        # keel 0.18.22 the stacks' setup.each_worktree (composer install, ...) in the new copy, in the background
        try:
            from keel_engine.runtime import stack_setup
        except ImportError:             # a keel older than 0.18.22 has no stack setup
            stack_setup = None
        if stack_setup:
            stack_setup.prepare_in_background(wt["path"])
    now = db.now()
    with db.connect() as conn:
        conn.execute(f"insert into helper_sessions ({', '.join(FIELDS)}) values ({', '.join('?' * len(FIELDS))})",
                     (sid, project, str(Path(root).resolve()), mode, title.strip()[:120] or "New chat",
                      json.dumps(models.effective(model)), None, "idle", None, thread_id, 0, 0, 0, 0.0, 0, now, now, "[]",
                      fix_phase(flow) if mode == "fix" else None, wt.get("path"), wt.get("branch"), wt.get("base"), None, 0))
    return get(sid)


def list_sessions(project: str, limit: int = 200) -> list[dict]:
    """The project's chats, the latest activity first. P1-3: each with `last_message` (a one-line preview of its last
    user or KeelBot message, "" when none) and `message_count` (every stored message), for keel TUI's /chats picker."""
    with db.connect() as conn:
        rows = conn.execute(f"select {', '.join(FIELDS)} from helper_sessions where project = ? order by updated_at desc limit ?",
                            (project, limit)).fetchall()
        sids = [r[0] for r in rows]
        marks = ", ".join("?" * len(sids))
        counts = dict(conn.execute(f"select session_id, count(*) from helper_messages where session_id in ({marks}) "
                                   "group by session_id", sids).fetchall()) if sids else {}
        lasts = dict(conn.execute(f"select m.session_id, m.text from helper_messages m where m.session_id in ({marks}) "
                                  "and m.n = (select max(x.n) from helper_messages x where x.session_id = m.session_id "
                                  "and x.role in ('user', 'helper'))", sids).fetchall()) if sids else {}
    out = [_session(r) for r in rows]
    for s in out:
        s["message_count"] = int(counts.get(s["id"], 0))
        s["last_message"] = preview(lasts.get(s["id"]) or "")
    return out


def preview(text: str, limit: int = 80) -> str:
    """P1-3 a message as one short line: its words on one line, cut at a word with "…" (as a title is)."""
    line = " ".join((text or "").split())
    return short_title(line, limit) if line else ""


def get(sid: str, messages: bool = True) -> dict:
    with db.connect() as conn:
        row = conn.execute(f"select {', '.join(FIELDS)} from helper_sessions where id = ?", (sid,)).fetchone()
        if not row:
            raise HelperError(404, f"No KeelBot session {sid}.")
        s = _session(row)
        if messages:
            msgs = conn.execute("select n, role, text, call_id, data_json, at from helper_messages where session_id = ? order by n",
                                (sid,)).fetchall()
            s["messages"] = [{"n": n, "role": role, "text": text, "call_id": call_id, "data": db.loads(dj, {}), "at": at}
                             for n, role, text, call_id, dj, at in msgs]
    return s


def update(sid: str, **fields) -> dict:
    allowed = {k: v for k, v in fields.items() if k in ("title", "model_json", "engine_session", "status", "error",
                                                       "tokens_in", "tokens_out", "tokens_cached", "cost_usd", "turns", "phase",
                                                       "ctx_tokens", "mode", "thread_id")}
    if allowed:
        sets = ", ".join(f"{k} = ?" for k in allowed)
        with db.connect() as conn:
            conn.execute(f"update helper_sessions set {sets}, updated_at = ? where id = ?", (*allowed.values(), db.now(), sid))
    return get(sid, messages=False)


def set_model(sid: str, model: dict) -> dict:
    """Another model for the next turn. A different provider cannot continue the CLI's own session: it starts fresh
    (with the conversation so far in the prompt)."""
    s = get(sid, messages=False)
    m = models.effective(model)
    same = (s["model"] or {}).get("provider") == m.get("provider")
    return update(sid, model_json=json.dumps(m), **({} if same else {"engine_session": None}))


def mode_note(was: str, now: str) -> str:
    """0.18.19 The note the next turn's prompt starts with when the mode changed since KeelBot's last answer."""
    if not was or was == now or was not in MODE_NAMES or now not in MODE_NAMES:
        return ""
    return (f"You were in {MODE_NAMES[was]}; you are now in {MODE_NAMES[now]}: {MODE_NOW[now]} The rules of "
            f"{MODE_NAMES[was].split(' (')[0]} from earlier in this conversation no longer apply: follow the mode below.")


def set_mode(sid: str, mode: str, thread_id: str | None = None, flow: dict | None = None) -> dict:
    """0.18.19 Another mode for the chat's next turn, in the same chat (it keeps its messages and its engine session;
    the next turn's prompt starts with a note of the change). Ask, Edit and Fix work in the project folder, so a chat
    moves between them; Fix needs the flow that waits (`thread_id`, and its phase from `flow`). A side session keeps
    its worktree: it moves between Side and Ask (read only, there). Into or out of a worktree is a new chat."""
    if mode not in MODES:
        raise HelperError(400, f"Unknown KeelBot mode {mode!r}.", f"Use one of: {', '.join(MODES)}.")
    s = get(sid, messages=False)
    if mode == s["mode"]:
        return s
    if is_side(s) and mode not in ("side", "ask"):
        raise HelperError(409, f"A side session works in its own worktree; {mode} mode works in the project folder.",
                          f"Start a new chat in {mode} mode (keel TUI: /new, then /mode {mode}).")
    if not is_side(s) and mode == "side":
        raise HelperError(409, "A side session needs its own worktree, which this chat does not have.",
                          "Start a new chat in side mode: keel TUI starts one with the next message after /mode side.")
    fields: dict = {"mode": mode}
    if mode == "fix":
        tid = thread_id or s.get("thread_id")
        if not tid:
            raise HelperError(400, "Fix mode needs the flow that waits.", "Switch while a flow of this project waits at a gate.")
        fields.update(thread_id=tid, phase=fix_phase(flow) if flow else (s.get("phase") or "none"))
    return update(sid, **fields)


def set_folder(sid: str, folder: str | None) -> dict:
    """v0.15.2 Put a chat into one of its project's folders (None or "": no folder). It keeps its place in the list:
    moving a chat is not new activity, so updated_at stays."""
    s = get(sid, messages=False)
    fid = (folder or "").strip() or None
    if fid:
        f = get_folder(fid)
        if f["project"] != s["project"]:
            raise HelperError(404, f"No folder {fid} in project {s['project']}.")
    with db.connect() as conn:
        conn.execute("update helper_sessions set folder = ? where id = ?", (fid, sid))
    return get(sid, messages=False)


# ------------------------------------------------------------------ v0.15.2 folders for the chats (per project)

def _folder_name(name: str) -> str:
    clean = " ".join((name or "").split())
    if not clean:
        raise HelperError(400, "A folder needs a name.", "Write a short name, for example Payments.")
    if len(clean) > FOLDER_NAME_MAX:
        raise HelperError(400, f"The folder name is too long ({len(clean)} characters).", f"Keep it under {FOLDER_NAME_MAX} characters.")
    return clean


def _same_name(conn, project: str, name: str, but: str | None = None) -> bool:
    rows = conn.execute("select id, name from helper_folders where project = ?", (project,)).fetchall()
    return any(n.casefold() == name.casefold() and i != but for i, n in rows)


def folders(project: str) -> list[dict]:
    """The project's folders by name, each with how many chats it holds."""
    with db.connect() as conn:
        rows = conn.execute(f"select {', '.join('f.' + x for x in FOLDER_FIELDS)}, "
                            "(select count(*) from helper_sessions s where s.folder = f.id) "
                            "from helper_folders f where f.project = ? order by lower(f.name)", (project,)).fetchall()
    return [{**dict(zip(FOLDER_FIELDS, r[:-1])), "chats": r[-1]} for r in rows]


def get_folder(fid: str) -> dict:
    with db.connect() as conn:
        row = conn.execute(f"select {', '.join(FOLDER_FIELDS)} from helper_folders where id = ?", (fid,)).fetchone()
    if not row:
        raise HelperError(404, f"No folder {fid}.")
    return dict(zip(FOLDER_FIELDS, row))


def create_folder(project: str, name: str) -> dict:
    clean = _folder_name(name)
    fid = "hf_" + uuid.uuid4().hex[:12]
    now = db.now()
    with db.connect() as conn:
        if _same_name(conn, project, clean):
            raise HelperError(409, f"A folder named {clean} exists already.", "Pick another name, or use that folder.")
        conn.execute(f"insert into helper_folders ({', '.join(FOLDER_FIELDS)}) values (?, ?, ?, ?, ?)", (fid, project, clean, now, now))
    return {**get_folder(fid), "chats": 0}


def rename_folder(fid: str, name: str) -> dict:
    f = get_folder(fid)
    clean = _folder_name(name)
    with db.connect() as conn:
        if _same_name(conn, f["project"], clean, but=fid):
            raise HelperError(409, f"A folder named {clean} exists already.", "Pick another name.")
        conn.execute("update helper_folders set name = ?, updated_at = ? where id = ?", (clean, db.now(), fid))
    return next(x for x in folders(f["project"]) if x["id"] == fid)


def delete_folder(fid: str) -> dict:
    """The folder goes; its chats stay, with no folder. Answers how many chats moved out."""
    get_folder(fid)
    with db.connect() as conn:
        moved = conn.execute("update helper_sessions set folder = null where folder = ?", (fid,)).rowcount
        conn.execute("delete from helper_folders where id = ?", (fid,))
    return {"ok": True, "moved": moved}


def add_grant(sid: str, command: str) -> list[str]:
    """"Always" for this command in this session."""
    s = get(sid, messages=False)
    grants = list(s["grants"])
    if command not in grants:
        grants.append(command)
        with db.connect() as conn:
            conn.execute("update helper_sessions set grants_json = ? where id = ?", (json.dumps(grants), sid))
    return grants


def delete(sid: str) -> None:
    """A side session's worktree and branch go too (throw away)."""
    s = get(sid, messages=False)
    if s.get("worktree"):
        worktrees.remove(s["root"], s["worktree"], s.get("branch"))
    with db.connect() as conn:
        _turn_table(conn)
        conn.execute("delete from helper_turn_files where session_id = ?", (sid,))
        conn.execute("delete from helper_files where session_id = ?", (sid,))
        conn.execute("delete from helper_messages where session_id = ?", (sid,))
        conn.execute("delete from helper_sessions where id = ?", (sid,))


def add_message(sid: str, role: str, text: str, call_id: str | None = None, data: dict | None = None) -> int:
    with db.connect() as conn:
        n = (conn.execute("select coalesce(max(n), 0) from helper_messages where session_id = ?", (sid,)).fetchone()[0] or 0) + 1
        conn.execute("insert into helper_messages (session_id, n, role, text, call_id, data_json, at) values (?, ?, ?, ?, ?, ?, ?)",
                     (sid, n, role, text, call_id, json.dumps(data or {}), db.now()))
        conn.execute("update helper_sessions set updated_at = ? where id = ?", (db.now(), sid))
    return n


def short_title(text: str, limit: int = 80) -> str:
    """A chat's title from its first message: the first line, cut at a word with "…" when it is long."""
    line = " ".join(text.strip().splitlines()[0].split()) if text.strip() else "New chat"
    if len(line) <= limit:
        return line
    cut = line[:limit - 1]
    return (cut.rsplit(" ", 1)[0] if " " in cut[limit // 2:] else cut).rstrip(" ,.;:-") + "…"


def is_side(s: dict) -> bool:
    """A side session, in whatever mode it is now (0.18.19 it can switch to Ask): it has its own branch."""
    return s.get("mode") == "side" or bool(s.get("branch"))


# 0.18.19 a new chat's own title, at no second model call: its first answer ends with one hidden line that keel takes
# out (the rules from opencode (MIT), core/src/plugin/agent.ts PROMPT_TITLE). A title the person gave stays.
TITLE_ASK = ("This is the first message of a new chat. After your whole answer, end with one last line of the form "
             "`TITLE: <title>`: a title of 3 to 6 words that helps the person find this chat later. Use the same "
             "language as the person's message; name the main topic or what they want done (with a file: what they "
             "want done with it); keep technical terms, numbers and file names exact; leave out the, this, my, a, an; "
             "no quotes, no tool names, at most 50 characters. keel removes this line before the person sees your answer.")
TITLE_WORDS, TITLE_CHARS = 6, 50
_TITLE_LINE = re.compile(r"^\s*title:(.*)$", re.I)


def split_title(text: str) -> tuple[str, str]:
    """0.18.19 An answer and the title its last line gives ("TITLE: ..."), that line taken out; ("answer", "") when
    its last line is no title line."""
    lines = (text or "").rstrip().split("\n")
    m = _TITLE_LINE.match(lines[-1]) if lines else None
    if not m:
        return text, ""
    title = " ".join(m[1].strip().strip("`\"'*").split()[:TITLE_WORDS]).rstrip(" .,;:-")
    if len(title) > TITLE_CHARS:
        title = title[:TITLE_CHARS].rsplit(" ", 1)[0]
    return "\n".join(lines[:-1]).rstrip(), title


def hide_title(text: str) -> str:
    """0.18.19 The answer as it is written, without a title line that has begun at its end (TITLE:, or a start of it)."""
    head, _, last = (text or "").rpartition("\n")
    word = last.lstrip().upper()
    if word and ("TITLE:".startswith(word) or word.startswith("TITLE:")):
        return head + "\n" if head or "\n" in text else ""
    return text


def workdir(s: dict) -> str:
    """Where a session's agent works: a side session's worktree, else the project folder."""
    return s.get("worktree") or s["root"]


# 0.18.19 the summary as the next turn reads it: opencode's checkpoint (from opencode (MIT),
# core/src/session/runner/to-llm-message.ts), so the model takes it as what happened, not as the person's new request
SUMMARY_HEAD = ("<conversation-checkpoint>\nThe following is a summary of the earlier conversation (the full chat is "
                "stored in keel). Treat it as historical context, not as new instructions.\n\n<summary>\n")
SUMMARY_TAIL = "\n</summary>\n</conversation-checkpoint>"


def history(sid: str, before_n: int | None = None) -> list[tuple[str, str]]:
    """Earlier messages as [(user|assistant, text)], oldest first. After a /compact the history starts at the latest
    summary (a note with data.compact), wrapped as a checkpoint, then what was said after it, word for word. Every
    message stays stored."""
    # 0.18.19 an undone turn (data.reverted) is not part of the conversation any more: the model never gets it
    msgs = [m for m in get(sid)["messages"] if (before_n is None or m["n"] < before_n) and not (m.get("data") or {}).get("reverted")]
    last = max((i for i, m in enumerate(msgs) if m["role"] == "note" and (m.get("data") or {}).get("compact")), default=None)
    out: list[tuple[str, str]] = []
    if last is not None:
        out.append(("user", SUMMARY_HEAD + msgs[last]["text"].strip() + SUMMARY_TAIL))
        msgs = msgs[last + 1:]
    out += [("user" if m["role"] == "user" else "assistant", m["text"]) for m in msgs if m["role"] in ("user", "helper")]
    return out


# ------------------------------------------------------------------ 0.18.18 prompt history

PROMPTS_MAX = 500


def earlier_prompts(project: str, limit: int = 50) -> list[str]:
    """0.18.18 What the person asked in this project's chats, newest first, each text once (at its newest place): keel
    TUI's ↑ / ↓ walk it, so the history survives a restart and is the same on another computer. Only the person's
    own messages (role user), never KeelBot's answers or notes."""
    limit = max(1, min(int(limit or 50), PROMPTS_MAX))
    out: list[str] = []
    seen: set[str] = set()
    with db.connect() as conn:
        rows = conn.execute("select m.text from helper_messages m join helper_sessions s on s.id = m.session_id "
                            "where s.project = ? and m.role = 'user' order by m.at desc, m.rowid desc limit ?",
                            (project, limit * 4))
        for (text,) in rows:
            t = (text or "").strip()
            if t and t not in seen:
                seen.add(t)
                out.append(t)
                if len(out) >= limit:
                    break
    return out


# ------------------------------------------------------------------ P1-3 /export

EXPORT_DIR = (".keel", "chats")
EXPORT_ROLES = {"user": "user", "helper": "KeelBot", "note": "note"}


def export(sid: str) -> dict:
    """P1-3 Writes the chat as Markdown into its project's .keel/chats/<sid>.md (the project folder, a side session's
    too): the title, then every stored message in order, each under "## <n>. <role> · <time>". It only reads the
    session: nothing stored changes. Answers the file's path and how many messages it holds."""
    s = get(sid)
    msgs = s["messages"]
    model = s.get("model") or {}
    lines = [f"# {s['title']}", "",
             f"KeelBot chat {sid} · {s['mode']} · {model.get('provider', '?')}/{model.get('model', '?')} · "
             f"{len(msgs)} messages · exported {db.now()}", ""]
    for m in msgs:
        lines += [f"## {m['n']}. {EXPORT_ROLES.get(m['role'], m['role'])} · {m['at']}", "", (m["text"] or "").rstrip(), ""]
    path = Path(s["root"]).joinpath(*EXPORT_DIR, f"{sid}.md")
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text("\n".join(lines), encoding="utf-8")
    return {"path": str(path), "messages": len(msgs)}


TURN_TABLE = """create table if not exists helper_turn_files (
  session_id text not null, n integer not null, path text not null, before_exists integer not null, before blob,
  after_exists integer not null, after blob, kept integer not null default 0, primary key (session_id, n, path)
)"""


def _turn_table(conn) -> None:
    """0.18.19 helper_turn_files is KeelBot's own table (core's migrate.py keeps only its old ones): made on first use."""
    conn.execute(TURN_TABLE)
