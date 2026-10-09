"""Step 5 (docs/plugins/16-steps5-7-contract.md): a plugin in its own repo, and keel-v2 reading released plugins from
plugins.lock. Without the network: a stand-in gh, a local HTTP server, local git repos.

  scripts/plugin_versions.py        versions, ranges and requires.plugins, as keel's resolver reads them
  scripts/build-plugin-repo.sh      the plugin repos' CI build (here only for plugins that need no Gradle or npm)
  docs/plugins/tools/split-plugin.sh a plugin's own repo with its history, the workflows and keel.ref
  scripts/fetch-locked-plugins.sh   the Dockerfile's PLUGINS=lock: the lock's format, sha256, signature, lint, layout
  scripts/update-plugins-lock.sh    the lock's lines from the newest releases
  docs/plugins/plugin-repo/, template-repo/   the files the repos get
"""

from __future__ import annotations

import functools
import hashlib
import importlib.util
import json
import os
import re
import shutil
import stat
import subprocess
import sys
import threading
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import pytest
from conftest import REPO, TOOL, set_manifest, write

from keel_plugin import minisign, miniyaml, template
from keel_plugin.package import pack

pytestmark = pytest.mark.skipif(not (shutil.which("bash") and shutil.which("git")), reason="needs bash and git")

KEELBOT = "Co-Authored-By: KeelBot <keel.dev.bot@gmail.com>"
GIT_ENV = {"GIT_AUTHOR_NAME": "t", "GIT_AUTHOR_EMAIL": "t@localhost", "GIT_COMMITTER_NAME": "t",
           "GIT_COMMITTER_EMAIL": "t@localhost", "GIT_CONFIG_NOSYSTEM": "1"}


def _versions():
    spec = importlib.util.spec_from_file_location("plugin_versions", REPO / "scripts/plugin_versions.py")
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


versions = _versions()


def sh(*args, cwd=None, env=None, check=True) -> subprocess.CompletedProcess:
    r = subprocess.run([str(a) for a in args], cwd=cwd, env={**os.environ, **GIT_ENV, **(env or {})},
                       capture_output=True, text=True, check=False)
    if check and r.returncode != 0:
        raise AssertionError(f"{args} failed ({r.returncode}):\n{r.stdout}\n{r.stderr}")
    return r


def git(repo: Path, *args, check=True) -> str:
    return sh("git", "-C", repo, *args, check=check).stdout.strip()


@pytest.fixture
def kp(tmp_path) -> Path:
    """A keel-plugin command that runs this tool (the scripts take it from KEEL_PLUGIN)."""
    f = write(tmp_path / "bin" / "keel-plugin",
              f'#!/bin/sh\nPYTHONPATH="{TOOL}" exec "{sys.executable}" -m keel_plugin "$@"\n')
    f.chmod(f.stat().st_mode | stat.S_IXUSR)
    return f


def content_only(where: Path, name: str, version: str = "1.0.0", needs: str = "") -> Path:
    """A plugin with only a content folder (no engine, api or web part)."""
    root = template.new(name, where, publisher="keel")
    package = "keel_plugin_" + name.replace("-", "_")
    set_manifest(root, f"  engine: {{ path: engine, package: {package} }}\n  web: {{ entry: web/index.js }}\n", "")
    set_manifest(root, "version: 0.1.0", f"version: {version}")
    if needs:
        set_manifest(root, '  # plugins: { code: ">=1.0.0" }   # other plugins it needs (on one line)',
                     f"  plugins: {{ {needs} }}")
    shutil.rmtree(root / "engine")
    shutil.rmtree(root / "web")
    write(root / "content" / "workflows" / f"{name}-hello.yaml", "name: hello\n")
    return root


def files_of(folder: Path) -> dict[str, bytes]:
    return {p.relative_to(folder).as_posix(): p.read_bytes() for p in sorted(folder.rglob("*")) if p.is_file()}


# ---------------------------------------------------------------- plugin_versions.py


@pytest.mark.parametrize(("version", "spec", "ok"), [
    ("1.2.0", ">=1.0.0", True), ("1.2.0", ">=1.0.0,<2.0.0", True), ("2.0.0", ">=1.0.0,<2.0.0", False),
    ("1.0.0-beta.1", ">=1.0.0", True),          # the release numbers only, as keel's resolver compares
    ("0.9.9", ">=1.0.0", False), ("1.0.0", "", True), ("1.0.0", "==1.0.0", True), ("1.0.0", "~1.0", False),
])
def test_fits_like_keels_resolver(version, spec, ok):
    assert versions.fits(version, spec) is ok


def test_pick_prefers_the_newest_release_and_a_pre_release_only_without_one():
    assert versions.pick(">=1.0.0,<2.0.0", ["1.0.0", "1.2.0", "2.0.0", "1.3.0-beta.1", "x"]) == "1.2.0"
    assert versions.pick("", ["0.1.0-beta.2", "0.1.0-beta.10"]) == "0.1.0-beta.10"
    assert versions.pick(">=3.0.0", ["1.0.0"]) is None


def test_needs_reads_the_one_line_mapping_and_refuses_the_block_form():
    text = (REPO / "plugins/jira/keel-plugin.yml").read_text()
    assert versions.needs(text) == [("tasks", ">=1.0.0")]
    assert versions.needs((REPO / "product/keel-plugin.yml").read_text()) == [("tasks", ">=1.0.0"), ("jira", ">=1.0.0")]
    assert versions.needs((REPO / "plugins/wiki/keel-plugin.yml").read_text()) == []
    with pytest.raises(ValueError, match="one line"):
        versions.needs("requires:\n  sdk: 1\n  plugins:\n    tasks: '>=1'\n")


def test_the_cli_answers_with_exit_codes():
    py = [sys.executable, str(REPO / "scripts/plugin_versions.py")]
    assert subprocess.run([*py, "fits", "1.0.0", ">=1.0.0"]).returncode == 0
    assert subprocess.run([*py, "fits", "0.1.0", ">=1.0.0"]).returncode == 1
    r = subprocess.run([*py, "pick", ">=1.0.0", "1.0.0", "1.1.0"], capture_output=True, text=True)
    assert r.returncode == 0 and r.stdout == "1.1.0\n"
    r = subprocess.run([*py, "needs", str(REPO / "plugins/jira/keel-plugin.yml")], capture_output=True, text=True)
    assert r.stdout == "tasks\t>=1.0.0\n"


# ---------------------------------------------------------------- build-plugin-repo.sh


@pytest.fixture
def keel(tmp_path) -> Path:
    """A throw-away 'keel checkout' with what build-plugin-repo.sh uses: its scripts and two plugins of its own."""
    root = tmp_path / "keel"
    for f in ("build-plugin.sh", "build-plugin-repo.sh", "plugin_versions.py", "test-plugins.sh"):
        write(root / "scripts" / f, (REPO / "scripts" / f).read_text())
    content_only(root / "plugins", "base", "1.0.0")
    content_only(root / "plugins", "other", "1.0.0")
    return root


def build(keel: Path, plugin: Path, out: Path, kp: Path, *extra, repos: Path | None = None):
    env = {"KEEL_PLUGIN": str(kp), "KEEL_PLUGIN_REPOS": str(repos or keel / "no-repos")}
    return sh("bash", keel / "scripts/build-plugin-repo.sh", plugin, out, *extra, env=env, check=False)


def test_build_refuses_without_throwaway(keel, tmp_path, kp):
    plugin = content_only(tmp_path / "src", "solo")
    r = build(keel, plugin, tmp_path / "dist", kp)
    assert r.returncode == 1 and "--throwaway" in r.stderr
    assert (keel / "plugins/base").is_dir() and not (keel / "plugins/solo").exists()


def test_build_a_content_only_plugin(keel, tmp_path, kp, run):
    plugin = content_only(tmp_path / "src", "solo", "1.2.0")
    (plugin / ".github").mkdir()
    write(plugin / "keel.ref", "0" * 40 + "\n")
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 0, r.stdout + r.stderr
    kplug = tmp_path / "dist/solo-1.2.0.kplug"
    assert f"built: {kplug} sha256:{hashlib.sha256(kplug.read_bytes()).hexdigest()}" in r.stdout
    assert run("lint", kplug)[0] == 0
    # the plugin is in keel's tree (without its repo files), next to keel's own plugins
    assert sorted(p.name for p in (keel / "plugins").iterdir()) == ["base", "other", "solo"]
    assert not (keel / "plugins/solo/keel.ref").exists() and not (keel / "plugins/solo/.github").exists()
    assert "== api" not in r.stdout and "== web" not in r.stdout and "== engine" not in r.stdout


def test_build_the_template_plugin_engine_and_a_ready_web_part(keel, tmp_path, kp):
    plugin = template.new("example", tmp_path / "src", publisher="you")
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "engine: no engine/tests to run" in r.stdout
    assert "web: web/index.js is packed as it is" in r.stdout
    out = tmp_path / "unpacked"
    out.mkdir()
    sh("tar", "-xzf", tmp_path / "dist/example-0.1.0.kplug", "-C", out)
    assert (out / "web/index.js").read_text() == (plugin / "web/index.js").read_text()
    assert (out / "engine/keel_plugin_example/__init__.py").is_file()


def test_build_takes_a_needed_plugin_from_keel_when_its_repo_has_no_release(keel, tmp_path, kp):
    plugin = content_only(tmp_path / "src", "needer", needs='base: ">=1.0.0,<2.0.0"')
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 0, r.stdout + r.stderr
    assert "base 1.0.0: keel-v2's plugins/base (no tag of keel-plugin-base fits >=1.0.0,<2.0.0)" in r.stdout
    assert sorted(p.name for p in (keel / "plugins").iterdir()) == ["base", "needer", "other"]


def test_build_takes_a_needed_plugin_from_its_repo_at_the_newest_tag_that_fits(keel, tmp_path, kp):
    repos = tmp_path / "repos"
    repo = repos / "keel-plugin-base"
    content_only(tmp_path / "base-src", "base")
    shutil.copytree(tmp_path / "base-src/base", repo)
    git(repo, "init", "-q", "-b", "main")
    for v in ("1.0.0", "1.2.0", "2.0.0"):
        text = (repo / "keel-plugin.yml").read_text()
        (repo / "keel-plugin.yml").write_text(re.sub(r"^version: .*$", f"version: {v}", text, flags=re.M))
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"base {v}")
        git(repo, "tag", f"v{v}")
    git(repo, "tag", "v1.5.0", "v1.2.0")       # a wrong tag (its release was refused): passed over
    plugin = content_only(tmp_path / "src", "needer", needs='base: ">=1.0.0,<2.0.0"')
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway", repos=repos)
    assert r.returncode == 0, r.stdout + r.stderr
    assert "the tag v1.5.0 of" in r.stderr and "holds base/1.2.0, not base 1.5.0: passed over" in r.stderr
    assert "base 1.2.0: its repo keel-plugin-base at v1.2.0" in r.stdout
    assert "version: 1.2.0" in (keel / "plugins/base/keel-plugin.yml").read_text()
    assert not (keel / "plugins/base/.git").exists()


def test_build_stops_when_a_needed_plugin_is_nowhere(keel, tmp_path, kp):
    plugin = content_only(tmp_path / "src", "needer", needs='missing: ">=1.0.0"')
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 1
    assert "missing >=1.0.0 is needed, but" in r.stderr and "keel-v2 has no plugins/missing" in r.stderr
    plugin = content_only(tmp_path / "src2", "needer2", needs='base: ">=2.0.0"')
    r = build(keel, plugin, tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 1 and "base >=2.0.0 is needed, and keel-v2's plugins/base is 1.0.0" in r.stderr


def test_build_refuses_a_plugin_folder_inside_keel(keel, kp, tmp_path):
    r = build(keel, keel / "plugins/base", tmp_path / "dist", kp, "--throwaway")
    assert r.returncode == 1 and "inside the keel checkout" in r.stderr


# ---------------------------------------------------------------- split-plugin.sh

needs_subtree = pytest.mark.skipif(
    "subtree split" not in subprocess.run(["git", "subtree", "-h"], capture_output=True, text=True).stdout
    + subprocess.run(["git", "subtree", "-h"], capture_output=True, text=True).stderr,
    reason="git subtree is not installed")


@pytest.fixture
def source(tmp_path) -> Path:
    """A small keel-v2 with history: plugins/hello in two commits, a commit elsewhere, the repo files of step 5."""
    root = tmp_path / "keel-v2"
    root.mkdir()
    git(root, "init", "-q", "-b", "plugin-base")
    shutil.copytree(REPO / "docs/plugins/plugin-repo", root / "docs/plugins/plugin-repo")
    shutil.copytree(REPO / "docs/plugins/template-repo", root / "docs/plugins/template-repo")
    write(root / "docs/plugins/tools/split-plugin.sh", (REPO / "docs/plugins/tools/split-plugin.sh").read_text())
    shutil.copy(REPO / "LICENSE", root / "LICENSE")
    write(root / "README.md", "keel\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "keel")
    hello = template.new("hello", root / "plugins", publisher="keel")
    (hello / "README.md").unlink()        # like keel's plugins: the repo gets plugin-repo/'s README
    set_manifest(hello, '  # plugins: { code: ">=1.0.0" }   # other plugins it needs (on one line)',
                 '  plugins: { base: ">=1.0.0,<2.0.0" }')
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "hello 0.1.0")
    write(root / "README.md", "keel, changed\n")
    git(root, "commit", "-q", "-am", "not about hello")
    set_manifest(hello, "version: 0.1.0", "version: 1.0.0")
    git(root, "commit", "-q", "-am", "hello 1.0.0")
    return root


def split(source: Path, *args) -> subprocess.CompletedProcess:
    return sh("bash", source / "docs/plugins/tools/split-plugin.sh", *args, "--root", source, check=False)


@needs_subtree
def test_split_makes_a_repo_with_the_plugins_history_and_the_repo_files(source, tmp_path):
    out = tmp_path / "keel-plugin-hello"
    r = split(source, "hello", out, "--push")
    assert r.returncode == 0, r.stderr
    head = git(source, "rev-parse", "HEAD")
    log = git(out, "log", "--format=%s").splitlines()
    assert log == [f"Hello: its own repo, built against keel-v2 {head[:12]}", "hello 1.0.0", "hello 0.1.0"]
    assert git(out, "log", "-1", "--format=%B").strip().endswith(KEELBOT)
    assert git(out, "status", "--porcelain") == "" and git(out, "branch", "--show-current") == "main"
    assert (out / "keel-plugin.yml").is_file() and (out / "engine/keel_plugin_hello/__init__.py").is_file()
    for wf in ("ci.yml", "release.yml"):
        assert (out / ".github/workflows" / wf).read_bytes() == \
            (REPO / "docs/plugins/plugin-repo/.github/workflows" / wf).read_bytes()
    ref_lines = (out / "keel.ref").read_text().splitlines()
    assert ref_lines[-1] == head and all(line.startswith("#") for line in ref_lines[:-1])
    assert not (out / "README.md").exists()      # the repo page is .github/README.md: never in the package
    readme = (out / ".github/README.md").read_text()
    assert "@" + "TITLE@" not in readme and "# keel plugin: Hello" in readme and "`base`" in readme
    assert "2.0.0" not in readme and "| parts   | engine · web · content" in readme
    assert f"`{head[:12]}`" in readme
    assert (out / "LICENSE").read_text() == (REPO / "LICENSE").read_text()
    # never pushed: no remote; --push prints the commands
    assert git(out, "remote") == ""
    assert "nothing was pushed." in r.stdout
    assert f'git -C "{out}" push --force -u origin main' in r.stdout
    assert "https://github.com/keel-studio/keel-plugin-hello.git" in r.stdout


@needs_subtree
def test_split_refuses_what_it_cannot_do_well(source, tmp_path):
    r = split(source, "nope", tmp_path / "a")
    assert r.returncode == 1 and "there is no plugins/nope/keel-plugin.yml" in r.stderr
    write(tmp_path / "full/x", "x")
    r = split(source, "hello", tmp_path / "full")
    assert r.returncode == 1 and "not empty" in r.stderr
    write(source / "plugins/hello/README.md", "changed\n")
    r = split(source, "hello", tmp_path / "b")
    assert r.returncode == 1 and "not committed" in r.stderr
    assert not (tmp_path / "b").exists()
    r = split(source, "Bad", tmp_path / "c")
    assert r.returncode == 1 and "not a plugin name" in r.stderr


def test_split_template_makes_the_template_repo(source, tmp_path):
    out = tmp_path / "keel-plugin-template"
    r = split(source, "--template", out, "--push")
    assert r.returncode == 0, r.stderr
    head = git(source, "rev-parse", "HEAD")
    assert (out / "keel.ref").read_text().splitlines()[-1] == head
    assert files_of(out / ".github") == files_of(REPO / "docs/plugins/template-repo/.github")
    assert (out / "README.md").read_text() == (REPO / "docs/plugins/template-repo/README.md").read_text()
    assert git(out, "log", "--format=%s").splitlines() == [f"The keel plugin template, built against keel-v2 {head[:12]}"]
    assert "gh repo edit keel-studio/keel-plugin-template --template" in r.stdout


# ---------------------------------------------------------------- the repo files


def test_the_template_is_what_keel_plugin_new_makes(tmp_path):
    made = files_of(template.new("example", tmp_path, publisher="you"))
    have = files_of(REPO / "docs/plugins/template-repo")
    made.pop("README.md")
    extra = {k for k in have if k not in made}
    assert extra == {"README.md", "keel.ref", ".github/workflows/ci.yml", ".github/workflows/release.yml"}
    assert {k: have[k] for k in made} == made, \
        "docs/plugins/template-repo is not what `keel-plugin new example` makes: make it again (README.md, keel.ref " \
        "and .github stay)"


def test_the_workflows_build_with_keels_script_and_sign_with_the_right_key():
    plugin_repo = REPO / "docs/plugins/plugin-repo/.github/workflows"
    template_repo = REPO / "docs/plugins/template-repo/.github/workflows"
    assert (plugin_repo / "ci.yml").read_text() == (template_repo / "ci.yml").read_text()
    for folder in (plugin_repo, template_repo):
        for wf in ("ci.yml", "release.yml"):
            text = (folder / wf).read_text()
            data = miniyaml.loads(text)
            steps = next(iter(data["jobs"].values()))["steps"]
            runs = [s.get("run", "") for s in steps]
            assert "bash keel/scripts/build-plugin-repo.sh plugin dist --throwaway" in runs
            assert any(s.get("with", {}).get("repository") == "MiladNalbandi/keel-v2" for s in steps)
            assert all(s["with"].get("persist-credentials") is False for s in steps if s.get("uses", "").startswith("actions/checkout"))
            assert not any("${{" in r for r in runs), "expressions go into env:, never into a script"
    first = (plugin_repo / "release.yml").read_text()
    other = (template_repo / "release.yml").read_text()
    assert "secrets.KEEL_PUBLISHER_KEY" in first and "PUBLISHER_KEY: ${{ secrets.PUBLISHER_KEY }}" not in first
    assert "secrets.PUBLISHER_KEY" in other and "KEEL_PUBLISHER_KEY" not in other
    assert "keel/content/trust/keel.pub" in first and "plugin/.github/publisher.pub" in other


def test_the_keel_ref_templates_are_not_set():
    for f in ("plugin-repo/keel.ref", "template-repo/keel.ref"):
        lines = (REPO / "docs/plugins" / f).read_text().splitlines()
        assert lines[-1] == "0" * 40 and all(line.startswith("#") for line in lines[:-1])


# ---------------------------------------------------------------- plugins.lock and fetch-locked-plugins.sh

FETCH = REPO / "scripts/fetch-locked-plugins.sh"


def fetch(*args, env=None) -> subprocess.CompletedProcess:
    return sh("bash", FETCH, *args, env=env, check=False)


def test_the_repos_lock_has_the_right_format():
    r = fetch("--check", REPO / "plugins.lock")
    assert r.returncode == 0, r.stderr
    assert "plugins locked" in r.stdout


def test_check_names_every_bad_line(tmp_path):
    sha = "sha256:" + "a" * 64
    lock = write(tmp_path / "plugins.lock", "\n".join([
        "# a comment",
        f"wiki 1.0.0 https://example.com/wiki-1.0.0.kplug {sha}",
        f"Wiki 1.0.0 https://example.com/w.kplug {sha}",
        f"jira one https://example.com/j.kplug {sha}",
        f"tasks 1.0.0 http://example.com/t.kplug {sha}",
        f"db 1.0.0 https://example.com/d.kplug sha256:{'A' * 64}",
        "map 1.0.0 https://example.com/m.kplug",
        f"wiki 1.0.1 https://example.com/wiki-1.0.1.kplug {sha}",
        f"ci 1.0.0 ftp://example.com/c.kplug {sha} extra",
    ]) + "\n")
    r = fetch("--check", lock)
    assert r.returncode == 1
    for why in ("'Wiki' is not a plugin name", "'one' is not a version", "it must be https://",
                "is not sha256: and 64 lowercase hex", "write four fields", "wiki is locked twice"):
        assert why in r.stderr, why
    assert f"{lock}:2" not in r.stderr and f"{lock}:3: 'Wiki'" in r.stderr


class Server:
    """A folder served on 127.0.0.1 (a free port) by python's http.server, in a thread."""

    def __init__(self, folder: Path):
        handler = functools.partial(SimpleHTTPRequestHandler, directory=str(folder))
        handler.log_message = lambda *a, **k: None
        self.httpd = ThreadingHTTPServer(("127.0.0.1", 0), handler)
        self.base = f"http://127.0.0.1:{self.httpd.server_address[1]}"
        threading.Thread(target=self.httpd.serve_forever, daemon=True).start()

    def close(self) -> None:
        self.httpd.shutdown()
        self.httpd.server_close()


@pytest.fixture
def released(tmp_path):
    """Two signed releases served over http: base 1.0.0 (content) and top 1.0.0 (engine, web, content; needs base)."""
    key, other = minisign.SecretKey.generate(), minisign.SecretKey.generate()
    www = tmp_path / "www"
    plugins = {}
    for name, needs in (("base", ""), ("top", 'base: ">=1.0.0"')):
        if name == "base":
            src = content_only(tmp_path / "src", name)
        else:
            src = template.new(name, tmp_path / "src", publisher="keel")
            set_manifest(src, "version: 0.1.0", "version: 1.0.0")
            set_manifest(src, '  # plugins: { code: ">=1.0.0" }   # other plugins it needs (on one line)',
                         f"  plugins: {{ {needs} }}")
        kplug, _, _ = pack(src, www / name)
        kplug.with_name(kplug.name + ".minisig").write_text(minisign.sign(kplug.read_bytes(), key, kplug.name))
        plugins[name] = (src, kplug)
    pub = write(tmp_path / "keel.pub", key.public().pub_file())
    server = Server(www)
    yield {"plugins": plugins, "key": key, "other": other, "pub": pub, "server": server, "tmp": tmp_path}
    server.close()


def lock_for(w, *names, sums=None) -> Path:
    lines = ["# test lock"]
    for n in names:
        kplug = w["plugins"][n][1]
        sha = (sums or {}).get(n) or hashlib.sha256(kplug.read_bytes()).hexdigest()
        lines.append(f"{n} 1.0.0 {w['server'].base}/{n}/{kplug.name} sha256:{sha}")
    return write(w["tmp"] / "plugins.lock", "\n".join(lines) + "\n")


def fetch_lock(w, lock, out, kp, *extra, http="1"):
    return fetch(lock, out, "--pub", w["pub"], *extra, env={"KEEL_PLUGIN": str(kp), "PLUGINS_LOCK_ALLOW_HTTP": http})


def test_fetch_puts_each_locked_plugin_where_build_plugin_sh_would(released, kp, tmp_path):
    w = released
    out = tmp_path / "out"
    r = fetch_lock(w, lock_for(w, "base", "top"), out, kp)
    assert r.returncode == 0, r.stderr
    assert "base 1.0.0: sha256 ok, signature ok, lint ok" in r.stdout
    assert "2 plugins into" in r.stdout
    assert sorted(p.relative_to(out).as_posix() for p in out.glob("*/*")) == ["base/1.0.0", "top/1.0.0"]
    # the same files as scripts/build-plugin.sh lays out for the same plugin (its folder, files.sha256 inside)
    src = w["plugins"]["top"][0]
    stage = tmp_path / "stage"
    sh("bash", REPO / "scripts/build-plugin.sh", src, stage, "--no-build", env={"KEEL_PLUGIN_WEB_DIST": str(src / "web")})
    assert files_of(out / "top/1.0.0") == files_of(stage / "top/1.0.0")


def test_fetch_refuses_a_wrong_sha256(released, kp, tmp_path):
    w = released
    r = fetch_lock(w, lock_for(w, "base", sums={"base": "b" * 64}), tmp_path / "out", kp)
    assert r.returncode == 1
    assert "base 1.0.0: the sha256 of" in r.stderr and "not the lock's " + "b" * 64 in r.stderr
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


def test_fetch_refuses_a_bad_signature(released, kp, tmp_path):
    w = released
    kplug = w["plugins"]["base"][1]
    sig = kplug.with_name(kplug.name + ".minisig")
    sig.write_text(minisign.sign(kplug.read_bytes(), w["other"], kplug.name))      # signed by another key
    r = fetch_lock(w, lock_for(w, "base"), tmp_path / "out", kp)
    assert r.returncode == 1 and "base 1.0.0: the signature does not verify with the publisher's key" in r.stderr
    lines = minisign.sign(kplug.read_bytes(), w["key"], kplug.name).splitlines()
    g = lines[3]
    lines[3] = g[:10] + ("A" if g[10] != "A" else "B") + g[11:]                       # a wrong global signature
    sig.write_text("\n".join(lines) + "\n")
    r = fetch_lock(w, lock_for(w, "base"), tmp_path / "out", kp)
    assert r.returncode == 1 and "the signature does not verify" in r.stderr
    assert not (tmp_path / "out").exists() or not any((tmp_path / "out").iterdir())


def test_fetch_refuses_without_the_key_and_over_http_without_the_test_flag(released, kp, tmp_path):
    w = released
    lock = lock_for(w, "base")
    r = fetch(lock, tmp_path / "out", "--pub", tmp_path / "content/trust/keel.pub",
              env={"KEEL_PLUGIN": str(kp), "PLUGINS_LOCK_ALLOW_HTTP": "1"})
    assert r.returncode == 1
    assert "content/trust/keel.pub is missing" in r.stderr and "PLUGINS=source" in r.stderr
    r = fetch_lock(w, lock, tmp_path / "out", kp, http="0")
    assert r.returncode == 1 and "it must be https://" in r.stderr


def test_fetch_refuses_a_lock_that_misses_a_needed_plugin_and_an_empty_lock(released, kp, tmp_path):
    w = released
    r = fetch_lock(w, lock_for(w, "top"), tmp_path / "out", kp)
    assert r.returncode == 1 and "top 1.0.0 needs base >=1.0.0, which plugins.lock does not lock" in r.stderr
    r = fetch_lock(w, lock_for(w, "base", "top"), tmp_path / "out", kp, "--skip", "base")
    assert r.returncode == 1 and "needs base" in r.stderr
    r = fetch(REPO / "plugins.lock", tmp_path / "out", "--pub", w["pub"], env={"KEEL_PLUGIN": str(kp)})
    assert r.returncode == 1 and "locks no plugin" in r.stderr and "PLUGINS=source" in r.stderr


def test_fetch_refuses_a_package_whose_manifest_is_not_the_lock_line(released, kp, tmp_path):
    w = released
    lock = lock_for(w, "base")
    lock.write_text(lock.read_text().replace("base 1.0.0 ", "base 1.0.1 "))
    r = fetch_lock(w, lock, tmp_path / "out", kp)
    assert r.returncode == 1 and "the package's manifest is base 1.0.0, not the lock's" in r.stderr


# ---------------------------------------------------------------- update-plugins-lock.sh

FAKE_GH = """#!/usr/bin/env bash
# a stand-in for gh: `api repos/<owner>/<repo>/releases… --jq Q` runs Q over $PB_GH_DIR/<repo>.json;
# `release download <tag> --repo <owner>/<repo> --dir D --pattern P …` copies $PB_GH_DIR/<repo>/<tag>/P to D
set -euo pipefail
echo "$*" >> "$PB_GH_DIR/calls.log"
if [ "$1" = api ]; then
  repo="${2#repos/*/}"; repo="${repo%%/*}"
  [ -f "$PB_GH_DIR/$repo.json" ] || { echo "HTTP 404: Not Found" >&2; exit 1; }
  jq -r "$4" "$PB_GH_DIR/$repo.json"
elif [ "$1 $2" = "release download" ]; then
  tag="$3"; shift 3
  while [ $# -gt 0 ]; do
    case "$1" in --repo) repo="${2#*/}"; shift ;; --dir) dir="$2"; shift ;; --pattern) pats+=("$2"); shift ;; esac
    shift
  done
  for p in "${pats[@]}"; do cp "$PB_GH_DIR/$repo/$tag/$p" "$dir/" 2> /dev/null || true; done
else
  exit 3
fi
"""


@pytest.fixture
def lockroot(tmp_path, kp):
    """A keel-v2 root (plugins/a, plugins/b, product, a lock with a header) and a stand-in gh with releases."""
    if not shutil.which("jq"):
        pytest.skip("needs jq")
    key, other = minisign.SecretKey.generate(), minisign.SecretKey.generate()
    root = tmp_path / "keel-v2"
    for n in ("a", "b"):
        write(root / "plugins" / n / "keel-plugin.yml", f"name: {n}\n")
    write(root / "product/keel-plugin.yml", "name: product\n")
    write(root / "content/trust/keel.pub", key.public().pub_file())
    write(root / "plugins.lock", "# the header\n#   stays\n\nold 0.9.0 https://example.com/old-0.9.0.kplug sha256:"
          + "c" * 64 + "\n")
    gh_dir = tmp_path / "gh"

    def release(name: str, version: str, signer, draft=False):
        src = content_only(tmp_path / "src" / f"{name}-{version}", name, version)
        kplug, _, _ = pack(src, gh_dir / f"keel-plugin-{name}" / f"v{version}")
        kplug.with_name(kplug.name + ".minisig").write_text(minisign.sign(kplug.read_bytes(), signer, kplug.name))
        return {"tag_name": f"v{version}", "draft": draft, "prerelease": "-" in version}

    write(gh_dir / "keel-plugin-a.json", json.dumps([release("a", "2.0.0", key, draft=True),
                                                     release("a", "1.1.0", key), release("a", "1.0.0", key)]))
    write(gh_dir / "keel-plugin-b.json", json.dumps([release("b", "0.1.0-beta.10", key),
                                                     release("b", "0.1.0-beta.2", key)]))
    write(gh_dir / "keel-plugin-bad.json", json.dumps([release("bad", "1.0.0", other)]))
    gh = write(tmp_path / "bin/gh", FAKE_GH)
    gh.chmod(gh.stat().st_mode | stat.S_IXUSR)
    env = {"PATH": f"{tmp_path / 'bin'}{os.pathsep}{os.environ['PATH']}", "PB_GH_DIR": str(gh_dir),
           "KEEL_PLUGIN": str(kp)}
    return root, gh_dir, env


def update(root, env, *names):
    return sh("bash", REPO / "scripts/update-plugins-lock.sh", *names, "--root", root, env=env, check=False)


def test_update_writes_the_newest_release_of_each_plugin(lockroot, kp):
    root, gh_dir, env = lockroot
    r = update(root, env)
    assert r.returncode == 0, r.stderr
    a = gh_dir / "keel-plugin-a/v1.1.0/a-1.1.0.kplug"
    b = gh_dir / "keel-plugin-b/v0.1.0-beta.10/b-0.1.0-beta.10.kplug"
    url = "https://github.com/keel-studio/keel-plugin-{0}/releases/download/v{1}/{0}-{1}.kplug"
    assert (root / "plugins.lock").read_text() == (
        "# the header\n#   stays\n\n"
        f"a 1.1.0 {url.format('a', '1.1.0')} sha256:{hashlib.sha256(a.read_bytes()).hexdigest()}\n"
        f"b 0.1.0-beta.10 {url.format('b', '0.1.0-beta.10')} sha256:{hashlib.sha256(b.read_bytes()).hexdigest()}\n"
        f"old 0.9.0 https://example.com/old-0.9.0.kplug sha256:{'c' * 64}\n")
    assert "a: 1.1.0" in r.stdout and "product: the releases of keel-studio/keel-plugin-product cannot be read" in r.stdout
    assert "old: the releases of keel-studio/keel-plugin-old cannot be read" in r.stdout
    assert fetch("--check", root / "plugins.lock").returncode == 0
    again = update(root, env, "a")
    assert again.returncode == 0 and "a: 1.1.0 (no change)" in again.stdout


def test_update_never_locks_a_file_with_a_bad_signature(lockroot):
    root, _, env = lockroot
    before = (root / "plugins.lock").read_text()
    r = update(root, env, "bad")
    assert r.returncode == 1 and "bad 1.0.0: the signature does not verify" in r.stderr
    assert (root / "plugins.lock").read_text() == before


def test_update_needs_keels_public_key(lockroot):
    root, _, env = lockroot
    (root / "content/trust/keel.pub").unlink()
    r = update(root, env, "a")
    assert r.returncode == 1 and "content/trust/keel.pub" in r.stderr and "setup-signing-keys.sh" in r.stderr


# ---------------------------------------------------------------- the scripts are valid bash


@pytest.mark.parametrize("script", ["scripts/build-plugin-repo.sh", "scripts/fetch-locked-plugins.sh",
                                    "scripts/update-plugins-lock.sh", "docs/plugins/tools/split-plugin.sh"])
def test_scripts_parse(script):
    assert subprocess.run(["bash", "-n", str(REPO / script)]).returncode == 0
