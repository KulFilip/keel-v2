#!/usr/bin/env bash
# The checks of keel's "plugin" workflow (content/workflows/plugin.yaml) for the plugins a branch adds or changes in
# plugins/ (docs/plugins/17-publish-your-plugin.md):
#
#   scripts/plugin-check.sh lint [name…]    build each one as its package (scripts/build-plugin.sh, into a temp folder)
#                                           and check it with keel-plugin lint (tools/keel-plugin)
#   scripts/plugin-check.sh test [name…]    its engine tests: scripts/test-plugins.sh <name> (a plugin without
#                                           engine tests is said, not failed)
#   scripts/plugin-check.sh changed         the names only, one per line
#
# Without names: the plugins whose folder this branch changed against its base (KEEL_BASE, else origin/main, else
# main), committed or not. None found is a failure: the workflow builds a plugin, so there must be one.
set -euo pipefail

root="$(cd "$(dirname "$0")/.." && pwd)"
cmd="${1:-}"
[ $# -gt 0 ] && shift
case "$cmd" in lint|test|changed) ;; *) echo "usage: scripts/plugin-check.sh lint|test|changed [name…]" >&2; exit 2 ;; esac

changed() {
  local base=""
  for b in "${KEEL_BASE:-}" origin/main main; do
    [ -n "$b" ] && git -C "$root" rev-parse -q --verify "$b^{commit}" >/dev/null 2>&1 && { base="$b"; break; }
  done
  {
    if [ -n "$base" ]; then git -C "$root" diff --name-only "$(git -C "$root" merge-base HEAD "$base")" -- plugins/; fi
    git -C "$root" diff --name-only HEAD -- plugins/ 2>/dev/null || true
    git -C "$root" ls-files --others --exclude-standard -- plugins/
  } | awk -F/ 'NF > 2 && $1 == "plugins" { print $2 }' | sort -u | while read -r n; do
    [ -f "$root/plugins/$n/keel-plugin.yml" ] && echo "$n"
  done
}

names=("$@")
if [ ${#names[@]} -eq 0 ]; then
  while IFS= read -r n; do [ -n "$n" ] && names+=("$n"); done < <(changed)
fi
if [ "$cmd" = changed ]; then
  printf '%s\n' ${names[@]+"${names[@]}"}
  exit 0
fi
if [ ${#names[@]} -eq 0 ]; then
  echo "plugin-check: this branch changes no plugin in plugins/ (a folder with a keel-plugin.yml)." >&2
  echo "Scaffold one first: (cd tools/keel-plugin && uv run keel-plugin new <name> --dir ../../plugins)" >&2
  exit 1
fi

failed=()
if [ "$cmd" = lint ]; then
  out="$(mktemp -d)"
  trap 'rm -rf "$out"' EXIT
  for n in "${names[@]}"; do
    echo "== $n: build the package, then keel-plugin lint"
    if ! bash "$root/scripts/build-plugin.sh" "$root/plugins/$n" "$out"; then failed+=("$n"); continue; fi
    kplug="$(ls "$out"/"$n"-*.kplug 2>/dev/null | head -1)"
    if [ -z "$kplug" ] || ! (cd "$root/tools/keel-plugin" && uv run -q keel-plugin lint "$kplug"); then failed+=("$n"); fi
  done
else
  with=()
  for n in "${names[@]}"; do
    if [ -d "$root/plugins/$n/engine/tests" ]; then with+=("$n"); else echo "plugin-check: $n has no engine tests (plugins/$n/engine/tests)"; fi
  done
  if [ ${#with[@]} -gt 0 ] && ! bash "$root/scripts/test-plugins.sh" "${with[@]}"; then failed+=("${with[@]}"); fi
fi

if [ ${#failed[@]} -gt 0 ]; then echo "plugin-check $cmd: failed: ${failed[*]}" >&2; exit 1; fi
echo "plugin-check $cmd: ok (${names[*]})"
