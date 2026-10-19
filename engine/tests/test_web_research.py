"""0.18.20 web research: the built-in web-researcher agent, the web tools its engine gets (Claude Code's WebSearch and
WebFetch, opencode's webfetch/websearch), and the guard letting a read-only `curl` through for the engines without
web tools. No model and no web call runs here."""

from __future__ import annotations

import dataclasses
import json
import re
from pathlib import Path

import pytest
import yaml

from keel_engine import hook, rules
from keel_engine.models import cli_runners, fake
from keel_engine.models.base import AgentRequest
from keel_engine.runtime import guard_ctx, markers, prompts
from keel_engine.tools.agent_tools import ToolBox

CONTENT = Path(__file__).resolve().parents[2] / "content"
AGENT = CONTENT / "agents" / "web-researcher.md"

CURLS = [
    "curl -sL 'https://html.duckduckgo.com/html/?q=parcelperform+webhook+eta'",
    'curl -sL "https://developers.example.com/docs/webhooks?a=1&b=2" | head -200',
    "curl -sL https://raw.githubusercontent.com/acme/sdk/main/openapi.json | python3 -m json.tool | grep -n eta",
    "curl -sIL https://api.example.com/v2/events",
]


def front(f: Path) -> dict:
    return yaml.safe_load(re.match(r"\A---\n(.*?)\n---\n", f.read_text(), flags=re.S).group(1))


def test_the_web_researcher_is_a_read_only_agent_with_web_tools():
    fm = front(AGENT)
    assert fm["name"] == "web-researcher" and fm["description"]
    tools = [t.strip() for t in fm["tools"].split(",")]
    assert tools == ["Read", "Grep", "Glob", "Bash", "WebSearch", "WebFetch"]
    assert "Write" in fm["disallowedTools"] and "Edit" in fm["disallowedTools"]
    assert isinstance(fm["maxTurns"], int) and fm["maxTurns"] >= 30
    body = AGENT.read_text()
    # never stops after one failed URL: searches first, five sources, a table of what was tried, the curl fallback
    for must in ("WebSearch", "WebFetch", "five", "CONFIRMED", "curl -sL", "html.duckduckgo.com", "OpenAPI",
                 "changelog", "Postman", "Stack Overflow", "raw.githubusercontent.com", "CONFIDENCE: high | medium | low"):
        assert must in body, must


def test_web_tools_come_from_the_agent_file():
    assert prompts.web_tools("web-researcher") == ["WebSearch", "WebFetch"]
    assert prompts.web_tools("investigator") == []
    assert prompts.web_tools("no-such-agent") == []


def test_confidence_is_a_registered_marker():
    assert markers.REGISTRY["CONFIDENCE"] == ("high", "medium", "low")
    assert markers.parse("...\nCONFIDENCE: Medium — two sources agree", ["CONFIDENCE"]) == {"CONFIDENCE": "medium"}


def test_the_fake_web_researcher_answers_with_sources_and_confidence():
    req = AgentRequest(agent="web-researcher", system="", prompt="go", root="/tmp", phase="spec",
                       model={"provider": "fake"}, toolbox=ToolBox("/tmp", "spec"))
    _path, _content, text, _data = fake._canned(req)
    assert "https://" in text and markers.parse(text, ["CONFIDENCE"]) == {"CONFIDENCE": "medium"}


def fake_claude(tmp_path) -> Path:
    out = tmp_path / "out"
    out.mkdir()
    bin_ = tmp_path / "claude"
    res = {"type": "result", "result": "done", "usage": {}}
    bin_.write_text(f"#!/bin/sh\ncat > /dev/null\necho \"$@\" > {out}/argv\necho '{json.dumps(res)}'\n")
    bin_.chmod(0o755)
    return out


def flag(argv: list[str], name: str) -> list[str]:
    return argv[argv.index(name) + 1].split(",")


async def test_claude_code_gives_websearch_and_webfetch_to_the_web_researcher_only(tmp_path, monkeypatch):
    out = fake_claude(tmp_path)
    monkeypatch.setenv("KEEL_CLAUDE_BIN", str(tmp_path / "claude"))
    root = tmp_path / "proj"
    root.mkdir()
    work = tmp_path / "work"
    work.mkdir()
    req = AgentRequest(agent="web-researcher", system="", prompt="go", root=str(root), phase="spec",
                       model={"provider": "claude", "mode": "subscription", "model": "sonnet"},
                       toolbox=ToolBox(str(root), "spec"), workdir=str(work))
    await cli_runners.ClaudeCLIRunner().run(req, lambda *a, **k: None)
    argv = (out / "argv").read_text().split()
    assert {"WebSearch", "WebFetch"} <= set(flag(argv, "--tools"))
    assert {"WebSearch", "WebFetch"} <= set(flag(argv, "--allowedTools"))
    hidden = flag(argv, "--disallowedTools")
    assert "WebSearch" not in hidden and "WebFetch" not in hidden and "Task" in hidden
    # a read-only run (run mode readonly) keeps them: they write nothing
    ro = dataclasses.replace(req, toolbox=ToolBox(str(root), "spec", readonly=True))
    await cli_runners.ClaudeCLIRunner().run(ro, lambda *a, **k: None)
    argv = (out / "argv").read_text().split()
    assert flag(argv, "--tools") == ["Read", "Bash", "Glob", "Grep", "WebSearch", "WebFetch"]
    # any other agent still has no web
    inv = dataclasses.replace(req, agent="investigator")
    await cli_runners.ClaudeCLIRunner().run(inv, lambda *a, **k: None)
    argv = (out / "argv").read_text().split()
    assert "WebSearch" not in flag(argv, "--tools") and "WebFetch" in flag(argv, "--disallowedTools")


def test_opencode_keeps_its_web_tools_on_for_an_agent_with_web_tools(tmp_path):
    tools = json.loads((Path(cli_runners.write_opencode_plugin(tmp_path / "a", web=True)) / "opencode.json").read_text())["tools"]
    assert "webfetch" not in tools and "websearch" not in tools and tools["task"] is False
    tools = json.loads((Path(cli_runners.write_opencode_plugin(tmp_path / "b")) / "opencode.json").read_text())["tools"]
    assert tools["webfetch"] is False and tools["websearch"] is False


def test_claude_codes_web_tools_never_reach_the_hook():
    # they write nothing, so keel's hook is not asked about them (its matcher leaves them out)
    assert not re.fullmatch(guard_ctx.MATCHER, "WebSearch") and not re.fullmatch(guard_ctx.MATCHER, "WebFetch")


@pytest.mark.parametrize("cmd", CURLS)
def test_a_read_only_curl_passes_the_guard_in_the_spec_phase(cmd, tmp_path):
    assert rules.check_bash("spec", cmd, {}).ok
    ctx = {"root": str(tmp_path), "phase": "spec", "unlocks": []}
    assert hook.decide("Bash", {"command": cmd}, ctx) is None
    # and in a read-only run (no file changes, but reading the web is no change)
    assert hook.decide("Bash", {"command": cmd}, {**ctx, "readonly": True}) is None


@pytest.mark.parametrize("cmd", ["curl -sL -o page.html https://example.com", "curl -sLO https://example.com/a.zip",
                                 "curl -s --output x.json https://example.com", "curl -sL --remote-name https://e.com/f",
                                 "wget https://example.com/a.zip", "wget -q -O spec.yaml https://example.com/spec.yaml"])
def test_a_read_only_run_refuses_a_download_into_a_file(cmd):
    # 0.18.20 fix: run mode readonly let `curl -o` and `wget` write files (only redirects and rm/mv/... were caught)
    from keel_engine.runtime import run_mode
    assert run_mode.readonly_bash(cmd)


@pytest.mark.parametrize("cmd", [*CURLS, "wget -qO- https://example.com", "wget -O - https://example.com",
                                 "curl -sL -o /dev/null -w '%{http_code}' https://example.com"])
def test_a_read_only_run_still_reads_the_web(cmd):
    from keel_engine.runtime import run_mode
    assert run_mode.readonly_bash(cmd) is None


# ------------------------------------------------------------------ the spike flow (fake model)

def test_the_spikes_web_findings_reach_the_researchers_and_the_findings(client, repo, monkeypatch):
    from conftest import start, wait

    frame = ("Question: what is ParcelPerform's ETA field called in the webhook?\nOutside the repo: the webhook payload.\n"
             "```json\n" + json.dumps([{"title": "map the field from the webhook"}, {"title": "poll the API"}]) + "\n```")
    web = ("CONFIRMED\n- `estimated_delivery_date`: https://developers.example.com/webhooks \"the latest ETA\"\n"
           "| tried | result |\n|---|---|\n| search: parcelperform webhook eta | 4 hits |\n\nCONFIDENCE: medium")
    real, seen = fake._plan, []

    def plan(req):
        seen.append(req)
        text = {"explorer": frame, "web-researcher": web}.get(req.agent)
        if req.agent == "investigator":
            text = "RECOMMEND: map the field" if req.step_name.startswith("findings") else "Measured.\nVERDICT: promising"
        return (None, "", text, {}) if text else real(req)
    monkeypatch.setattr(fake, "_plan", plan)
    s = wait(client, start(client, repo, workflow="spike", title="ParcelPerform ETA"))
    assert s["waiting"]["step"] == "decide"
    assert [r.agent for r in seen][:2] == ["explorer", "web-researcher"]
    researcher = next(r for r in seen if r.agent == "web-researcher")
    assert "what is ParcelPerform's ETA field called" in researcher.prompt      # it reads the frame's question and angles
    research = [r for r in seen if r.agent == "investigator" and r.item]
    assert len(research) == 2 and all("https://developers.example.com/webhooks" in r.prompt for r in research)
    findings = next(r for r in seen if r.step_name.startswith("findings"))
    assert "https://developers.example.com/webhooks" in findings.prompt and "VERDICT: promising" in findings.prompt


def test_the_spikes_agents_write_no_spec_and_its_gate_offers_spec_or_drop(client, repo, monkeypatch):
    """The spike's agents (frame, web research, researchers, findings) are not spec writers: they were told to write a
    spec under docs/specs/, and keel read criteria from the frame's answer, so the spike held criteria and a spec file
    of its own before the person chose "spec"."""
    from conftest import start, wait

    real, seen = fake._plan, []

    def plan(req):
        seen.append(req)
        return real(req)
    monkeypatch.setattr(fake, "_plan", plan)
    s = wait(client, start(client, repo, workflow="spike", title="ParcelPerform ETA"))
    assert s["waiting"]["step"] == "decide" and s["waiting"]["choices"] == ["spec", "drop"], s["waiting"]
    assert s["acs"] == [] and not s.get("spec")
    assert [p.name for p in (Path(repo) / "docs" / "specs").glob("*.md")] in ([], ["README.md"])
    assert seen and all("Write the spec under" not in r.prompt and "keel-questions block (max 4" not in r.prompt for r in seen)
