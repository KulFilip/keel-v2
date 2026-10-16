#!/usr/bin/env bash
# Downloads the plugins' and workflows' release files for `keel-plugin index` (sync.yml, check-pr.yml):
#
#   .github/fetch-releases.sh <out-dir> [--latest] [name …]
#
# For each plugins/<name>.yml (every one when no name is given): the .kplug and .kplug.minisig of each release of its
# repo (only the newest with --latest) go into <out-dir>/<name>/<tag>/, each .kplug with <file>.json
# {"url": its download URL, "released": "YYYY-MM-DD"}. For each workflows/<name>.yml that has a repo: the releases
# tagged <name>-v<version>, their <name>-<version>.yaml and .yaml.minisig, the same way (a workflow without a repo keeps
# its files in this repo: workflows/<name>/<version>.yaml). Draft releases are skipped. A repo with no release yet is
# skipped with a note. Needs gh (with GH_TOKEN) and jq.
set -euo pipefail

out="${1:?usage: fetch-releases.sh <out-dir> [--latest] [name …]}"
shift
latest=0
if [ "${1:-}" = "--latest" ]; then latest=1; shift; fi
names=("$@")
plugins=()
workflows=()
if [ ${#names[@]} -eq 0 ]; then
  for f in plugins/*.yml; do [ -f "$f" ] && plugins+=("$(basename "$f" .yml)"); done
  for f in workflows/*.yml; do [ -f "$f" ] && workflows+=("$(basename "$f" .yml)"); done
else
  for name in "${names[@]}"; do
    [[ "$name" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || { echo "::error::'$name' is not a plugin name" >&2; exit 1; }
    found=0
    if [ -f "plugins/$name.yml" ]; then plugins+=("$name"); found=1; fi
    if [ -f "workflows/$name.yml" ]; then workflows+=("$name"); found=1; fi
    [ "$found" = 1 ] || { echo "::error::there is no plugins/$name.yml (or workflows/$name.yml)" >&2; exit 1; }
  done
fi
mkdir -p "$out"

repo_of() { # the owner/repo of a file's `repo: https://github.com/<owner>/<repo>`, or nothing
  sed -n 's|^repo:[[:space:]]*["'\'']\{0,1\}https://github\.com/\([A-Za-z0-9_.-]*/[A-Za-z0-9_.-]*\).*|\1|p' "$1" | head -1
}

# fetch <kind> <name> <repo> <tag prefix> <file patterns…>
fetch() {
  local kind="$1" name="$2" repo="$3" prefix="$4"
  shift 4
  local patterns=() p
  for p in "$@"; do patterns+=(--pattern "$p"); done
  # newest first: tag and day (a workflow's releases: only the tags <name>-v…)
  local query=".[] | select(.draft | not) | select(.tag_name | startswith(\"$prefix\")) | [.tag_name, ((.published_at // .created_at)[0:10])] | @tsv"
  local releases
  if ! releases="$(gh api "repos/$repo/releases?per_page=100" --jq "$query" 2> /dev/null)"; then
    echo "::notice::$name: the releases of $repo cannot be read (no repo yet, or it is private)"
    return 0
  fi
  if [ "$latest" = 1 ]; then releases="$(head -n 1 <<< "$releases")"; fi
  if [ -z "$releases" ]; then
    echo "$name: no release yet"
    return 0
  fi
  local tag day dir k file
  while IFS=$'\t' read -r tag day; do
    dir="$out/$name/$tag"
    mkdir -p "$dir"
    if ! gh release download "$tag" --repo "$repo" --dir "$dir" --clobber "${patterns[@]}" 2> /dev/null; then
      echo "::warning::$name $tag: the release has no $kind file"
      continue
    fi
    for k in "$dir"/*.kplug "$dir"/*.yaml; do
      [ -f "$k" ] || continue
      file="$(basename "$k")"
      jq -n --arg url "https://github.com/$repo/releases/download/$tag/$file" --arg day "$day" \
        '{url: $url, released: $day}' > "$k.json"
      echo "$name $tag: $file"
    done
  done <<< "$releases"
}

for name in ${plugins[@]+"${plugins[@]}"}; do
  f="plugins/$name.yml"
  repo="$(repo_of "$f")"
  [ -n "$repo" ] || { echo "::error::$f has no repo: https://github.com/<owner>/<repo>" >&2; exit 1; }
  fetch .kplug "$name" "$repo" "" '*.kplug' '*.kplug.minisig'
done

for name in ${workflows[@]+"${workflows[@]}"}; do
  f="workflows/$name.yml"
  repo="$(repo_of "$f")"
  if [ -z "$repo" ]; then
    echo "$name: its files are in this repo (workflows/$name/)"
    continue
  fi
  fetch .yaml "$name" "$repo" "$name-v" "$name-*.yaml" "$name-*.yaml.minisig"
done
