"""Gate details are Markdown documents: a ## heading per part, code in code format, and every diff, JSON or log in a
fenced block (runtime/md.py and the gate builders that use it)."""

from keel_engine.runtime import md
from keel_engine.runtime.flow_actions import ac_evidence


def test_code_and_fence_keep_code_out_of_markdown():
    assert md.code("eta_updated_at") == "`eta_updated_at`" and md.code("a`b") == "``a`b``"
    body = "- removed line\n+ added_line\n```\nnested\n```"
    f = md.fence(body, "diff")
    assert f.startswith("````diff\n") and f.endswith("\n````"), "a longer fence than the one inside"
    assert md.fence("{}", "json") == "```json\n{}\n```"
    assert md.safe_words("send eta_updated_at now") == "send `eta_updated_at` now"
    assert md.table(["a", "b"], [["x|y", "z"]]) == "| a | b |\n|---|---|\n| x\\|y | z |"
    assert md.verdict("safe for a rolling deploy") == "**Verdict: safe for a rolling deploy.**"


def test_cut_closes_an_open_fence_and_unfence_drops_the_fence_lines():
    text = md.doc(md.section("Diff", md.fence("\n".join(f"+line {i}" for i in range(500)), "diff")))
    out = md.cut(text, 400)
    assert out.count("```") == 2 and out.endswith("(cut; see the repository for the rest)")
    assert md.unfence("## Diff\n\n```diff\n+a\n```") == "## Diff\n\n+a"


def test_diff_blocks_label_each_file_and_fence_it():
    diff = ("diff --git a/x_y.json b/x_y.json\n--- a/x_y.json\n+++ b/x_y.json\n@@ -1 +1,2 @@\n-a\n+b\n+c\n"
            "diff --git a/b.kt b/b.kt\n--- a/b.kt\n+++ b/b.kt\n@@ -1 +1 @@\n-x\n+y\n")
    blocks = md.diff_blocks(diff)
    assert len(blocks) == 2 and blocks[0].startswith("`x_y.json` (+2 / -1)\n\n```diff\ndiff --git")
    assert md.new_file_block("n_e_w.md", "one\ntwo").startswith("new file `n_e_w.md` (+2 lines)\n\n```diff\n+one\n+two")


def test_demote_moves_agent_headings_under_the_gate_parts_but_not_inside_fences():
    assert md.demote("# Plan\n```\n# not a heading\n```\n## Risks") == "### Plan\n```\n# not a heading\n```\n#### Risks"


def test_the_ac_gate_evidence_has_sections_and_code(tmp_path):
    from test_v02 import commit_all, git, write
    root = tmp_path / "p"
    root.mkdir()
    git(root, "init", "-q", "-b", "main")
    write(root, "README.md", "x\n")
    commit_all(root, "init")
    write(root, "src/test/rank_test.py", "assert True\n")
    commit_all(root, "test(AC-1): rank_by_score")
    write(root, "src/rank_by_score.py", "def rank(): pass\n")
    commit_all(root, "feat(AC-1): rank_by_score")
    acs = [{"id": "AC-1", "layer": "API", "title": "rank_by_score works"}, {"id": "AC-2", "layer": "WEB", "title": "page"}]
    d = ac_evidence(str(root), acs[0], acs, "## Blocking\nnone\n\nAC-REVIEW: pass", note="tests pass")
    for head in ("## Criterion", "## Commits", "## Review", "## Board"):
        assert f"\n{head}\n" in f"\n{d}", head
    assert "`AC-1` [API] `rank_by_score` works" in d and "**RED**: `" in d and "`src/test/rank_test.py`" in d
    assert "```text\nsrc/rank_by_score.py" in d, "the diffstat is fenced"
    assert "**AC-REVIEW: pass**" in d and "#### Blocking" in d, "the reviewer's headings sit under ## Review"
    assert "Board: done - · now `AC-1` · todo `AC-2`" in d
