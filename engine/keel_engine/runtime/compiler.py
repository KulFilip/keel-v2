"""Compile a Workflow into a LangGraph StateGraph.

    START ─▶ step ─▶ step ─▶ __ac_begin ─▶ [per_ac steps ...] ─▶ __ac_end ─┐ ─▶ step ... ─▶ __finish ─▶ END
                                 ▲                                         │
                                 └──────────── next AC ────────────────────┘

Every node returns Command(goto=...): the default is the next step, a gate's reject follows `back`,
a branch's "no" follows `no`, a failed check goes back to the agent before it. Gates, budget pauses
and "keeps failing" pauses are interrupt()s; only POST /threads/{id}/resume continues them.

interrupt() re-runs its node from the top on resume, so nothing with a side effect may sit before
an interrupt() unless re-running it is the intended retry.
"""

from __future__ import annotations

import asyncio
import copy
import dataclasses
import datetime
import hashlib
import json
import logging
import re
import tempfile
import time
import uuid
from pathlib import Path

from langgraph.errors import GraphBubbleUp
from langgraph.graph import END, START, StateGraph
from langgraph.types import Command, interrupt

from .. import addons, extensions, models, rules
from . import doc_history
from ..models import catalog
from ..models import usage as provider_usage
from ..models.base import AgentRequest, AgentResult, ModelError
from ..models.stream import DeltaThrottle
from .findings import REVIEWERS, blocking, unique
from ..tools import git, guard, mcp
from ..tools.agent_tools import ToolBox
from ..workflows.model import Loop, Step, Workflow
from . import agent_knowledge, clarify, guard_ctx, init_gates, markers, prompts, run_mode, spec_check, stacks
from . import blockers as push_gates
from . import choices as choices_mod
from . import flow_actions
from . import tools as tool_runner
from . import memory as memory_mod
from . import ship as ship_mod
from .actions import ActionInput, ActionResult, revert_manifests, run_action
from .state import FlowState, ThreadContext, merge_unlocks, normalize_unlocks

log = logging.getLogger(__name__)

AC_BEGIN, AC_END, FINISH = "__ac_begin", "__ac_end", "__finish"
END_TARGET = "end"                   # a branch's `no` or a gate choice that finishes the flow
KNOWN_SECTIONS = {"architecture", "domain", "conventions", "data", "integrations"}
OPTIONS = ["approve", "reject"]
# How often one gate (step and criterion or item) may be sent back in a row before keel asks: go on anyway or stop
# (settings.sendback_limit). A loop of send-backs that changes nothing never runs by itself.
SENDBACK_LIMIT = flow_actions.SENDBACK_LIMIT
# What the next agent reads when a send-back came without a reason (an old client, a driver script).
NO_REASON = ("The person sent this back but gave no reason. Do not do the same work again: if you cannot tell what to "
             "change, say so in one line and ask them once what they want.")
# A spec path an agent's answer names: `.keel/specs/x.md`, docs/specs/x.md
SPEC_PATH = re.compile(r"(?<![\w./-])((?:\.{0,2}/)?[\w@.-]+(?:/[\w@.-]+)*\.md)\b")
# The knowledge check's actions: a failure goes to the librarian, never fails the flow (Compiler._knowledge_failed).
KNOWLEDGE_CHECKS = ("knowledge_check", "memory_check")
RESUMABLE = {"claude", "codex"}      # CLIs whose sessions keel can continue (claude --resume, codex exec resume)
ALREADY_MET = "already-met"
DONE = ("done", ALREADY_MET)        # AC statuses the per-AC loop is finished with
ITEM_DONE = ("done", "skipped", "failed")   # item statuses a for_each loop is finished with (todo is the rest)
# Where a review fix goes (findings_step, payload.route) and the actions that follow the fixing agent.
ROUTES = {"review-fix": ("verify_green", "commit"), "coverage-fix": ("verify_green", "commit"), "red": ("commit",)}
STEP_FIELD_MAX = 24_000          # per string field of an agent.step (runners already cap at 20 KB plus a note)
USAGE_EVERY = 15.0               # 0.18.17 seconds between two agent.usage events of one running call (the usage so far)



KEEP_MAX = 60_000       # `keep: true`: the most of an agent's answer the flow keeps for its next steps


def add_usage(usage: dict, used: dict | None) -> dict:
    """usage += used (tokens_in, tokens_out, tokens_cached, cost_usd, premium_requests); returns usage."""
    for k in ("tokens_in", "tokens_out", "tokens_cached", "premium_requests"):
        if (used or {}).get(k):
            usage[k] = int(usage.get(k, 0)) + int(used[k])
    if (used or {}).get("cost_usd"):
        usage["cost_usd"] = round(float(usage.get("cost_usd", 0.0)) + float(used["cost_usd"]), 6)
    return usage


CONTINUE = ("You used all your turns before you finished. Continue the same task from where you stopped: everything you "
            "changed is still on disk. Do not start over. End with the answer the task asks for (and its result lines).")


async def run_or_continue(runner, req: AgentRequest, emit, can_resume: bool, memory) -> AgentResult:
    """v0.17.5 an agent that runs out of turns continues its own session once with "continue" (claude --resume, codex
    exec resume) instead of starting fresh; the tokens of the cut-off run are added to the result. `memory` returns the
    step's memory row (its session) or None."""
    try:
        return await runner.run(req, emit)
    except ModelError as exc:
        if not (exc.max_turns and can_resume):
            raise
        row = memory()
        row = (await row) if row is not None and hasattr(row, "__await__") else row
        sid = (row or {}).get("session") or req.session
        if not sid:
            raise
        spent = dict(exc.usage or {})
    emit("text", "The agent used all its turns: keel continues its own session (\"continue\").")

    def emit_on(kind: str, text: str = "", **extra):
        # 0.18.17 the continued run counts its usage from 0: the call's usage so far includes the cut-off run's
        emit(kind, text, **(add_usage(dict(extra), spent) if kind == "usage" else extra))
    try:
        res = await runner.run(dataclasses.replace(req, prompt=CONTINUE, session=sid, resume=True), emit_on)
    except ModelError as exc:
        exc.usage = add_usage(dict(exc.usage or {}), spent)
        raise
    res.tokens_in += int(spent.get("tokens_in", 0))
    res.tokens_out += int(spent.get("tokens_out", 0))
    res.tokens_cached += int(spent.get("tokens_cached", 0))
    res.cost_usd += float(spent.get("cost_usd", 0.0))
    return res


def _usage_fields(u: dict) -> dict:
    """An agent event's usage fields (agent.usage, agent.finished) from a usage dict."""
    return {"tokens_in": int(u.get("tokens_in", 0)), "tokens_out": int(u.get("tokens_out", 0)),
            "tokens_cached": int(u.get("tokens_cached", 0)), "cost_usd": round(float(u.get("cost_usd", 0.0)), 6)}


def running_usage(usage: dict, running: dict) -> dict:
    """0.18.17 a flow's usage with the usage so far of the agents that still run (ThreadContext.running)."""
    out = dict(usage)
    for u in list(running.values()):
        add_usage(out, u)
    return out


def raised_cap(used: int, cap: int, first: int) -> int:
    """0.18.17 the token cap after "Token cap reached" is approved: what the flow used plus the largest of the cap now,
    the flow's first cap and half of what it used. One approval bought only one cap more (used + cap): with the 500,000
    default a big flow asked a person every 500k (500k, 1.03M, 1.53M, ...); half the use so far makes the gates come
    further apart as the flow grows, and an approval never buys less than before."""
    return int(used + max(cap, first, used // 2, 1))


def budget_tokens(usage: dict) -> int:
    """Tokens that count toward caps: new input + output + a tenth of cache reads (they cost about a tenth)."""
    return int(usage.get("tokens_in", 0)) + int(usage.get("tokens_out", 0)) + int(usage.get("tokens_cached", 0)) // 10


def answer_problem(question: dict, decision: str, why: str | None, payload: dict | None) -> tuple[str, str] | None:
    """(error, hint) when an answer does not fit the question that waits, else None. A gate takes only the decisions it
    offers (a spec gate without criteria offers only "reject": an "approve" there acted as a send-back without a reason,
    hundreds of times), and only one of its choices. A send-back from a gate needs a reason: it goes into the next
    agent's prompt. A gate with named exits takes a plain reject as its exit "reject" when it has one (Compiler._choice)."""
    title = question.get("title") or "This question"
    options = list(question.get("options") or OPTIONS)
    choices = [str(c) for c in question.get("choices") or []]
    if decision not in options and not (decision == "reject" and "reject" in choices):
        return (f'"{title}" does not take {decision}.', "Answer with one of: " + ", ".join(options) + ".")
    choice = (payload or {}).get("choice")
    if choice is not None and choices and str(choice) not in choices:
        return (f'"{choice}" is not a choice of "{title}".', "Choose one of: " + ", ".join(choices) + ".")
    back = decision == "reject" or choice == "reject"         # "reject" as a named exit sends back too (feature's spec gate)
    said = (why or "").strip() or str((payload or {}).get("reason") or (payload or {}).get("note") or "").strip()
    if back and question.get("kind", "gate") == "gate" and not said:
        return ("Say why when you send it back.", "The reason goes into the next agent's prompt.")
    # 0.19.0 a choice whose choice_info says a reason is required (skip an item, accept uncovered lines, close a finding)
    took = choices_mod.picked(question, decision, payload)
    if took and took.get("why") == choices_mod.REQUIRED and not said:
        return (f'Say why when you choose "{took.get("label") or took.get("name")}".', "The reason is recorded.")
    return None


def question_id(question: dict) -> str:
    """Names a question by what it asks (not its detail, which changes between runs)."""
    raw = "|".join(str(question.get(k) or "") for k in ("step", "kind", "title"))
    return hashlib.sha1(raw.encode()).hexdigest()[:12]


def ask_once(question: dict) -> dict:
    """interrupt(), but an answer only counts for the question it was given to.

    A resumed node runs again from the top, so it can reach a different question first (verify_red: "keeps
    failing" before, "already passes" now). The resume carries `asked` = the id the user saw; when it does not
    match, the node pauses again on the new question. LangGraph keeps one resume value per interrupt() in a node.
    """
    qid = question_id(question)
    question = {**question, "id": qid}
    answer = interrupt(question) or {}
    while answer.get("asked") and answer["asked"] != qid:
        answer = interrupt(question) or {}
    return answer

class LaneFailed(Exception):
    pass


class Nav:
    """Where to go next, given the step list and its loops (the per-AC loop and the for_each loops).

    A loop is entered through its begin node, which picks the next unfinished entry (AC or item) or leaves the loop;
    its last step goes to its end node, which marks the entry done and goes round to the begin node.
    """

    def __init__(self, wf: Workflow):
        self.steps = wf.steps
        self.index = {s.id: i for i, s in enumerate(wf.steps)}
        self.loops = wf.loops()
        ac = next((lp for lp in self.loops if lp.per_ac), None)
        self.first, self.last = (ac.first, ac.last) if ac else (None, None)

    def loop_of(self, i: int) -> Loop | None:
        return next((lp for lp in self.loops if lp.first <= i <= lp.last), None)

    @staticmethod
    def begin(lp: Loop) -> str:
        return AC_BEGIN if lp.per_ac else f"__each_{lp.id}"

    @staticmethod
    def end(lp: Loop) -> str:
        return AC_END if lp.per_ac else f"__each_{lp.id}_end"

    def enter(self, j: int) -> str:
        if j >= len(self.steps):
            return FINISH
        lp = next((lp for lp in self.loops if lp.first == j), None)
        return self.begin(lp) if lp else self.steps[j].id

    def after(self, i: int) -> str:
        lp = self.loop_of(i)
        if lp and i == lp.last:
            return self.end(lp)
        return self.enter(i + 1)

    def after_loop(self, lp: Loop | None = None) -> str:
        lp = lp or next((x for x in self.loops if x.per_ac), None)
        return self.enter(lp.last + 1) if lp else FINISH

    def jump(self, sid: str, from_i: int) -> str:
        if sid == END_TARGET:
            return FINISH
        j = self.index[sid]
        target, here = self.loop_of(j), self.loop_of(from_i)
        if target and (not here or here.id != target.id):
            return self.begin(target)
        return self.steps[j].id if target else self.enter(j)

    def retry_target(self, i: int) -> str | None:
        """The agent step a failed check sends work back to (never across a loop's edge)."""
        here = (self.loop_of(i) or Loop(id="", key="", first=-1, last=-1)).id
        for k in range(i - 1, -1, -1):
            s = self.steps[k]
            if (self.loop_of(k) or Loop(id="", key="", first=-1, last=-1)).id != here:
                break
            if s.kind in ("agent", "parallel"):
                return s.id
        return None


def fix_id(review_id: str) -> str:
    return f"{review_id}__fix"


def close_note(state: FlowState) -> str:
    """The flow's last note: "done", plus the warnings it went on with (a knowledge check that kept failing)."""
    warned = [w.get("text") or "" for w in (state.get("data") or {}).get("warnings") or []]
    return "done" + (f" with {len(warned)} warning(s): " + "; ".join(warned) if warned else "")


def _ac(state: FlowState) -> dict | None:
    return next((a for a in state.get("acs") or [] if a["id"] == state.get("ac")), None)


def _set_ac(acs: list[dict], ac_id: str | None, status: str) -> list[dict]:
    return [dict(a, status=status) if a["id"] == ac_id else dict(a) for a in acs]


def get_list(state: FlowState, key: str) -> list[dict]:
    """A list of items in the state: state.data[key] (collected by a step, or a seed), else the state's own key (acs).
    Entries that are not dicts are left out; every entry has an id."""
    data = state.get("data") or {}
    raw = data[key] if key in data else state.get(key)
    if not isinstance(raw, list):
        return []
    return [dict(x, id=str(x.get("id") or f"{key}-{n + 1}")) for n, x in enumerate(raw) if isinstance(x, dict)]


def put_list(state: FlowState, key: str, items: list[dict]) -> dict:
    """The state update that stores a list where get_list reads it."""
    data = state.get("data") or {}
    if key not in data and key in FlowState.__annotations__:
        return {key: items}
    return {"data": {**data, key: items}}


class Compiler:
    def __init__(self, ctx: ThreadContext):
        self.ctx = ctx
        self.wf = ctx.workflow
        self.nav = Nav(self.wf)

    # ------------------------------------------------------------ build

    def build(self, checkpointer):
        g = StateGraph(FlowState)
        for i, step in enumerate(self.wf.steps):
            fn = {"agent": self.agent_step, "parallel": self.agent_step, "code": self.code_step,
                  "gate": self.gate_step, "branch": self.branch_step}[step.kind]
            g.add_node(step.id, self._wrap(i, step, fn))
            if self._reviews(step):
                fix = Step(id=fix_id(step.id), kind="agent", name=f"{step.name}: fix findings", agent="implementer",
                           model=step.model, phase="review-fix")
                g.add_node(fix.id, self._wrap(i, fix, self.findings_step))
        for lp in self.nav.loops:
            g.add_node(self.nav.begin(lp), self._loop_begin(lp))
            g.add_node(self.nav.end(lp), self._loop_end(lp))
        g.add_node(FINISH, self.finish)
        g.add_edge(START, self.nav.enter(0))
        return g.compile(checkpointer=checkpointer)

    def _wrap(self, i: int, step: Step, fn):
        ctx = self.ctx

        async def node(state: FlowState):
            if state.get("status") in ("stopped", "failed"):
                return Command(goto=END)
            # Unlocks granted through the engine API (POST /threads/{id}/unlocks) since the last step join the thread's state.
            have = list(state.get("unlocks") or [])
            merged = merge_unlocks(have, ctx.api_unlocks)
            if len(merged) != len(have):
                state = {**state, "unlocks": merged}
            prev = state.get("phase") or "none"
            phase = step.phase or prev
            ac = state.get("ac") if step.per_ac else None
            item = state.get("item") if step.per_item else None
            skipped = self._skipped(i, step, state)
            if skipped:
                why, goto = skipped
                ctx.emit("step.started", step=step.id, data={"name": step.name, "kind": step.kind, "phase": prev, "ac": ac,
                                                             "from": prev, "flow": self.wf.flow, "skipped": True})
                ctx.emit("step.finished", step=step.id, data={"name": step.name, "kind": step.kind, "phase": prev, "ac": ac,
                                                              "ok": True, "note": why, "skipped": True})
                return Command(update={"note": why, "current": step.id,
                                       **({"unlocks": merged} if len(merged) != len(have) else {})}, goto=goto)
            started = {"name": step.name, "kind": step.kind, "phase": phase, "ac": ac, "from": prev, "flow": self.wf.flow,
                       "phase_changed": prev != phase, "transition_ok": rules.can_transition(prev, phase)}
            if item:
                started["item"] = item
            ctx.emit("step.started", step=step.id, data=started)
            # v0.15.9 keel's file history: what changed before this step (outside keel) and during it (runtime/doc_history.py)
            docs_before = doc_history.before_step(ctx.emit, ctx.root, phase, step.id)
            update, goto = await fn(i, step, {**state, "phase": phase})
            by_kind, by_name = doc_history.who(step)
            doc_history.after_step(ctx.emit, ctx.root, docs_before, by_kind, by_name, phase, step.id,
                                   (state.get("data") or {}).get("started_via"))
            if len(merged) != len(have):
                update.setdefault("unlocks", merged)
            update.setdefault("phase", phase)
            update.setdefault("current", step.id)
            failed = update.get("status") in ("stopped", "failed")
            finished = {"name": step.name, "kind": step.kind, "phase": phase, "ac": ac, "ok": not failed, "note": update.get("note")}
            if item:
                finished["item"] = item
            ctx.emit("step.finished", step=step.id, data=finished)
            return Command(update=update, goto=END if failed else goto)

        node.__name__ = f"step_{step.id}"
        return node

    def _skipped(self, i: int, step: Step, state: FlowState) -> tuple[str, str] | None:
        """(why, where to) when this step does not run: turned off at the opening skip menu (the whole unit of steps
        that share its group is passed over), or a retry_only step that nothing sent work back to."""
        unit = ship_mod.unit_of(step)
        if step.skippable:
            skip = next((s for s in (state.get("data") or {}).get("ship_skipped") or [] if s.get("step") == unit), None)
            if skip:
                j = i
                while j + 1 < len(self.wf.steps) and self.wf.steps[j + 1].skippable and ship_mod.unit_of(self.wf.steps[j + 1]) == unit:
                    j += 1
                return f"{unit} skipped: {skip.get('reason') or 'no reason given'}", self.nav.after(j)
        if step.retry_only and not (state.get("last_failure") or state.get("feedback")):
            return f"{step.name}: nothing was sent back; not needed", self.nav.after(i)
        if step.when and step.kind in ("agent", "parallel", "code"):
            # On a working step, `when` says when it runs (feature: the explorers only once there are criteria).
            label, values = self._when(state, step.when)
            if not self._holds(step.when, values):
                return f"{step.name}: not needed ({label}: {self._shown_values(values)})", self.nav.after(i)
        return None

    # ------------------------------------------------------------ loop + end

    def _loop_begin(self, lp: Loop):
        """The loop's entry: the next AC (or item) that is not finished, else on past the loop."""
        cursor, finished = ("ac", DONE) if lp.per_ac else ("item", ITEM_DONE)

        async def begin(state: FlowState):
            if state.get("status") in ("stopped", "failed"):
                return Command(goto=END)
            items = get_list(state, lp.key)
            nxt = next((a for a in items if a.get("status") not in finished), None)
            if not nxt:
                return Command(update={cursor: None}, goto=self.nav.after_loop(lp))
            if lp.per_ac:
                # v0.17.5 a criterion waits for the ones it depends on (the plan's depends_on): the first unfinished one
                # whose dependencies are finished; when none is (a cycle, or one that is not in the list), list order.
                open_ids = {a["id"] for a in items if a.get("status") not in finished}
                nxt = next((a for a in items if a.get("status") not in finished
                            and not (set(a.get("depends_on") or []) & open_ids)), nxt)
            update = {cursor: nxt["id"], "retries": {}}
            esc = (state.get("data") or {}).get("ladder_escalated")
            if lp.per_ac and esc and esc.get("ac") != nxt["id"]:
                # the stall ladder's stronger model was for that criterion only: the agent's model goes back
                models_ = dict(state.get("agent_models") or {})
                if esc.get("before"):
                    models_[esc["agent"]] = esc["before"]
                else:
                    models_.pop(esc["agent"], None)
                data = {k: v for k, v in (state.get("data") or {}).items() if k != "ladder_escalated"}
                update.update(agent_models=models_, data=data)
            return Command(update=update, goto=self.wf.steps[lp.first].id)

        begin.__name__ = f"loop_begin_{lp.id}"
        return begin

    def _loop_end(self, lp: Loop):
        """The loop's last step is through: the entry is done (unless it is already met, skipped or failed)."""
        cursor = "ac" if lp.per_ac else "item"
        keep = (ALREADY_MET,) if lp.per_ac else ("skipped", "failed")

        async def end(state: FlowState):
            items = get_list(state, lp.key)
            cur = next((a for a in items if a["id"] == state.get(cursor)), None)
            if cur and cur.get("status") not in keep:
                items = _set_ac(items, state[cursor], "done")
            return Command(update=put_list(state, lp.key, items), goto=self.nav.begin(lp))

        end.__name__ = f"loop_end_{lp.id}"
        return end

    def _item(self, state: FlowState, step: Step) -> dict | None:
        """The current item of the for_each loop this step is in."""
        if not step.per_item:
            return None
        lp = self.nav.loop_of(self.nav.index[step.id]) if step.id in self.nav.index else None
        if not lp:
            return None
        return next((x for x in get_list(state, lp.key) if x["id"] == state.get("item")), None)

    async def finish(self, state: FlowState):
        return Command(update={"status": "done", "ac": None, "note": close_note(state), **self._booked(state)}, goto=END)

    def _booked(self, state: FlowState) -> dict:
        """{"usage": ...} with the failed calls' tokens booked in, or {} when there are none."""
        if not self.ctx.unbooked:
            return {}
        usage = add_usage(dict(state.get("usage") or {}), self.ctx.unbooked)
        self.ctx.unbooked.clear()
        return {"usage": usage}

    # ------------------------------------------------------------ models

    def _model(self, state: FlowState, step: Step, agent: str) -> dict:
        m = None
        if state.get("model_override"):
            m = state["model_override"]
        elif (state.get("agent_models") or {}).get(agent):
            m = state["agent_models"][agent]
        elif step.model and step.model != "default" and step.model in self.ctx.models:
            m = self.ctx.models[step.model]
        elif agent in self.ctx.models:
            m = self.ctx.models[agent]
        elif "default" in self.ctx.models:
            m = self.ctx.models["default"]
        return models.effective(m)

    def _ask(self, state: FlowState, question: dict, gate: str | None = None, review: str | None = None) -> tuple[dict, dict]:
        """interrupt() for any pause, plus what every answer may carry: payload.unlock {path, phase}.

        The thread's run mode may answer first (runtime/run_mode.py): `gate` names the kind of pause when the caller knows
        it (else it is classified from the question), `review` is the AC review's answer for an AC gate. An automatic
        answer is {decision: approve, why: "auto-approved (mode <m>)", auto: true}; the caller logs it like any answer.

        Returns (answer, state update). An unlock is added to state.unlocks and logged as a gate event.
        """
        answer = self._auto_answer(state, question, gate, review)
        if answer is None:
            answer = ask_once(question)
        payload = answer.get("payload") or {}
        new = normalize_unlocks(payload.get("unlock"), state.get("phase") or "none", "user")
        if not new:
            return answer, {}
        have = list(state.get("unlocks") or [])
        merged = merge_unlocks(have, new)
        for u in merged[len(have):]:
            self.ctx.emit("gate.decided", step=question.get("step"), data={
                "gate": "unlock", "decision": "approve", "unlock": {"path": u["path"], "phase": u["phase"]},
                "why": f"{u['path']} in {u['phase']}" + (f": {answer.get('why')}" if answer.get("why") else "")})
        return answer, {"unlocks": merged}

    def _mode(self) -> str:
        return run_mode.normalize((self.ctx.settings or {}).get("run_mode"))

    def _readonly(self) -> bool:
        return self._mode() == "readonly"

    def _auto_answer(self, state: FlowState, question: dict, gate: str | None, review: str | None) -> dict | None:
        """The run mode's answer to this pause, or None to ask. A question the user is answering right now (it waited
        before the mode changed: the resume carries its id) is always theirs. keel approves the very same question by
        itself at most run_mode.MAX_REPEATS times in a run; then it asks."""
        mode = self._mode()
        if mode in ("manual", "readonly"):
            return None
        qid = question_id(question)
        if getattr(self.ctx, "resume_qid", None) == qid:
            self.ctx.resume_qid = None
            return None
        kind = gate or run_mode.classify(question)
        seen = self.ctx.auto_seen.get(qid, 0)
        answer = run_mode.decide(mode, kind, question, dict(state), review=review, repeats=seen)
        if answer:
            self.ctx.auto_seen[qid] = seen + 1
        return answer

    def _gate_kind(self, i: int, step: Step, state: FlowState, question: dict, ac: dict | None) -> tuple[str, str | None]:
        """A gate step's kind for the run mode, and the AC review's answer when an AC gate follows a review step."""
        prev = self.wf.steps[i - 1] if i else None
        kind = run_mode.classify(question, step, flow=self.wf.flow, prev_actions=prev.actions() if prev else (), per_ac=bool(ac))
        review = None
        if kind == "ac" and prev and prev.per_ac and prev.kind in ("agent", "parallel") and \
                (prev.agent or "") in ("ac-reviewer", "reviewer", "code-reviewer"):
            review = state.get("last_answer") or ""
        return kind, review

    async def _run_agent(self, state: FlowState, step: Step, agent: str, index: int, section: str | None = None,
                         item: dict | None = None) -> tuple[AgentResult, dict, ToolBox]:
        ctx = self.ctx
        phase = state["phase"]
        ac = _ac(state) if step.per_ac else None
        model = self._model(state, step, agent)
        call_id = uuid.uuid4().hex
        # `root: item` (a parallel step): this agent works in its item's folder, read only (another project, e.g. one
        # repo of a product); otherwise in the thread's folder.
        item_root = bool(step.root == "item" and item and item.get("root"))
        root = str(item["root"]) if item_root else ctx.root
        cfg = rules.load_config(root)
        # What this agent may use: its knowledge sections, the code graph, its memory (agent_knowledge.py).
        know = agent_knowledge.for_agent(agent, ctx.agents)
        # The parts' own servers join the MCP servers (keel_engine/extensions.py mcp_specs: the code graph's once the
        # project's index is ready); filter_mcp keeps the code graph only for agents with code_graph on.
        specs, allow = await asyncio.to_thread(extensions.with_part_servers, list(ctx.mcp), list(step.tools or []),
                                               extensions.Agent(agent, know), root)
        # a plugin's read tools (keel-db, keel-git) when the plugin is on and this agent may use them (Tools page)
        wanted = mcp.parse_allow(allow)
        servers = extensions.servers()
        mine = [n for n in extensions.enabled(ctx.settings) if servers.get(n) in wanted]
        plugin_key = extensions.open_call(project=ctx.project_id, root=root, keys=ctx.keys, plugins=mine,
                                          who=f"agent:{agent}") if mine else None
        if plugin_key:
            specs += extensions.server_specs(mine, plugin_key)
        mcp_specs, tools_allow = agent_knowledge.filter_mcp(specs, allow, know)

        def on_refuse(tool: str, path: str, reason: str, command: str | None = None):
            data = {"tool": tool, "path": path or "", "reason": reason, "agent": agent, "phase": phase}
            if command:
                data["command"] = command
            ctx.emit("guard.refused", step=step.id, call_id=call_id, data=data)

        toolbox = ToolBox(root, phase, cfg=cfg, lane=rules.ac_lane(ac) if ac else None,
                          ac=(ac or {}).get("id"), ac_layer=(ac or {}).get("layer", "API"), on_refuse=on_refuse,
                          unlocks=state.get("unlocks") or [], agent=agent, knowledge=know,
                          readonly=self._readonly() or item_root)
        # keel v1's push gate for the agent's own `git push` / `gh pr create` (rules.push_gate)
        toolbox.push_blockers = await asyncio.to_thread(push_gates.for_agents, root, state.get("base_head"), ctx.project_id or None)
        ctx.emit("agent.started", step=step.id, call_id=call_id, data={
            "agent": agent, "provider": model["provider"], "model": model.get("model"), "mode": model.get("mode"),
            "effort": catalog.effort_for(model), "phase": phase, "ac": (ac or {}).get("id"), "index": index, **({"item": item["id"]} if item else {})})
        counter = {"n": 0}

        # Agent memory: the same step again (restart, try again, send-back) continues this agent's own session.
        mem = ctx.memory
        key = memory_mod.attempt_key(step.id, ac or item, agent, index, section)
        if agent in REVIEWERS:
            # 0.18.17 a reviewer remembers one commit only: after a fix commit it continued its old session ("use what
            # you already know") and repeated the fixed findings word for word. A new HEAD is a new review.
            key += "|" + ((await asyncio.to_thread(git.head, root)) or "")[:12]
        prev = await mem.get(key) if mem and know["memory"] else None
        same = bool(prev and prev["provider"] == model["provider"] and prev["root"] == root)
        can_resume = model.get("mode") != "api" and model["provider"] in RESUMABLE
        resuming = bool(same and can_resume and prev.get("session"))
        session = prev["session"] if resuming else (str(uuid.uuid4()) if can_resume and model["provider"] == "claude" else None)
        if mem:
            await mem.start(key, model["provider"], root, session, keep_trail=same)

        # the agent's text as it writes it: agent.delta events (the text so far, every 80 ms; never stored)
        live_text = DeltaThrottle(lambda d: ctx.emit("agent.delta", step=step.id, call_id=call_id, data=d))

        usage_sent = {"at": 0.0}

        def emit(kind: str, text: str = "", **extra):
            if kind == "delta":
                live_text.add(str(text))
                return
            if kind == "usage":
                # 0.18.17 the run's usage so far (runners that learn it while they run): kept for the thread's view and
                # the cap, and sent as agent.usage at most every USAGE_EVERY seconds; agent.finished still books the total
                ctx.running[call_id] = {k: extra[k] for k in ("tokens_in", "tokens_out", "tokens_cached", "cost_usd") if extra.get(k)}
                now = time.monotonic()
                if now - usage_sent["at"] >= USAGE_EVERY:
                    usage_sent["at"] = now
                    ctx.emit("agent.usage", step=step.id, call_id=call_id, data={"agent": agent, **_usage_fields(ctx.running[call_id])})
                    self._running_cap(state, step)
                return
            live_text.reset()
            counter["n"] += 1
            # Every string field (text, diff, output, ...) is bounded; newlines are kept for the web's Markdown and diff views.
            data = {"n": counter["n"], "kind": kind, "text": str(text)[:STEP_FIELD_MAX]}
            data.update({k: (v[:STEP_FIELD_MAX] if isinstance(v, str) else v) for k, v in extra.items() if v is not None})
            ctx.emit("agent.step", step=step.id, call_id=call_id, data=data)
            line = memory_mod.trail_line(kind, str(text), extra) if mem else None
            if line:
                mem.note(key, line)

        prompt = prompts.task_prompt(agent=agent, phase=phase, step_name=step.name, title=ctx.title, root=root, ac=ac,
                                     acs=state.get("acs") or [], feedback=state.get("feedback"), index=index, spec=state.get("spec"),
                                     section=section, unlocks=state.get("unlocks") or [], request=ctx.request,
                                     knowledge=know, graph=agent_knowledge.has_codegraph(mcp_specs, tools_allow), item=item,
                                     pid=ctx.project_id or "", writes_spec=prompts.spec_writer(step))
        asks = prompts.step_asks(step, lambda path: self._seed_value("$" + path, state, item))
        if asks:
            prompt = f"{prompt}\n{asks}"
        if phase == "spec" and not item and not state.get("feedback") and (step.asks or prompts.spec_writer(step)):
            # the parent flow's whole evidence (a spike's report) for the interview and the spec writer
            evidence = prompts.evidence_block((state.get("data") or {}).get("seed"))
            if evidence:
                prompt = f"{prompt}\n\n{evidence}"
        started_from = (state.get("data") or {}).get("spec")
        if phase == "spec" and started_from and started_from == state.get("spec") and not state.get("feedback"):
            # 0.17.3 started from a spec (the Wiki): the agents change that file instead of writing another one
            prompt += (f"\nThis flow starts from the spec {started_from}: change that file (keep its criteria ids and words), "
                       "do not write a new spec file.")
        lint_notes = (state.get("data") or {}).get("lint_notes") or []
        if lint_notes:
            why = "know them while you review" if rules.read_only(phase) else "fix them when they are in your scope"
            prompt += (f"\n\nStatic checks on the files the last step changed ({why}):\n"
                       + "\n".join(f"- {n}" for n in lint_notes))
        note = memory_mod.resume_note(prev, resuming) if same else ""
        if note:
            prompt = f"{note}\n\n{prompt}"
            emit("text", "Continuing this agent's earlier session for this step." if resuming
                 else "This agent gets a summary of its last try on this step.")
        with tempfile.TemporaryDirectory(prefix="keel-agent-") as tmp:
            req = AgentRequest(agent=agent, system=prompts.system_prompt(agent, ctx.skills), prompt=prompt, root=root,
                               phase=phase, model=model, toolbox=toolbox, ac=ac, acs=state.get("acs") or [], title=ctx.title,
                               step_name=step.name, index=index, feedback=state.get("feedback"), mcp_specs=mcp_specs,
                               tools_allow=tools_allow, key=models.key_for(model["provider"], ctx.keys), workdir=tmp,
                               keys=dict(ctx.keys), section=section, session=session, resume=resuming,
                               on_session=(lambda sid: mem.set_session(key, sid)) if mem else None, thread=ctx.thread_id,
                               knowledge=know, item=item)
            # The guard context keel's hook reads on every tool call (CLI agents). It sits in this run's scratch folder,
            # outside the project; an unlock granted while the agent runs rewrites it (ThreadContext.add_unlocks).
            gfile = guard_ctx.GuardFile(Path(tmp) / guard_ctx.FILE, **guard_ctx.context_for(req))
            req.guard_ctx = gfile.path
            live = [gfile, toolbox]
            ctx.guards.extend(live)
            t0 = time.time()
            try:
                res = await run_or_continue(models.runner_for(model), req, emit, can_resume,
                                            lambda: mem.get(key) if mem else None)
            except asyncio.CancelledError:
                # 0.18.17 a stopped run used what it reported so far (it booked 0 before)
                so_far = dict(ctx.running.get(call_id) or {})
                add_usage(ctx.unbooked, so_far)
                ctx.emit("agent.finished", step=step.id, call_id=call_id, data={"agent": agent, "status": "stopped",
                                                                                **_usage_fields(so_far), "premium_requests": 0})
                raise
            except Exception as exc:
                emit("error", f"{exc}{(' ' + exc.hint) if getattr(exc, 'hint', '') else ''}", ok=False)
                if mem:
                    await mem.finish(key, "failed", str(exc))
                # 0.18.17 an error that carries no usage still used what the run reported so far
                used = getattr(exc, "usage", None) or dict(ctx.running.get(call_id) or {})
                add_usage(ctx.unbooked, used)
                # A failed run still used tokens (a turn limit after 30 turns is not free): the job and the budget count them.
                ctx.emit("agent.finished", step=step.id, call_id=call_id, data={
                    "agent": agent, "status": "failed", "tokens_in": used.get("tokens_in", 0), "tokens_out": used.get("tokens_out", 0),
                    "tokens_cached": used.get("tokens_cached", 0), "cost_usd": round(used.get("cost_usd", 0.0), 6),
                    "premium_requests": 0, "result": str(exc)[:500]})
                raise
            finally:
                ctx.running.pop(call_id, None)
                for g in live:
                    ctx.guards.remove(g)
                extensions.close_call(plugin_key)
                self._usage_event(step, model["provider"], t0)
        if mem:
            await mem.finish(key, "done", res.text or "")
        if not res.cost_usd and model.get("mode") == "api" and model["provider"] != "fake":
            res.cost_usd = catalog.cost_usd(model["provider"], model.get("model", ""), res.tokens_in, res.tokens_out)
        if not res.cost_usd and res.premium_requests:
            # 0.18.16 Copilot (any mode) costs premium requests, not tokens: it showed $0 for every call before
            res.cost_usd = catalog.premium_cost(model["provider"], model.get("model", ""), res.premium_requests)
        ctx.emit("agent.finished", step=step.id, call_id=call_id, data={
            "agent": agent, "status": "done", "tokens_in": res.tokens_in, "tokens_out": res.tokens_out, "tokens_cached": res.tokens_cached,
            "cost_usd": round(res.cost_usd, 6), "premium_requests": res.premium_requests, "result": res.text[:2000]})
        return res, model, toolbox

    # ------------------------------------------------------------ budget

    def _usage_event(self, step: Step, provider: str, since: float):
        """provider.usage: the plan's windows this run reported (claude's rate_limit_event), for the api's usage cards."""
        entry = provider_usage.LATEST.get(provider)
        if entry and entry["at"] >= since:
            self.ctx.emit("provider.usage", step=step.id, data={"provider": provider, "windows": entry["windows"],
                                                                "source": entry["source"], "at": provider_usage.iso(entry["at"])})

    def _first_cap(self) -> int:
        """The token cap the flow started with (initial_state): the settings' (or start request's) cap_tokens, else the
        workflow's budget.max_tokens."""
        b = self.wf.budget
        return int(self.ctx.settings.get("cap_tokens") or (b.max_tokens if b and b.max_tokens else 0) or 0)

    def _running_cap(self, state: FlowState, step: Step) -> None:
        """0.18.17 while agents run: the flow's tokens with what they used so far (state.usage holds only finished
        calls). Past the token cap, budget.warn says so once per step (a running CLI cannot be paused); _budget asks
        before the next step, which then counts this step's whole usage."""
        ctx = self.ctx
        cap = int((state.get("usage") or {}).get("cap_tokens") or 0)
        if not cap or ctx.running_warned == step.id:
            return
        used = budget_tokens(running_usage(state.get("usage") or {}, ctx.running))
        if used >= cap:
            ctx.running_warned = step.id
            ctx.emit("budget.warn", step=step.id, data={
                "used": used, "cap": cap, "pct": round(used * 100 / cap), "running": True,
                "detail": f"This flow has used {used:,} of {cap:,} tokens while {step.name} still runs. keel asks before the next step."})

    async def _provider_window(self, state: FlowState, step: Step) -> dict:
        """Before a subscription agent: warn when its plan window is nearly used (settings.usage_warn, default 0.80) and
        pause at settings.usage_pause (default 0.95): continue, wait for the reset, use the cheaper model, or stop."""
        ctx = self.ctx
        model = self._model(state, step, step.agent or "")
        provider = model.get("provider")
        if model.get("mode") == "api" or provider in (None, "fake"):
            return {}
        await provider_usage.refresh_before_step(model, ctx.keys)
        w = provider_usage.fullest(provider)
        warn, pause = float(ctx.settings.get("usage_warn") or 0.8), float(ctx.settings.get("usage_pause") or 0.95)
        if not w or w["used_pct"] < warn:
            return {}
        seen = dict(state.get("usage_seen") or {})
        key = f"{provider}:{w['window']}:{w.get('resets_at') or ''}"
        info = {"provider": provider, "window": w["window"], "used_pct": w["used_pct"], "resets_at": provider_usage.iso(w.get("resets_at")),
                "detail": provider_usage.headline(provider, w), "kind": "usage"}
        if w["used_pct"] < pause or seen.get(key) == "ok":
            if seen.get(key):
                return {}
            ctx.emit("budget.warn", step=step.id, data=info)
            return {"usage_seen": {**seen, key: "warn"}}
        qkey = (ctx.thread_id, step.id, key)
        question = provider_usage.QUESTIONS.setdefault(qkey, {
            "step": step.id, "kind": "usage", "title": info["detail"], "options": OPTIONS, "choices": ["continue", "wait", "cheaper", "stop"],
            "detail": "Continue uses the plan anyway (the provider may refuse when it is full). Wait sleeps until the window resets, "
                      "then goes on. Cheaper switches to the cheaper model in settings. Stop ends the flow here.",
            "choice_info": choices_mod.choice_info(["continue", "wait", "cheaper", "stop"], context="usage")})
        answer, extra = self._ask(state, question)
        provider_usage.QUESTIONS.pop(qkey, None)
        choice = ((answer or {}).get("payload") or {}).get("choice")
        if (answer or {}).get("decision") != "approve" or choice == "stop":
            ctx.emit("budget.stop", step=step.id, data={**info, "why": (answer or {}).get("why")})
            return {**extra, "status": "stopped", "note": f"stopped: {info['detail']}"}
        upd = {**extra, "usage_seen": {**seen, key: "ok"}}
        cheaper = _real_cheaper(ctx)
        if choice == "cheaper" and cheaper:
            ctx.emit("budget.warn", step=step.id, data={**info, "action": "cheaper", "model": cheaper})
            return {**upd, "model_override": cheaper, "note": "plan window nearly used; switched to the cheaper model"}
        if choice == "cheaper":
            return {**upd, "note": "no real cheaper model is set (Settings › Cheaper model): went on with the same model"}
        if choice == "wait" and w.get("resets_at"):
            delay = min(max(0.0, w["resets_at"] - time.time()) + 30, 8 * 24 * 3600)
            ctx.emit("budget.warn", step=step.id, data={**info, "action": "wait", "seconds": int(delay)})
            await asyncio.sleep(delay)
        return upd

    def _budget(self, state: FlowState, step: Step) -> dict:
        """Before an agent step: the flow's token cap (usage.cap_tokens), its dollar cap (usage.cap_usd, against the
        reported usage.cost_usd) and the step's token limit (its own max_tokens, or settings.step_cap_tokens when that
        is smaller or the step has none). Over one: switch to the cheaper model, stop, or pause and ask."""
        ctx = self.ctx
        usage = dict(state.get("usage") or {})
        cap = int(usage.get("cap_tokens") or 0)
        used = budget_tokens(usage)
        cap_usd = float(usage.get("cap_usd") or 0)
        cost = float(usage.get("cost_usd") or 0)
        step_cap, own_cap = _step_cap(step, ctx.settings)
        step_used = int((state.get("step_tokens") or {}).get(step.id, 0))
        over_step = bool(step_cap) and step_used >= step_cap
        over_cap = bool(cap) and used >= cap
        over_usd = cap_usd > 0 and cost >= cap_usd
        if not (over_step or over_cap or over_usd):
            if not state.get("warned"):
                if cap and used >= 0.8 * cap:
                    ctx.emit("budget.warn", step=step.id, data={"used": used, "cap": cap, "pct": round(used * 100 / cap)})
                    return {"warned": True}
                if cap_usd and cost >= 0.8 * cap_usd:
                    ctx.emit("budget.warn", step=step.id, data={"cost_usd": round(cost, 4), "cap_usd": cap_usd,
                                                                "pct": round(cost * 100 / cap_usd)})
                    return {"warned": True}
            return {}
        wf_on = self.wf.budget.on_limit if self.wf.budget else None
        on_cap = ctx.settings.get("on_cap")
        if over_step:       # the step's own limit says what it does; the project's per-step cap has step_on_cap
            on = (step.on_limit if own_cap else ctx.settings.get("step_on_cap")) or on_cap or wf_on or "pause"
        elif over_cap:
            on = on_cap or wf_on or "pause"
        else:
            on = ctx.settings.get("on_cap_usd") or on_cap or wf_on or "pause"
        what = "token" if (over_step or over_cap) else "cost"
        cheaper = _real_cheaper(ctx)          # None (never the fake model for a real flow): pause and ask below
        info = {"used": used, "cap": cap, "step_used": step_used, "step_cap": step_cap or None,
                "cost_usd": round(cost, 4), "cap_usd": cap_usd or None, "limit": "step" if over_step else what}
        if on == "cheaper" and cheaper and state.get("model_override") != cheaper:
            ctx.emit("budget.warn", step=step.id, data={**info, "action": "cheaper", "model": cheaper})
            return {"model_override": cheaper, "warned": True, "note": f"{what} cap reached; switched to the cheaper model"}
        if on == "stop":
            ctx.emit("budget.stop", step=step.id, data=info)
            return {"status": "stopped", "note": f"{what} cap reached; flow stopped"}
        limit_txt = (f"{step_used:,} of {step_cap:,} tokens for this step" if over_step
                     else f"{used:,} of {cap:,} tokens" if over_cap else f"${cost:,.2f} of ${cap_usd:,.2f}")
        new_cap = raised_cap(used, cap, self._first_cap()) if over_cap else 0
        new_usd = round(cost + max(cap_usd, 0.01), 4) if over_usd else 0.0
        after = [f"the flow's cap goes up to {new_cap:,} tokens" if over_cap else "",
                 f"its cost cap to ${new_usd:,.2f}" if over_usd else "",
                 f"this step gets another {step_cap:,} tokens" if over_step else ""]
        answer, extra = self._ask(state, {"step": step.id, "kind": "budget", "title": "Token cap reached" if what == "token" else "Cost cap reached",
                                          "detail": f"This flow has used {limit_txt}. Approve to continue: "
                                                    f"{', '.join(a for a in after if a)}. Reject to stop.",
                                          "options": OPTIONS})
        if (answer or {}).get("decision") != "approve":
            ctx.emit("budget.stop", step=step.id, data={**info, "why": (answer or {}).get("why")})
            return {**extra, "status": "stopped", "note": f"stopped at the {what} cap"}
        payload = (answer or {}).get("payload") or {}
        upd: dict = {"warned": False, **extra}
        if over_cap:
            usage["cap_tokens"] = int(payload.get("cap_tokens") or new_cap)
            upd["usage"] = usage
        if over_usd:
            usage["cap_usd"] = round(float(payload.get("cap_usd") or new_usd), 4)
            upd["usage"] = usage
        if over_step:
            st = dict(state.get("step_tokens") or {})
            st[step.id] = 0
            upd["step_tokens"] = st
        return upd

    # ------------------------------------------------------------ step kinds

    async def agent_step(self, i: int, step: Step, state: FlowState):
        ctx = self.ctx
        ctx.running_warned = None
        upd = self._budget(state, step)
        if upd.get("status") == "stopped":
            return upd, END
        state = {**state, **upd}
        plan = await self._provider_window(state, step)
        upd = {**upd, **plan}
        if plan.get("status") == "stopped":
            return upd, END
        state = {**state, **plan}

        calls: list[tuple[str, int]] = []
        code_lanes: list[str] = []
        if step.kind == "agent":
            calls = [(step.agent or "", 0)]
        elif step.lanes:
            lane_sections: dict[int, str] = {}
            for lane in step.lanes:
                if lane.kind == "agent":
                    who = lane.sub or step.agent or ""
                    chosen = (state.get("init") or {}).get("knowledge_sections")
                    if who == "librarian" and isinstance(chosen, list):
                        # init: one librarian per section the user chose, each told its section (none: no librarian).
                        for sec in chosen:
                            lane_sections[len(calls)] = sec
                            calls.append((who, len(lane_sections) - 1))
                    else:
                        calls += [(who, k) for k in range(max(1, step.parallel or 1))]
                elif lane.sub:
                    code_lanes.append(lane.sub)
        else:
            calls = [(step.agent or "", k) for k in range(max(1, step.parallel or 1))]
        sections = self._sections(step, state)
        if sections:
            calls = [(step.agent or "librarian", k) for k in range(len(sections))]
        section_of = {n: sections[k] for n, (_a, k) in enumerate(calls)} if sections else \
            (dict(lane_sections) if step.lanes else {})
        # Dynamic fan-out: one call per item of a state list (at most `cap`); a for_each step gives its item to each call.
        loop_item = self._item(state, step)
        item_of: dict[int, dict] = {}
        if step.items_from:
            items = get_list(state, step.items_from)[: step.cap or None]
            if not items:
                note = f"{step.name}: no items in {step.items_from}; no agent ran"
                return {**upd, "note": note, "data": {**(state.get("data") or {}), f"{step.id}_results": []}}, self.nav.after(i)
            calls = [(self._item_agent(step, it), k) for k, it in enumerate(items)]
            item_of = dict(enumerate(items))
        elif loop_item:
            item_of = {n: loop_item for n in range(len(calls))}

        before = await asyncio.to_thread(guard.snapshot, ctx.root)
        started = time.time()       # a spec a CLI agent wrote with its own tools is found by its time (_acs_from)
        ac = _ac(state) if step.per_ac else None

        async def lane(action: str) -> ActionResult:
            # 0.18.16 a code lane (init's setup ladder) is a live job too, like a code step
            job = _CodeJob(self.ctx, step, state, name=f"{step.name}: {action}", actions=[action])
            job.start()
            a = self._action_input(state, ac)
            a.step, a.progress = step.id, job.progress
            t0 = time.monotonic()
            job.progress(f"▶ {action}", tool=action)
            try:
                r = await run_action(action, a)
            except BaseException:
                job.finish("failed")
                raise
            job.progress(r.note or action, tool=action, ok=bool(r.ok), ms=int((time.monotonic() - t0) * 1000),
                         output=(r.detail or "")[-STEP_FIELD_MAX:] or None)
            job.finish("done" if r.ok else "failed")
            if not r.ok:
                raise LaneFailed(f"{action}: {r.note}\n{r.detail}")
            return r

        done = ctx.done_calls
        attempt = f"{step.id}|{(ac or loop_item or {}).get('id', '')}"
        if self._reviews(step):
            # 0.18.17 the finished calls a "try again" keeps belong to one HEAD: after a fix commit they are stale
            head = ((await asyncio.to_thread(git.head, ctx.root)) or "")[:12]
            for old in [k for k in done if k.startswith(attempt + "|") and not k.startswith(f"{attempt}|{head}|")]:
                del done[old]
            attempt += f"|{head}"
        # `batch: N`: at most N agents of this step run at the same time; the step is still one node.
        # "$data.x" reads the number from the state when the step runs.
        batch = self._seed_value(step.batch, state, None) if isinstance(step.batch, str) else step.batch
        batch = int(batch) if isinstance(batch, (int, float)) or str(batch or "").isdigit() else None
        gate = asyncio.Semaphore(batch) if batch and batch > 0 else None

        async def one(n: int, a: str, k: int):
            key = f"{attempt}|{a}|{k}"
            if key in done:
                return done[key]
            if gate:
                async with gate:
                    r = await self._run_agent(state, step, a, k, section_of.get(n), item_of.get(n))
            else:
                r = await self._run_agent(state, step, a, k, section_of.get(n), item_of.get(n))
            if len(calls) > 1:
                done[key] = r
            return r

        while True:
            try:
                outs = await asyncio.gather(*[one(n, a, k) for n, (a, k) in enumerate(calls)], *[lane(c) for c in code_lanes], return_exceptions=True)
                for o in outs:
                    if isinstance(o, (asyncio.CancelledError, GraphBubbleUp)):
                        raise o
                failed = [o for o in outs if isinstance(o, BaseException)]
                if failed:
                    raise failed[0]
                out = list(outs)
                break
            except (asyncio.CancelledError, GraphBubbleUp):
                raise
            except Exception as exc:
                log.warning("step %s failed: %s", step.id, exc, exc_info=True)
                if len(calls) > 1:
                    kept = sum(1 for key in done if key.startswith(attempt + "|"))
                    if kept:
                        exc.args = (f"{exc} ({kept} of {len(calls)} agents finished; try again runs only the others)",)
                answer, extra = self._ask(state, {"step": step.id, "kind": "fix", "title": f"{step.name} failed",
                                                  "detail": f"{exc}{(' ' + exc.hint) if getattr(exc, 'hint', '') else ''}\n\nApprove to try again, reject to stop the flow.",
                                                  "options": OPTIONS})
                upd.update(extra)
                state = {**state, **extra}
                if (answer or {}).get("decision") != "approve":
                    return {**upd, **self._booked(state), "status": "failed", "error": str(exc)[:500],
                            "note": f"{step.name} failed"}, END

        for key in [key for key in done if key.startswith(attempt + "|")]:
            del done[key]
        agent_results = [o for o in out if isinstance(o, tuple)]
        lane_notes = [o.note for o in out if isinstance(o, ActionResult)]
        for o in out:
            if isinstance(o, ActionResult):
                upd.update(o.update)

        refused = await asyncio.to_thread(guard.guard_diff, ctx.root, state["phase"], before, None,
                                          rules.ac_lane(ac) if ac else None, state.get("unlocks") or [], self._readonly())
        for r in refused:
            ctx.emit("guard.refused", step=step.id, data={"tool": "diff-guard", "phase": state["phase"], **r})
        tools_note = ""
        if agent_results:
            tools_note, lint_data = await self._after_edit(step, state, before, refused)
            if lint_data is not None:
                state = {**state, "data": lint_data}
                upd["data"] = lint_data

        usage = add_usage(dict(state.get("usage") or {}), ctx.unbooked)
        ctx.unbooked.clear()
        step_tokens = dict(state.get("step_tokens") or {})
        notes = []
        for res, model, _tb in agent_results:
            usage["tokens_in"] = usage.get("tokens_in", 0) + res.tokens_in
            usage["tokens_out"] = usage.get("tokens_out", 0) + res.tokens_out
            usage["tokens_cached"] = usage.get("tokens_cached", 0) + res.tokens_cached
            usage["cost_usd"] = round(usage.get("cost_usd", 0.0) + res.cost_usd, 6)
            usage["premium_requests"] = usage.get("premium_requests", 0) + res.premium_requests
            step_tokens[step.id] = step_tokens.get(step.id, 0) + res.tokens_in + res.tokens_out + res.tokens_cached // 10
            notes.append(res.text.strip().splitlines()[0][:160] if res.text.strip() else "")
        upd.update(usage=usage, step_tokens=step_tokens, feedback=None)
        label = step.agent or "lanes"
        if agent_results:
            m = agent_results[0][1]
            label = f"{step.agent or calls[0][0]} · {m['provider']} {m.get('model', '')}"
        upd["note"] = " · ".join(x for x in [label, *notes[:2], *lane_notes] if x)
        if refused:
            upd["note"] += f" · guard put back {len(refused)} file(s)"
        if tools_note:
            upd["note"] += f" · {tools_note}"
        if sections and state.get("acs"):
            upd["acs"] = [dict(a, status="done") if a["id"] in sections else dict(a) for a in state["acs"]]

        for res, _m, tb in agent_results:
            # A CLI agent stopped by keel's PreToolUse hook: the runner reported it as a guard step.
            for r in res.data.get("refusals") or []:
                data = {"tool": r.get("tool") or "hook", "phase": state["phase"], "path": r.get("path") or "",
                        "reason": r.get("reason", ""), "source": "keel-hook"}
                if r.get("command"):
                    data["command"] = r["command"]
                ctx.emit("guard.refused", step=step.id, data=data)
        if agent_results:
            agent_results = await self._marker_reask(state, step, agent_results, calls, section_of, item_of)
            upd["last_answer"] = (agent_results[-1][0].text or "")[:8000]
            # keel v1 post-failure: the last shell command an agent saw fail (shown by Explain and "Rules now")
            fails = [(res.data.get("failed_command") or getattr(tb, "failed_command", None)) for res, _m, tb in agent_results]
            fail = next((f for f in reversed(fails) if f), None)
            if fail:
                data = dict(upd.get("data") or state.get("data") or {})
                data["last_command_failure"] = {**fail, "step": step.id, "agent": step.agent or calls[0][0]}
                upd["data"] = data
                state = {**state, "data": data}
        upd.update(self._outputs(step, state, [r[0] for r in agent_results], item_of))
        said = ((upd.get("markers") or {}).get(step.id) or {}) if step.markers else {}
        if said:
            upd["note"] += " · " + ", ".join(f"{k}: {v}" for k, v in said.items())
        if state["phase"] in ("spec", "triage") and not state.get("acs") and prompts.spec_writer(step):
            acs, spec = await asyncio.to_thread(self._acs_from, agent_results, started, state.get("spec"))
            if not acs and ctx.request:
                # 0.18.17 the agent wrote its criteria in another form ("1. ..."), but the request lists them as AC
                # lines: those are the person's own criteria, not "no acceptance criteria yet"
                acs = prompts.parse_acs(ctx.request)
            if acs:
                # keel's spec check: something clear is missing (a screen with no mockup, an API with no request path)
                # → send the spec back to the explorer ONCE, in the same session. Otherwise the gate shows the warnings.
                found = spec_check.check(await asyncio.to_thread(spec_check.read_spec, ctx.root, spec or state.get("spec")), acs,
                                         spec_check.outside_facts(ctx.request, state.get("data")))
                if any(f["level"] == "fix" for f in found) and not state.get("spec_revisions") \
                        and ctx.settings.get("spec_check", not ctx.fake):
                    upd.update(spec_revisions=1, feedback=spec_check.revision_note(found), clarify={},
                               note=upd["note"] + " · spec check: sent back once")
                    if spec:
                        upd["spec"] = spec
                    return upd, self.nav.jump(step.id, i)
                web = [a["id"] for a in acs if str(a.get("layer") or "").upper() == "WEB"]
                if web and not stacks.has_web_layer(ctx.root):
                    # 0.18.12 no web layer: the pages are tested by backend tests in the api lane; spec_sync fixes the
                    # spec's lines and the spec gate names these criteria (data.web_to_api)
                    acs = [dict(a, layer="API") for a in acs]
                    upd["data"] = {**(upd.get("data") or state.get("data") or {}), "web_to_api": web}
                upd["acs"] = acs
                upd["clarify"] = {}
            elif state.get("clarify_rounds", 0) < clarify.MAX_ROUNDS:
                # No criteria, but questions: the spec gate shows them as buttons (clarify loop).
                asked = [q for res, _m, _tb in agent_results for q in clarify.parse_questions(res.text)]
                upd["clarify"] = {"questions": asked[:clarify.MAX_QUESTIONS]} if asked else {}
            if spec:
                upd["spec"] = spec
        if step.asks:
            # keel's clarify loop for any agent step: its keel-questions go to the next gate as buttons, the answers back
            # to this agent (at most clarify.MAX_ROUNDS rounds; then it must decide with the recommended options).
            rounds = int(state.get("clarify_rounds") or 0)
            asked = [q for res, _m, _tb in agent_results for q in clarify.parse_questions(res.text, clarify.STEP_QUESTIONS)] \
                if rounds < clarify.MAX_ROUNDS else []
            upd["clarify"] = {"questions": asked[:clarify.STEP_QUESTIONS], "step": step.id} if asked else {}
        if self._reviews(step):
            def lens(n: int) -> str:
                if step.items_from and n in item_of:
                    return f"{step.name}: {item_of[n].get('title') or item_of[n]['id']}"
                return f"{step.name} #{n + 1}" if len(agent_results) > 1 else step.name
            found = unique([{"lens": lens(n), "text": t}
                            for n, (res, _m, _tb) in enumerate(agent_results) for t in blocking(res.text)])
            upd["findings"] = found
            if found:
                upd["note"] += f" · {len(found)} blocking finding(s)"
                key = self._rounds_key(step, loop_item)
                done_rounds = int((state.get("review_rounds") or {}).get(key, 0))
                if step.back and done_rounds < (step.rounds or 2):
                    # Findings go straight back to the step that wrote the work (cover: the test author), no question,
                    # until the rounds are used up; then the fix node asks.
                    rounds = {**(state.get("review_rounds") or {}), key: done_rounds + 1}
                    listed = "\n".join(f"- [{f['lens']}] {f['text']}" for f in found)
                    upd.update(review_rounds=rounds, findings=[],
                               feedback=f"Fix these blocking findings from {step.name} (round {done_rounds + 1}):\n{listed}")
                    upd["note"] += f" · sent back to {step.back} (round {done_rounds + 1})"
                    return upd, self.nav.jump(step.back, i)
                return upd, fix_id(step.id)
        return upd, self.nav.after(i)

    def _addon_event(self, step_id: str):
        """An add-on action's own events: kind "<addon>.<what>" only (keel's own kinds stay keel's)."""
        def event(kind: str, data: dict | None = None):
            if not addons.may_emit(kind):
                raise ValueError(f"an add-on may emit only its own events ('<name>.<what>'), not {kind!r}")
            self.ctx.emit(kind, step=step_id, data=dict(data or {}))
        return event

    def _tool_emit(self, step_id: str):
        """Each tool run as an event `tool.ran` with its full output (the dashboard); the agent only gets one line."""
        def emit(r: dict):
            self.ctx.emit("tool.ran", step=step_id, data={
                "tool": r["name"], "on": r["on"], "fail": r["fail"], "ok": r["ok"], "available": r["available"],
                "ms": r["ms"], "files": r["files"], "cmd": r["cmd"], "dir": r["dir"], "code": r["code"],
                "source": r.get("source"), "output": r.get("output", "")[:STEP_FIELD_MAX]})
        return emit

    async def _marker_reask(self, state: FlowState, step: Step, results: list, calls: list, section_of: dict,
                            item_of: dict) -> list:
        """keel v1 subagent-stop: an agent whose answer has none of the result lines the step reads (BLOCKING: yes | no,
        ...) is asked once more, in its own session where the provider keeps one, to repeat its whole answer and end with
        the line. A reply with only the line would lose the findings, so the prompt says so. Still missing: as before.
        Like keel v1's one contract per agent, one of the step's lines is enough."""
        wanted = [m.upper() for m in step.markers or [] if markers.REGISTRY.get(m.upper())]
        if not wanted or len(results) != len(calls):
            return results
        out = list(results)
        for n, (res, _model, _tb) in enumerate(results):
            if markers.parse(res.text or "", wanted):
                continue
            missing = wanted
            agent, k = calls[n]
            lines = "\n".join(f"{m}: {' | '.join(markers.REGISTRY[m])}" for m in missing)
            ask = (f"Your answer did not end with keel's result line. Repeat your full answer (this reply replaces it, so "
                   f"anything you leave out is lost) and end with:\n{lines}")
            self.ctx.emit("agent.reask", step=step.id, data={"agent": agent, "missing": missing})
            try:
                again = await self._run_agent({**state, "feedback": ask}, step, agent, k, section_of.get(n), item_of.get(n))
            except Exception as exc:  # noqa: BLE001  the first answer stays
                log.warning("re-ask of %s failed: %s", agent, exc)
                continue
            if markers.parse(again[0].text or "", missing) or not (res.text or "").strip():
                out[n] = again
        return out

    async def _after_edit(self, step: Step, state: FlowState, before, refused: list[dict]) -> tuple[str, dict | None]:
        """After an agent step that changed files: the project's `edit` and `batch` tools on those files (runtime/tools.py).
        A formatter's changes stay; block and warn failures go to data.lint_notes, which the next agent's prompt and
        the next gate show. Returns (a note for the step, the new data or None when nothing ran)."""
        ctx = self.ctx
        if before is None or rules.read_only(state.get("phase")) or self._readonly():
            return "", None
        gone = {r.get("path") for r in refused}
        changed = await asyncio.to_thread(guard.changed_since, ctx.root, before)
        files = [f for f in changed if f not in gone]
        if not files:
            return "", None
        res = await asyncio.to_thread(tool_runner.after_edit, ctx.root, files, include_stacks=not ctx.simulate_checks,
                                      emit=self._tool_emit(step.id))
        if not res["ran"]:
            return "", None
        data = {**(state.get("data") or {}), "lint_notes": res["notes"]}
        parts = [f"tools: {len(res['ran'])} ran"]
        if res["changed"]:
            parts.append(f"{len(res['changed'])} file(s) formatted")
        if res["notes"]:
            parts.append(f"{len(res['notes'])} finding(s): " + "; ".join(n.split(':')[0] for n in res["notes"]))
        return ", ".join(parts), data

    def _item_agent(self, step: Step, item: dict) -> str:
        """The agent for one item of a fan-out: the item's own `agent` when the list was made by the flow's code
        (review_scope: reviewer, code-reviewer or ac-reviewer), never when an agent's answer made the list."""
        own = item.get("agent")
        if own and not any(s.collect == step.items_from for s in self.wf.steps):
            return str(own)
        return step.agent or ""

    @staticmethod
    def _rounds_key(step: Step, item: dict | None) -> str:
        """Fix rounds count per review step, and per item inside a for_each loop."""
        return f"{step.id}:{item['id']}" if item and step.per_item else step.id

    def _outputs(self, step: Step, state: FlowState, results: list[AgentResult], item_of: dict[int, dict]) -> dict:
        """What a step's answers put into the state: per-item results (fan-out), markers, a collected list."""
        upd: dict = {}
        data = dict(state.get("data") or {})
        found = [markers.parse(r.text, step.markers) if step.markers else {} for r in results]
        if "BLOCKED" in [m.upper() for m in step.markers or []]:
            for f, r in zip(found, results):
                why = markers.blocked(r.text or "")
                if why:
                    f["BLOCKED"] = why
        if step.items_from:
            data[f"{step.id}_results"] = [{"item": item_of[n]["id"], "title": item_of[n].get("title") or item_of[n]["id"],
                                           "text": (r.text or "")[:16000], "markers": found[n]} for n, r in enumerate(results)]
        elif step.keep and results:
            data[f"{step.id}_text"] = (results[-1].text or "")[:KEEP_MAX]
        if step.markers:
            mine: dict = {}
            for f in found:
                mine.update(f)
            mk = dict(state.get("markers") or {})
            mk[step.id] = mine
            mk["*"] = {**(mk.get("*") or {}), **mine}
            upd["markers"] = mk
        if step.collect:
            got: list[dict] = []
            for n, r in enumerate(results):
                # In a fan-out, each collected entry says which item's agent gave it (from_item).
                src = (item_of.get(n) or {}).get("id") if step.items_from else None
                got += [dict(x, from_item=src) if src else x for x in markers.collect(r.text, step.collect)]
            ids = [x["id"] for x in got]
            if len(set(ids)) != len(ids):
                got = [dict(x, id=f"{step.collect}-{n + 1}") for n, x in enumerate(got)]
            data[step.collect] = got
        if data != (state.get("data") or {}):
            upd["data"] = data
        return upd

    def _reviews(self, step: Step) -> bool:
        """A review step whose blocking findings must be fixed or accepted before the flow goes on."""
        if rules.read_only(step.phase):
            return False      # a read-only flow (review) reports its findings; nothing is fixed
        return step.kind in ("agent", "parallel") and not step.per_ac and not step.lanes and (step.agent or "") in REVIEWERS

    async def findings_step(self, i: int, fix: Step, state: FlowState):
        """After a review with blocking findings: ask; fix and review again, or go on with the user's reason (the
        findings are kept as dismissed). Nothing runs before the question, so answering it never re-runs anything.

        The fix is routed by payload.route: review-fix (default: implementer, tests, fix commit), coverage-fix
        (test-author, tests, coverage commit) or red (test-author, red commit). After it the flow goes on from the
        review's `redo` step (default the review itself). A review with `back` sends its findings to that step by
        itself; this question only comes once its `rounds` are used up, and approving sends them back once more.
        """
        ctx = self.ctx
        review = self.wf.steps[i]
        item = self._item(state, review)
        found = list(state.get("findings") or [])
        rounds = dict(state.get("review_rounds") or {})
        key = self._rounds_key(review, item)
        done_rounds = rounds.get(key, 0)
        listed = "\n".join(f"- [{f['lens']}] {f['text']}" for f in found)
        again = f" (fix round {done_rounds + 1})" if done_rounds else ""
        limit = review.rounds or (2 if review.back else None)
        past = f"\n\n{done_rounds} fix round(s) done, the limit is {limit}: the check and the change disagree, and " \
               f"repeating may not settle it. Deciding is yours." if limit and done_rounds >= limit else ""
        fix_txt = (f"Send back: {review.back} gets these findings once more, then {review.name} runs again." if review.back else
                   f"Fix them: the implementer fixes these findings (payload route: review-fix, coverage-fix or red picks "
                   f"who and how), the tests run, the fix is committed, and the flow goes on from "
                   f"{review.redo or review.name}.")
        answer, extra = self._ask(state, {
            "step": fix.id, "kind": "gate", "title": f"{review.name}: {len(found)} blocking finding(s){again}" + (f" · {item['id']}" if item else ""),
            "detail": f"{listed}\n\n{fix_txt}\nGo on anyway: say why; the findings are kept as dismissed and shown "
                      f"at the final review.{past}",
            "options": OPTIONS, "labels": {"approve": "Send back" if review.back else "Fix them", "reject": "Go on anyway"}},
            gate="findings" if done_rounds < (review.rounds or 2) else "rounds")
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        why = (answer.get("why") or "").strip()
        if answer.get("decision") != "approve":
            gates["log"].append(f"{review.name} findings accepted: {why}")
            ctx.emit("gate.decided", step=fix.id, data={"gate": f"{review.name} findings", "decision": "reject", "why": why,
                                                        "findings": [f["text"] for f in found]})
            data = dict(state.get("data") or {})
            data["dismissed_findings"] = list(data.get("dismissed_findings") or []) + [{
                "step": review.id, "name": review.name, "item": (item or {}).get("id"), "findings": [f["text"] for f in found],
                "why": why}]
            return {**extra, "gates": gates, "findings": [], "data": data,
                    "note": f"{len(found)} finding(s) accepted: {why}"[:300]}, self.nav.after(i)
        ctx.emit("gate.decided", step=fix.id, data={"gate": f"{review.name} findings", "decision": "approve", "why": why})
        if answer.get("auto"):
            gates["log"].append(f"{review.name} findings sent to fix: {why}")
        feedback = f"Fix these blocking findings from {review.name}:\n{listed}" + (f"\n\nFrom the user: {why}" if why and not answer.get("auto") else "")
        rounds[key] = done_rounds + 1
        if review.back:
            return {**extra, "gates": gates, "review_rounds": rounds, "findings": [], "feedback": feedback,
                    "note": f"sent back to {review.back} (round {rounds[key]})"}, self.nav.jump(review.back, i)
        route = str((answer.get("payload") or {}).get("route") or "review-fix")
        if route not in ROUTES:
            route = "review-fix"
        agent = "implementer" if route == "review-fix" else "test-author"
        fix = fix.model_copy(update={"phase": route, "agent": agent})
        state = {**state, **extra, "phase": route, "feedback": feedback}
        before = await asyncio.to_thread(guard.snapshot, ctx.root)
        res, model, _tb = await self._run_agent(state, fix, agent, 0)
        refused = await asyncio.to_thread(guard.guard_diff, ctx.root, route, before, None, None, state.get("unlocks") or [],
                                          self._readonly())
        for r in refused:
            ctx.emit("guard.refused", step=fix.id, data={"tool": "diff-guard", "phase": route, **r})
        usage = dict(state.get("usage") or {})
        for k in ("tokens_in", "tokens_out", "tokens_cached", "premium_requests"):
            usage[k] = usage.get(k, 0) + getattr(res, k)
        usage["cost_usd"] = round(usage.get("cost_usd", 0.0) + res.cost_usd, 6)
        step_tokens = dict(state.get("step_tokens") or {})
        step_tokens[review.id] = step_tokens.get(review.id, 0) + res.tokens_in + res.tokens_out + res.tokens_cached // 10
        upd = {**extra, "gates": gates, "usage": usage, "step_tokens": step_tokens, "review_rounds": rounds, "findings": [],
               "feedback": None, "last_answer": (res.text or "")[:2000], "phase": route}
        a = self._action_input(state, None)
        a.title = f"address {review.name} findings"
        a.emit = self._tool_emit(fix.id)
        notes = []
        for action in ROUTES[route]:
            r = await run_action(action, a)
            notes.append(r.note)
            upd.update(r.update)
            if not r.ok:
                # Tests broke or the commit was refused: back to the question with what went wrong.
                found = found + [{"lens": "keel", "text": f"after the fix: {r.note}"}]
                return {**upd, "findings": found, "note": f"fix round {rounds[key]}: {r.note}"[:300]}, fix.id
        upd["note"] = " · ".join([f"{agent} ({route}) · {model['provider']} {model.get('model', '')}", *notes])[:300]
        return upd, self.nav.jump(review.redo or review.id, i)

    def _sections(self, step: Step, state: FlowState) -> list[str]:
        """knowledge-refresh: one librarian per section, for a parallel librarian step.

        Sections come from settings.sections, else from the thread's acs (the api starts the flow with
        one AC per stale section: {id: <section>, layer: "API", title: <section>}).
        """
        if step.kind != "parallel" or step.lanes or step.items_from or (step.agent or "") != "librarian":
            return []
        secs = [str(x) for x in self.ctx.settings.get("sections") or [] if str(x).strip()]
        if not secs and (self.wf.flow == "knowledge-refresh" or all(a["id"] in KNOWN_SECTIONS for a in state.get("acs") or [{"id": "-"}])):
            secs = [a["id"] for a in state.get("acs") or []]
        if not secs and self.wf.flow == "knowledge-refresh":
            # Started without a list (the plain "start a flow" form): the sections init chose, else the ones that
            # exist, else all five. A librarian always gets its own section; without one it wanders.
            chosen = (rules.load_config(self.ctx.root).get("init") or {}).get("knowledge_sections")
            have = init_gates.existing_sections(self.ctx.root)
            secs = list(chosen) if isinstance(chosen, list) and chosen else (have or list(init_gates.SECTIONS))
        return secs

    def _acs_from(self, results, started: float | None = None, known: str | None = None) -> tuple[list[dict], str | None]:
        from pathlib import Path

        for res, _m, tb in results:
            if res.data.get("acs"):
                return [dict(a, status="todo") for a in res.data["acs"]], res.data.get("spec")
        root = Path(self.ctx.root)
        seen = None
        for res, _m, tb in results:
            # The spec file the agent wrote comes first; its chat answer only when no file has criteria.
            files = [w["path"] for w in tb.writes if w["path"].endswith(".md")]
            if git.is_repo(self.ctx.root):
                files += [rel for rel in git.dirty(self.ctx.root) if "spec" in rel and rel.endswith(".md")]
            # A CLI agent writes with its own tools (keel's ToolBox sees nothing), and a git-ignored .keel/specs/ is
            # never dirty: the spec its answer names, the one the flow already knows, and the spec folder's files
            # changed since the step started.
            files += self._specs_named(res.text) + ([known] if known else []) + self._specs_since(started)
            files = [f for f in dict.fromkeys(files) if (root / f).is_file()]
            spec = files[0] if files else None
            seen = seen or spec
            for rel in files:
                acs = prompts.parse_acs((root / rel).read_text(errors="replace"))
                if acs:
                    return acs, rel
            acs = prompts.parse_acs(res.text)
            if acs:
                return acs, spec
        # No criteria yet, but the spec file is known: a send-back changes that file instead of starting over.
        return [], seen

    def _spec_dirs(self) -> tuple[str, ...]:
        from .. import layout

        return layout.resolve(self.ctx.root).spec_dirs

    def _specs_named(self, text: str | None) -> list[str]:
        """Spec files an answer names ("I wrote the spec to `.keel/specs/x.md`"): .md paths inside the project, in a
        spec folder or with "spec" in the path."""
        root = Path(self.ctx.root).resolve()
        out = []
        for raw in SPEC_PATH.findall(text or ""):
            p = (root / raw).resolve()          # an absolute path stays itself
            if not p.is_relative_to(root) or not p.is_file():
                continue
            rel = p.relative_to(root).as_posix()
            if "spec" in rel or any(rel.startswith(d.rstrip("/") + "/") for d in self._spec_dirs()):
                out.append(rel)
        return out

    def _specs_since(self, started: float | None) -> list[str]:
        """The spec folders' .md files changed since the step started (git-ignored ones too), newest first."""
        if started is None:
            return []
        root = Path(self.ctx.root)
        found = []
        for d in self._spec_dirs():
            folder = root / d
            if not folder.is_dir():
                continue
            for p in folder.rglob("*.md"):
                try:
                    mtime = p.stat().st_mtime
                except OSError:
                    continue
                if mtime >= started - 1:        # file systems keep mtimes to the second
                    found.append((mtime, p.relative_to(root).as_posix()))
        return [rel for _t, rel in sorted(found, reverse=True)]

    def _action_input(self, state: FlowState, ac: dict | None, item: dict | None = None) -> ActionInput:
        return ActionInput(root=self.ctx.root, project=self.ctx.project_id, phase=state["phase"], title=self.ctx.title, ac=ac, init=dict(state.get("init") or {}),
                           acs=copy.deepcopy(state.get("acs") or []), fake=self.ctx.simulate_checks, flow=self.wf.flow,
                           deps=list(state.get("deps") or []), gates_log=list((state.get("gates") or {}).get("log") or []),
                           base=state.get("base_head"), unlocks=list(state.get("unlocks") or []),
                           preexisting=dict(state.get("preexisting") or {}), item=item, data=dict(state.get("data") or {}),
                           keys=dict(self.ctx.keys), state=dict(state), settings=dict(self.ctx.settings or {}),
                           thread_id=self.ctx.thread_id, request=self.ctx.request)

    async def code_step(self, i: int, step: Step, state: FlowState):
        """0.18.15 a code step is a job like an agent's (code.started → code.step per action and command →
        code.finished; the api stores them as a job), so the Flow page, the Jobs list, keel TUI and KeelBot see what runs
        now, not "starting…". Its own event names: whoever counts agent.* still counts agents only."""
        job = _CodeJob(self.ctx, step, state)
        job.start()
        try:
            out = await self._code_step_run(i, step, state, job)
        except GraphBubbleUp:
            job.progress("waits for a person")    # an interrupt (a question the step raised) is not a failure; the
            job.finish("done")                    # step runs again on the answer, as a new job
            raise
        except BaseException:
            job.finish("failed")
            raise
        job.finish("done" if job.ok else "failed")
        return out

    async def _code_step_run(self, i: int, step: Step, state: FlowState, job: "_CodeJob"):
        ac = _ac(state) if step.per_ac else None
        item = self._item(state, step)
        st = dict(state)
        upd: dict = {}
        notes, details = [], []
        actions = step.actions()
        for n, action in enumerate(actions):
            if action == "start_flow":
                r = await self._start_flow(step, st, item)
            elif action == "escalate_model":
                r = self._escalate_model(step, st)
            else:
                a = self._action_input(st, ac, item)
                a.step = step.id
                a.emit = self._tool_emit(step.id)
                a.params = dict(step.params or {})
                a.event = self._addon_event(step.id)
                if extensions.owner(action):
                    a.state["gate_approved"] = self._gate_approved(i, st)     # a part's step (git:push asks the gate)
                if action == "open_pr":
                    a.state["pr_approved"] = self._gate_approved(i, st)
                    a.state["pr_auto"] = run_mode.is_auto_line(self._gate_line(i, st))
                a.progress = job.progress
                t0 = time.monotonic()
                job.progress(f"▶ {action}", tool=action)
                r = await run_action(action, a)
                job.progress(r.note or action, tool=action, ok=bool(r.ok), ms=int((time.monotonic() - t0) * 1000),
                             output=(r.detail or "")[-STEP_FIELD_MAX:] or None)
                if not r.ok and not step.soft:
                    job.ok = False
            if r.ask and r.ask.get("type") == "already-met" and ac:
                return await self._already_met(i, step, st, ac, r, upd, actions[n + 1:])
            if r.ask:
                return await self._answer_check(i, step, st, r, upd)
            if r.stop:
                # A refusal no retry can change (an empty diff to review): the flow ends here and says why.
                return {**upd, "status": "stopped", "error": r.note, "note": r.note}, END
            if not r.ok and step.soft:
                # A soft check records what it found and goes on; a branch reads markers[<id>].RESULT, a later step
                # reads what it said in data["<id>_output"].
                st.update(r.update)
                upd.update(r.update)
                data = {**(st.get("data") or {}), f"{step.id}_output": f"{r.note}\n{r.detail}".strip()[:6000]}
                st["data"] = upd["data"] = data
                notes.append(r.note)
                break
            if not r.ok:
                for k in ("blockers", "ladder"):
                    if k in r.update:
                        upd[k] = r.update[k]
                if action in KNOWLEDGE_CHECKS:
                    return await self._knowledge_failed(i, step, st, r, upd)
                return await self._check_failed(i, step, st, ac or item, r, upd)
            st.update(r.update)
            upd.update(r.update)
            notes.append(r.note)
            if r.detail:
                details.append(r.detail)
        else:
            r = None
        if step.soft:
            result = "fail" if r is not None else "pass"
            mk = dict(state.get("markers") or {})
            mk[step.id] = {"RESULT": result}
            mk["*"] = {**(mk.get("*") or {}), "RESULT": result}
            upd["markers"] = mk
        key = f"{step.id}:{(ac or item or {}).get('id')}"
        retries = dict(state.get("retries") or {})
        retries.pop(key, None)
        upd.update(note="; ".join(notes), retries=retries, stall={"fingerprint": None, "count": 0, "step": 0}, last_failure=None,
                   output="\n".join(details)[:2000] or None)   # what the actions printed (explain.py shows its head)
        if not ac and not item:
            # a step outside any loop passed: its "keeps failing" count starts again (a criterion's ends at its gate)
            upd.update(flow_actions.stuck_counted({**state, **upd}, step.id, None))
        upd.setdefault("show", None)        # what the next gate shows: only an action of this step sets it
        if step.then == "end":
            # The work goes on in the flow start_flow started (or there is nothing more to do); this one ends here.
            return {**upd, "status": "done", "ac": None, "item": None}, END
        if step.then and step.then != "continue":
            return upd, self.nav.jump(step.then, i)
        return upd, self.nav.after(i)

    def _escalate_model(self, step: Step, state: FlowState) -> ActionResult:
        """keel v1 "escalate the model once": the step's agent (default investigator) runs on a stronger model from here
        on (settings.stronger_model, else Opus for Claude, else high effort). Marker ESCALATED: yes."""
        agent = step.agent or "investigator"
        cur = self._model(state, step, agent)
        strong = self.ctx.settings.get("stronger_model") or stronger(cur)
        mk = dict(state.get("markers") or {})
        mk[step.id] = {"ESCALATED": "yes"}
        mk["*"] = {**(mk.get("*") or {}), "ESCALATED": "yes"}
        upd = {"markers": mk, "agent_models": {**(state.get("agent_models") or {}), agent: strong}}
        same = strong == cur
        label = f"{strong.get('provider')} {strong.get('model', '')}{' ' + strong['effort'] if strong.get('effort') else ''}"
        return ActionResult(True, f"{agent}: no stronger model to escalate to; it tries again on {label}" if same
                            else f"{agent} escalated to {label}", update=upd)

    def _gate_approved(self, i: int, state: FlowState) -> bool:
        """Was the nearest gate before step i approved (its last line in the gate log)?"""
        gate = next((s for s in reversed(self.wf.steps[:i]) if s.kind == "gate"), None)
        last = self._gate_line(i, state)
        return bool(gate and last.startswith(f"gate {gate.id} approve"))

    def _gate_line(self, i: int, state: FlowState) -> str:
        """The last gate-log line of the nearest gate before step i ("" when it has none)."""
        gate = next((s for s in reversed(self.wf.steps[:i]) if s.kind == "gate"), None)
        if not gate:
            return ""
        mine = [line for line in (state.get("gates") or {}).get("log") or [] if line.startswith(f"gate {gate.id} ")]
        return mine[-1] if mine else ""

    def _seed_value(self, value, state: FlowState, item: dict | None):
        """A seed value: "$a.b.c" reads that path from the state (item = the loop's item), anything else is literal."""
        if isinstance(value, dict):
            return {k: self._seed_value(v, state, item) for k, v in value.items()}
        if isinstance(value, list):
            return [self._seed_value(v, state, item) for v in value]
        if not (isinstance(value, str) and value.startswith("$")):
            return value
        cur = {**state, "item": item, "request": self.ctx.request}
        for part in value[1:].split("."):
            if isinstance(cur, dict):
                cur = cur.get(part)
            elif isinstance(cur, list) and part.isdigit() and int(part) < len(cur):
                cur = cur[int(part)]
            else:
                return None
        return cur

    async def _start_flow(self, step: Step, state: FlowState, item: dict | None) -> ActionResult:
        return await self.start_flow(step.flow, step.seed or {}, step, state, item)

    async def start_flow(self, flow: str, raw_seed: dict, step: Step, state: FlowState, item: dict | None) -> ActionResult:
        """Hand-off: start another workflow's thread on this project with a seed; both threads record the link."""
        ctx = self.ctx
        if not ctx.spawn:
            return ActionResult(False, "This engine cannot start another flow from here.")
        seed = {"title": (item or {}).get("title") or ctx.title, "request": ctx.request}
        seed.update({k: self._seed_value(v, state, item) for k, v in raw_seed.items()})
        link = {"thread_id": ctx.thread_id, "workflow": self.wf.id, "step": step.id}
        key = f"start_flow|{step.id}|{(item or {}).get('id', '')}"
        try:
            # A node that runs again (try again after a later failure in the same step) must not start a second child.
            child = ctx.done_calls.get(key) or await ctx.spawn(flow, seed, link)
        except Exception as exc:
            return ActionResult(False, f"Could not start the {flow} flow: {getattr(exc, 'error', None) or exc}")
        ctx.done_calls[key] = child
        children = list(state.get("children") or []) + [{"thread_id": child, "workflow": flow, "step": step.id,
                                                        "title": str(seed.get("title") or "")[:200]}]
        ctx.emit("flow.started", step=step.id, data={"child": child, "workflow": flow, "title": seed.get("title"),
                                                     "then": step.then or "continue"})
        return ActionResult(True, f"started the {flow} flow ({child[:8]}): {seed.get('title')}", update={"children": children})

    async def _already_met(self, i: int, step: Step, state: FlowState, ac: dict, r: ActionResult, upd: dict, rest: list[str]):
        """verify_red found the AC's own test already passing (keel v1 "already-met"). No retries: ask right away.

        approve: run the rest of this step (the red commit: `test(<AC>): ...`), set the AC to already-met and
        skip its green, review and gate steps. reject: back to the red step with the user's note as feedback.
        """
        q = r.ask
        answer, extra = self._ask(state, {"step": step.id, "kind": q["kind"], "title": q["title"], "detail": q["detail"],
                                          "options": OPTIONS}, gate="already-met")
        upd = {**upd, **extra}
        state = {**state, **extra}
        decision = answer.get("decision", "reject")
        why = (answer.get("why") or "").strip()
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        gates["log"].append(f"ac {ac['id']} already-met {decision}" + (f": {why}" if why else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": decision, "why": why, "ac": ac["id"]})
        key = f"{step.id}:{ac['id']}"
        retries = dict(state.get("retries") or {})
        retries.pop(key, None)
        if decision != "approve":
            feedback = (f"{ac['id']}: the test passed before any code was written, so it does not prove the criterion. "
                        f"Write a stricter test that fails until {ac['id']} is built.")
            if why:
                feedback += f"\n\nFrom the user: {why}"
            target = self.nav.retry_target(i) or step.id
            return {**upd, "gates": gates, "retries": retries, "feedback": feedback, "last_failure": r.note[:300],
                    "note": f"{ac['id']} already passes; sent back for a stricter test" + (f": {why}" if why else "")}, target
        st = {**state, "gates": gates}
        notes = [r.note]
        for action in rest:
            res = await run_action(action, self._action_input(st, ac))
            if not res.ok or res.ask:
                # A refused commit is an ordinary failed check (it goes back to the red agent).
                return await self._check_failed(i, step, st, ac, res, {**upd, "gates": gates})
            st.update(res.update)
            upd.update(res.update)
            notes.append(res.note)
        acs = _set_ac(st.get("acs") or [], ac["id"], ALREADY_MET)
        upd.update(acs=acs, gates=gates, retries=retries, feedback=None, last_failure=None,
                   stall={"fingerprint": None, "count": 0, "step": 0},
                   note=" · ".join([f"{ac['id']} marked as already met" + (f": {why}" if why else ""), *notes[1:]]))
        return upd, AC_END if step.per_ac and self.nav.last is not None else self.nav.after(i)

    def _stuck_question(self, step: Step, ac: dict, r: ActionResult, rounds: int, attempts: int) -> dict:
        """The question after the stall ladder: retry with a note / skip the criterion / edit the spec / stop."""
        edit = any(s.id == "amend" for s in self.wf.steps)
        choices = ["retry", "skip"] + (["edit"] if edit else []) + ["stop"]
        lines = [f"{step.name} failed {rounds} times for {ac['id']}: the same agent, an investigator's proposal and a "
                 "stronger model did not fix it.", "", r.note, "", r.detail[-1500:], "",
                 'Choose one (approve with payload {"choice": "<name>"} and a note):',
                 "- retry: one more round, with your note for the agent",
                 f"- skip: move {ac['id']} to the end of the list and go on with the next criterion"]
        if edit:
            lines.append(f"- edit: amend the spec for {ac['id']} first (your note says what is wrong)")
        lines.append("- stop: stop the flow here (the commits so far stay)")
        return choices_mod.for_question({"type": "stuck", "kind": "fix", "title": f"{ac['id']} is stuck at {step.name}",
                                         "detail": "\n".join(lines), "choices": choices, "retries_after": attempts},
                                        context="stuck")

    def _choice_answer(self, i: int, step: Step, state: FlowState, r: ActionResult, upd: dict):
        """v0.17.5 a check that asks with real choices (a command that cannot run, a stuck criterion), never decided by a
        run mode: recheck (this check again), retry (the agent again, with the note), skip (the criterion to the end of the
        list, on with the next), edit (an amendment of the spec, with the note), stop. Plain approve = the first choice."""
        q = r.ask
        names = list(q["choices"])
        detail = q["detail"]
        ac = _ac(state)
        lp = self.nav.loop_of(i)
        # 0.18.12 the same stuck criterion sent around again and again: past settings.sendback_limit only skip or stop
        who = (ac or {}).get("id") or step.id
        tries, limit = flow_actions.stuck_tries(state, who), flow_actions.sendback_limit(self.ctx.settings)
        if tries >= limit:
            names = flow_actions.past_limit(names, bool(ac and lp and lp.per_ac and self._others_open(state, ac)))
            detail = flow_actions.limit_note(tries, limit, who) + "\n\n" + flow_actions.offered(detail, names)
        question = {"step": step.id, "kind": "fix", "title": q["title"], "detail": detail, "options": OPTIONS,
                    "choices": names}
        # the check's own choice_info (its labels and reasons), only the choices still offered; else from the text
        info = choices_mod.keep(q.get("choice_info"), names)
        question = {**question, "choice_info": info} if len(info) == len(names) else \
            choices_mod.for_question(question, context=q.get("type"))
        answer, extra = self._ask(state, question, gate="failure")
        upd = {**upd, **extra}
        why = (answer.get("why") or "").strip()
        choice = str((answer.get("payload") or {}).get("choice") or (names[0] if answer.get("decision") == "approve" else "stop"))
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        gates["log"].append(f"{q['type']} {choice}" + (f": {why}" if why else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": choice, "why": why})
        key = f"{step.id}:{(ac or {}).get('id')}"
        retries = {**(state.get("retries") or {}), key: int(q.get("retries_after") or 0) if choice == "retry" else 0}
        base = {**upd, "gates": gates, "retries": retries, "stall": {"fingerprint": None, "count": 0, "step": 0}}
        if choice in ("recheck", "retry", "edit"):
            # the same criterion goes around again: one more toward the limit (skip and stop do not count)
            base.update(flow_actions.stuck_counted({**state, **upd}, who, tries + 1))
        if choice == "recheck":
            return {**base, "note": f"{step.name}: checked again"}, step.id
        if choice == "retry":
            feedback = f"{r.note}\n{r.detail[-2000:]}".strip() + (f"\n\nFrom the user: {why}" if why else "")
            target = self.nav.jump(q["retry_to"], i) if q.get("retry_to") else self.nav.retry_target(i)
            return {**base, "feedback": feedback, "last_failure": r.note[:300], "note": f"{r.note} · tried again"[:300]}, target or step.id
        if choice in ("skip", "edit") and ac:
            # the stuck criterion's uncommitted work goes back (keel's agents' files only, never the person's), so the next
            # criterion's red commit is not refused for it; its commits stay
            back = flow_actions.reset(self._action_input(state, ac))
            gates["log"].append(f"{ac['id']}: {back.note}"[:300])
        if choice == "skip" and ac and lp and lp.per_ac:
            acs = [x for x in state.get("acs") or [] if x["id"] != ac["id"]] + [x for x in state.get("acs") or [] if x["id"] == ac["id"]]
            return {**base, "acs": acs, "ac": None, "feedback": None, "last_failure": None,
                    "note": f"{ac['id']} moved to the end"}, self.nav.begin(lp)
        if choice == "edit" and ac and any(s.id == "amend" for s in self.wf.steps):
            data = {**(state.get("data") or {}), "amend": {"from": step.id, "ac": ac["id"], "route": "amend",
                                                          "reason": f"{ac['id']} · {r.note}" + (f"\nThe person says: {why}" if why else ""),
                                                          "at": datetime.date.today().isoformat()}}
            return {**base, "data": data, "note": f"{ac['id']}: the spec is amended first"}, self.nav.jump("amend", i)
        return {**base, "status": "stopped", "error": r.note + (f" ({why})" if why else ""),
                "note": f"stopped: {q['title']}"[:300]}, END

    @staticmethod
    def _others_open(state: FlowState, ac: dict) -> bool:
        """Is another criterion still to build (so skipping this one moves the flow on, not round to it again)?"""
        return any(x["id"] != ac["id"] and x.get("status") not in DONE for x in state.get("acs") or [])

    async def _answer_check(self, i: int, step: Step, state: FlowState, r: ActionResult, upd: dict):
        """A commit check asked the user (new dependency, escalation). Apply the answer and run the step again.

        Returning to the same step keeps one interrupt per node run, so a resume can never hand one
        question's answer to another.
        """
        q = r.ask
        if q.get("choices"):
            return self._choice_answer(i, step, state, r, upd)
        kind = {"deps": "dependency", "escalate": "escalate", "secrets": "secrets", "readonly": "readonly",
                "plugin": "plugin"}.get(q["type"], "failure")
        question = {"step": step.id, "kind": q["kind"], "title": q["title"], "detail": q["detail"], "options": OPTIONS}
        if q.get("labels"):
            question["labels"] = dict(q["labels"])
        answer, extra = self._ask(state, question, gate=kind)
        upd = {**upd, **extra}
        decision = answer.get("decision", "reject")
        why = (answer.get("why") or "").strip()
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        if q["type"] in ("secrets", "readonly"):
            # A secret in the staged diff (every mode stops for it), or a read-only run's commit: the user decides.
            self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": decision, "why": why})
            gates["log"].append(f"{q['type']} {decision}" + (f": {why}" if why else ""))
            if decision != "approve":
                return {**upd, "gates": gates, "status": "stopped", "error": r.note, "note": f"stopped: {r.note}"[:300]}, END
            if q["type"] == "readonly":
                # Approve = try the commit again (after the run mode was changed; still read-only, it asks again).
                return {**upd, "gates": gates, "note": "the commit runs again"}, step.id
            feedback = f"{r.note}\n{r.detail[-2000:]}".strip() + (f"\n\nFrom the user: {why}" if why else "")
            target = self.nav.jump(step.back, i) if step.back else self.nav.retry_target(i)
            return {**upd, "gates": gates, "feedback": feedback, "last_failure": r.note[:300],
                    "note": f"{r.note} · sent back to remove it"[:300]}, target or step.id
        if q["type"] == "plugin":
            # a plugin step asked first (db:change, git:push, git:pr): approve runs the step again with the answer
            self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": decision, "why": why})
            gates["log"].append(f"plugin {step.id} {decision}" + (f": {why}" if why else ""))
            if decision != "approve":
                return {**upd, "gates": gates, "status": "stopped", "error": r.note, "note": f"stopped: {q['title']}"[:300]}, END
            ok = {**(state.get("plugin_ok") or {}), step.id: q.get("fingerprint")}
            return {**upd, "gates": gates, "plugin_ok": ok, "note": f"approved: {q['title']}"[:300]}, step.id
        if q["type"] == "deps":
            if decision == "approve":
                deps = list(state.get("deps") or []) + [d for d in q["deps"] if d not in (state.get("deps") or [])]
                gates["log"].append("deps approve: " + ", ".join(q["deps"]) + (f": {why}" if why else ""))
                upd.update(deps=deps, gates=gates, note="new dependency approved: " + ", ".join(q["deps"]))
            else:
                await asyncio.to_thread(revert_manifests, self.ctx.root, q["files"])
                gates["log"].append("deps reject: " + ", ".join(q["deps"]) + (f": {why}" if why else ""))
                upd.update(gates=gates, note="new dependency rejected; manifest put back: " + ", ".join(q["files"]))
            self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": decision, "why": why})
            return upd, step.id
        # escalate
        self.ctx.emit("gate.decided", step=step.id, data={"gate": q["title"], "decision": decision, "why": why})
        if decision == "approve":
            gates["log"].append(f"escalation: {q['why']}" + (f" ({why})" if answer.get("auto") else ""))
            # keel v1 `keel escalate`: the inline criteria become the feature flow's, finished ones stay finished, and
            # every commit stays on the branch.
            r2 = await self.start_flow("feature", {"acs": "$acs", "escalated_from": self.wf.id, "why": q["why"]}, step, state, None) \
                if self.ctx.spawn else None
            if not r2 or not r2.ok:
                return {**upd, "gates": gates, "status": "stopped", "error": f"Escalated to a feature flow: {q['why']}.",
                        "note": "escalated: start a feature flow for this work"}, END
            return {**upd, **r2.update, "gates": gates, "status": "done", "ac": None,
                    "note": f"escalated: {r2.note}"[:300]}, END
        gates["log"].append(f"escalation-override: {why or q['why']}")
        return {**upd, "gates": gates, "note": f"stays a small change: {why}"}, step.id

    async def _ladder(self, count: int, i: int, step: Step, state: FlowState, target: str, feedback: str) -> tuple[str, dict, str]:
        """v0.17.5 the stall ladder of a criterion's check, one rung per failed round:
        1. the same agent again, with the concrete failure (no extra call);
        2. an investigator (read only) reads the failure and the code and proposes a fix; the agent gets its proposal;
        3. the agent's model is escalated once (for this criterion), with the investigator's proposal;
        after that the person chooses (_check_failed). Returns (feedback, state update, what this round did)."""
        tstep = self.wf.steps[self.nav.index[target]] if target in self.nav.index else None
        agent = (tstep.agent if tstep and tstep.kind == "agent" else None) or ""
        data = dict(state.get("data") or {})
        ac_id = (_ac(state) or {}).get("id")
        if count == 2:
            inv = step.model_copy(update={"id": f"{step.id}_investigate", "kind": "agent", "name": f"{step.name}: why does it keep failing",
                                          "agent": "investigator", "phase": "review", "markers": None, "instructions": None})
            ask = (f"{feedback}\n\nThis check failed twice for {ac_id}. Read the failure and the code (read only). Say in a few "
                   "lines what really goes wrong and what the next try must change. If the cause is outside the agent's "
                   "reach (the test command, the build, a criterion that must be built first), say so.")
            try:
                res, _m, _tb = await self._run_agent({**state, "phase": "review", "feedback": ask}, inv, "investigator", 0)
            except (asyncio.CancelledError, GraphBubbleUp):
                raise
            except Exception as exc:          # the ladder goes on without the proposal
                return feedback, {}, f"the investigator failed ({str(exc)[:120]}); tried again"
            usage = add_usage(dict(state.get("usage") or {}), {k: getattr(res, k, 0) for k in
                                                               ("tokens_in", "tokens_out", "tokens_cached", "premium_requests", "cost_usd")})
            proposal = (res.text or "").strip()[-3000:]
            data["ladder_proposal"] = proposal
            return (f"{feedback}\n\nAn investigator read this failure. Its proposal:\n{proposal}", {"usage": usage, "data": data},
                    "an investigator proposed a fix; tried again")
        if count == 1:
            return feedback, {}, "the same agent again, with the failure"
        proposal = data.get("ladder_proposal")
        extra = f"\n\nThe investigator's proposal:\n{proposal}" if proposal else ""
        if count == 3 and agent and not data.get("ladder_escalated"):
            r = self._escalate_model(tstep, state)
            before = (state.get("agent_models") or {}).get(agent)
            data["ladder_escalated"] = {"agent": agent, "ac": ac_id, "before": before}
            upd = {**r.update, "data": data}
            mk = dict(upd.get("markers") or {})
            mk.pop(tstep.id, None)
            upd["markers"] = mk
            return feedback + extra, upd, r.note
        return feedback + extra, {}, "tried again"

    async def _knowledge_failed(self, i: int, step: Step, state: FlowState, r: ActionResult, upd: dict):
        """The knowledge check found problems (a citation of a file that is not there, a section without any). The pages
        are the librarian's work, so the librarian gets the list and fixes them: one round per run of this step, at most
        the step's rounds (else settings.fix_attempts), then the check runs again. Running the same check again without a
        fix would change nothing. After the rounds the person chooses: go on with a warning, or stop. Neither fails the
        flow: its code, tests and reviews are done, only its notes are off. The warning stays in data.warnings, the gate
        log and the flow's last note."""
        key = f"{step.id}:knowledge"
        retries = dict(state.get("retries") or {})
        count = retries.get(key, 0) + 1
        rounds = step.rounds if step.rounds is not None else int(self.ctx.settings.get("fix_attempts") or 3)
        problems = (r.detail or "").strip()
        gates = copy.deepcopy(upd.get("gates") or state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        base = {**upd, "last_failure": r.note[:300]}
        if count <= rounds:
            fixer = step.model_copy(update={"id": f"{step.id}_fix", "kind": "agent", "name": f"{step.name}: fix the pages",
                                            "agent": "librarian", "action": None, "markers": None, "instructions": None})
            ask = (f"keel's knowledge check found these problems in the knowledge pages (round {count} of {rounds}). Fix "
                   "each one in the page it names and change nothing else. A citation needs the file's full path from "
                   "the repo root (as `git ls-files` shows it) and a line that exists; when you cannot find the source "
                   f"of a claim, remove the claim.\n\n{problems[-4000:]}")
            try:
                res, _m, _tb = await self._run_agent({**state, "feedback": ask}, fixer, "librarian", 0)
            except (asyncio.CancelledError, GraphBubbleUp):
                raise
            except Exception as exc:          # the check runs again; the rounds still end
                did = f"the librarian failed ({str(exc)[:120]})"
            else:
                base["usage"] = add_usage(dict(state.get("usage") or {}), {k: getattr(res, k, 0) for k in (
                    "tokens_in", "tokens_out", "tokens_cached", "premium_requests", "cost_usd")})
                tokens = dict(state.get("step_tokens") or {})
                tokens[step.id] = tokens.get(step.id, 0) + res.tokens_in + res.tokens_out + res.tokens_cached // 10
                base["step_tokens"] = tokens
                did = "the librarian fixed the pages it names"
            retries[key] = count
            gates["log"].append(f"knowledge {step.id} round {count} of {rounds}: {r.note} {did}"[:300])
            return {**base, "gates": gates, "retries": retries,
                    "note": f"{r.note} · round {count} of {rounds}: {did}; the check runs again"[:300]}, step.id
        answer, extra = self._ask(state, {
            "step": step.id, "kind": "fix", "title": f"{step.name}: problems remain after {rounds} round(s)",
            "detail": f"{r.note}\n\n{problems[-1500:]}\n\nThe librarian had {rounds} round(s) to fix them. Go on with a "
                      "warning: the flow goes on, and the warning is kept in the flow and its last note. Stop: the flow ends "
                      "here as done, with the warning (the work before this step stays).",
            "options": OPTIONS, "labels": {"approve": "Go on with a warning", "reject": "Stop"}}, gate="failure")
        why = (answer.get("why") or "").strip()
        go_on = answer.get("decision") == "approve"
        warning = f"{step.name}: {r.note.rstrip('.')} (not fixed after {rounds} round(s))"
        data = dict(state.get("data") or {})
        data["warnings"] = [w for w in data.get("warnings") or [] if w.get("step") != step.id] + \
            [{"step": step.id, "text": warning, "problems": problems.splitlines()[:50]}]
        gates["log"].append(f"knowledge {step.id} {'go on with a warning' if go_on else 'stop'}: {warning}"
                            + (f" ({why})" if why else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": answer.get("decision"),
                                                          "why": why, "warning": warning})
        retries[key] = 0
        out = {**base, **extra, "gates": gates, "data": data, "retries": retries, "feedback": None, "last_failure": None}
        if not go_on:
            return {**out, "status": "done", "ac": None, "item": None, "note": f"stopped with a warning: {warning}"[:300]}, END
        out["note"] = f"warning: {warning}"[:300]
        if step.then == "end":
            return {**out, "status": "done", "ac": None, "item": None}, END
        if step.then and step.then != "continue":
            return out, self.nav.jump(step.then, i)
        return out, self.nav.after(i)

    async def _check_failed(self, i: int, step: Step, state: FlowState, ac: dict | None, r: ActionResult, upd: dict):
        key = f"{step.id}:{(ac or {}).get('id')}"
        retries = dict(state.get("retries") or {})
        count = retries.get(key, 0) + 1
        fp = hashlib.sha1((r.note + r.detail[:400]).encode()).hexdigest()[:12]
        stall = dict(state.get("stall") or {"fingerprint": None, "count": 0, "step": 0})
        if stall.get("fingerprint") == fp:
            stall["count"] = stall.get("count", 0) + 1
        else:
            stall = {"fingerprint": fp, "count": 1, "step": 0}
        feedback = f"{r.note}\n{r.detail[-2000:]}".strip()
        limit = rules.load_config(self.ctx.root).get("loops", {}).get("stall_repeats", 3)
        if stall["count"] >= limit:
            stall["step"] = min(stall.get("step", 0) + 1, len(rules.LADDER))
            feedback += "\n\nStall ladder: " + rules.LADDER[stall["step"] - 1]
        # A code step's `back` names where its failures go; else the agent step before it. `rounds` caps the attempts.
        target = self.nav.jump(step.back, i) if step.back else self.nav.retry_target(i)
        attempts = step.rounds if step.rounds is not None else int(self.ctx.settings.get("fix_attempts") or 3)
        base = {**upd, "stall": stall, "last_failure": r.note[:300], "feedback": feedback, "note": r.note}
        lp = self.nav.loop_of(i)
        ladder = bool(step.per_ac and lp and lp.per_ac and ac and target and not step.after_rounds)
        if target and count <= attempts:
            retries[key] = count
            if ladder:
                fb, more, did = await self._ladder(count, i, step, {**state, **upd}, target, feedback)
                gates = copy.deepcopy(base.get("gates") or state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
                gates["log"].append(f"stall {ac['id']} round {count}: {did}"[:300])
                return {**base, **more, "gates": gates, "feedback": fb, "retries": retries,
                        "note": f"{r.note} · round {count}: {did}"[:300]}, target
            return {**base, "retries": retries}, target
        if step.after_rounds:
            # keel v1 "fails twice: reset and reproduce again": a fresh start instead of another try in the same place.
            return {**base, "retries": {**retries, key: 0}, "note": f"{r.note} · on to {step.after_rounds}"[:300]}, \
                self.nav.jump(step.after_rounds, i)
        if ladder:
            return self._choice_answer(i, step, state, ActionResult(False, r.note, r.detail, ask=self._stuck_question(
                step, ac, r, count - 1, attempts)), base)
        in_items = bool(lp and not lp.per_ac and ac)
        reject = "reject to mark this item failed and go on with the next one" if in_items else "reject to stop the flow"
        who = (ac or {}).get("id") or step.id
        tries, limit = flow_actions.stuck_tries(state, who), flow_actions.sendback_limit(self.ctx.settings)
        question = {"step": step.id, "kind": "fix", "title": f"{step.name} keeps failing",
                    "detail": f"{r.note}\n\n{r.detail[-1500:]}\n\nApprove to try again, {reject}.", "options": OPTIONS}
        if tries >= limit:
            # 0.18.12 past settings.sendback_limit tries: no "try again", only the way out
            question.update(options=["reject"], labels={"reject": "Skip this item" if in_items else "Stop"},
                            detail=f"{flow_actions.limit_note(tries, limit, who)}\n\n{r.note}\n\n{r.detail[-1500:]}\n\n"
                                   f"Reject: {'the item is marked failed and the next one goes on' if in_items else 'the flow stops'}.")
        answer, extra = self._ask(state, question)
        base.update(extra)
        if (answer or {}).get("decision") != "approve":
            if in_items:
                items = _set_ac(get_list(state, lp.key), ac["id"], "failed")
                return {**base, **put_list(state, lp.key, items), "retries": {**retries, key: 0}, "feedback": None,
                        "note": f"{ac['id']} failed: {r.note}"[:300]}, self.nav.end(lp)
            return {**base, "status": "failed", "error": r.note}, END
        retries[key] = 0
        base.update(flow_actions.stuck_counted({**state, **base}, who, tries + 1))
        why = (answer or {}).get("why")
        if why:
            base["feedback"] = f"{feedback}\n\nFrom the user: {why}"
        return {**base, "retries": retries}, target or step.id

    async def gate_step(self, i: int, step: Step, state: FlowState):
        ctx = self.ctx
        ac = _ac(state) if step.per_ac else None
        item = self._item(state, step)
        acs = state.get("acs") or []
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        if ac:
            due = rules.gate_due(gates.get("mode", "every-ac"), acs, ac["id"], gates.get("skipped"), rules.ac_lane(ac))
            if not due["due"]:
                gates["log"].append(f"ac {ac['id']} approve: no gate here ({due['why']})")
                return {"gates": gates, "acs": _set_ac(acs, ac["id"], "done"), "note": f"no gate: {due['why']}",
                        **flow_actions.stuck_counted(state, ac["id"], None)}, self.nav.after(i)
        if step.when:
            label, values = self._when(state, step.when)
            if not self._holds(step.when, values):
                # Not this time (a --semi gate in an --auto run, a question with nothing to ask): approved unasked.
                why = f"not asked, {label}: {self._shown_values(values)}"
                gates["log"].append(f"gate {step.id} approve: {why}")
                ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "why": why, "by": "engine"})
                return {"gates": gates, "note": f"{step.name}: {why}"[:300]}, self.nav.after(i)
        if self.wf.flow == "init" and step.id == "questions":
            return self._init_questions(step, state, gates), self.nav.after(i)
        if step.skip_menu:
            return self._skip_menu(i, step, state, gates)
        if isinstance(step.choices, list) and item:
            return self._choice_gate(i, step, state, gates, item)
        waived = (gates.get("skipped") or {}).get(step.phase or "") if not ac and not item else None
        if waived:
            # keel v1 --no-gates: the gate records an automatic approval (it shows in the PR body's skipped gates).
            gates["log"].append(f"gate {step.id} approve: waived ({waived})")
            self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "why": f"waived: {waived}"})
            upd = {"gates": gates, "note": f"{step.name}: waived ({waived})"}
            if isinstance(step.choices, dict):
                first = next(iter(step.choices))
                upd["data"] = {**(state.get("data") or {}), f"{step.id}_answer": {"choice": first, "why": "waived", "payload": {}}}
                return upd, self.nav.jump(step.choices[first], i)
            if step.choices:
                upd["markers"] = self._choice_markers(state, step, _default_choice(state, step), "waived")
            return upd, self.nav.after(i)
        options = OPTIONS
        title = step.name + (f" · {ac['id']}" if ac else f" · {item['id']}" if item else "")
        # only a flow with a step that writes the spec waits for criteria (a spike's gates have none, on purpose)
        no_criteria = not ac and step.phase in ("spec", "triage") and not acs and self._writes_specs()
        clar = state.get("clarify") or {}
        # the spec's questions, or the questions of an agent step with `asks: true` (clar["step"])
        asked = clar.get("questions") if (no_criteria or clar.get("step")) else None
        if asked:
            return self._clarify_gate(i, step, state, gates, asked)
        if no_criteria:
            # Nothing real to approve: say so and only allow "send back" with what the agent should do.
            options = ["reject"]
            title = f"{step.name} — no acceptance criteria yet"
            said = (state.get("last_answer") or state.get("note") or "").strip()
            detail = ("The spec step wrote no acceptance criteria, so there is nothing to approve yet. "
                      "Send it back and say what to build.\n\nWhat the agent said:\n" + said[:1200])
        elif step.report == "verdicts":
            detail = await asyncio.to_thread(ship_mod.final_report, ctx.root, ctx.project_id or ctx.root, dict(state), ctx.title,
                                             ctx.thread_id)
        elif self.wf.flow == "init" and step.id == "plan_gate":
            detail = init_gates.plan(ctx.root, state.get("init") or init_gates.defaults(ctx.root, bool(ctx.settings.get("fast"))))
        elif (state.get("data") or {}).get(f"{step.id}_detail"):
            # A step before this gate wrote what it should show (the hunt's lens list, its report summary).
            detail = str(state["data"][f"{step.id}_detail"])
        elif step.when and step.when.get("data") and not {"equals", "in"} & set(step.when) and isinstance(self._seed_value(f"$data.{step.when['data']}", state, None), str):
            # A gate that pauses on a data value shows it (cover: why coverage could not be measured).
            detail = self._seed_value(f"$data.{step.when['data']}", state, None)
        elif ac:
            detail = f"{ac['id']} [{ac.get('layer', 'API')}] {ac.get('title', '')}\nLast step: {state.get('note', '')}"
        elif item:
            about = item.get("title") or item.get("summary") or json.dumps({k: v for k, v in item.items() if k not in ("id", "status")},
                                                                          ensure_ascii=False, default=str)[:600]
            detail = (f"{item['id']}: {about}\nLast step: {state.get('note', '')}\n\n"
                      'Approve to go on, or choose skip (payload {"choice": "skip"}) and say why to skip this item.')
        elif i and self._code_before(i) and state.get("show"):
            # What the code step before this gate prepared for it (a review report, a diagnosis, a size proposal);
            # branches in between change nothing (v0.17.4: the amendment's branches before amend_gate and amend_loop).
            detail = state["show"]
        elif i and "pr" in self.wf.steps[i - 1].actions() and state.get("pr_body"):
            # The PR body the pr step built: approve to go on (an open_pr step after this gate may open it).
            detail = state["pr_body"]
        else:
            detail = "\n".join(f"{a['id']} [{a.get('layer', 'API')}] {a.get('title', '')}" for a in acs) or (state.get("note") or "")
            if state.get("spec"):
                detail = f"Spec: {state['spec']}\n{detail}"
                if step.phase in ("spec", "triage"):
                    detail += "\n\n" + spec_check.describe(spec_check.check(spec_check.read_spec(ctx.root, state["spec"]), acs,
                                                                              spec_check.outside_facts(ctx.request, state.get("data"))))
        lint_notes = (state.get("data") or {}).get("lint_notes") or []
        if lint_notes and not no_criteria:
            detail = f"{detail}\n\nStatic checks on the last changed files:\n" + "\n".join(f"- {n}" for n in lint_notes)
        if step.menus and not no_criteria:
            detail = f"{detail}\n\n{self._folded_menus(i)}"
        question = {"step": step.id, "kind": "gate", "title": title, "detail": detail, "options": options}
        routes = isinstance(step.choices, dict) and not no_criteria
        context = f"{self.wf.flow}:{step.id}"
        if routes:
            question.update(options=["approve"], choices=self._open_choices(step, state))
            question = choices_mod.for_question(question, context)
        elif step.choices and not no_criteria:
            # A list outside a loop: named exits as markers CHOICE and WHY (branches route on them); reject sends back.
            question.update(choices=list(step.choices), detail=detail + "\n\nApprove with one of: " + ", ".join(step.choices)
                            + f" (default {_default_choice(state, step)}). Send back to {step.back or 'the step before'} with a note.")
            question = choices_mod.for_question(question, context, default=_default_choice(state, step))
        elif item:
            # 0.19.0 a for_each item's gate: skip is a named choice that needs a reason (payload skip: true still works)
            question.update(choices=["approve", "skip"])
            question = choices_mod.for_question(question, "item")
        extra_q = self._gate_questions(i, step, state) if not no_criteria else []
        if extra_q:
            # questions a form can show beside the choices (the hunt's lenses and triage, the folded skip menus)
            question["questions"] = extra_q
        kind, review = self._gate_kind(i, step, state, question, ac)
        answer, extra = self._ask(state, question, gate=kind, review=review)
        decision = answer.get("decision", "reject") if not no_criteria else "reject"
        why = (answer.get("why") or "").strip()
        payload = answer.get("payload") or {}
        if routes:
            names = self._open_choices(step, state)
            plain = "reject" if decision == "reject" and "reject" in names else names[0]
            back = str(payload.get("choice") or plain) == "reject"
        else:
            back = decision != "approve"
        stop, counted = self._sendbacks(step, {**state, **extra}, f"{step.id}:{(ac or item or {}).get('id', '')}", back)
        extra = {**extra, **counted}
        if ac and not back and decision == "approve":
            # the criterion is through its gate: its stuck count starts again (flow_actions.STUCK)
            extra.update(flow_actions.stuck_counted({**state, **extra}, ac["id"], None))
        if stop:
            gates["log"].append(f"gate {step.id} stop: {stop['note']}")
            return {"gates": gates, **extra, **stop}, END
        if routes:
            return self._choice(i, step, state, gates, extra, answer, item)
        choice = None
        if step.choices and decision == "approve":
            choice = payload.get("choice") if payload.get("choice") in step.choices else _default_choice(state, step)
        subject = f"ac {ac['id']}" if ac else f"gate {step.id}"
        gates["log"].append(f"{subject} {decision}" + (f" ({item['id']})" if item else "") + (f" [{choice}]" if choice else "")
                            + (f": {why}" if why else ""))
        decided = {"gate": step.name, "decision": decision, "why": why, "ac": (ac or {}).get("id")}
        if item:
            decided["item"] = item["id"]
        if choice:
            decided["choice"] = choice
        ctx.emit("gate.decided", step=step.id, data=decided)
        upd: dict = {"gates": gates, **extra}
        if payload.get("acs"):
            acs = [{"id": a["id"], "layer": a.get("layer", "API"), "title": a.get("title", ""), "status": a.get("status", "todo")}
                   for a in payload["acs"]]
            upd["acs"] = acs
        if decision == "approve":
            if ac:
                upd["acs"] = _set_ac(acs, ac["id"], "done")
            upd["note"] = f"{step.name} approved" + (f" [{choice}]" if choice else "") + (f": {why}" if why else "")
            if choice:
                upd["markers"] = self._choice_markers(state, step, choice, why)
            if item and (payload.get("skip") or payload.get("choice") == "skip"):
                lp = self.nav.loop_of(i)
                why = why or str(payload.get("reason") or "").strip()
                upd.update(self._end_item(state, lp, item, "skipped", None, why, (step.on_skip or {}).get("record")))
                upd["note"] = f"{item['id']} skipped" + (f": {why}" if why else "")
                return upd, self.nav.end(lp)
            return upd, self.nav.after(i)
        if ac:
            upd["acs"] = _set_ac(acs, ac["id"], "todo")
        upd["feedback"] = why or f"Sent back at {step.name}. {NO_REASON}"
        upd["note"] = f"{step.name} sent back" + (f": {why}" if why else "")
        target = self.nav.jump(step.back, i) if step.back else self.nav.enter(max(i - 1, 0))
        return upd, target

    def _sendbacks(self, step: Step, state: FlowState, key: str, back: bool) -> tuple[dict | None, dict]:
        """Counts the send-backs of one gate in a row (key: step and criterion or item; an approval starts again) and
        returns (an update that stops the flow, or None; the state update). With a reason or without, after
        settings.sendback_limit send-backs (default SENDBACK_LIMIT) the next one asks the person first: go on anyway
        (the count starts again) or stop. Never a run mode's answer: it is a loop keel cannot see the end of."""
        counts = dict(state.get("sendbacks") or {})
        if not back:
            return None, ({"sendbacks": {k: v for k, v in counts.items() if k != key}} if key in counts else {})
        limit = flow_actions.sendback_limit(self.ctx.settings)
        n = int(counts.get(key, 0))
        extra: dict = {}
        if n >= limit:
            answer, extra = self._ask(state, {
                "step": step.id, "kind": "fix", "title": f"{step.name}: sent back {n} time(s) in a row",
                "detail": f"{step.name} was sent back {n} time(s) in a row (the limit is {limit}, settings.sendback_limit). "
                          "Another round may change nothing. Go on anyway: this send-back goes ahead and the count starts "
                          "again. Stop: the flow stops here (the work so far stays; rewind to go on later).",
                "options": OPTIONS, "labels": {"approve": "Go on anyway", "reject": "Stop"}}, gate="rounds")
            self.ctx.emit("gate.decided", step=step.id, data={"gate": f"{step.name} send-back limit",
                                                              "decision": answer.get("decision"), "why": answer.get("why") or ""})
            if answer.get("decision") != "approve":
                return {**extra, "status": "stopped", "sendbacks": {**counts, key: 0},
                        "note": f"stopped: {step.name} was sent back {n} time(s) in a row"}, {}
            n = 0
        return None, {**extra, "sendbacks": {**counts, key: n + 1}}

    @staticmethod
    def _choice_markers(state: FlowState, step: Step, choice: str, why: str) -> dict:
        """A gate's named exit as markers (CHOICE, WHY) that branches read: `when: {marker: CHOICE, step: <gate>}`."""
        mk = dict(state.get("markers") or {})
        mk[step.id] = {"CHOICE": choice, "WHY": why}
        mk["*"] = {**(mk.get("*") or {}), "CHOICE": choice, "WHY": why}
        return mk

    def _when(self, state: FlowState, when: dict) -> tuple[str, list]:
        """A `when`'s subject and the values it looks at: a path in state.data (`data: hunt.mode`), or a marker an earlier
        agent ended with (when.step names that step or a list of steps, else the latest value from any step; `any: true`
        adds each fan-out item's marker). Empty values count as not given."""
        if when.get("data") or when.get("state"):
            # `data: hunt.mode` reads state.data; `state: acs` reads any path of the flow state.
            path = str(when["data"]).removeprefix("data.") if when.get("data") else str(when["state"])
            value = self._seed_value(f"$data.{path}" if when.get("data") else f"${path}", state, None)
            return path, [None if value in (None, "", [], {}) else value]
        name = str(when["marker"]).upper()
        return name, self._marker_values(state, when, name)

    @staticmethod
    def _holds(when: dict, values: list) -> bool:
        if when.get("absent"):
            # 0.18.21 `absent: true`: the value is not given (the feature's interview runs only without criteria)
            return not any(v not in (None, "", [], {}) for v in values)
        return any(markers.matches(v, when) for v in values)

    @staticmethod
    def _shown_values(values: list) -> str:
        shown = [f"{len(v)} item(s)" if isinstance(v, (list, dict)) else str(v) for v in values if v not in (None, "")]
        return ", ".join(shown) or "not given"

    def _code_before(self, i: int) -> bool:
        """Is the step before this one (past any branches) a code step?"""
        j = i - 1
        while j >= 0 and self.wf.steps[j].kind == "branch":
            j -= 1
        return j >= 0 and self.wf.steps[j].kind == "code"

    def _choice(self, i: int, step: Step, state: FlowState, gates: dict, extra: dict, answer: dict, item: dict | None):
        """A gate with named exits: payload.choice picks one (default the first); its answer is kept in
        state.data["<gate id>_answer"] for the step it leads to ({choice, why, payload})."""
        payload = answer.get("payload") or {}
        why = (answer.get("why") or "").strip()
        names = self._open_choices(step, state)
        # A plain "send back" picks the exit named reject when the gate has one; otherwise the first exit.
        plain = "reject" if answer.get("decision") == "reject" and "reject" in names else names[0]
        choice = str(payload.get("choice") or plain)
        if choice not in names:
            gates["log"].append(f"gate {step.id} unknown choice {choice}")
            return {"gates": gates, **extra, "note": f"{step.name}: '{choice}' is not one of {', '.join(names)}"}, step.id
        gates["log"].append(f"gate {step.id} {choice}" + (f" ({item['id']})" if item else "") + (f": {why}" if why else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "choice": choice, "why": why})
        data = {**(state.get("data") or {}), f"{step.id}_answer": {"choice": choice, "why": why, "payload": payload}}
        said = None if answer.get("auto") else why
        upd = {"gates": gates, **extra, "data": data, "feedback": said or (NO_REASON if choice == "reject" else None),
               "note": f"{step.name}: {choice}" + (f": {why}" if why else "")}
        return upd, self.nav.jump(step.choices[choice], i)

    @staticmethod
    def _open_choices(step: Step, state: FlowState) -> list[str]:
        """A dict-choice gate's exits, minus the ones a step before it ruled out this time (data["<gate id>_without"],
        v0.17.5: amend_loop has no `first` when nothing else is unfinished)."""
        without = set((state.get("data") or {}).get(f"{step.id}_without") or [])
        names = [c for c in step.choices or {} if c not in without]
        return names or list(step.choices or {})

    def _gate_questions(self, i: int, step: Step, state: FlowState) -> list[dict]:
        """Questions a gate shows beside its choices: what a step before it wrote (data["<gate id>_questions"]: the hunt's
        lenses, its triage's finding) and, for a gate with menus: true, the skip menus it decides."""
        out = [dict(q) for q in (state.get("data") or {}).get(f"{step.id}_questions") or [] if isinstance(q, dict)]
        if step.menus:
            units = [u for j in self._menu_steps(i) for u in ship_mod.skip_units(self.wf.steps, j)]
            if units:
                out.append(ship_mod.skip_question(units))
        return out

    def _menu_steps(self, after: int) -> list[int]:
        return [j for j, s in enumerate(self.wf.steps) if j > after and s.skip_menu]

    def _folded_menus(self, i: int) -> str:
        """The skip menus after gate i, for its own text (a gate with menus: true)."""
        out = ["Optional steps (decided here with this approval, so the flow does not stop again to ask):"]
        for j in self._menu_steps(i):
            out += ["", f"— {self.wf.steps[j].name} —", ship_mod.skip_menu_detail(self.wf.steps, j)]
        return "\n".join(out)

    def _folded_answer(self, i: int, state: FlowState) -> tuple[str, dict] | None:
        """(gate id, payload) when an earlier gate with menus: true was approved and so answers the menu at step i."""
        for j in range(i - 1, -1, -1):
            g = self.wf.steps[j]
            if g.kind == "gate" and g.menus and i in self._menu_steps(j):
                ans = (state.get("data") or {}).get(f"{g.id}_answer") or {}
                first = next(iter(g.choices)) if isinstance(g.choices, dict) else "approve"
                if ans and ans.get("choice") == first:
                    return g.id, dict(ans.get("payload") or {})
        return None

    def _skip_menu(self, i: int, step: Step, state: FlowState, gates: dict):
        """keel v1 ship's opening question: which skippable steps after this gate run this time. Every skip needs a
        reason; skips land in data.ship_skipped (the PR body and the final review show them) and the gate log."""
        units = ship_mod.skip_units(self.wf.steps, i)
        detail = ship_mod.skip_menu_detail(self.wf.steps, i)
        title, extra_all = step.name, {}
        folded = self._folded_answer(i, state)
        if folded:
            # v0.17.5 decided at an earlier gate (the spec gate): its skips for this menu, no second stop. A name no menu
            # knows, or a skip without a reason, still asks here.
            gid, payload = folded
            payload = ship_mod.skip_payload(payload)
            mine = {u["name"] for u in units}
            known = {u["name"] for j in self._menu_steps(-1) for u in ship_mod.skip_units(self.wf.steps, j)}
            raw = payload.get("skip") or {}
            raw = {str(x.get("step") or x.get("name") or ""): x.get("reason") for x in raw if isinstance(x, dict)} \
                if isinstance(raw, list) else raw
            unknown = [n for n in raw if n not in known] if isinstance(raw, dict) else ["skip"]
            skips, lenses, problem = ship_mod.parse_skips(
                {**payload, "skip": {k: v for k, v in raw.items() if k in mine} if isinstance(raw, dict) else raw}, units)
            if unknown:
                problem = f"{', '.join(unknown)} cannot be skipped (skippable: {', '.join(sorted(known)) or 'none'})"
            if not problem:
                data = dict(state.get("data") or {})
                names = {s["step"] for s in skips}
                data["ship_skipped"] = [x for x in data.get("ship_skipped") or [] if x.get("step") not in names] + skips
                if lenses:
                    data["lenses_chosen"] = lenses
                gates["log"].append(f"gate {step.id} approve: chosen at {gid}")
                for sk in skips:
                    gates["log"].append(f"gate {step.id} skip {sk['step']} ({sk['band']}): {sk['reason']}")
                self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve",
                                                                  "why": f"chosen at {gid}", "skipped": skips})
                note = ("skipped: " + ", ".join(f"{s['step']} ({s['reason']})" for s in skips)) if skips else "every step runs"
                return {"gates": gates, "data": data, "note": f"{note} (chosen at {gid})"[:300]}, self.nav.after(i)
            title = f"{step.name}: {problem}"
        while True:
            ask = {"step": step.id, "kind": "gate", "title": title, "detail": detail, "options": ["approve"],
                   "labels": {"approve": "Run these steps"}}
            if units:
                ask["questions"] = [ship_mod.skip_question(units)]
            answer, extra = self._ask(state, ask, gate="skip-menu")
            extra_all.update(extra)
            state = {**state, **extra}
            skips, lenses, problem = ship_mod.parse_skips(ship_mod.skip_payload(answer.get("payload") or {}), units)
            if not problem:
                break
            title = f"{step.name}: {problem}"
        why = (answer.get("why") or "").strip()
        data = dict(state.get("data") or {})
        names = {s["step"] for s in skips}
        data["ship_skipped"] = [x for x in data.get("ship_skipped") or [] if x.get("step") not in names] + skips
        if lenses:
            data["lenses_chosen"] = lenses
        gates["log"].append(f"gate {step.id} approve" + (f": {why}" if why else ""))
        for sk in skips:
            gates["log"].append(f"gate {step.id} skip {sk['step']} ({sk['band']}): {sk['reason']}")
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "why": why,
                                                          "skipped": skips, **({"lenses": lenses} if lenses else {})})
        note = ("skipped: " + ", ".join(f"{s['step']} ({s['reason']})" for s in skips)) if skips else "every step runs"
        return {**extra_all, "gates": gates, "data": data, "note": note[:300]}, self.nav.after(i)

    def _choice_gate(self, i: int, step: Step, state: FlowState, gates: dict, item: dict):
        """One choice per item of a for_each loop (cover: test, delete or accept). The choice is stored on the item
        (decision, reason) and as markers[<id>].CHOICE; on_skip's choice ends the item as skipped, needs a reason and is
        appended to data[on_skip.record]."""
        lp = self.nav.loop_of(i)
        on_skip = step.on_skip or {}
        skip_choice = on_skip.get("choice")
        about = item.get("title") or json.dumps({k: v for k, v in item.items() if k not in ("id", "status")}, ensure_ascii=False,
                                                default=str)[:600]
        detail = (f"{item['id']}: {about}\nLast step: {state.get('note', '')}\n\nChoose one: {' | '.join(step.choices)} "
                  f"(approve with payload {{\"choice\": \"<one>\"}}; plain approve = {step.choices[0]})."
                  + (f" {skip_choice} needs a reason (why): it is recorded and shown at the final review and in the PR body."
                     if skip_choice else ""))
        title, extra_all = f"{step.name} · {item['id']}", {}
        while True:
            ask = choices_mod.for_question({"step": step.id, "kind": "gate", "title": title, "detail": detail,
                                            "options": ["approve"], "choices": list(step.choices)},
                                           f"{self.wf.flow}:{step.id}", default=step.choices[0],
                                           needs_why={skip_choice: choices_mod.REQUIRED} if skip_choice else None)
            answer, extra = self._ask(state, ask, gate="choice")
            extra_all.update(extra)
            state = {**state, **extra}
            payload = answer.get("payload") or {}
            choice = str(payload.get("choice") or (skip_choice if payload.get("skip") and skip_choice else step.choices[0]))
            why = (answer.get("why") or str(payload.get("reason") or "")).strip()
            problem = (f"{choice} is not one of {', '.join(step.choices)}" if choice not in step.choices else
                       f"{choice} needs a reason" if choice == skip_choice and not why else None)
            if not problem:
                break
            title = f"{step.name} · {item['id']}: {problem}"
        gates["log"].append(f"gate {step.id} {choice} ({item['id']})" + (f": {why}" if why else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "choice": choice,
                                                          "why": why, "item": item["id"]})
        mk = dict(state.get("markers") or {})
        mk[step.id] = {"CHOICE": choice}
        mk["*"] = {**(mk.get("*") or {}), "CHOICE": choice}
        upd = {**extra_all, "gates": gates, "markers": mk}
        if choice == skip_choice:
            upd.update(self._end_item(state, lp, item, "skipped", choice, why, on_skip.get("record")))
            upd["note"] = f"{item['id']}: {choice}: {why}"[:300]
            return upd, self.nav.end(lp)
        items = [dict(x, decision=choice, reason=why or None) if x["id"] == item["id"] else x for x in get_list(state, lp.key)]
        upd.update(put_list(state, lp.key, items))
        upd["note"] = f"{item['id']}: {choice}" + (f": {why}" if why else "")
        return upd, self.nav.after(i)

    @staticmethod
    def _end_item(state: FlowState, lp: Loop, item: dict, status: str, decision: str | None, why: str,
                  record: str | None) -> dict:
        """The state update that ends a loop item (skipped) and, with `record`, keeps it in data[record] with its reason."""
        items = [dict(x, status=status, **({"decision": decision} if decision else {}), reason=why or None)
                 if x["id"] == item["id"] else x for x in get_list(state, lp.key)]
        upd = put_list(state, lp.key, items)
        if record:
            data = dict(upd.get("data") or state.get("data") or {})
            rec = {k: item[k] for k in ("id", "key", "file", "lines", "title", "app", "critical") if k in item}
            rec.update(decision=decision or status, reason=why or None)
            ident = rec.get("key") or rec["id"]
            data[record] = [x for x in data.get(record) or [] if (x.get("key") or x.get("id")) != ident] + [rec]
            upd = {**upd, "data": data}
        return upd

    def _writes_specs(self) -> bool:
        """Does any agent step of this flow write a spec (prompts.spec_writer, in a spec or triage phase)?"""
        return any(s.phase in ("spec", "triage") and prompts.spec_writer(s) for s in self.wf.steps)

    def _clarify_gate(self, i: int, step: Step, state: FlowState, gates: dict, asked: list[dict]):
        """The explorer's questions as a pause with buttons. Answers (clicked or typed) go back to the explorer."""
        n = len(asked)
        src = (state.get("clarify") or {}).get("step")      # an agent step with `asks: true`; else the spec's explorer
        asker = next((s.name for s in self.wf.steps if s.id == src), src) if src else None
        title = (f"{asker} has {n} question{'s' if n != 1 else ''}" if asker
                 else f"The explorer has {n} question{'s' if n != 1 else ''} before the spec")
        answer, extra = self._ask(state, {
            "step": step.id, "kind": "clarify", "title": title,
            "detail": clarify.describe(asked), "questions": asked, "options": ["approve"],
            "labels": {"approve": "Send my answers"}})
        payload = answer.get("payload") or {}
        round_no = int(state.get("clarify_rounds") or 0) + 1
        auto = answer.get("why") if answer.get("auto") else ""
        text = clarify.answers_text(asked, payload.get("answers"), "" if auto else (answer.get("why") or ""), round_no,
                                    spec=not src)
        gates["log"].append(f"gate {step.id} answered the explorer's {n} question(s)" + (f": {auto}, the recommended options" if auto else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve", "why": text[:600],
                                                          "clarify": True})
        upd = {"gates": gates, **extra, "feedback": text, "clarify": {}, "clarify_rounds": round_no,
               "note": f"answered {n} question(s)"}
        if src:
            # keep the answers for the add-on's records too (data.<gate>_clarify: questions and answers, every round)
            kept = list(((state.get("data") or {}).get(f"{step.id}_clarify")) or [])
            kept.append({"round": round_no, "questions": asked, "answers": dict(payload.get("answers") or {}), "note": answer.get("why") or ""})
            # and the answers as text for the steps after it (data.<asking step>_answers: the feature's spec step reads the
            # interview's), every round
            now = clarify.answers_message(asked, payload.get("answers")) + (f"\nAlso, in the person's words: {answer['why']}"
                                                                         if answer.get("why") and not auto else "")
            said = "\n\n".join(x for x in (str((state.get("data") or {}).get(f"{src}_answers") or ""), now) if x)
            upd["data"] = {**(state.get("data") or {}), f"{step.id}_clarify": kept, f"{src}_answers": said}
            target = self.nav.jump(src, i)
        else:
            target = self.nav.jump(step.back, i) if step.back else self.nav.enter(max(i - 1, 0))
        return upd, target

    def _init_questions(self, step: Step, state: FlowState, gates: dict) -> dict:
        """keel init's three questions as a clarify form (0.19.0): the answers ({run, services, knowledge}) set the init
        config; approving without answers takes the recommended options (keel's defaults). An old client's "Use my
        answers" (a send-back with typed words) still goes through the keyword parser."""
        root, fast = self.ctx.root, bool(self.ctx.settings.get("fast"))
        asked = init_gates.clarify_questions(root, fast=fast)
        answer, extra = self._ask(state, {
            "step": step.id, "kind": "clarify", "title": "three questions", "detail": clarify.describe(asked),
            "questions": asked, "options": OPTIONS, "labels": {"approve": "Use these answers", "reject": "Use my answers"}},
            gate="clarify")
        why = (answer.get("why") or "").strip()
        given = (answer.get("payload") or {}).get("answers")
        mine = answer.get("decision") == "reject" and why
        if isinstance(given, dict) and given:
            init = init_gates.from_answers(root, given, fast=fast)
            said = "answered: " + "; ".join(f"{k} {v}" for k, v in given.items())
        else:
            init = init_gates.answers(root, why if mine else None, fast=fast)
            said = "answered: " + why if mine else "defaults"
        gates["log"].append(f"gate questions: {said}"[:300] + (f" ({why})" if answer.get("auto") else ""))
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": "approve",
                                                          "why": said if said != "defaults" else "defaults"})
        return {"gates": gates, **extra, "init": init,
                "note": "answers: " + ", ".join(f"{k} {v}" for k, v in init.items() if k != "said")[:300]}

    async def branch_step(self, i: int, step: Step, state: FlowState):
        yes = True
        note = "yes"
        if step.when:
            name, values = self._when(state, step.when)
            yes = self._holds(step.when, values)
            note = f"{name}: {self._shown_values(values)}"
        elif step.action and step.action.startswith("run:"):
            r = await run_action(step.action, self._action_input(state, _ac(state)))
            yes, note = r.ok, r.note
        elif step.agent:
            res, _m, _tb = await self._run_agent(state, step, step.agent, 0)
            yes = not res.text.strip().lower().startswith("no")
            note = res.text.strip()[:160]
        if step.rounds:
            return self._branch_rounds(i, step, state, yes, note)
        target = self.nav.after(i) if yes else self.nav.jump(step.no, i)
        return {"note": f"{step.name}: {'yes' if yes else 'no'} ({note})"}, target

    @staticmethod
    def _marker_values(state: FlowState, when: dict, name: str) -> list:
        """The values a `when` looks at: the marker of when.step (one id or a list; default the latest of any step), and
        with `any: true` each item's marker of those fan-out steps too."""
        src = when.get("step")
        srcs = src if isinstance(src, list) else [src or "*"]
        mk, data = state.get("markers") or {}, state.get("data") or {}
        values = [(mk.get(s) or {}).get(name) for s in srcs]
        if when.get("any"):
            values += [(r.get("markers") or {}).get(name) for s in srcs for r in data.get(f"{s}_results") or []]
        return values


    def _branch_rounds(self, i: int, step: Step, state: FlowState, yes: bool, note: str):
        """A branch with `rounds` closes a loop: "no" sends the flow back at most rounds - 1 times. After that keel asks:
        approve = go on anyway (said why, kept in the gate log), reject = stop the flow. "yes" starts the count again."""
        rounds = dict(state.get("rounds") or {})
        done = int(rounds.get(step.id, 0))
        if yes:
            rounds.pop(step.id, None)
            return {"rounds": rounds, "note": f"{step.name}: yes ({note})"}, self.nav.after(i)
        if done + 1 < step.rounds:
            rounds[step.id] = done + 1
            return {"rounds": rounds, "note": f"{step.name}: no ({note}); round {done + 2} of {step.rounds}"}, self.nav.jump(step.no, i)
        answer, extra = self._ask(state, {
            "step": step.id, "kind": "gate", "title": f"{step.name}: still no after {step.rounds} round(s)",
            "detail": f"{note}\n\nThe loop ran {step.rounds} time(s), its limit. Approve to go on anyway (say why; it is kept in "
                      f"the gate log and shown at the final review). Reject to stop the flow here.",
            "options": OPTIONS, "labels": {"approve": "Go on anyway", "reject": "Stop"}}, gate="rounds")
        why = (answer.get("why") or "").strip()
        gates = copy.deepcopy(state.get("gates") or {"mode": "every-ac", "log": [], "skipped": {}})
        decision = answer.get("decision", "reject")
        self.ctx.emit("gate.decided", step=step.id, data={"gate": step.name, "decision": decision, "why": why})
        rounds.pop(step.id, None)
        if decision != "approve":
            gates["log"].append(f"gate {step.id} stop after {step.rounds} round(s)" + (f": {why}" if why else ""))
            return {**extra, "gates": gates, "rounds": rounds, "status": "stopped",
                    "note": f"stopped: {step.name} still no after {step.rounds} round(s)"}, END
        gates["log"].append(f"gate {step.id} go on after {step.rounds} round(s): {why or 'no reason given'}")
        return {**extra, "gates": gates, "rounds": rounds, "note": f"{step.name}: went on after {step.rounds} round(s)"}, self.nav.after(i)


def _step_cap(step: Step, settings: dict) -> tuple[int, bool]:
    """A step's token limit and whether it is the step's own: the project's per-step cap (settings.step_cap_tokens)
    applies to every step, but a step's own max_tokens wins when it is smaller. (0, False) = no limit."""
    own = int(step.max_tokens or 0)
    default = int(settings.get("step_cap_tokens") or 0)
    if own and (not default or own <= default):
        return own, True
    return default, False


def _real_cheaper(ctx):
    """The cheaper model for a budget switch, but never the fake model for a flow that runs real models: the fake model
    writes example files (the settings default once was fake). None means keel pauses and asks instead."""
    cheaper = ctx.settings.get("cheaper_model")
    if not cheaper or cheaper.get("provider") != "fake":
        return cheaper
    models = [m for m in (ctx.models or {}).values() if isinstance(m, dict)]
    return cheaper if models and all(m.get("provider") == "fake" for m in models) else None


def _default_choice(state, step) -> str:
    """What a plain approve picks: the recommended marker's value when it names a choice, else the first choice."""
    if step.recommend:
        said = str(((state.get("markers") or {}).get("*") or {}).get(step.recommend) or "").strip().lower().split(" ")[0]
        if said in step.choices:
            return said
    return step.choices[0]


def stronger(model: dict) -> dict:
    """The next model up for an escalation: Opus for Claude, high effort elsewhere (the same model when there is none)."""
    if model.get("provider") == "claude" and "opus" not in str(model.get("model") or ""):
        return {**model, "model": "opus"}
    if model.get("provider") in ("codex", "copilot") and model.get("effort") != "high":
        return {**model, "effort": "high"}
    return dict(model)


def compile_workflow(ctx: ThreadContext, checkpointer):
    return Compiler(ctx).build(checkpointer)


class _CodeJob:
    """0.18.15 a code step shown as a job: its own code.* events (stored as a job like an agent's), agent "keel", kind "code",
    no model and no tokens. progress(text, ...) adds one live line (a command, a rung, an action's result)."""

    def __init__(self, ctx, step: Step, state: FlowState, name: str | None = None, actions: list[str] | None = None):
        self.ctx, self.step, self.state = ctx, step, state
        self.name, self.actions = name or step.name, actions
        self.call_id = uuid.uuid4().hex
        self.n = 0
        self.ok = True
        self.t0 = time.monotonic()
        self.last = ""
        try:
            self.loop = asyncio.get_running_loop()
        except RuntimeError:
            self.loop = None

    def start(self):
        ac = (_ac(self.state) or {}).get("id") if self.step.per_ac else None
        self.ctx.emit("code.started", step=self.step.id, call_id=self.call_id, data={
            "agent": "keel", "kind": "code", "provider": "keel", "model": "code", "name": self.name,
            "phase": self.state.get("phase"), "ac": ac, "action": ",".join(self.actions or self.step.actions())})

    def progress(self, text: str, **fields):
        # many actions run in a worker thread (asyncio.to_thread): their lines go back to the event loop's thread
        if self.loop is not None and not self.loop.is_closed():
            try:
                same = asyncio.get_running_loop() is self.loop
            except RuntimeError:
                same = False
            if not same:
                self.loop.call_soon_threadsafe(lambda: self.progress(text, **fields))
                return
        self.n += 1
        self.last = str(text)
        data = {"n": self.n, "kind": "tool", "job": "code", "text": str(text)[:STEP_FIELD_MAX]}
        data.update({k: (v[:STEP_FIELD_MAX] if isinstance(v, str) else v) for k, v in fields.items() if v is not None})
        self.ctx.emit("code.step", step=self.step.id, call_id=self.call_id, data=data)

    def finish(self, status: str):
        self.ctx.emit("code.finished", step=self.step.id, call_id=self.call_id, data={
            "agent": "keel", "kind": "code", "status": status, "tokens_in": 0, "tokens_out": 0, "cost_usd": 0.0,
            "ms": int((time.monotonic() - self.t0) * 1000), "result": self.last[:500]})
