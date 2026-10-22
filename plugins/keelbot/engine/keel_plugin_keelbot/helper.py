"""KeelBot (plugins/keelbot): chat sessions in the Code page, run by keel's own harness under keel's rules.

A session belongs to one project and one mode. One turn is one agent run, shaped like a flow's agent step
(runtime/compiler.py `_run_agent`): the model's runner (claude, codex, copilot / opencode, an API key or the fake
model), keel's guarded tools (ToolBox), the MCP servers KeelBot may use plus the code graph, the guard context
the hook reads on every tool call, and the diff guard as the backstop for engines without a hook.

    modes   ask   read only: no edit, no new file, no command that changes files or git (the guard's readonly)
            fix   while the project's flow waits at a gate: edits under the flow's phase rules and unlocks; a command
                  that changes something waits for the person's OK (runtime/permissions.py); keel remembers each file
                  as it was before KeelBot's first change (Undo), and Done runs the checks and makes keel's commit
            edit  any time, in the project folder itself (keel 0.18.7): edits under keel's always-on rules only (secrets,
                  .git, old migrations; no flow's phase), commands that change something (git checkout, a build) asked
                  as in Fix; keel remembers each file as it was (Undo) and Keep runs the checks and makes keel's commit
            side  any time, in its own copy of the project (a git worktree on branch keel/helper/<id>, tools/worktrees.py):
                  free edits there and nowhere else, commands asked as in Fix; Keep runs the checks and commits on that
                  branch; the person hands it over (a task, a change flow on the branch) or throws it away

How a session continues: claude and codex continue their own CLI session (cheap: their context stays cached); the
API-key runner gets the earlier messages; the other CLIs get the conversation so far in the prompt.

Events (thread_id = the session id, step "helper"): helper.started, helper.step, helper.finished. The api stores
them as agent calls (agent "helper", so the budget, Live agents and Jobs count them) but never as a flow. Live, never
stored: helper.delta (the answer so far), 0.18.23 helper.thinking.delta (the model's thinking so far) and
helper.tool (each tool call as one record: name, args, status, summary, output; keel TUI's tool lines).

Its sessions live in the engine DB's helper_sessions, helper_messages and helper_files: core's runtime/migrate.py
still makes them (the old tables stay core). Its routes are routes.py; its runner starts and stops with keel's app
(the part's lifespan, __init__.py).
"""

from __future__ import annotations

import asyncio
import difflib
import json
import logging
import re
import secrets
import subprocess
import tempfile
import time
import uuid
from pathlib import Path

from keel_engine import approvals, config, extensions, models, rules
from keel_engine.models import catalog
from keel_engine.models.base import AgentRequest, AgentResult
try:                                    # keel 0.18.2: live text (an older core has no deltas: KeelBot drops them)
    from keel_engine.models.stream import DeltaThrottle
except ImportError:                     # pragma: no cover
    class DeltaThrottle:                # type: ignore[no-redef]
        def __init__(self, send, *a, **k): pass
        def add(self, chunk): pass
        def flush(self): pass
        def reset(self): pass
from keel_engine.runtime.blockers import for_agents as push_blockers_for
from keel_engine.runtime import agent_knowledge, db, doc_history, guard_ctx, permissions, plugins, prompts, repeats
from keel_engine.tools import git, guard, testcmd, worktrees
from keel_engine.tools.agent_tools import ToolBox, command_env

from . import ASK_PATH as PART_ASK_PATH
from . import keelbot

log = logging.getLogger(__name__)

MODES = ("ask", "edit", "fix", "side")
AGENT = "helper"
RESUMABLE = {"claude", "codex"}          # CLIs that continue their own session (runtime/compiler.py RESUMABLE)
TRANSCRIPT_CHARS = 6000                  # the conversation so far, for the engines that cannot continue a session
HISTORY_TURNS = 12                       # earlier messages an API-key model gets
TURN_TIMEOUT = 900
SHELL_TIMEOUT = 300                      # 0.18.18 a `!command` the person runs (keel TUI), once it may run
COMPACT_RATIO = 0.85                     # ctx_tokens / ctx_window above this: compact before the next turn runs
COMPACT_WINDOW = 128_000                 # 0.18.19 the window assumed for /compact when the model's is unknown
COMPACT_SHARE = 0.5                      # of the window (as characters, about 4 a token) the chat to summarise may fill
STEP_FIELD_MAX = 24_000
MODE_TEXT = {
    "ask": ("Mode: Ask. Read only: you change nothing (no edits, no new files, no command that changes files or git). "
            "When the person asks for a change (edit a file, git checkout or switch a branch, install, build, commit), do "
            "not try it and do not try other ways around it: say in one line that Ask mode is read only, and give the "
            "exact command they asked for (for example `git checkout main`), so they can run it themselves. Then offer "
            "the ways forward as a keel-questions block: switch to Edit (recommended: in keel TUI `/mode edit`, in the "
            "dashboard the chat's mode menu; it works in the project folder and every command that changes something "
            "waits for their OK), a side session (`/mode side`: its own copy on its own branch), or run the command "
            "themselves. You cannot switch the mode yourself: after they switch, they ask again."),
    "fix": ("Mode: Fix at a gate. The flow waits for the person at a gate, and the person asked you to change something. "
            "Edit only what the request needs, with the smallest change; keel's guard refuses files the flow's phase "
            "({phase}) does not allow. Reading, searching and running the tests need no OK; any other command that changes "
            "something waits for the person's OK. Never commit: when the person presses Done, keel runs the checks and "
            "commits your change. End with one short line per file you changed."),
    "edit": ("Mode: Edit. You work in the project folder itself, with no flow: edit what the person asks, with the smallest "
             "change; keel's always-on rules still apply (no secrets, never write .git by hand, no applied migration). "
             "Reading, searching and running the tests need no OK; any other command that changes something waits for the "
             "person's OK, and keel shows them each command first. Git work on the person's branch is yours to do when they "
             "ask for it: git status, git stash and git stash pop, git checkout or git switch, git fetch and git pull, and "
             "git commit of the person's own changes when they choose that (you write the message, they OK the command). "
             "A command that throws work away (git checkout -- ., git restore, git reset --hard, git clean, git stash "
             "drop) only when the person picked exactly that, and say first what is lost. Never commit your own file "
             "changes and never push: when the person keeps your change, keel runs the checks and commits it. End with "
             "one short line per file you changed."),
    "side": ("Mode: Side session. You work in your own copy of the project: a git worktree on branch {branch}, not the "
             "main folder. Edit freely there, but only there (keel refuses a file outside it); nothing you do touches the "
             "main folder or a flow running in it. Reading, searching and running the tests need no OK; any other command "
             "that changes something (git stash, git pull, git checkout in this worktree) waits for the person's OK. Never "
             "commit your own changes: the person keeps your work (keel runs the checks and commits it on the branch), "
             "hands it over as a task or a flow, or throws it away. End with one short line per file you changed."),
}
# keel 0.18.18 when something fails (every mode). A person asked to check out main with uncommitted changes in the
# folder; `git checkout main` failed, and KeelBot ran it again on every "fix it" and ended with "I cannot". The way
# opencode does it (and now keel): read the error, say why in one line, offer the ways forward, do what the person picks.
FAILURES = ("When a command or a tool fails, or keel refuses it: never run the same thing again unchanged (keel refuses an "
            "exact repeat while nothing in the folder changed). Read the error, and say in one line why it failed, quoting "
            "the error's own words. Then offer 2 to 4 ways forward as a keel-questions block, the safe one first and "
            "recommended, each with what it does and what it costs, and a way to leave it as it is; then stop and wait. "
            "Never end with only \"I cannot\": there is always a next step to offer. After the person's answer, do what "
            "they picked, step by step (each command that changes something waits for their OK). If they deny a command, "
            "their reason comes back to you: go on from what they said, do not ask for the same command again.\n"
            "For example `git checkout main` fails with \"Your local changes to the following files would be overwritten "
            "by checkout\": say that the folder has uncommitted changes in those files, and offer: stash them, check out "
            "main, pull, then git stash pop (recommended: nothing is lost); commit them first on this branch; discard them "
            "(git checkout -- <files>: they are lost); or leave it as it is.")
# 0.18.23 KeelBot asked a question card for leave to read code ("What should I do next? → Read the handler and entity,
# then confirm the rule fits (recommended)"). Reading needs nobody's OK, in Ask mode too: only the person's own choices
# are asked.
READING = ("Reading is always allowed, in every mode (Ask mode too): reading files, searching the code and explaining "
           "need nobody's OK. Never ask the person before you read, search or explain, and never offer it as an option "
           "in a keel-questions block (\"Read the handler first?\"): do it, in the same turn. Ask only for choices that "
           "are the person's: a decision, a change to a file, a command that changes something. When the person asks "
           "whether you read the code (\"did you read the code?\"), read it now and answer from it in the same turn, "
           "with file:line.")
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
COMMITS = {          # keel's commit line in KeelBot's system prompt (runtime/prompts.py system_prompt), per mode
    "edit": ("keel commits your own file changes after its checks (when the person keeps them); never git commit them "
             "yourself, and never push. Only the person's own uncommitted work may be committed with git commit, when they "
             "choose that, and the command waits for their OK."),
}
# Ask mode's refusals in its own words (the guard said "this flow runs read-only", and KeelBot looked for a flow)
ASK_LABEL = "KeelBot's Ask mode is read only"
ASK_NOTE = ("You cannot switch the mode yourself and must not try another way around it. Say so in one line, give the "
            "exact command for the person to run, and offer the ways forward as a keel-questions block: switch to Edit "
            "(recommended; keel TUI `/mode edit`, the dashboard's mode menu), a side session (`/mode side`), or run it "
            "themselves.")
DIFF_MAX = 40_000
ASK_PATH = PART_ASK_PATH               # where the guard hook asks (it checks the turn's key, then asks approvals.py)

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


# ------------------------------------------------------------------ Fix mode: the files KeelBot changed

def _head_bytes(root: str, rel: str) -> bytes | None:
    if not git.tracked_in_head(root, rel):
        return None
    r = subprocess.run(["git", "show", f"HEAD:{rel}"], cwd=root, capture_output=True, timeout=30)
    return r.stdout if r.returncode == 0 else None


def remember_originals(sid: str, root: str, before: guard.Snapshot | None) -> list[str]:
    """After a Fix turn: each file it changed for the first time is remembered as it was before (the user's own
    uncommitted version when there was one, else HEAD, else "did not exist"). Returns the newly remembered paths."""
    if before is None:
        return []
    changed = guard.changed_since(root, before)
    if not changed:
        return []
    with db.connect() as conn:
        known = {r[0] for r in conn.execute("select path from helper_files where session_id = ?", (sid,))}
        new = []
        for rel in changed:
            if rel in known:
                continue
            original = before.content[rel] if rel in before.content else _head_bytes(root, rel)
            conn.execute("insert into helper_files (session_id, path, existed, content, at) values (?, ?, ?, ?, ?)",
                         (sid, rel, 0 if original is None else 1, original, db.now()))
            new.append(rel)
    return new


def _text(b: bytes | None) -> str:
    return "" if b is None else b.decode("utf-8", errors="replace")


def changes(sid: str) -> list[dict]:
    """The files KeelBot changed in this session, against what they were before: path, status, +/- lines, diff.
    A side session: what is not kept yet (its worktree against the last commit on its branch)."""
    s = get(sid, messages=False)
    if is_side(s):
        return worktrees.changes(s["worktree"], "HEAD") if s.get("worktree") else []
    root = s["root"]
    with db.connect() as conn:
        rows = conn.execute("select path, existed, content from helper_files where session_id = ? order by path", (sid,)).fetchall()
    out = []
    for rel, existed, content in rows:
        f = Path(root) / rel
        now = f.read_bytes() if f.is_file() else None
        entry = _change(rel, content if existed else None, now)
        if entry:
            out.append(entry)
    return out


def _change(rel: str, before: bytes | None, now: bytes | None) -> dict | None:
    """One changed file as the panel and keel TUI show it: path, status, +/- lines, diff (None when it is the same)."""
    if now == before:
        return None
    status = "added" if before is None else "deleted" if now is None else "modified"
    diff = "".join(difflib.unified_diff(_text(before).splitlines(keepends=True), _text(now).splitlines(keepends=True),
                                        fromfile=f"a/{rel}" if before is not None else "/dev/null",
                                        tofile=f"b/{rel}" if now is not None else "/dev/null"))
    plus = sum(1 for ln in diff.splitlines() if ln.startswith("+") and not ln.startswith("+++"))
    minus = sum(1 for ln in diff.splitlines() if ln.startswith("-") and not ln.startswith("---"))
    return {"path": rel, "status": status, "added": plus, "removed": minus, "diff": diff[:DIFF_MAX]}


def turn_changes(sid: str, n: int) -> list[dict]:
    """0.18.20 The files one answer changed (the turn whose user message is `n`), each as it was before that turn
    against how the turn left it: keel TUI's block after an answer. Never the folder's other uncommitted files (the
    person's own, what keel init left): only what record_turn saw this turn change. [] for a turn that changed none."""
    get(sid, messages=False)                       # 404 for an unknown chat
    with db.connect() as conn:
        rows = _turn_files(conn, sid, n)
    out = []
    for rel, bx, b, ax, a, _kept in rows:
        entry = _change(rel, b if bx else None, a if ax else None)
        if entry:
            out.append(entry)
    return out


def _edited_since_last_turn(conn, s: dict, root: Path, paths: list[str]) -> list[str]:
    """Of these files, the ones the person changed after KeelBot's last (not undone) answer left them: undoing the file
    would write the old text over their edit (undo_turn checks the same). A file with no turn record is not checked."""
    sid = s["id"]
    _turn_table(conn)
    reverted = {n for t in _turns(get(sid)["messages"]) if t["data"].get("reverted") for n in t["ns"]}
    out = []
    for rel in paths:
        rows = conn.execute("select n, after_exists, after from helper_turn_files where session_id = ? and path = ? "
                            "order by n desc", (sid, rel)).fetchall()
        last = next((r for r in rows if r[0] not in reverted), None)
        if last and _now_bytes(root, rel) != (last[2] if last[1] else None):
            out.append(rel)
    return out


def undo(sid: str, path: str | None = None) -> list[dict]:
    """Put one file (or every file) back as it was before KeelBot changed it."""
    s = get(sid, messages=False)
    if is_side(s):
        if not s.get("worktree"):
            raise HelperError(409, "This side session was handed over; its worktree is gone.")
        if path and not any(c["path"] == path for c in changes(sid)):
            raise HelperError(404, f"KeelBot did not change {path} in this chat.")
        try:
            left = worktrees.undo(s["worktree"], "HEAD", path)
        except worktrees.WorktreeError as exc:
            raise HelperError(400, str(exc), exc.hint) from exc
        _drop_turn_paths(sid, [path] if path else None)
        return left
    root = Path(s["root"])
    with db.connect() as conn:
        q = "select path, existed, content from helper_files where session_id = ?" + (" and path = ?" if path else "")
        rows = conn.execute(q, (sid, path) if path else (sid,)).fetchall()
        if path and not rows:
            raise HelperError(404, f"KeelBot did not change {path} in this chat.")
        mine = _edited_since_last_turn(conn, s, root, [r[0] for r in rows])
        if mine:
            raise HelperError(409, f"You changed {', '.join(mine[:5])} after KeelBot's last answer, so keel did not undo it.",
                              "Undo your own change first, or keep the file as it is.")
        for rel, existed, content in rows:
            f = root / rel
            if existed:
                f.parent.mkdir(parents=True, exist_ok=True)
                f.write_bytes(content or b"")
            else:
                f.unlink(missing_ok=True)
            conn.execute("delete from helper_files where session_id = ? and path = ?", (sid, rel))
    _drop_turn_paths(sid, [path] if path else None)
    return changes(sid)


# ------------------------------------------------------------------ 0.18.19 undo / redo a whole answer
#
# As opencode's /undo and /redo (from opencode (MIT), core/src/session/revert.ts): undo marks the last turn (the person's
# message and KeelBot's answer) as reverted, puts back every file that turn changed and gives its question back for the
# prompt; redo puts the turn back while no new turn was sent; a new turn makes the revert final. keel keeps each
# turn's files in helper_turn_files (this plugin's own table): the file as it was before the turn and after it.

TURN_TABLE = """create table if not exists helper_turn_files (
  session_id text not null, n integer not null, path text not null, before_exists integer not null, before blob,
  after_exists integer not null, after blob, kept integer not null default 0, primary key (session_id, n, path)
)"""


def _turn_table(conn) -> None:
    """0.18.19 helper_turn_files is KeelBot's own table (core's migrate.py keeps only its old ones): made on first use."""
    conn.execute(TURN_TABLE)


def _now_bytes(root: Path, rel: str) -> bytes | None:
    f = root / rel
    return f.read_bytes() if f.is_file() else None


def _put(root: Path, rel: str, content: bytes | None) -> None:
    """A file as it was: written back, or deleted when it did not exist (only this one file, no git command)."""
    f = root / rel
    if content is None:
        f.unlink(missing_ok=True)
        parent = f.parent
        while parent != root and parent.is_dir() and not any(parent.iterdir()):
            parent.rmdir()
            parent = parent.parent
    else:
        f.parent.mkdir(parents=True, exist_ok=True)
        f.write_bytes(content)


def record_turn(sid: str, n: int, root: str, before: guard.Snapshot | None) -> list[str]:
    """0.18.19 After a Fix, Edit or side turn: each file it changed, as it was before the turn (the person's own unsaved
    version when there was one, else HEAD, else "did not exist") and as it is now (after the guard put back what it
    refused). `n` is the turn's user message. Returns the paths."""
    if before is None:
        return []
    base = Path(root)
    changed = list(guard.changed_since(root, before))
    # a file that was dirty before and is back to HEAD now: the turn changed it too (changed_since leaves it out)
    changed += [rel for rel, old in before.content.items() if rel not in changed and _now_bytes(base, rel) != old]
    rows = []
    for rel in sorted(set(changed)):
        old = before.content[rel] if rel in before.content else _head_bytes(root, rel)
        new = _now_bytes(base, rel)
        if old != new:
            rows.append((sid, n, rel, 0 if old is None else 1, old, 0 if new is None else 1, new))
    if rows:
        with db.connect() as conn:
            _turn_table(conn)
            conn.executemany("insert or replace into helper_turn_files (session_id, n, path, before_exists, before, "
                             "after_exists, after) values (?, ?, ?, ?, ?, ?, ?)", rows)
    return [r[2] for r in rows]


def _turns(msgs: list[dict]) -> list[dict]:
    """The turns of a chat in order: its user message's n and text, and the n of each message that belongs to it (the
    user message, then KeelBot's answer or the note a stopped or failed turn left: the messages with a call id)."""
    out: list[dict] = []
    for m in msgs:
        if m["role"] == "user":
            out.append({"n": m["n"], "text": m["text"], "ns": [m["n"]], "data": m.get("data") or {}})
        elif out and m.get("call_id") and m["role"] in ("helper", "note"):
            out[-1]["ns"].append(m["n"])
    return out


def _mark(conn, sid: str, ns: list[int], **flags) -> None:
    """Sets (a value) or clears (None) flags in these messages' data."""
    for n in ns:
        row = conn.execute("select data_json from helper_messages where session_id = ? and n = ?", (sid, n)).fetchone()
        data = db.loads(row[0], {}) if row else {}
        for k, v in flags.items():
            if v is None:
                data.pop(k, None)
            else:
                data[k] = v
        conn.execute("update helper_messages set data_json = ? where session_id = ? and n = ?", (json.dumps(data), sid, n))


def _undoable(sid: str) -> tuple[dict, Path]:
    s = get(sid)
    # an Ask chat that never changed a file has nothing to undo; one switched to Ask from Edit, Fix or Side (0.18.19)
    # can still take back the answers that changed files, as it can still keep or undo its files
    if s["mode"] == "ask" and not is_side(s) and not _has_turn_files(sid):
        raise HelperError(400, "Ask mode changes nothing, so there is nothing to undo.",
                          "In Edit, Fix or a side chat, /undo takes KeelBot's last answer back.")
    if is_side(s) and not s.get("worktree"):
        raise HelperError(409, "This side session was handed over; its worktree is gone.")
    return s, Path(workdir(s))


def _has_turn_files(sid: str) -> bool:
    with db.connect() as conn:
        _turn_table(conn)
        return conn.execute("select 1 from helper_turn_files where session_id = ? limit 1", (sid,)).fetchone() is not None


def _turn_files(conn, sid: str, n: int) -> list[tuple]:
    _turn_table(conn)
    return conn.execute("select path, before_exists, before, after_exists, after, kept from helper_turn_files "
                        "where session_id = ? and n = ? order by path", (sid, n)).fetchall()


def _changed_by_person(root: Path, rows: list[tuple], want: str) -> list[str]:
    """The files that are not as the turn left them (want "after") or as undo left them (want "before")."""
    out = []
    for rel, bx, b, ax, a, _kept in rows:
        expect = (a if ax else None) if want == "after" else (b if bx else None)
        if _now_bytes(root, rel) != expect:
            out.append(rel)
    return out


def undo_turn(sid: str) -> dict:
    """0.18.19 Undo KeelBot's last answer: every file that turn changed goes back to what it was before it (Edit and Fix:
    the project folder; side: its worktree), its question and answer stay stored, marked reverted, and the question
    comes back. Each call takes one more turn back. Refused, with nothing changed, when the person changed one of those
    files after the turn, or keel kept (committed) one of them. Answers {n, text, files, messages}."""
    s, root = _undoable(sid)
    live = [t for t in _turns(s["messages"]) if not t["data"].get("reverted")]
    if not live:
        raise HelperError(409, "Nothing to undo: KeelBot has no answer in this chat that is not undone already.")
    t = live[-1]
    with db.connect() as conn:
        rows = _turn_files(conn, sid, t["n"])
        kept = [r[0] for r in rows if r[5]]
        if kept:
            raise HelperError(409, f"keel kept (committed) {', '.join(kept[:5])} already, so that answer cannot be undone.",
                              "Change the file in a new answer, or revert the commit yourself.")
        mine = _changed_by_person(root, rows, "after")
        if mine:
            raise HelperError(409, f"You changed {', '.join(mine[:5])} after that answer, so keel did not undo it.",
                              "Undo your own change first, or keep the files as they are and ask KeelBot again.")
        for rel, bx, b, _ax, _a, _k in rows:
            _put(root, rel, b if bx else None)
        _mark(conn, sid, t["ns"], reverted=True)
        conn.execute("update helper_sessions set updated_at = ? where id = ?", (db.now(), sid))
    return {"n": t["n"], "text": t["text"], "files": [r[0] for r in rows], "messages": t["ns"]}


def redo_turn(sid: str) -> dict:
    """0.18.19 Redo: the earliest undone turn that is not final comes back (its files as that turn left them, its
    messages no longer reverted), as opencode's /redo moves the revert one turn on. Refused
    when the person changed one of those files after the undo. Answers {n, text, files, messages}."""
    s, root = _undoable(sid)
    undone = [t for t in _turns(s["messages"]) if t["data"].get("reverted") and not t["data"].get("final")]
    if not undone:
        raise HelperError(409, "Nothing to redo: no answer was undone since the last message.",
                          "/redo puts back what /undo took, until you send a new message.")
    t = undone[0]
    with db.connect() as conn:
        rows = _turn_files(conn, sid, t["n"])
        mine = _changed_by_person(root, rows, "before")
        if mine:
            raise HelperError(409, f"You changed {', '.join(mine[:5])} after the undo, so keel did not redo it.",
                              "Undo your own change first, or ask KeelBot again.")
        for rel, _bx, _b, ax, a, _k in rows:
            _put(root, rel, a if ax else None)
        _mark(conn, sid, t["ns"], reverted=None)
        conn.execute("update helper_sessions set updated_at = ? where id = ?", (db.now(), sid))
    return {"n": t["n"], "text": t["text"], "files": [r[0] for r in rows], "messages": t["ns"]}


def finalize_reverts(sid: str) -> int:
    """0.18.19 A new turn makes the undone turns final: they stay stored and shown as reverted, but redo cannot bring
    them back (their newer files are dropped), and the CLI's own session, which still holds them, is not continued
    (the next turn starts a new one with the conversation without them). Answers how many turns became final."""
    s = get(sid)
    undone = [t for t in _turns(s["messages"]) if t["data"].get("reverted") and not t["data"].get("final")]
    if not undone:
        return 0
    with db.connect() as conn:
        _turn_table(conn)
        for t in undone:
            _mark(conn, sid, t["ns"], final=True)
            conn.execute("delete from helper_turn_files where session_id = ? and n = ?", (sid, t["n"]))
        conn.execute("update helper_sessions set engine_session = null where id = ?", (sid,))
    return len(undone)


def _drop_turn_paths(sid: str, paths: list[str] | None, kept: bool = False) -> None:
    """0.18.19 A file undone on its own (/undo <path>, or every file) leaves the turns' records (undo_turn skips it); a
    kept (committed) one is marked kept, so no undo_turn puts it back behind keel's commit."""
    with db.connect() as conn:
        _turn_table(conn)
        if kept:
            conn.executemany("update helper_turn_files set kept = 1 where session_id = ? and path = ?",
                             [(sid, p) for p in paths or []])
        elif paths is None:
            conn.execute("delete from helper_turn_files where session_id = ?", (sid,))
        else:
            conn.executemany("delete from helper_turn_files where session_id = ? and path = ?", [(sid, p) for p in paths])


def done(sid: str, flow: dict, emit=None, message: str = "", commit: dict | None = None,
         paths: list[str] | None = None) -> dict:
    """Run the checks, then keel's commit of only the files KeelBot changed (runtime/actions.py `commit`: the phase's
    commit rules, secrets, new dependencies, pre-commit tools). The flow's timeline gets a helper.commit event.
    keel 0.18.3 `paths`: keep only these of its files (keel TUI's /keep <path>); the others stay changes to keep or undo."""
    from keel_engine.runtime import actions          # late: actions imports most of the runtime

    s = get(sid, messages=False)
    # 0.18.19 a chat switched to Ask keeps what it changed before (and a side session its worktree)
    if s["mode"] not in ("fix", "side", "edit") and not (is_side(s) or changes(sid)):
        raise HelperError(400, "Only a Fix, Edit or side chat has changes to commit.")
    if is_side(s) and not s.get("worktree"):
        raise HelperError(409, "This side session was handed over; its worktree is gone.")
    root = workdir(s)
    files = [c["path"] for c in changes(sid)]
    if paths:
        unknown = [p for p in paths if p not in files]
        if unknown:
            raise HelperError(404, f"KeelBot did not change {', '.join(unknown[:5])} in this chat.", "/changes lists its files.")
        files = [f for f in files if f in paths]
    if not files:
        return {"ok": False, "step": "changes", "error": "Nothing to commit: KeelBot changed no file in this chat."}
    # the module's tests (the criterion's own test is one of them): the change works and nothing else broke
    ac = flow.get("ac") or None
    cmd = testcmd.command_for(root, None, (ac or {}).get("layer", "API")) or testcmd.command_for(root)
    if cmd:
        code, out = testcmd.run(root, cmd, env=command_env())
        if code != 0:
            return {"ok": False, "step": "checks", "command": cmd, "error": "The checks failed, so keel did not commit.",
                    "output": out[-6000:]}
    # "fix(AC-2): <what the person wrote>" at a criterion's gate, else "fix(helper): ..."; the chat's title by default
    subject = " ".join((message or s["title"]).split())[:120]
    a = actions.ActionInput(root=root, phase=fix_phase(flow), title=subject, ac=None, ident=(ac or {}).get("id") or "helper",
                            acs=list(flow.get("acs") or []), fake=False, flow=str(flow.get("workflow") or "helper"),
                            unlocks=list(flow.get("unlocks") or []), deps=list(flow.get("deps") or []), project=s["project"],
                            paths=files, thread_id=s["thread_id"] or "",
                            settings={"run_mode": flow.get("run_mode") or "manual",
                                      **{k: v for k, v in (commit or {}).items() if k in ("commit_author", "commit_coauthor")}})
    res = actions.commit(a)
    if not res.ok:
        return {"ok": False, "step": "commit", "error": res.note, "output": res.detail or ""}
    sha = git.head(root)
    with db.connect() as conn:
        conn.executemany("delete from helper_files where session_id = ? and path = ?", [(sid, f) for f in files])
    _drop_turn_paths(sid, files, kept=True)          # 0.18.19 a kept file: no undo_turn puts it back behind the commit
    where = f" on branch {s['branch']}" if is_side(s) else ""
    note = f"keel committed KeelBot's change{where}: {res.note}" + (f" (checks: {cmd})" if cmd else " (no test command found)")
    subject = git.git(root, "log", "-1", "--format=%s").stdout.strip()
    add_message(sid, "note", note, data={"status": "committed", "sha": sha, "files": files, "subject": subject})
    if emit:
        emit("helper.commit", s["thread_id"] or sid, s["project"], {"session": sid, "sha": sha, "message": res.note,
                                                                    "files": files, "checks": cmd})
    return {"ok": True, "sha": sha, "message": res.note, "files": files, "checks": cmd}


def handover(sid: str) -> dict:
    """What a side session hands over (a task or a change flow): its branch, the commits kept on it, what is not kept
    yet, and its last answer."""
    s = get(sid)
    if not is_side(s):
        raise HelperError(400, "Only a side session can be handed over.")
    if not s.get("worktree"):
        raise HelperError(409, "This side session was handed over already.")
    answers = [m["text"] for m in s["messages"] if m["role"] == "helper"]
    asked = [m["text"] for m in s["messages"] if m["role"] == "user"]
    return {"session": sid, "title": s["title"], "branch": s["branch"], "base": s["base_sha"], "worktree": s["worktree"],
            "commits": worktrees.commits(s["worktree"], s["base_sha"]), "uncommitted": [c["path"] for c in changes(sid)],
            "asked": asked[:20], "answer": answers[-1] if answers else ""}


def release(sid: str) -> dict:
    """Hand a side session's branch over: its worktree goes, the branch and its commits stay (a change flow takes it)."""
    h = handover(sid)
    if h["uncommitted"]:
        raise HelperError(409, f"{len(h['uncommitted'])} file(s) are not kept yet: {', '.join(h['uncommitted'][:5])}.",
                          "Keep them (the checks run, keel commits on the branch) or undo them first.")
    s = get(sid, messages=False)
    worktrees.remove(s["root"], s["worktree"], None)
    with db.connect() as conn:
        conn.execute("update helper_sessions set worktree = null, updated_at = ? where id = ?", (db.now(), sid))
    add_message(sid, "note", f"Handed over: branch {h['branch']} with {len(h['commits'])} commit(s); its worktree is gone.",
                data={"status": "handed", "branch": h["branch"]})
    return h


def commits_for(thread_id: str) -> list[dict]:
    """The commits Done made for a flow (its Fix chats), oldest first: for the PR body."""
    if not thread_id:
        return []
    with db.connect() as conn:
        rows = conn.execute("select m.data_json, m.text, s.id, s.root from helper_messages m join helper_sessions s on s.id = m.session_id "
                            "where s.thread_id = ? and m.role = 'note' order by m.at", (thread_id,)).fetchall()
    out = []
    for dj, text, sid, root in rows:
        d = db.loads(dj, {})
        if d.get("status") == "committed" and d.get("sha"):
            subject = d.get("subject") or git.git(root, "log", "-1", "--format=%s", d["sha"]).stdout.strip() or text
            out.append({"sha": d["sha"], "subject": subject, "files": d.get("files") or [], "session": sid})
    return out


# ------------------------------------------------------------------ the prompt

def _pointing(mentions: list[dict], selection: dict | None, open_file: str | None) -> str:
    lines = []
    for m in mentions or []:
        kind, value = str(m.get("kind") or ""), str(m.get("value") or "")
        if not value:
            continue
        where = f" ({m['file']}:{m['line']})" if m.get("file") and m.get("line") else ""
        lines.append(f"- {kind or 'item'} {value}{where}")
    if selection and selection.get("path") and selection.get("text"):
        lo, hi = selection.get("from"), selection.get("to")
        span = f":{lo}-{hi}" if lo and hi and lo != hi else (f":{lo}" if lo else "")
        lines.append(f"- selected lines {selection['path']}{span}:\n```\n{str(selection['text'])[:4000]}\n```")
    if open_file:
        lines.append(f"- the file open in the editor: {open_file}")
    return ("The person points at:\n" + "\n".join(lines)) if lines else ""


def _flow_block(flow: dict | None) -> str:
    """The flow that runs or waits in this project: its title, phase, spec, criteria and the waiting gate."""
    if not flow or not flow.get("title"):
        return ""
    lines = [f"A flow {flow.get('status') or 'runs'} in this project: \"{flow['title']}\" (phase {flow.get('phase') or '?'})."]
    if flow.get("spec"):
        lines.append(f"Its spec: {flow['spec']}")
    acs = flow.get("acs") or []
    if acs:
        lines.append("Its acceptance criteria:")
        lines += [f"- {a.get('id')} [{a.get('layer', '')}] {a.get('title', '')} ({a.get('status', '')})" for a in acs[:30]]
    w = flow.get("waiting") or {}
    if w.get("title"):
        lines.append(f"It waits for the person at a gate: {w['title']}" + (f" (the step {w['name']!r})" if w.get("name") else "") + ".")
        if w.get("detail"):
            lines.append(f"The gate shows:\n{str(w['detail'])[:6000]}")
        lines += keelbot.effect_lines(w)
    if flow.get("current"):
        lines.append(f"The step it is at now: {flow['current']}.")
    jobs = flow.get("jobs") or []
    if jobs:
        # 0.18.15 the newest agents and code steps (agent "keel") of this flow and what each ended with
        lines.append("Its newest jobs (newest first; agent \"keel\" is a code step keel runs itself):")
        for j in jobs[:8]:
            head = f"- {j.get('agent') or '?'} at {j.get('step') or '?'}: {j.get('status') or '?'}"
            res = str(j.get("result") or "").strip()
            lines.append(head + (f"\n  ended with: {res[:1200]}" if res else ""))
    return "\n".join(lines)


def flows_in_folder(keel: dict | None) -> list[dict]:
    """The project's flows that run or wait in the project folder itself (not in a worktree of their own): a branch
    switch there changes the files they work on."""
    return [f for f in (keel or {}).get("flows") or [] if isinstance(f, dict)
            and f.get("status") in ("running", "waiting") and (f.get("where") or "folder") != "worktree"]


def flow_branches(keel: dict | None) -> set[str]:
    """The branches of the project's flows that run or wait: theirs, not KeelBot's to check out."""
    return {str(f["branch"]) for f in (keel or {}).get("flows") or [] if isinstance(f, dict) and f.get("branch")
            and f.get("status") in ("running", "waiting")}


def _failed_block(failed: list[dict] | None) -> str:
    """keel 0.18.18 what failed or was refused in KeelBot's last answer: the next turn starts from the error, not from
    the same command again."""
    rows = [f for f in failed or [] if f.get("command") or f.get("said")]
    if not rows:
        return ""
    lines = [f"- `{f['command']}`" + (f": {f['said']}" if f.get("said") else "") if f.get("command") else f"- {f['said']}"
             for f in rows[-6:]]
    return ("In your last answer these failed or were refused:\n" + "\n".join(lines) + "\nDo not run them again "
            "unchanged. If the person now says \"fix it\" or \"try again\", offer the ways forward (a keel-questions block) "
            "unless they already picked one.")


def _transcript(hist: list[tuple[str, str]], limit: int = TRANSCRIPT_CHARS) -> str:
    """The conversation so far, newest kept, for engines that cannot continue their own session. 0.18.19 a /compact
    summary (history()'s first message) always stays: the newest messages share the rest of `limit`."""
    parts, used = [], 0
    if hist and hist[0][0] == "user" and hist[0][1].startswith(SUMMARY_HEAD):
        parts.append(f"Person: {hist[0][1].strip()}")
        hist = hist[1:]
    keep = parts[:]
    parts = []
    for role, text in reversed(hist):
        line = f"{'Person' if role == 'user' else 'KeelBot'}: {text.strip()}"
        if used + len(line) > limit:
            break
        parts.append(line)
        used += len(line)
    parts = keep + list(reversed(parts))
    return ("The conversation so far (oldest first):\n" + "\n\n".join(parts)) if parts else ""


SHELL_OUTPUT_MAX = 8000
IMAGE_EXT = (".png", ".jpg", ".jpeg", ".gif", ".webp")
IMAGE_MAX = 10 * 1024 * 1024
IMAGES_MAX = 8


def sees_images(model: dict) -> bool:
    """0.18.18 Claude Code (the claude CLI) reads an image file with its Read tool and sees it. keel's other runners
    give the model text only: an API-key model's read_file reads text, the other CLIs get no picture."""
    return model.get("provider") == "claude" and model.get("mode", "api") != "api"


def attach_images(s: dict, model: dict, paths: list[str]) -> dict:
    """0.18.18 The images the person names with a turn (keel TUI: a path ending .png/.jpg/.jpeg/.gif/.webp, an
    @mention of one, a pasted one): each a file of the chat's folder (its worktree, or the project folder), relative
    or absolute. Answers {images: their full paths, once, for a model that sees images; skipped: [{path, why}]}."""
    roots = [Path(r).resolve() for r in dict.fromkeys(x for x in (workdir(s), s.get("root")) if x)]
    ok: list[str] = []
    skipped: list[dict] = []
    for raw in list(dict.fromkeys(str(p).strip() for p in paths or [] if str(p).strip()))[:IMAGES_MAX * 2]:
        p = Path(raw).expanduser()
        full = (p if p.is_absolute() else roots[0] / p).resolve()
        if not any(full == r or r in full.parents for r in roots):
            why = "it is outside the project folder (keel reads only the project's files): copy it into the project"
        elif full.suffix.lower() not in IMAGE_EXT:
            why = f"it is not an image KeelBot can send ({', '.join(IMAGE_EXT)})"
        elif not full.is_file():
            why = "it does not exist in the project folder"
        elif full.stat().st_size > IMAGE_MAX:
            why = f"it is larger than {IMAGE_MAX // (1024 * 1024)} MB"
        elif not sees_images(model):
            why = (f"the model {model.get('provider', '?')}/{model.get('model', '?')} cannot see images here: only "
                   "Claude Code (the claude CLI) does; /model picks it")
        elif len(ok) >= IMAGES_MAX:
            why = f"at most {IMAGES_MAX} images go with one question"
        else:
            if str(full) not in ok:
                ok.append(str(full))
            continue
        skipped.append({"path": raw, "why": why})
    return {"images": ok, "skipped": skipped}


def _images_block(images: list[str] | None) -> str:
    if not images:
        return ""
    return ("The person attached these images. Look at each with your Read tool (it shows you the picture) before "
            "you answer:\n" + "\n".join(f"- {i}" for i in images))


def _shell_block(shell: dict | None) -> str:
    """0.18.18 The output of a command the person ran themselves (keel TUI's `!command`), for their next question."""
    if not shell or not str(shell.get("command") or "").strip():
        return ""
    code = shell.get("exit")
    how = f"exit {code}" if code is not None else "refused"
    out = str(shell.get("output") or "")[-SHELL_OUTPUT_MAX:]
    return f"The person ran `{shell['command']}` in the project folder ({how}); its output:\n```\n{out.rstrip()}\n```"


def build_prompt(*, mode: str, root: str, question: str, know: dict, graph: bool, flow: dict | None,
                 mentions: list[dict] | None, selection: dict | None, open_file: str | None, transcript: str,
                 branch: str = "", pid: str = "", keel: dict | None = None, shell: dict | None = None,
                 images: list[str] | None = None, failed: list[dict] | None = None, was: str = "",
                 title: bool = False) -> str:
    where = f"Your folder (the worktree): {root}" if mode == "side" or (mode == "ask" and branch) else \
        f"The project folder: {root}"
    note = mode_note(was, mode)            # 0.18.19 the mode changed since the last answer: say so first
    parts = [*([note] if note else []), MODE_TEXT[mode].format(phase=fix_phase(flow), branch=branch or "?"), READING, FAILURES, where]
    if mode == "edit":
        busy = flows_in_folder(keel)
        if busy:
            parts.append("A flow works in this project folder now (" + "; ".join(f"\"{f.get('title')}\" {f.get('status')}"
                         for f in busy) + "): a branch switch, a pull or a stash changes the files it works on. Say so "
                         "before you offer one, and recommend a side session (`/mode side`) or waiting for the flow.")
    lost = _failed_block(failed)
    if lost:
        parts.append(lost)
    block = agent_knowledge.prompt_block(root, know, graph)
    if block:
        parts.append(block)
    # what the parts add for this question (keel_engine/extensions.py prompt_context): the code graph's "where to look"
    # lookups when hints are on, the places to read first, at no tool call
    parts += extensions.prompt_context(extensions.Agent(AGENT, know, mentions, open_file, selection), root, pid, question)
    ctx = plugins.context_files(root, (keel or {}).get("plugins"))
    if ctx:
        parts.append("Read these when they help: " + ", ".join(ctx))
    for extra in (_flow_block(flow), keelbot.keel_block(keel, question), transcript,
                  _pointing(mentions or [], selection, open_file), _shell_block(shell), _images_block(images)):
        if extra:
            parts.append(extra)
    if title:
        parts.append(TITLE_ASK)            # 0.18.19 a new chat: its first answer names it
    parts.append(f"Question: {question.strip()}")
    return "\n\n".join(parts)


def last_mode(sid: str, before_n: int) -> str:
    """0.18.19 The mode KeelBot's last answer (or stopped turn) before message `before_n` ran in; "" when none says."""
    msgs = [m for m in get(sid)["messages"] if m["n"] < before_n and m["role"] in ("helper", "note")
            and (m.get("data") or {}).get("mode")]
    return str(msgs[-1]["data"]["mode"]) if msgs else ""


def last_failures(sid: str, before_n: int) -> list[dict]:
    """What failed or was refused in KeelBot's last answer before message `before_n` (its stored `failed`)."""
    msgs = [m for m in get(sid)["messages"] if m["n"] < before_n and m["role"] in ("helper", "note")]
    return list((msgs[-1].get("data") or {}).get("failed") or []) if msgs else []


# ------------------------------------------------------------------ /compact

# 0.18.19 the summary's form and rules, from opencode (MIT), core/src/session/compaction.ts: what the person wants, what
# was decided, what is done, active or blocked, the next move and the files to open, so a fresh session goes on alone
SUMMARY_TEMPLATE = """You MUST use this format for your response (you may omit sections that aren't applicable). Do not \
include the <template> tags in your response.
<template>
## Objective
- [one or two brief sentences describing what the person is trying to accomplish]

## Requirements
- [constraints, preferences, requirements, and scope boundaries stated by the person, or "(none)"]

## Decisions
- [decisions already made and why, or "(none)"]

## Work State
Break the objective into smaller goals and report which are completed, which are being worked on, and which are blocked.
### Completed
- [goals that have been completed; otherwise "(none)"]

### Active
- [goals currently being worked on; otherwise "(none)"]

### Blocked
- [anything blocking progress, and why; otherwise "(none)"]

## Next Move
1. [ordered list of next actions, or "(none)"]

## Relevant Files
List the files and directories, other than the project folder itself, that another agent would need to open to \
continue this work. Include at most 15, most important first. Do not list every file that was read or changed. If none, \
write "(none)".
- `[file or directory path]`: [brief reason it matters]

## Important Context
- [facts the next agent cannot continue without and cannot easily find on its own; or "(none)"]
</template>"""
SUMMARY_RULES = """Rules:
- Keep each section concise. Use terse, single-line bullets, not prose paragraphs or nested lists.
- Prefer short references over detailed restatement. It is fine to leave out information the next agent can recover \
from the code or the files listed above.
- Preserve exact file paths, symbols, commands, error strings, URLs, and identifiers.
- Carry forward only the person's questions or requests that remain unanswered or require further action. Do not \
repeat ones that newer history has answered or resolved. Preserve exact wording when carrying one forward.
- Preserve consequential workflow state, including whether changes are uncommitted, committed, pushed, under review, or \
merged (keel keeps KeelBot's own changes until the person keeps them: say which are kept and which wait).
- Do not mention the summary process or that context was compacted."""


def summary_prompt(update: bool) -> str:
    """0.18.19 What /compact asks after the chat (opencode's buildPrompt): a new summary, or, when the chat starts from
    an earlier one, that summary updated with what came after it."""
    shared = ["Summarize only what the person and KeelBot said and did. Leave out instructions and setup KeelBot was "
              "given rather than told by the person (keel's rules, the mode, the project's knowledge): the next session "
              "receives current versions of these separately.",
              SUMMARY_TEMPLATE, SUMMARY_RULES, "Do not continue the task or call tools.",
              "Return only the structured summary in the requested format. Do not include a preamble, explanation, or "
              "other commentary."]
    if not update:
        return "\n\n".join(["You MUST summarize the conversation above into a structured summary that will be given to "
                             "another agent to resume the work.", *shared])
    return "\n\n".join([
        "Update the existing checkpoint in the conversation above into one consolidated summary.",
        "Newer history always takes precedence over the existing checkpoint. Preserve previous information unless newer "
        "history clearly contradicts, supersedes, resolves, or makes it stale. If something is no longer relevant to "
        "continuing the work, you may remove it.",
        "Incorporate newer requirements, decisions, progress, and context. Reconcile Work State and Next Move: move "
        "completed work out of Active, remove resolved blockers and answered questions, and preserve unresolved or "
        "pending work.",
        "Return only the updated Markdown sections. Do not reproduce the `<conversation-checkpoint>` or `<summary>` "
        "wrapper tags from the previous checkpoint.", *shared])


async def compact(sid: str) -> dict:
    """Asks the model to summarise the stored conversation (0.18.19 in opencode's structured form, or to update the
    earlier summary), stores that summary as a note (never a user or helper turn) and starts a fresh engine_session: the next turn's prompt begins from the summary, not the old session.
    Nothing in helper_messages is ever deleted; ctx_tokens resets to the summary's own size."""
    s = get(sid, messages=False)
    model = models.effective(s["model"])
    hist = history(sid)
    root = workdir(s)
    # 0.18.19 the whole chat, as far as the model's window allows (it was the newest 6000 characters), and only in the
    # prompt: an API-key model got it a second time as its messages
    room = max(TRANSCRIPT_CHARS, int((s.get("ctx_window") or COMPACT_WINDOW) * 4 * COMPACT_SHARE))
    earlier = bool(hist) and hist[0][1].startswith(SUMMARY_HEAD)
    prompt = _transcript(hist, room) + "\n\n" + summary_prompt(update=earlier)
    req = AgentRequest(agent=AGENT, system=prompts.system_prompt(AGENT, None), prompt=prompt, root=root, phase="none",
                       model=model, toolbox=ToolBox(root, "none", agent=AGENT, readonly=True), title=s["title"],
                       step_name="compact", key=models.key_for(model["provider"], {}), history=[])
    res = await models.runner_for(model).run(req, lambda *_a, **_k: None)
    tin, tout, cached = int(res.tokens_in), int(res.tokens_out), int(res.tokens_cached)
    before = int(s.get("ctx_tokens") or 0)
    summary = res.text or ""
    after = max(tout, len(summary) // 4)          # what the next turn starts with: the summary, not the old chat
    add_message(sid, "note", summary, data={"compact": True, "before": before, "after": after,
                                            "tokens_in": tin, "tokens_out": tout, "tokens_cached": cached})
    # no engine session: the next turn starts a new one and gets history() — the summary and what follows — as its
    # transcript (a made-up session id would "resume" a session the engine never had, with no transcript at all)
    update(sid, engine_session=None, ctx_tokens=after)
    return get(sid, messages=False)


# ------------------------------------------------------------------ turns

def said_no(command: str, ans: dict) -> dict:
    """keel 0.18.18 the person's deny, as KeelBot reads it: their reason, and to go on from it (not to ask again)."""
    if ans.get("decision") == "allow":
        return ans
    why = str(ans.get("why") or "").strip() or approvals.DENY_WHY
    if why in (approvals.DENY_WHY, approvals.TIMEOUT_WHY) or why.startswith(("The person stopped", "KeelBot's answer")):
        note = why
    else:
        note = f"The person said no to this command: {why}"
    return {**ans, "why": f"{note} Do not run it again; go on from what they said, or offer other ways forward."}



class HelperRunner:
    """Runs turns in the background (one at a time per session) and stops them."""

    def __init__(self, bus):
        self.bus = bus
        self.tasks: dict[str, asyncio.Task] = {}
        # Fix and side: the running turn's ask key per session (it can only ask). The waiting itself is core's
        # (keel_engine/approvals.py); KeelBot keeps its keys, its "always" grants and the cards of its own panel.
        self.ask_keys: dict[str, str] = {}
        self.approvals = approvals.of(bus)
        self.commands: set[str] = set()          # 0.18.18 sessions whose person's `!command` runs now
        # a turn that was accepted but has no task yet (it awaits a compact first), and a Done that runs the checks and
        # commits: both make the chat busy, so a second message queues instead of starting a second answer
        self.starting: set[str] = set()
        self.committing: set[str] = set()
        # keel 0.18.18 the running turn's view of keel per session (its flows): the cards warn when a flow works in the
        # folder, and a flow's own branch is not KeelBot's to check out
        self.turn_keel: dict[str, dict] = {}
        # 0.18.28 messages the person sent while an answer ran: sent in order once it ends (or at once after a stop)
        self.queued: dict[str, list[dict]] = {}

    # ---- permission cards (runtime/permissions.py) --------------------------------------------------------------

    def _check(self, sid: str, key: str, command: str) -> tuple[dict | None, dict | None]:
        """(the session that asks, or an answer at once)."""
        if not key or self.ask_keys.get(sid) != key:
            return None, {"decision": "deny", "why": "This KeelBot turn may not ask (it ended, or the key is wrong)."}
        try:
            s = get(sid, messages=False)
        except HelperError:
            return None, {"decision": "deny", "why": "The KeelBot chat is gone."}
        branch = self._flow_branch(sid, command)
        if branch:
            return None, {"decision": "deny", "why": f"{branch} is the branch of a keel flow that runs or waits: the flow "
                          "owns it (in its own worktree), so KeelBot does not check it out or change it. Offer the person "
                          "another way (a side session, or wait until the flow is finished)."}
        if permissions.granted(command, s["grants"]):
            return None, {"decision": "allow"}
        return s, None

    def _flow_branch(self, sid: str, command: str) -> str:
        """The flow branch this command checks out, switches to, resets or deletes, else ""."""
        if not permissions.changes_tree(command) and " branch " not in f" {command} ":
            return ""
        words = set(str(command).replace("=", " ").split())
        return next((b for b in sorted(flow_branches(self.turn_keel.get(sid))) if b in words), "")

    def _warning(self, s: dict, command: str) -> str:
        """What the person should know before they say yes: the command throws work away, or a flow works in this
        folder and the command changes its files."""
        out = [permissions.destructive(command)]
        if s["mode"] in ("edit", "fix") and permissions.changes_tree(command):
            busy = flows_in_folder(self.turn_keel.get(s["id"]))
            if busy:
                out.append(f"A flow works in this folder (\"{busy[0].get('title')}\" {busy[0].get('status')}): this "
                           "changes the files it works on.")
        return " ".join(w for w in out if w)

    def _open(self, s: dict, kind: str, command: str, path: str = "") -> str:
        """Asks approvals; KeelBot's own panel gets helper.permission, and helper.permission.answered when it ends."""
        sid = s["id"]

        def answered(q: dict, said: str, ans: dict):
            if said == "always" and not permissions.destructive(q["command"]):     # one that throws work away: every time
                add_grant(sid, q.get("always") or q["command"])
            self.bus.emit("helper.permission.answered", sid, q["project"], step="helper",
                          data={"id": q["id"], "decision": ans.get("decision"), "why": ans.get("why", "")})

        q = self.approvals.open(kind, s["project"], s["title"], command, source="keelbot", thread_id=s["thread_id"],
                                session=sid, path=path, on_answer=answered,
                                extra={"warning": self._warning(s, command),
                                       # what "always" keeps; none for a command that throws work away (asked every time)
                                       "always": "" if permissions.destructive(command) else permissions.always_pattern(command)})
        self.bus.emit("helper.permission", sid, s["project"], step="helper", data=q)
        return q["id"]

    async def ask(self, sid: str, key: str, kind: str, command: str, path: str = "") -> dict:
        """The hook's question (POST /helper/permissions/ask): waits for the person, at most ASK_TIMEOUT."""
        s, now = self._check(sid, key, command)
        if now:
            return now
        return said_no(command, await self.approvals.wait(self._open(s, kind, command, path)))

    def ask_blocking(self, sid: str, key: str, command: str) -> tuple[bool, str]:
        """The ToolBox's question (API-key models run their tools in a worker thread)."""
        s, now = self._check(sid, key, command)
        ans = now or said_no(command, self.approvals.wait_blocking(self._open(s, "command", command)))
        return ans.get("decision") == "allow", ans.get("why", "")

    def answer(self, qid: str, decision: str, why: str = "") -> dict:
        """The person's answer: once | always (this command, for the rest of the chat) | deny (with a reason)."""
        try:
            return self.approvals.answer(qid, decision, why)
        except approvals.ApprovalError as exc:
            raise HelperError(exc.status, str(exc), exc.hint) from exc

    def pending(self, project: str | None = None) -> list[dict]:
        return self.approvals.pending(project)

    def _drop_questions(self, sid: str, why: str):
        self.approvals.close(session=sid, why=why)

    def busy(self, sid: str) -> bool:
        t = self.tasks.get(sid)
        return bool(t and not t.done()) or sid in self.commands or sid in self.starting or sid in self.committing

    async def run_command(self, sid: str, command: str, timeout: int = SHELL_TIMEOUT) -> dict:
        """0.18.18 keel TUI's `!command`: the person's own command, in the chat's folder (a side session's worktree),
        through keel's guard as KeelBot's own commands go (ToolBox.run_command): the rules first, then in Edit, Fix and
        side a command that changes something waits for the person's OK on a permission card; Ask runs only what
        changes nothing. Answers {command, exit, output, refused}; nothing is stored in the chat."""
        s = get(sid, messages=False)
        cmd = (command or "").strip()
        if self.busy(sid):
            raise HelperError(409, "KeelBot is still working in this chat.", "Wait for it, or stop it, then run the command.")
        root, mode = workdir(s), s["mode"]
        cfg = rules.load_config(root)
        refused: list[str] = []

        def on_refuse(tool: str, path: str, reason: str, command: str | None = None):
            refused.append(reason)

        if mode == "ask":
            toolbox = ToolBox(root, "none", cfg=cfg, on_refuse=on_refuse, agent=AGENT, readonly=True)
        else:
            key = secrets.token_urlsafe(24)
            self.ask_keys[sid] = key
            toolbox = ToolBox(root, (s.get("phase") or "none") if mode == "fix" else "none", cfg=cfg, on_refuse=on_refuse,
                              agent=AGENT, confine=mode in ("side", "edit"),
                              asker=lambda c: self.ask_blocking(sid, key, c))
        self.commands.add(sid)
        try:
            said = await asyncio.to_thread(toolbox.run_command, cmd, timeout)
        finally:
            self.commands.discard(sid)
            self.ask_keys.pop(sid, None)
            self._drop_questions(sid, "The command ended.")
        if said.startswith("REFUSED:"):
            why = refused[-1] if refused else said[len("REFUSED:"):].strip()
            if mode == "ask":
                why = (f"{why} KeelBot's Ask mode is read only: /mode edit runs it (a command that changes something "
                       "waits for your OK), or run it in your own terminal.")
            return {"command": cmd, "exit": None, "output": "", "refused": why}
        head, _, out = said.partition("\n")
        code = int(head.split()[1]) if head.startswith("exit ") and head.split()[1].lstrip("-").isdigit() else None
        return {"command": cmd, "exit": code, "output": out, "refused": None}

    async def turn(self, sid: str, body: dict) -> dict:
        s = get(sid, messages=False)
        text = str(body.get("text") or "").strip()
        if not text:
            raise HelperError(400, "The message is empty.")
        if self.busy(sid) and body.get("interrupt"):
            # 0.18.28 Esc / Ctrl+C with a new message: the running answer stops, this one goes now
            await self.stop(sid)
        if self.busy(sid):
            # 0.18.28 no "still answering" refusal: the message waits and goes after this answer
            q = self.queued.setdefault(sid, [])
            q.append({k: v for k, v in body.items() if k != "interrupt"})
            self.bus.emit("helper.queued", sid, s["project"], step="helper",
                          data={"session": sid, "text": text[:2000], "position": len(q)})
            return {"session": sid, "queued": True, "position": len(q), "text": text}
        self.starting.add(sid)      # busy from here: nothing below may let a second message start its own answer
        try:
            if s["mode"] == "side" and not s.get("worktree"):
                raise HelperError(409, "This side session was handed over; its worktree is gone.", "Start a new chat.")
            if finalize_reverts(sid):         # 0.18.19 a new message makes /undo final (no /redo any more)
                s = get(sid, messages=False)
            if s["ctx_window"] and s["ctx_tokens"] / s["ctx_window"] >= COMPACT_RATIO:
                s = await compact(sid)
            if body.get("model"):
                s = set_model(sid, body["model"])
            question, command = plugins.expand(s["root"], text, body.get("plugins"))
            # 0.18.18 the images the person named: the ones the model can see go with the turn, the others say why not
            att = attach_images(s, models.effective(s["model"]), list(body.get("images") or []))
            body["images_ok"] = att["images"]
            n = add_message(sid, "user", text, data={k: v for k, v in {"command": command, "mentions": body.get("mentions"),
                                                                        "selection": body.get("selection"),
                                                                        "shell": body.get("shell"), "images": att["images"],
                                                                        "images_skipped": att["skipped"]}.items() if v})
            if s["title"] == "New chat" and s["turns"] == 0:
                # named by the question until the first answer gives its own short title (0.18.19, _run)
                body["auto_title"] = update(sid, title=short_title(text))["title"]
            call_id = uuid.uuid4().hex
            update(sid, status="running", error=None)
            self.tasks[sid] = asyncio.create_task(self._run(sid, n, question, body, call_id))
            return {"session": sid, "call_id": call_id, "n": n, "command": command, "images": att["images"],
                    "images_skipped": att["skipped"]}
        finally:
            self.starting.discard(sid)

    async def stop(self, sid: str) -> dict:
        self._drop_questions(sid, "The person stopped KeelBot.")
        t = self.tasks.get(sid)
        if t and not t.done():
            t.cancel()
            try:
                await t
            except (asyncio.CancelledError, Exception):
                pass
        return get(sid, messages=False)

    async def close(self):
        for sid in list(self.tasks):
            await self.stop(sid)

    async def _run(self, sid: str, n: int, question: str, body: dict, call_id: str):
        s = get(sid, messages=False)
        project, mode = s["project"], s["mode"]
        root = workdir(s)               # a side session works in its worktree, never the project folder
        model = models.effective(s["model"])
        provider = model["provider"]
        keys = dict(body.get("keys") or {})
        counter = {"n": 0}

        def ev(type_: str, data: dict):
            self.bus.emit(type_, sid, project, step="helper", call_id=call_id, data=data)

        # the answer as it is written: helper.delta events (the text so far, every 80 ms; never stored)
        # 0.18.19 a new chat's first answer ends with its title line: the person never sees it
        auto = str(body.get("auto_title") or "")
        live = DeltaThrottle(lambda d: ev("helper.delta", {**d, "text": hide_title(d.get("text", ""))} if auto else d))
        # 0.18.23 KeelBot's thinking as the model writes it: helper.thinking.delta (the turn's thinking so far, every
        # 80 ms; a live event the api never stores), apart from the answer. Kept with the answer's data for a reload
        # (capped), never in the conversation the model gets next turn (history() reads the text only).
        think = DeltaThrottle(lambda d: ev("helper.thinking.delta", d))
        thought: dict = {"text": "", "first": None, "last": None, "live": False, "gap": False}

        def add_thought(chunk: str):
            if not chunk:
                return
            now = time.monotonic()
            thought["first"] = thought["first"] or now
            thought["last"] = now
            if thought["gap"] and thought["text"]:
                chunk = "\n\n" + chunk.lstrip()
            thought["gap"] = False
            thought["text"] += chunk
            think.add(chunk)
        # keel 0.18.18 what failed or was refused in this turn: the next turn's prompt starts from it, and failed.json
        # (runtime/repeats.py, in the turn's scratch folder) lets the hook and the ToolBox refuse an exact repeat
        failures: list[dict] = []
        scratch: dict = {"dir": None}

        def note_failure(kind: str, text: str, extra: dict):
            if extra.get("ok") is not False:
                return
            if kind == "tool" and extra.get("tool") in ("Bash", "run_command") and text:
                note = repeats.remember(scratch["dir"], root, str(text), str(extra.get("output") or ""))
                failures.append({"command": str(text)[:300], "said": note.get("said", ""), "state": note.get("state", "")})
            elif kind == "guard" and text:
                failures.append({"command": str(extra.get("command") or "")[:300], "said": str(text)[:300]})

        def emit(kind: str, text: str = "", **extra):
            if kind == "delta":
                think.flush()
                live.add(str(text))
                return
            if kind == "thinking_delta":
                thought["live"] = True
                add_thought(str(text))
                return
            if kind == "thinking" and not thought["live"]:
                add_thought(str(text))           # an engine that sends whole thinking only (Codex, opencode)
                think.flush()
            elif kind != "thinking":
                thought["gap"] = True            # a tool call or a message between: the next thinking is a new block
            live.reset()
            try:
                note_failure(kind, str(text), extra)
            except Exception:  # noqa: BLE001  (a note for the next turn: never the turn's failure)
                log.debug("KeelBot could not note a failure", exc_info=True)
            counter["n"] += 1
            if auto and kind in ("text", "answer"):
                text = split_title(str(text))[0]
            data = {"n": counter["n"], "kind": kind, "text": str(text)[:STEP_FIELD_MAX]}
            data.update({k: (v[:STEP_FIELD_MAX] if isinstance(v, str) else v) for k, v in extra.items() if v is not None})
            ev("helper.step", data)
            # the same tool call as one tidy record for keel TUI's tool lines (a live event: never stored,
            # never in the next turn's history)
            if kind in TOOL_KINDS:
                ev("helper.tool", tool_event(counter["n"], kind, str(text), extra))

        def on_refuse(tool: str, path: str, reason: str, command: str | None = None):
            emit("guard", reason, tool=tool, path=path or None, ok=False, command=command)

        # v0.15.9 keel's file history: what KeelBot changes in specs, knowledge, ADRs or the runbook
        def doc_emit(type_: str, step: str | None = None, data: dict | None = None):
            self.bus.emit(type_, sid, project, step=step or "helper", call_id=call_id, data=data or {})

        know = agent_knowledge.for_agent(AGENT, body.get("agents"))
        cfg = rules.load_config(root)
        flow = body.get("flow") or {}
        if mode == "fix":
            # the flow's phase, criterion and unlocks decide what may change; commands that change something are asked
            ac = flow.get("ac") or None
            phase, unlocks = fix_phase(flow), list(flow.get("unlocks") or [])
            if phase != s.get("phase"):
                update(sid, phase=phase)
            key = secrets.token_urlsafe(24)
            self.ask_keys[sid] = key
            toolbox = ToolBox(root, phase, cfg=cfg, lane=rules.ac_lane(ac) if ac else None, ac=(ac or {}).get("id"),
                              ac_layer=(ac or {}).get("layer", "API"), on_refuse=on_refuse, unlocks=unlocks, agent=AGENT,
                              knowledge=know, readonly=flow.get("run_mode") == "readonly",
                              ask={"url": f"http://127.0.0.1:{config.port()}{ASK_PATH}", "key": key, "session": sid},
                              asker=lambda command: self.ask_blocking(sid, key, command))
        elif mode in ("side", "edit"):
            # no flow's phase: only keel's always-on rules (secrets, .git, old migrations), and nothing outside the worktree
            # (side) or the project folder (edit); a command that changes something waits for the person's OK
            phase, unlocks, ac = "none", [], None
            key = secrets.token_urlsafe(24)
            self.ask_keys[sid] = key
            toolbox = ToolBox(root, "none", cfg=cfg, on_refuse=on_refuse, agent=AGENT, knowledge=know, confine=True,
                              ask={"url": f"http://127.0.0.1:{config.port()}{ASK_PATH}", "key": key, "session": sid},
                              asker=lambda command: self.ask_blocking(sid, key, command))
        else:
            phase, unlocks, ac = "none", [], None
            toolbox = ToolBox(root, "none", cfg=cfg, on_refuse=on_refuse, agent=AGENT, knowledge=know, readonly=True)
            toolbox.readonly_label, toolbox.readonly_note = ASK_LABEL, ASK_NOTE
        self.turn_keel[sid] = dict(body.get("keel") or {})
        resumable = model.get("mode") != "api" and provider in RESUMABLE
        session = s["engine_session"] if resumable else None
        resume = bool(session)
        if resumable and not session and provider == "claude":
            session = str(uuid.uuid4())
        hist: list = []
        res: AgentResult | None = None
        status, err = "done", None
        before = None
        plugin_key = None
        t0 = time.monotonic()
        effort = catalog.effort_for(model)       # what the runner passes on (None: the engine's own default)
        docs_before: dict | None = None      # None: the turn failed before the setup read the docs

        def on_session(new: str):
            update(sid, engine_session=new)

        # everything that awaits sits in the try: a stop can come at any moment and is recorded the same way
        try:
            # the setup sits in the try as well: an error or a Stop here must end the turn the same way (status, keys)
            if mode in ("fix", "side", "edit"):
                # keel v1's push gate for KeelBot's own `git push` / `gh pr create` (rules.push_gate)
                toolbox.push_blockers = await asyncio.to_thread(push_blockers_for, root, flow.get("base_head"), project)
            hist = history(sid, before_n=n)
            ev("helper.started", {"agent": AGENT, "provider": provider, "model": model.get("model"), "mode": model.get("mode"),
                                  "effort": effort,
                                  "phase": f"helper-{mode}", "session": sid, "n": n})
            docs_before = doc_history.before_step(doc_emit, root, None, "helper")
            before = await asyncio.to_thread(guard.snapshot, root)
            # the parts' own servers (the code graph's: the project's index, same paths), keel_engine/extensions.py
            specs, allow = await asyncio.to_thread(extensions.with_part_servers, list(body.get("mcp") or []),
                                                   list(body.get("tools_allow") or []), extensions.Agent(AGENT, know),
                                                   s["root"])
            # the project's plugins (Control › Plugins): their read tools, through one key for this turn
            on = extensions.enabled({"plugins": body.get("plugins")})
            if on:
                plugin_key = extensions.open_call(project=project, root=root, keys=keys, plugins=on, who="keelbot")
                specs += extensions.server_specs(on, plugin_key)
                allow += extensions.allow_entries(on)
            mcp_specs, tools_allow = agent_knowledge.filter_mcp(specs, allow, know)
            before_failed = await asyncio.to_thread(last_failures, sid, n)
            was = await asyncio.to_thread(last_mode, sid, n)
            transcript = "" if (resume or model.get("mode") == "api" or provider == "fake") else _transcript(hist)
            prompt = build_prompt(mode=mode, root=root, question=question, know=know, branch=s.get("branch") or "", pid=project,
                                  graph=agent_knowledge.has_codegraph(mcp_specs, tools_allow), flow=body.get("flow"),
                                  mentions=body.get("mentions"), selection=body.get("selection"), open_file=body.get("open_file"),
                                  transcript=transcript, keel={**(body.get("keel") or {}), "plugins": on},
                                  shell=body.get("shell"), images=body.get("images_ok"), failed=before_failed, was=was,
                                  title=bool(auto))
            with tempfile.TemporaryDirectory(prefix="keel-helper-") as tmp:
                scratch["dir"] = tmp
                toolbox.no_repeat = tmp
                repeats.seed(tmp, before_failed)        # "fix it" with nothing changed: the same command stays refused
                req = AgentRequest(agent=AGENT, system=prompts.system_prompt(AGENT, body.get("skills"), COMMITS.get(mode)),
                                   prompt=prompt,
                                   root=root, phase=phase, model=model, toolbox=toolbox, title=s["title"], step_name="helper",
                                   ac=ac,
                                   mcp_specs=mcp_specs, tools_allow=tools_allow, key=models.key_for(provider, keys),
                                   workdir=tmp, timeout=int(body.get("timeout") or TURN_TIMEOUT), keys=keys, session=session,
                                   resume=resume, on_session=on_session, thread=sid, knowledge=know,
                                   history=hist[-HISTORY_TURNS:] if model.get("mode") == "api" or provider == "fake" else [])
                gfile = guard_ctx.GuardFile(Path(tmp) / guard_ctx.FILE, **guard_ctx.context_for(req))
                req.guard_ctx = gfile.path
                if session and not resume:
                    update(sid, engine_session=session)
                res = await models.runner_for(model).run(req, emit)
        except asyncio.CancelledError:
            status, err = "stopped", "Stopped."
        except Exception as exc:  # the panel shows it; the session stays usable
            status, err = "failed", f"{exc}{(' ' + exc.hint) if getattr(exc, 'hint', '') else ''}"
            emit("error", err[:2000], ok=False)
        think.flush()
        self.ask_keys.pop(sid, None)
        self.turn_keel.pop(sid, None)
        scratch["dir"] = None
        extensions.close_call(plugin_key)
        self._drop_questions(sid, "KeelBot's answer ended.")
        # the backstop for engines without keel's hook: in Ask nothing may change; in Fix only what the phase allows
        if mode == "ask":
            for r in guard.guard_diff(root, "none", before, cfg, None, None, True):
                emit("guard", f"Put back {r['path']}: KeelBot's Ask mode changes nothing.", path=r["path"], ok=False)
        elif mode in ("side", "edit"):
            for r in guard.guard_diff(root, "none", before, cfg, None, None, False):
                emit("guard", f"Put back {r['path']}: {r['reason']}", path=r["path"], ok=False)
            if mode == "edit":
                remember_originals(sid, root, before)          # Undo and Keep, as in Fix
        else:
            for r in guard.guard_diff(root, phase, before, cfg, rules.ac_lane(ac) if ac else None, unlocks,
                                      flow.get("run_mode") == "readonly"):
                emit("guard", f"Put back {r['path']}: {r['reason']}", path=r["path"], ok=False)
            remember_originals(sid, root, before)
        turn_files: list[str] = []
        if mode != "ask":
            try:                                               # 0.18.19 this turn's files, for /undo of the whole answer
                turn_files = record_turn(sid, n, root, before)
            except Exception:  # noqa: BLE001  (a record for /undo: never the turn's failure)
                log.warning("KeelBot could not record turn %s of %s for /undo", n, sid, exc_info=True)
        used = getattr(res, "__dict__", {}) if res else {}
        tin, tout = int(used.get("tokens_in", 0)), int(used.get("tokens_out", 0))
        cached = int(used.get("tokens_cached", 0))
        cost = float(used.get("cost_usd", 0.0))
        if res and not cost and model.get("mode") == "api" and provider != "fake":
            cost = catalog.cost_usd(provider, model.get("model", ""), tin, tout)
        if res and not cost and int(used.get("premium_requests", 0)):
            # 0.18.16 Copilot costs premium requests, not tokens (it showed $0 before)
            cost = catalog.premium_cost(provider, model.get("model", ""), int(used.get("premium_requests", 0)))
        answer = (res.text if res else "") or ("" if status == "done" else err or "")
        named = ""
        if auto and status == "done":
            answer, named = split_title(answer)
        if status == "done" and not answer.strip():
            answer = "(KeelBot gave no answer.)"
        if named and get(sid, messages=False)["title"] == auto:
            update(sid, title=named)            # before the answer is stored: keel TUI reads the chat once it is
        add_message(sid, "helper" if status == "done" else "note", answer, call_id=call_id,
                    data={"status": status, "mode": mode, "provider": provider, "model": model.get("model"),
                          **({"effort": effort} if effort else {}), "tokens_in": tin, "tokens_out": tout,
                          "tokens_cached": cached, "cost_usd": round(cost, 6), "ms": int((time.monotonic() - t0) * 1000),
                          # 0.18.20 the files this answer changed (keel TUI lists only these after it), and its turn
                          "turn": n, "files": turn_files,
                          **({"failed": failures[-10:]} if failures else {}),
                          **_thinking_data(thought, t0)})
        cur = get(sid, messages=False)
        update(sid, status="idle" if status != "failed" else "failed", error=err if status == "failed" else None,
               tokens_in=cur["tokens_in"] + tin, tokens_out=cur["tokens_out"] + tout, tokens_cached=cur["tokens_cached"] + cached,
               cost_usd=round(cur["cost_usd"] + cost, 6), turns=cur["turns"] + 1, ctx_tokens=tin + tout + cached)
        if docs_before is not None:
            doc_history.after_step(doc_emit, root, docs_before, "keelbot", "KeelBot", None, "helper")
        ev("helper.finished", {"agent": AGENT, "status": status, "tokens_in": tin, "tokens_out": tout, "tokens_cached": cached,
                               "cost_usd": round(cost, 6), "premium_requests": int(used.get("premium_requests", 0)),
                               "result": answer[:2000], "session": sid, "n": n, "files": turn_files})
        self.tasks.pop(sid, None)
        self.send_queued(sid)

    def send_queued(self, sid: str) -> None:
        """0.18.28 the next message the person sent while the answer ran (in order), now that it ended."""
        q = self.queued.get(sid) or []
        if not q:
            self.queued.pop(sid, None)
            return
        nxt = q.pop(0)

        async def go():
            try:
                await self.turn(sid, nxt)
            except Exception:  # noqa: BLE001 - a queued message that cannot go is logged, the chat stays usable
                log.warning("KeelBot could not send the queued message of %s", sid, exc_info=True)

        asyncio.get_running_loop().create_task(go())

    def queue_of(self, sid: str) -> list[str]:
        return [str(b.get("text") or "") for b in self.queued.get(sid) or []]

    async def flow_fix(self, *, project: str, root: str, model: dict | None, keys: dict | None, text: str,
                       thread: str | None = None, title: str = "") -> dict:
        """0.18.28 a flow's gate asks KeelBot to fix what it cannot (the suite fails at integration): a new Edit chat in
        the flow's folder, its turn waited for. The person sees it among KeelBot's chats. {session, status, answer}."""
        sess = create(project, root, mode="edit", model=model, title=title or "Fix the failing suite")
        sid = sess["id"]
        await self.turn(sid, {"text": text, "keys": dict(keys or {}), "flow": {"thread_id": thread} if thread else {}})
        task = self.tasks.get(sid)
        if task:
            try:
                await task
            except (asyncio.CancelledError, Exception):  # noqa: BLE001 - the flow checks the suite again either way
                pass
        now = get(sid)
        last = next((m for m in reversed(now.get("messages") or []) if m.get("role") != "user"), None)
        return {"session": sid, "status": (last or {}).get("data", {}).get("status") or now.get("status"),
                "answer": (last or {}).get("text") or ""}


THINKING_MAX = 20_000             # 0.18.23 the thinking kept with an answer, for a reload (never sent to the model)

TOOL_KINDS = ("tool", "read", "write", "edit", "guard")   # the steps that are a tool call (helper.tool)
TOOL_OUTPUT_MAX = 20_000          # a helper.tool event's output, at most
TOOL_SUMMARY_MAX = 200
SHELL_TOOLS = ("Bash", "bash", "shell", "run_command", "exec_command")
FILE_TOOL = {"read": "Read", "write": "Write", "edit": "Edit"}
_MORE_LINES = re.compile(r"\n… \((\d+) more lines\)$")
_STAT = re.compile(r"\(([^()]*)\)\s*$")


def _first_line(text: str) -> str:
    line = next((x.strip() for x in str(text or "").splitlines() if x.strip()), "")
    return line if len(line) <= TOOL_SUMMARY_MAX else line[:TOOL_SUMMARY_MAX - 1].rstrip() + "…"


def _line_count(output: str) -> int:
    """How many lines the tool printed: the lines kept, plus the ones a runner cut ("… (N more lines)")."""
    if not output:
        return 0
    m = _MORE_LINES.search(output)
    kept = output[:m.start()] if m else output
    return len(kept.splitlines()) + (int(m.group(1)) if m else 0)


def tool_event(n: int, kind: str, text: str, extra: dict) -> dict:
    """One tool call of a turn as keel TUI shows it: {n (the step's), name, server, args, shell, status
    (ok | error | refused), summary (one line: "220 lines", the error, what changed), lines, output (at most
    TOOL_OUTPUT_MAX characters), path, ms}. From the step the runner emitted (tool, read, write, edit, guard)."""
    name = str(extra.get("tool") or FILE_TOOL.get(kind) or kind)
    path = extra.get("path")
    if kind == "guard":
        args, output = str(extra.get("command") or path or ""), text
    elif kind in FILE_TOOL:
        args = str(path or "")
        output = str(extra.get("diff") or extra.get("output") or (text if kind == "read" else ""))
    else:
        args, output = text, str(extra.get("output") or "")
    try:                                       # MCP and other tools: their arguments as JSON
        parsed = json.loads(args) if args.lstrip().startswith("{") else None
    except ValueError:
        parsed = None
    status = "refused" if kind == "guard" else "error" if extra.get("ok") is False else "ok"
    lines = _line_count(output)
    if status == "refused":
        summary = "refused: " + _first_line(text)
    elif status == "error":
        summary = _first_line(output) or "failed"
    elif kind in ("write", "edit"):
        m = _STAT.search(text)
        summary = m.group(1) if m else f"{lines} lines"
    else:
        summary = "" if not lines else _first_line(output) if lines == 1 else f"{lines} lines"
    if len(output) > TOOL_OUTPUT_MAX:
        output = output[:TOOL_OUTPUT_MAX].rstrip() + f"\n… ({len(output) - TOOL_OUTPUT_MAX} more characters)"
    return {"n": n, "name": name, "args": parsed if isinstance(parsed, dict) else args,
            "shell": name in SHELL_TOOLS, "status": status, "summary": summary, "lines": lines, "output": output,
            **({"server": extra["server"]} if extra.get("server") else {}), **({"path": path} if path else {}),
            **({"ms": extra["ms"]} if isinstance(extra.get("ms"), int) else {})}


def _thinking_data(thought: dict, t0: float) -> dict:
    """The answer's thinking for its stored data: the text (cut at THINKING_MAX) and how long it took (from the turn's
    start to its last thinking); {} for none."""
    text = str(thought.get("text") or "").strip()
    if not text:
        return {}
    cut = text if len(text) <= THINKING_MAX else text[:THINKING_MAX].rstrip() + " …"
    ms = int(((thought.get("last") or t0) - t0) * 1000)
    return {"thinking": cut, "thinking_ms": max(0, ms)}


def commands(root: str | None, enabled: list[str] | None = None) -> list[dict]:
    """The slash commands the panel offers (runtime/plugins.py): keel's, the project's plugins' and the project's own."""
    return [{k: c[k] for k in ("name", "description", "plugin", "source")} for c in plugins.commands(root, enabled)]
