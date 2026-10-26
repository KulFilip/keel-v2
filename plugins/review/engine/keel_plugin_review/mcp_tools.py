"""The Code Review plugin's tools in keel's own MCP server (keel2 mcp, keel_engine/mcp_server.py): what keel TUI's review
mode and the dashboard's Code › Review do, through keel's api (the plugin's routes, /api/projects/<id>/review/...).

    read   keel_review_prs, keel_review_files, keel_review_diff, keel_review_notes
    write  keel_review_comment (a draft, kept in keel), keel_review_explain, keel_review_findings (keel's AI, it edits
           nothing), keel_review_reply, keel_review_resolve, keel_review_submit (these three post to GitHub or GitLab:
           the person says yes first, through the client)

A review is a pull request (`pr`), a branch (`branch`), or without either the branch the project folder is on."""

from __future__ import annotations

from typing import Literal

from mcp.server.fastmcp import Context
from keel_engine.mcp_server import KeelApi, _plugin_on, _project

MAX_DIFF_LINES = 600


def _open(api: KeelApi, project: str | None, pr: int | None, branch: str | None) -> tuple[str, dict]:
    """The project and the review (GET review/open: it fetches a pull request first)."""
    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "review")
    ref = str(int(pr)) if pr else (branch or "")
    return pid, api.get(f"/projects/{pid}/review/open", ref=ref)


def _name(v: dict) -> str:
    return f"pull request #{v['number']}" if v.get("kind") == "pr" else f"branch {v.get('branch')}"


def _who(t: dict) -> str:
    c = (t.get("comments") or [{}])[0]
    return f"{c.get('author', '?')}: {' '.join(str(c.get('body', '')).split())[:200]}"


def review_prs(api: KeelApi, project: str | None = None, filter: str = "all") -> str:
    pid = _project(api, project)["id"]
    _plugin_on(api, pid, "review")
    r = api.get(f"/projects/{pid}/review/prs", filter=filter)
    prs = r.get("prs") or []
    if not prs:
        return r.get("note") or f"No open pull request ({filter})."
    head = f"{(r.get('host') or {}).get('path', '')} · {len(prs)} pull request(s) ({filter})".lstrip(" ·")
    lines = [f"#{p['number']}  {p['title']} · {p['author']} · {p['branch']} → {p['base']}"
             + (" · asks you" if p.get("review_requested") else "") + (" · yours" if p.get("mine") else "") + (" · draft" if p.get("draft") else "")
             for p in prs]
    return "\n".join([head, *lines])


def review_files(api: KeelApi, project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
    _, v = _open(api, project, pr, branch)
    viewed = set(v.get("viewed") or [])
    out = [f"{_name(v).capitalize()}: {v.get('title')} · {v.get('branch')} → {v.get('base')} · +{v.get('added', 0)} −{v.get('removed', 0)}"
           f" · review key {v.get('key')}"]
    if v.get("approved") or v.get("changes_requested"):
        out.append(f"approved by {', '.join(v.get('approved') or []) or 'nobody'} · changes asked by {', '.join(v.get('changes_requested') or []) or 'nobody'}")
    out.append(f"{len(v.get('files') or [])} file(s):")
    out += [f"  {f['status']}  {f['path']}  +{f['added']} −{f['removed']}" + ("  (viewed)" if f["path"] in viewed else "")
            for f in v.get("files") or []]
    threads = v.get("threads") or []
    if threads:
        out.append(f"{len(threads)} thread(s) (thread_id for keel_review_reply / keel_review_resolve):")
        out += [f"  {t['id']}  {t.get('path') or '(the pull request)'}:{t.get('line') or '-'}  {'resolved' if t.get('resolved') else 'open'}"
                f"  {_who(t)} ({len(t.get('comments') or [])} comment(s))" for t in threads]
    drafts = v.get("drafts") or []
    if drafts:
        out.append(f"{len(drafts)} draft comment(s), sent with your review (keel_review_submit):")
        out += [f"  {d.get('path') or '(the review)'}:{d.get('line') or '-'} {d.get('side', 'RIGHT')}  {' '.join(str(d.get('body', '')).split())[:200]}"
                for d in drafts]
    out += [f"note: {n}" for n in v.get("notes") or []]
    return "\n".join(out)


def review_diff(api: KeelApi, path: str | None = None, project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
    pid, v = _open(api, project, pr, branch)
    paths = [path] if path else [f["path"] for f in v.get("files") or [] if not f.get("binary")]
    out: list[str] = []
    for p in paths:
        d = api.get(f"/projects/{pid}/review/diff", key=v["key"], path=p)
        out += (d.get("diff") or f"(no text diff for {p})").rstrip("\n").split("\n")
        if len(out) > MAX_DIFF_LINES:
            more = len(paths) - paths.index(p) - 1
            return "\n".join(out[:MAX_DIFF_LINES] + [f"… cut at {MAX_DIFF_LINES} lines" + (f"; {more} more file(s): ask for one with path" if more else "")])
    return "\n".join(out) or "No change."


def _coverage(r: dict) -> list[str]:
    """keel 0.18.57: a run that did not read every changed file says so, with the files (the first 20)."""
    c = r.get("coverage") or {}
    if not c.get("known"):
        return []
    if not r.get("partial"):
        return [f"  read all {c.get('files')} changed file(s)"]
    unread = c.get("unread") or []
    return [f"  PARTIAL: read {c.get('read')} of {c.get('files')} changed file(s); not read: " + ", ".join(unread[:20])
            + (f" … {len(unread) - 20} more" if len(unread) > 20 else "")]


def review_notes(api: KeelApi, project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
    pid, v = _open(api, project, pr, branch)
    ai = api.get(f"/projects/{pid}/review/ai", key=v["key"]) or {}
    out = [f"keel on {_name(v)}:"]
    o = ai.get("overview")
    if not o:
        out.append("overview: none yet (keel_review_explain asks for one)")
    else:
        r = o.get("result") or {}
        out.append(f"overview: {o.get('status')}" + (" (the code moved on since)" if o.get("stale") else "") + (f" · {o['error']}" if o.get("error") else ""))
        if r.get("summary"):
            out += [f"  {r['summary']}", f"  risk {r.get('risk') or '-'}: {r.get('risk_why') or ''} · effort {r.get('effort', '-')}/5"]
            out += _coverage(r)
            out += [f"  {f['path']}: {f['what']}" for f in r.get("files") or []]
    f = ai.get("findings")
    if not f:
        out.append("findings: none yet (keel_review_findings asks for them)")
    else:
        r = f.get("result") or {}
        found = r.get("findings") or []
        out.append(f"findings: {f.get('status')} · {len(found)} found" + (f" · {f['error']}" if f.get("error") else ""))
        out += _coverage(r)
        out += [f"  {x.get('severity')}  {x.get('path') or '-'}:{x.get('line') or '-'}  {x.get('title')} ({x.get('check', '')})\n    {x.get('why', '')}"
                for x in found]
    return "\n".join(out)


def review_comment(api: KeelApi, path: str, line: int, body: str, side: str = "RIGHT", project: str | None = None,
                   pr: int | None = None, branch: str | None = None, start_line: int | None = None) -> str:
    pid, v = _open(api, project, pr, branch)
    draft = {"key": v["key"], "path": path, "line": int(line), "side": side, "body": body}
    if start_line is not None and int(start_line) != int(line):
        draft |= {"start_line": int(start_line), "start_side": side}
    d = api.post(f"/projects/{pid}/review/drafts", draft)
    at = f"{d['start_line']}-{line}" if d.get("start_line") else f"{line}"
    return f"Draft {d['id']} on {path}:{at} saved in keel; it is sent with your review (keel_review_submit)."


def review_reply(api: KeelApi, thread_id: str, body: str, project: str | None = None, pr: int | None = None) -> str:
    pid, v = _open(api, project, pr, None)
    api.post(f"/projects/{pid}/review/threads/{thread_id}/reply", {"key": v["key"], "body": body})
    return f"Replied on thread {thread_id} of {_name(v)}."


def review_resolve(api: KeelApi, thread_id: str, resolved: bool = True, project: str | None = None, pr: int | None = None) -> str:
    pid, v = _open(api, project, pr, None)
    api.post(f"/projects/{pid}/review/threads/{thread_id}/resolve", {"key": v["key"], "resolved": bool(resolved)})
    return f"Thread {thread_id} of {_name(v)} is {'resolved' if resolved else 'open again'}."


def review_ai(api: KeelApi, kind: str, project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
    pid, v = _open(api, project, pr, branch)
    api.post(f"/projects/{pid}/review/ai/{kind}", {"key": v["key"]})
    what = "reads the change for an overview" if kind == "overview" else "looks for problems (two reviewers, then each claim is checked)"
    return f"keel {what} on {_name(v)} in KeelBot's sessions (it edits nothing). keel_review_notes shows it when it is done."


def review_submit(api: KeelApi, event: str, body: str = "", project: str | None = None, pr: int | None = None) -> str:
    pid, v = _open(api, project, pr, None)
    r = api.post(f"/projects/{pid}/review/submit", {"key": v["key"], "event": event, "body": body})
    return f"Sent your review ({event}) on {_name(v)} with {r.get('posted', 0)} line comment(s)" + (f": {r['url']}" if r.get("url") else ".")


def _acting(srv, guard):
    """keel's way to run an acting tool (keel 0.16.1: who acts, and with `confirm` the person's OK through the client
    first; PartServer.act in keel_engine/mcp_server.py). A keel before 0.16.1 has none: then the tool runs as it did."""
    act = getattr(srv, "act", None)

    async def run(ctx, name: str, what: str, fn, *a, confirm: bool = False, **kw) -> str:
        if act is None:
            return guard(fn, *a, **kw)
        return await act(ctx, name, what, fn, *a, confirm=confirm, **kw)

    return run


def register(srv, api: KeelApi, guard, write: bool) -> None:
    """The read tools, or (write) the acting ones."""
    from mcp.types import ToolAnnotations

    if not write:
        ro = ToolAnnotations(readOnlyHint=True, openWorldHint=False)

        @srv.tool(annotations=ro, structured_output=False)
        def keel_review_prs(project: str | None = None, filter: Literal["all", "review", "assigned", "mine"] = "all") -> str:
            """Code Review plugin: the open pull requests (GitHub) or merge requests (GitLab): number, title, author, branch.
            filter: all, review (you are asked), assigned or mine."""
            return guard(review_prs, api, project, filter)

        @srv.tool(annotations=ro, structured_output=False)
        def keel_review_files(project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
            """Code Review plugin: a review's changed files (status, +/-, viewed), its threads (with their ids), your draft
            comments and who approved. pr: a pull request's number; branch: a branch; neither: the branch you are on."""
            return guard(review_files, api, project, pr, branch)

        @srv.tool(annotations=ro, structured_output=False)
        def keel_review_diff(path: str | None = None, project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
            """Code Review plugin: the diff of one changed file (path), or of every file (cut at 600 lines), against the
            review's base."""
            return guard(review_diff, api, path, project, pr, branch)

        @srv.tool(annotations=ro, structured_output=False)
        def keel_review_notes(project: str | None = None, pr: int | None = None, branch: str | None = None) -> str:
            """Code Review plugin: keel's overview of a review (what changes, file by file, risk) and its checked findings."""
            return guard(review_notes, api, project, pr, branch)

        return
    rw = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=False)
    out = ToolAnnotations(readOnlyHint=False, destructiveHint=False, idempotentHint=False, openWorldHint=True)
    act = _acting(srv, guard)

    @srv.tool(annotations=rw, structured_output=False)
    async def keel_review_comment(path: str, line: int, body: str, side: Literal["RIGHT", "LEFT"] = "RIGHT", project: str | None = None,
                                  pr: int | None = None, branch: str | None = None, start_line: int | None = None,
                                  ctx: Context | None = None) -> str:
        """Code Review plugin: a line comment as a draft, kept in keel until you submit the review (keel_review_submit).
        line: the new file's line (side RIGHT), or the old file's for a removed line (side LEFT). start_line: the first
        line of a comment on several lines (line is the last)."""
        return await act(ctx, "keel_review_comment", "add a draft comment", review_comment, api, path, line, body, side, project, pr, branch,
                         start_line)

    @srv.tool(annotations=out, structured_output=False)
    async def keel_review_reply(thread_id: str, body: str, project: str | None = None, pr: int | None = None, ctx: Context | None = None) -> str:
        """Code Review plugin: reply on a pull request's thread (ids from keel_review_files). It is posted on GitHub or
        GitLab at once, so the person says yes first."""
        return await act(ctx, "keel_review_reply", f"post a reply on thread {thread_id}", review_reply, api, thread_id, body, project, pr, confirm=True)

    @srv.tool(annotations=out, structured_output=False)
    async def keel_review_resolve(thread_id: str, resolved: bool = True, project: str | None = None, pr: int | None = None,
                                  ctx: Context | None = None) -> str:
        """Code Review plugin: resolve a thread (or open it again with resolved=false), on GitHub or GitLab, after the
        person's yes."""
        return await act(ctx, "keel_review_resolve", f"{'resolve' if resolved else 'reopen'} thread {thread_id}", review_resolve, api, thread_id,
                         resolved, project, pr, confirm=True)

    @srv.tool(annotations=rw, structured_output=False)
    async def keel_review_explain(project: str | None = None, pr: int | None = None, branch: str | None = None, ctx: Context | None = None) -> str:
        """Code Review plugin: ask keel for an overview of the change (KeelBot reads the code and edits nothing; it uses
        tokens). keel_review_notes reads it when it is done."""
        return await act(ctx, "keel_review_explain", "ask keel to explain the change", review_ai, api, "overview", project, pr, branch)

    @srv.tool(annotations=rw, structured_output=False)
    async def keel_review_findings(project: str | None = None, pr: int | None = None, branch: str | None = None, ctx: Context | None = None) -> str:
        """Code Review plugin: ask keel for findings (two reviewers, then each claim is checked against the code; it
        edits nothing and uses tokens). keel_review_notes reads them when they are done."""
        return await act(ctx, "keel_review_findings", "ask keel for findings", review_ai, api, "findings", project, pr, branch)

    @srv.tool(annotations=out, structured_output=False)
    async def keel_review_submit(event: Literal["APPROVE", "REQUEST_CHANGES", "COMMENT"], body: str = "", project: str | None = None,
                                 pr: int | None = None, ctx: Context | None = None) -> str:
        """Code Review plugin: send your review of a pull request with every draft comment: APPROVE, REQUEST_CHANGES or
        COMMENT, with an optional text. The person says yes first."""
        return await act(ctx, "keel_review_submit", f"send your review ({event})" + (f" on #{pr}" if pr else ""), review_submit, api, event, body,
                         project, pr, confirm=True)
