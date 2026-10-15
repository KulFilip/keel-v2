#!/usr/bin/env bash
# Writes plugins.lock from the plugins' newest releases in keel-studio (docs/plugins/16-steps5-7-contract.md, step 5).
# Milad runs it when a plugin has a new release; it reads public releases with gh and changes only plugins.lock.
#
#   scripts/update-plugins-lock.sh [name …] [--root DIR] [--owner ORG]
#
# For each name (default: every plugin in plugins/, keel Product, and every name the lock has already), the newest
# release of <owner>/keel-plugin-<name> (drafts are left out; a pre-release only when the repo has no release):
#   1. downloads <name>-<version>.kplug and its .kplug.minisig (gh release download)
#   2. checks the signature with keel's public key content/trust/keel.pub, and keel-plugin lint: a file the image build
#      would refuse never gets into the lock
#   3. writes the line "<name> <version> <url> sha256:<hex>" (the url of the release asset)
# A plugin with no release keeps its line (or has none). The comment lines at the top stay; the lines are sorted.
#
#   --root DIR    the keel-v2 checkout (default: the one this script is in): DIR/plugins.lock, DIR/content/trust/keel.pub
#   --owner ORG   where the plugin repos are (default keel-studio)
# Needs gh (the repos are public: no special token), python3 and keel-plugin (KEEL_PLUGIN, keel-plugin on the PATH, or
# uv with tools/keel-plugin).
set -euo pipefail

die() { echo "update-plugins-lock: $*" >&2; exit 1; }

root="" owner=keel-studio names=()
while [ $# -gt 0 ]; do
  case "$1" in
    --root) [ $# -ge 2 ] || die "--root needs a folder"; root="$2"; shift ;;
    --owner) [ $# -ge 2 ] || die "--owner needs an organisation"; owner="$2"; shift ;;
    -h | --help) sed -n '2,22p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1" ;;
    *) [[ "$1" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "'$1' is not a plugin name"; names+=("$1") ;;
  esac
  shift
done
[ -n "$root" ] || root="$(cd "$(dirname "$0")/.." && pwd)"
[ -d "$root" ] || die "no folder $root"
root="$(cd "$root" && pwd)"
lock="$root/plugins.lock"
pub="$root/content/trust/keel.pub"
[ -f "$lock" ] || die "there is no $lock"
[ -f "$pub" ] || die "there is no $pub: the image build checks every locked file with it, so make the keys first" \
  "(docs/plugins/tools/setup-signing-keys.sh)"
command -v gh > /dev/null 2>&1 || die "gh is needed (https://cli.github.com)"
command -v python3 > /dev/null 2>&1 || die "python3 is needed"
here="$(cd "$(dirname "$0")" && pwd)"
if [ -n "${KEEL_PLUGIN:-}" ]; then
  kp=("$KEEL_PLUGIN")
elif command -v keel-plugin > /dev/null 2>&1; then
  kp=(keel-plugin)
else
  command -v uv > /dev/null 2>&1 || die "keel-plugin is needed: uv (it runs tools/keel-plugin) or KEEL_PLUGIN"
  kp=(uv run --quiet --project "$here/../tools/keel-plugin" keel-plugin)
fi
sha256() { if command -v sha256sum > /dev/null 2>&1; then sha256sum "$1"; else shasum -a 256 "$1"; fi | cut -d' ' -f1; }

tmp="$(mktemp -d "${TMPDIR:-/tmp}/update-plugins-lock.XXXXXX")"
trap 'rm -rf "$tmp"' EXIT

# the lock as it is: its header (the comment lines before the first plugin line) and its lines, "<name> <line>"
header=1
: > "$tmp/header"
: > "$tmp/lines"
while IFS= read -r raw || [ -n "$raw" ]; do
  line="$(printf '%s' "$raw" | tr -d '\r' | sed -e 's/^[[:space:]]*//' -e 's/[[:space:]]*$//')"
  case "$line" in
    "" | "#"*) if [ "$header" = 1 ]; then printf '%s\n' "$raw" >> "$tmp/header"; fi ;;
    *) header=0; printf '%s %s\n' "${line%% *}" "$line" >> "$tmp/lines" ;;
  esac
done < "$lock"

if [ ${#names[@]} -eq 0 ]; then
  while IFS= read -r n; do names+=("$n"); done < <(
    {
      for d in "$root"/plugins/*/; do [ -f "$d/keel-plugin.yml" ] && basename "$d"; done
      [ -f "$root/product/keel-plugin.yml" ] && echo product
      cut -d' ' -f1 "$tmp/lines"
    } | LC_ALL=C sort -u
  )
fi
[ ${#names[@]} -gt 0 ] || die "no plugin to look up"

changed=0
for name in "${names[@]}"; do
  repo="$owner/keel-plugin-$name"
  query='.[] | select(.draft | not) | .tag_name'
  if ! tags="$(gh api "repos/$repo/releases?per_page=100" --jq "$query" 2> /dev/null)"; then
    echo "$name: the releases of $repo cannot be read (no repo yet, or it is private): its line stays as it is"
    continue
  fi
  # shellcheck disable=SC2046 # one version per word
  version="$(python3 "$here/plugin_versions.py" pick "" $(printf '%s\n' "$tags" | sed -n 's/^v//p') || true)"
  if [ -z "$version" ]; then
    echo "$name: $repo has no release v<version> yet: its line stays as it is"
    continue
  fi
  tag="v$version" file="$name-$version.kplug"
  mkdir -p "$tmp/$name"
  gh release download "$tag" --repo "$repo" --dir "$tmp/$name" --pattern "$file" --pattern "$file.minisig" > /dev/null 2>&1 || true
  [ -f "$tmp/$name/$file" ] && [ -f "$tmp/$name/$file.minisig" ] ||
    die "$name: the release $tag of $repo has no $file and $file.minisig"
  report="$("${kp[@]}" verify "$tmp/$name/$file" --pub "$pub" 2>&1)" ||
    die "$name $version: the signature does not verify with $pub, so it is not locked: $report"
  report="$("${kp[@]}" lint "$tmp/$name/$file" 2>&1)" || die "$name $version: keel-plugin lint refuses it, so it is not locked:"$'\n'"$report"
  new="$name $version https://github.com/$repo/releases/download/$tag/$file sha256:$(sha256 "$tmp/$name/$file")"
  old="$(sed -n "s/^$name //p" "$tmp/lines")"
  if [ "$old" = "$new" ]; then
    echo "$name: $version (no change)"
    continue
  fi
  grep -v "^$name " "$tmp/lines" > "$tmp/lines.new" || true
  echo "$name $new" >> "$tmp/lines.new"
  mv "$tmp/lines.new" "$tmp/lines"
  echo "$name: ${old:+$(echo "$old" | cut -d' ' -f2) -> }$version"
  changed=$((changed + 1))
done

{
  cat "$tmp/header"
  LC_ALL=C sort "$tmp/lines" | cut -d' ' -f2-
} > "$tmp/plugins.lock"
cat "$tmp/plugins.lock" > "$lock"
echo "update-plugins-lock: $changed changed: $lock (check it with scripts/fetch-locked-plugins.sh --check plugins.lock)"
