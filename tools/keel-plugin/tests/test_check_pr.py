"""The marketplace's check-pr.yml for a community publisher (docs/plugins/16-steps5-7-contract.md step 7): its steps run
here as GitHub runs them, in a git repo of the marketplace files, with a stand-in gh (the releases) and a stand-in uvx
(this checkout's keel-plugin). A new, unverified publisher's content-only plugin passes and is listed as content; its
code plugin passes and is listed with trust code (raised from what its yml said) and verified false, so keel installs
it only with the rule "allow unverified publishers". A pull request that makes a publisher verified, or changes the
keys of one that is there, gets a warning for the maintainer."""

from __future__ import annotations

import json
import os
import shutil
import stat
import subprocess
import sys

import pytest
from conftest import REPO, write
from test_fetch_releases import FAKE_GH

from keel_plugin import minisign, miniyaml, template
from keel_plugin.package import pack

MARKET = REPO / "docs/plugins/marketplace-repo"
WORKFLOW = MARKET / ".github/workflows/check-pr.yml"
FAKE_UVX = """#!/usr/bin/env bash
# a stand-in for uvx: `uvx --from <spec> keel-plugin <args>` runs this checkout's keel-plugin with the test's Python
set -euo pipefail
[ "$1" = --from ] || { echo "uvx: expected --from" >&2; exit 2; }
echo "$2" >> "$PB_UVX_LOG"
shift 2
[ "$1" = keel-plugin ] || { echo "uvx: expected keel-plugin" >&2; exit 2; }
shift
exec "$PB_PYTHON" -m keel_plugin "$@"
"""

pytestmark = pytest.mark.skipif(not all(shutil.which(t) for t in ("bash", "jq", "git")), reason="needs bash, jq and git")


def git(cwd, *args: str) -> str:
    r = subprocess.run(["git", "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false",
                        *args], cwd=cwd, capture_output=True, text=True, check=True)
    return r.stdout.strip()


def steps() -> tuple[dict, list[dict]]:
    flow = miniyaml.loads(WORKFLOW.read_text())
    return flow["env"], [s for s in flow["jobs"]["check"]["steps"] if "run" in s]


def run_step(step: dict, market, env: dict, base: str) -> subprocess.CompletedProcess:
    """One step's script with bash as GitHub runs it; the ${{ … }} values are the test's."""
    given = {"GH_TOKEN": "test-token", "BASE": base}
    more = {k: (given[k] if "${{" in str(v) else str(v)) for k, v in (step.get("env") or {}).items()}
    return subprocess.run(["bash", "--noprofile", "--norc", "-eo", "pipefail", "-c", step["run"]], cwd=market,
                          env={**env, **more}, capture_output=True, text=True, check=False)


def release(tmp, gh_dir, name: str, key: minisign.SecretKey, parts: tuple[str, ...]) -> None:
    """keel-plugin new, pack and sign: a GitHub release v0.1.0 of ana-k/keel-plugin-<name> in the stand-in gh."""
    src = template.new(name, tmp / f"src-{name}", publisher="ana-k", parts=parts)
    kplug, _, _ = pack(src, gh_dir / f"keel-plugin-{name}" / "v0.1.0")
    kplug.with_name(kplug.name + ".minisig").write_text(minisign.sign(kplug.read_bytes(), key, kplug.name))
    write(gh_dir / f"keel-plugin-{name}.json",
          json.dumps([{"tag_name": "v0.1.0", "draft": False, "published_at": "2026-10-09T09:00:00Z"}]))


@pytest.fixture
def pr(tmp_path):
    """The marketplace as a git repo (base: keel's files with keel's key), and a pull request by ana-k that adds
    herself (not verified), a content-only plugin and a code plugin whose yml says content. Returns
    (market, env, base sha, ana's key)."""
    keel, ana = minisign.SecretKey.generate(), minisign.SecretKey.generate()
    market = tmp_path / "market"
    shutil.copytree(MARKET, market)
    pub = market / "publishers/keel.yml"
    pub.write_text(pub.read_text().replace("keys: []", f"keys: [{keel.public().line()}]"))
    git(market, "init", "-q", "-b", "main")
    git(market, "add", "-A")
    git(market, "commit", "-q", "-m", "the marketplace")
    base = git(market, "rev-parse", "HEAD")
    git(market, "checkout", "-q", "-b", "ana-k")
    write(market / "publishers/ana-k.yml", "\n".join([
        "name: ana-k", "title: Ana K", "verified: false", "contact: https://github.com/ana-k",
        f"keys: [{ana.public().line()}]"]) + "\n")
    write(market / "plugins/ana-notes.yml", "\n".join([
        "name: ana-notes", "title: Ana's notes", "publisher: ana-k", "repo: https://github.com/ana-k/keel-plugin-ana-notes",
        "category: knowledge", "summary: A workflow and an agent that write release notes.", "tags: [notes]",
        "trust: content"]) + "\n")
    write(market / "plugins/ana-tools.yml", "\n".join([
        "name: ana-tools", "title: Ana's tools", "publisher: ana-k", "repo: https://github.com/ana-k/keel-plugin-ana-tools",
        "category: code", "summary: Tools for agents.", "trust: content"]) + "\n")   # says content; it holds code
    git(market, "add", "-A")
    git(market, "commit", "-q", "-m", "ana-k: two plugins")
    gh_dir = tmp_path / "gh"
    release(tmp_path, gh_dir, "ana-notes", ana, template.parts_of("content"))
    release(tmp_path, gh_dir, "ana-tools", ana, template.PARTS)
    bin_dir = tmp_path / "bin"
    for name, text in (("gh", FAKE_GH), ("uvx", FAKE_UVX)):
        exe = write(bin_dir / name, text)
        exe.chmod(exe.stat().st_mode | stat.S_IXUSR)
    flow_env, _ = steps()
    env = {**os.environ, **{k: str(v) for k, v in flow_env.items()},
           "PATH": f"{bin_dir}{os.pathsep}{os.environ['PATH']}", "PB_GH_DIR": str(gh_dir),
           "PB_PYTHON": sys.executable, "PB_UVX_LOG": str(tmp_path / "uvx.log")}
    return market, env, base, ana


def test_a_community_content_plugin_passes_and_its_code_plugin_is_listed_unverified(pr, tmp_path):
    market, env, base, _ana = pr
    _, run_steps = steps()
    assert [s["name"] for s in run_steps] == [
        "The marketplace files are valid", "Lint the newest release of each new or changed plugin",
        "What keel will do with each plugin", "A pull request does not make a publisher verified or change its keys"]
    out = []
    for step in run_steps:
        r = run_step(step, market, env, base)
        assert r.returncode == 0, f"{step['name']}:\n{r.stdout}\n{r.stderr}"
        out.append(r.stdout + r.stderr)
    assert "marketplace: 2 publishers, 14 plugins, 0 revoked, 0 errors" in out[0]
    assert "ana-notes v0.1.0: ana-notes-0.1.0.kplug" in out[1] and "ana-tools v0.1.0: ana-tools-0.1.0.kplug" in out[1]
    assert "trust: content" in out[1] and "trust: code" in out[1] and "error" not in out[1].replace("0 errors", "")
    assert "note     ana-tools: trust raised from content to code" in out[1]
    assert "index: 2 plugins, 2 versions, 0 left out" in out[1]
    index = json.loads((market / "checked/index.json").read_text())
    assert index["publishers"]["ana-k"]["verified"] is False and index["publishers"]["keel"]["verified"] is True
    by = {p["name"]: p for p in index["plugins"]}
    assert sorted(by) == ["ana-notes", "ana-tools"]
    assert (by["ana-notes"]["trust"], by["ana-notes"]["publisher"]) == ("content", "ana-k")
    assert (by["ana-tools"]["trust"], by["ana-tools"]["publisher"]) == ("code", "ana-k")
    assert by["ana-notes"]["versions"][0]["url"] == \
        "https://github.com/ana-k/keel-plugin-ana-notes/releases/download/v0.1.0/ana-notes-0.1.0.kplug"
    assert not (market / "checked/index.json.minisig").exists()      # a pull request never signs
    assert "::notice::ana-notes: trust content, publisher ana-k (community, not verified): keel installs it" in out[2]
    assert ("::notice::ana-tools: trust code, publisher ana-k (community, not verified): listed as unverified; keel "
            "installs it only when a person turns on 'Allow unverified publishers'") in out[2]
    assert "::warning::" not in out[3]
    # keel-plugin came from keel-v2's plugin track, never from the pull request
    assert set((tmp_path / "uvx.log").read_text().split()) == {
        "git+https://github.com/MiladNalbandi/keel-v2@plugin-base#subdirectory=tools/keel-plugin"}


def test_a_release_signed_with_another_key_fails_the_check(pr, tmp_path):
    market, env, base, _ana = pr
    gh_dir = tmp_path / "gh"
    shutil.rmtree(gh_dir / "keel-plugin-ana-notes")
    release(tmp_path / "again", gh_dir, "ana-notes", minisign.SecretKey.generate(), template.parts_of("content"))
    _, run_steps = steps()
    r = run_step(run_steps[1], market, env, base)
    assert r.returncode == 1
    assert "ana-notes-0.1.0.kplug left out: the file was signed with key" in r.stdout


def test_making_a_publisher_verified_or_changing_its_keys_is_a_warning(pr):
    market, env, base, ana = pr
    _, run_steps = steps()
    last = run_steps[-1]
    f = market / "publishers/ana-k.yml"
    f.write_text(f.read_text().replace("verified: false", "verified: true"))
    other = minisign.SecretKey.generate().public().line()
    k = market / "publishers/keel.yml"
    k.write_text("\n".join(f"keys: [{other}]" if line.startswith("keys:") else line
                           for line in k.read_text().splitlines()) + "\n")
    git(market, "commit", "-q", "-am", "ana-k: verified, and keel's key")
    r = run_step(last, market, env, base)
    assert r.returncode == 0, r.stderr
    assert ("::warning::publishers/ana-k.yml sets verified: true. Only a maintainer does this, after the review in "
            "keel's docs/plugins/17-publish-your-plugin.md") in r.stdout
    assert "::warning::publishers/keel.yml changes the keys of an existing publisher" in r.stdout
    assert "ana-k.yml changes the keys" not in r.stdout                 # a new publisher brings its first keys
    assert ana.public().line() in f.read_text()
