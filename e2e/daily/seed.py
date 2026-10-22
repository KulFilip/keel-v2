#!/usr/bin/env python3
"""Seed the sample projects of the daily-use journeys:  seed.py <projects dir>

shop   e2e/core's fixture (Python: prices with tax) + files for the Code view journey (a long .py, a long .kt, a long
       .md, a three-line file) + branches in folders (feature/cart, feature/checkout, fix/rounding) for Source control.
notes  a tiny second project the journey "add a project" adds from the folders.
"""
from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
spec = importlib.util.spec_from_file_location("e2e_core", HERE.parent / "core" / "e2e.py")
core = importlib.util.module_from_spec(spec)  # type: ignore[arg-type]
sys.modules["e2e_core"] = core
spec.loader.exec_module(core)  # type: ignore[union-attr]

GIT = ["git", "-c", "user.name=e2e", "-c", "user.email=e2e@localhost", "-c", "commit.gpgsign=false"]


def git(repo: Path, *a: str) -> None:
    subprocess.run([*GIT, *a], cwd=repo, check=True, capture_output=True)


def write(repo: Path, rel: str, text: str) -> None:
    f = repo / rel
    f.parent.mkdir(parents=True, exist_ok=True)
    f.write_text(text)


def main() -> None:
    root = Path(sys.argv[1])
    root.mkdir(parents=True, exist_ok=True)
    repo = root / "shop"
    for rel, text in core.FIXTURE.items():
        write(repo, rel, text)
    py = ['"""Stock levels of the shop (a long file for the Code view journey)."""', "", "from __future__ import annotations", ""]
    for i in range(1, 121):
        py += [f"def stock_level_{i}(sku: str, warehouse: int = {i}) -> int:", f'    """Units of {{sku}} in warehouse {i}."""',
               f"    base = len(sku) * {i}", f"    return base + warehouse", ""]
    write(repo, "big/inventory.py", "\n".join(py) + "\n")
    kt = ["package shop", "", "// a long Kotlin file for the Code view journey", ""]
    for i in range(1, 81):
        kt += [f"data class Stock{i}(val sku: String, val units: Int = {i}) {{", f"    fun enough(need: Int): Boolean = units >= need + {i}", "}", ""]
    write(repo, "big/Stock.kt", "\n".join(kt) + "\n")
    md = ["# Shop guide", "", "A long Markdown file for the rendered pane.", ""]
    for i in range(1, 61):
        md += [f"## Section {i}", "", f"Prices are in cents. Section {i} says that tax is `{i}` percent of nothing in particular, and that "
               "a price is never negative. A longer sentence keeps the paragraph tall enough to need scrolling in a small window.", "",
               f"- item {i}.1", f"- item {i}.2", ""]
    write(repo, "docs/GUIDE.md", "\n".join(md) + "\n")
    write(repo, "tiny.txt", "one\ntwo\nthree\n")
    git(repo, "init", "-q", "-b", "main")
    git(repo, "add", "-A")
    git(repo, "commit", "-q", "-m", "The shop: prices with tax, stock, a guide")
    for br, f in (("feature/cart", "shop/cart.py"), ("feature/checkout", "shop/checkout.py"), ("fix/rounding", "shop/round.py")):
        git(repo, "checkout", "-q", "-b", br, "main")
        write(repo, f, f"# {br}\n")
        git(repo, "add", "-A")
        git(repo, "commit", "-q", "-m", f"feat: {br}")
    git(repo, "checkout", "-q", "main")

    notes = root / "notes"
    write(notes, "README.md", "# Notes\n\nA few notes.\n")
    write(notes, "notes/todo.md", "- write tests\n- ship\n")
    git(notes, "init", "-q", "-b", "main")
    git(notes, "add", "-A")
    git(notes, "commit", "-q", "-m", "Notes")
    print(repo)


if __name__ == "__main__":
    main()
