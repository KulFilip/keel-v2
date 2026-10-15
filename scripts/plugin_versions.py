"""Plugin versions and ranges for the plugin repo scripts (docs/plugins/16-steps5-7-contract.md, step 5): the same rules
as keel's resolver, with the standard library only (any python3 from 3.8 on, also the Debian one in the Dockerfile).

    python3 scripts/plugin_versions.py fits <version> <range>      exit 0 when the version fits the range
    python3 scripts/plugin_versions.py pick <range> [version …]    the newest release that fits (a pre-release only when
                                                                   no release fits); exit 1 when none fits
    python3 scripts/plugin_versions.py needs <keel-plugin.yml>     "<name>\t<range>" for each plugin it requires

A version is keel's manifest version (1.2.3, 1.2.3-beta.1, build metadata after +). A range is keel's: comma-separated
parts like ">=1.0.0" and "<2.0.0" (>=, <=, ==, >, <) that compare the release numbers only, as the resolver does; an
empty range fits every version. Versions sort in semver's order: a pre-release comes before its release.
requires.plugins is read from its one line, `plugins: { tasks: ">=1.0.0" }`, as api/build.gradle.kts and
scripts/build-plugin.sh read the manifest.
"""

from __future__ import annotations

import re
import sys

VERSION = re.compile(r"^[0-9]+\.[0-9]+\.[0-9]+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")
NAME = re.compile(r"^[a-z][a-z0-9-]{0,31}$")
PART = re.compile(r"^(>=|<=|==|>|<)\s*([0-9][0-9.]*)$")


def numbers(version: str) -> tuple:
    """'1.2.3-beta.1' -> (1, 2, 3): the release numbers only."""
    head = re.split(r"[-+]", version.strip(), maxsplit=1)[0]
    return tuple(int(p) for p in head.split(".") if p.isdigit())


def valid_range(spec: str) -> bool:
    return all(PART.match(p.strip()) for p in spec.split(",") if p.strip())


def fits(version: str, spec: str) -> bool:
    """Whether a version meets a range like '>=1.0.0,<2.0.0' (an empty range: any version)."""
    have = numbers(version)
    for part in [p.strip() for p in (spec or "").split(",") if p.strip()]:
        m = PART.match(part)
        if not m:
            return False
        want = numbers(m.group(2))
        ok = {">=": have >= want, "<=": have <= want, "==": have == want, ">": have > want, "<": have < want}[m.group(1)]
        if not ok:
            return False
    return True


def key(version: str) -> tuple:
    """Sorts versions: numbers first, a pre-release before its release (semver)."""
    core, _, pre = version.split("+", 1)[0].partition("-")
    nums = tuple(int(p) for p in core.split("."))
    parts = tuple((0, int(p), "") if p.isdigit() else (1, 0, p) for p in pre.split(".")) if pre else ()
    return nums, 0 if pre else 1, parts


def pick(spec: str, versions: list) -> str | None:
    """The newest release that fits the range; the newest fitting pre-release only when no release fits."""
    good = sorted({v for v in versions if VERSION.match(v) and fits(v, spec)}, key=key)
    releases = [v for v in good if "-" not in v.split("+", 1)[0]]
    return (releases or good or [None])[-1]


def _items(text: str) -> list:
    """The items of a flow mapping's inside, split at the commas that are not in quotes ('>=1.0.0,<2.0.0' is one)."""
    items, cur, quote = [], "", ""
    for ch in text:
        if quote:
            quote = "" if ch == quote else quote
        elif ch in "\"'":
            quote = ch
        elif ch == ",":
            items.append(cur)
            cur = ""
            continue
        cur += ch
    return items + [cur]


def needs(manifest_text: str) -> list:
    """[(name, range)] of `requires: plugins: { a: ">=1", b: "" }`, written on one line."""
    in_requires = False
    for line in manifest_text.splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if not line[0].isspace():
            in_requires = line.rstrip() == "requires:"
            continue
        m = re.match(r"^\s+plugins:\s*\{([^}]*)\}", line) if in_requires else None
        if m:
            out = []
            for item in _items(m.group(1)):
                if not item.strip():
                    continue
                name, _, spec = item.partition(":")
                name, spec = name.strip().strip("\"'"), spec.strip().strip("\"'").strip()
                if not NAME.match(name):
                    raise ValueError(f"requires.plugins: '{name}' is not a plugin name")
                if not valid_range(spec):
                    raise ValueError(f"requires.plugins.{name}: '{spec}' is not a range like '>=1.0.0'")
                out.append((name, spec))
            return out
        if in_requires and re.match(r"^\s+plugins:\s*(#.*)?$", line):
            raise ValueError("requires.plugins must be written on one line: plugins: { tasks: \">=1.0.0\" }")
    return []


def main(argv: list) -> int:
    usage = "usage: plugin_versions.py fits <version> <range> | pick <range> [version …] | needs <keel-plugin.yml>"
    if not argv:
        print(usage, file=sys.stderr)
        return 2
    cmd, args = argv[0], argv[1:]
    if cmd == "fits" and len(args) == 2:
        return 0 if VERSION.match(args[0]) and valid_range(args[1]) and fits(args[0], args[1]) else 1
    if cmd == "pick" and args:
        if not valid_range(args[0]):
            print(f"plugin_versions: '{args[0]}' is not a range like '>=1.0.0'", file=sys.stderr)
            return 2
        best = pick(args[0], args[1:])
        if best is None:
            return 1
        print(best)
        return 0
    if cmd == "needs" and len(args) == 1:
        try:
            with open(args[0], encoding="utf-8") as fh:
                found = needs(fh.read())
        except (OSError, ValueError) as exc:
            print(f"plugin_versions: {args[0]}: {exc}", file=sys.stderr)
            return 2
        for name, spec in found:
            print(f"{name}\t{spec}")
        return 0
    print(usage, file=sys.stderr)
    return 2


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
