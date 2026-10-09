#!/usr/bin/env bash
# Makes a local git repo for one of keel's plugins, with its history (docs/plugins/16-steps5-7-contract.md, step 5).
# It never pushes: --push only prints the commands that push it to keel-studio/keel-plugin-<name>.
#
#   docs/plugins/tools/split-plugin.sh <name> <out-dir> [--push] [--root DIR]
#   docs/plugins/tools/split-plugin.sh --template <out-dir> [--push] [--root DIR]
#
#   <name>       a plugin of plugins/<name>, or "product" (keel Product, product/)
#   <out-dir>    the new repo; it must not exist yet, or be empty
#   --template   the repo keel-studio/keel-plugin-template instead: docs/plugins/template-repo/ (no history)
#   --push       print the commands that push the repo to keel-studio (Milad runs them, or says yes)
#   --root DIR   the keel-v2 checkout to split from (default: the checkout this script is in)
#
# What it does:
#   1. git subtree split --prefix=plugins/<name> (or product): the commits that touched the plugin, with the plugin's
#      folder as the top of the repo, into <out-dir> (branch main)
#   2. the files of docs/plugins/plugin-repo/: .github/workflows/ci.yml and release.yml, keel.ref (= the commit split
#      from, HEAD), .github/README.md (the repo page, when the plugin has no README.md: never in the package),
#      .gitignore (when it has none), LICENSE (keel's, when it has none)
#   3. one commit with them
# The plugin's folder must have no changes that are not committed: the repo is made from HEAD.
set -euo pipefail

owner=keel-studio
die() { echo "split-plugin: $*" >&2; exit 1; }
usage="usage: split-plugin.sh <name> <out-dir> [--push] [--root DIR] | split-plugin.sh --template <out-dir> [--push] [--root DIR]"

name="" out="" push=0 root="" template=0
while [ $# -gt 0 ]; do
  case "$1" in
    --push) push=1 ;;
    --template) template=1 ;;
    --root) [ $# -ge 2 ] || die "--root needs a folder"; root="$2"; shift ;;
    -h | --help) sed -n '2,21p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    -*) die "unknown option $1 ($usage)" ;;
    *) if [ "$template" = 0 ] && [ -z "$name" ]; then name="$1"; elif [ -z "$out" ]; then out="$1"; else die "$usage"; fi ;;
  esac
  shift
done
if [ "$template" = 1 ]; then
  [ -z "$name" ] || die "--template takes no plugin name ($usage)"
  name=template
fi
[ -n "$name" ] && [ -n "$out" ] || die "$usage"
[[ "$name" =~ ^[a-z][a-z0-9-]{0,31}$ ]] || die "'$name' is not a plugin name"

here="$(cd "$(dirname "$0")" && pwd)"
[ -n "$root" ] || root="$(git -C "$here" rev-parse --show-toplevel)"
[ -d "$root" ] || die "no folder $root"
root="$(cd "$root" && pwd)"
git -C "$root" rev-parse --verify -q HEAD > /dev/null || die "$root is not a git checkout with a commit"
files="$root/docs/plugins/plugin-repo"
[ -f "$files/.github/workflows/ci.yml" ] || die "there is no $files (is $root a keel-v2 checkout on plugin-base?)"

if [ "$template" = 1 ]; then
  prefix=docs/plugins/template-repo
  repo="keel-plugin-template"
else
  if [ "$name" = product ]; then prefix=product; else prefix="plugins/$name"; fi
  repo="keel-plugin-$name"
fi
git -C "$root" cat-file -e "HEAD:$prefix/keel-plugin.yml" 2> /dev/null ||
  die "there is no $prefix/keel-plugin.yml in $root at HEAD (the plugins: $(cd "$root/plugins" 2> /dev/null && ls | paste -sd' ' -) product)"
[ -z "$(git -C "$root" status --porcelain -- "$prefix")" ] ||
  die "$prefix has changes that are not committed: commit them first (the repo is made from HEAD)"
if [ -e "$out" ] && [ -n "$(ls -A "$out" 2> /dev/null)" ]; then die "$out is there already and not empty"; fi
subtree_help="$(git -C "$root" subtree -h 2>&1 || true)"
if [ "$template" = 0 ] && [[ "$subtree_help" != *"subtree split"* ]]; then
  die "git subtree is not installed with this git ($(git --version)). It comes with git on macOS and in Git for Windows;" \
    "on Debian/Ubuntu install a newer git (the git-core PPA) or put contrib/subtree/git-subtree.sh on the PATH as git-subtree"
fi

ref="$(git -C "$root" rev-parse HEAD)"
mkdir -p "$out"
out="$(cd "$out" && pwd)"
git init -q -b main "$out"

# ---- 1. the plugin's history (the template has none of its own: its files only)
if [ "$template" = 0 ]; then
  split="$(git -C "$root" subtree split -q --prefix="$prefix" HEAD)"
  [ -n "$split" ] || die "git subtree split found no commit for $prefix"
  # the split commits are in keel-v2's objects but on no branch: fetch the one commit by its id
  git -C "$out" fetch -q --no-tags --upload-pack='git -c uploadpack.allowAnySHA1InWant=true upload-pack' "$root" "$split"
  git -C "$out" update-ref refs/heads/main "$split"
  git -C "$out" reset -q --hard main
  commits="$(git -C "$out" rev-list --count main)"
else
  git -C "$root" archive --format=tar "HEAD:$prefix" | tar -xf - -C "$out"
  commits=0
fi

# ---- 2. the repo's files
top() { sed -n "s/^$2:[[:space:]]*//p" "$1" | sed -n 1p | sed 's/[[:space:]]#.*$//' | tr -d "\"'\r" | sed 's/[[:space:]]*$//'; }
manifest="$out/keel-plugin.yml"
pname="$(top "$manifest" name)" version="$(top "$manifest" version)" title="$(top "$manifest" title)"
summary="$(top "$manifest" summary)"
mkdir -p "$out/.github/workflows"
if [ "$template" = 1 ]; then
  # the template carries its own workflows (set up for the publisher's own key) and README
  [ -f "$out/.github/workflows/release.yml" ] || die "$prefix has no .github/workflows/release.yml"
else
  cp "$files/.github/workflows/ci.yml" "$files/.github/workflows/release.yml" "$out/.github/workflows/"
fi
# keel.ref: its comment lines (the template's own, else plugin-repo/'s), then the commit split from
head="$files/keel.ref"
if [ -f "$out/keel.ref" ]; then head="$out/keel.ref"; fi
{ grep '^#' "$head" || true; echo "$ref"; } > "$out/keel.ref.new"
mv "$out/keel.ref.new" "$out/keel.ref"
[ -f "$out/.gitignore" ] || cp "$files/.gitignore" "$out/.gitignore"
[ -f "$out/LICENSE" ] || [ ! -f "$root/LICENSE" ] || cp "$root/LICENSE" "$out/LICENSE"
if [ "$template" = 0 ] && [ ! -f "$out/README.md" ]; then
  # the plugins it needs (requires.plugins, on one line) and its parts
  needs="$(sed -n 's/^[[:space:]]\{1,\}plugins:[[:space:]]*{\(.*\)}.*/\1/p' "$manifest" | sed -n 1p |
    tr ',' '\n' | sed 's/:.*//' | tr -d "\"' " | { grep -E '^[a-z][a-z0-9-]{0,31}$' || true; } | sed 's/.*/`&`/' |
    paste -sd',' - | sed 's/,/, /g')"
  parts="$(awk '/^[^ \t#]/ { inparts = ($0 ~ /^parts:[ \t]*\r?$/); next }
    inparts && /^[ \t]+[a-z]+:/ { sub(/^[ \t]+/, ""); sub(/:.*/, ""); print }' "$manifest" | paste -sd' ' - | sed 's/ / · /g')"
  T="${title:-$pname}" S="$summary" N="$pname" V="$version" P="${parts:-content}" R="\`${ref:0:12}\`" \
    D="${needs:+, $needs}" awk '
      function rep(s, k, v,   i, o) { o = ""; while ((i = index(s, k)) > 0) { o = o substr(s, 1, i - 1) v; s = substr(s, i + length(k)) } return o s }
      { s = $0
        s = rep(s, "@TITLE@", ENVIRON["T"]); s = rep(s, "@SUMMARY@", ENVIRON["S"]); s = rep(s, "@NAME@", ENVIRON["N"])
        s = rep(s, "@VERSION@", ENVIRON["V"]); s = rep(s, "@PARTS@", ENVIRON["P"]); s = rep(s, "@KEEL_COMMIT@", ENVIRON["R"])
        s = rep(s, "@NEEDS@", ENVIRON["D"]); print s }' "$files/README.md" > "$out/.github/README.md"
fi

# ---- 3. one commit
git -C "$out" add -A
if [ "$template" = 1 ]; then
  subject="The keel plugin template, built against keel-v2 ${ref:0:12}"
  body="The files of keel-v2's $prefix/ at $ref (keel-plugin new example, the CI and release workflows for a publisher's own key, the README), and keel.ref."
else
  subject="${title:-$pname}: its own repo, built against keel-v2 ${ref:0:12}"
  body="The history of keel-v2's $prefix/ (git subtree split), the CI and release workflows of keel-v2's docs/plugins/plugin-repo/, and keel.ref = $ref."
fi
git -C "$out" commit -q -m "$subject" -m "$body" -m "Co-Authored-By: KeelBot <keel.dev.bot@gmail.com>"

echo "made $out: ${title:-$pname} ${version} ($repo), $((commits + 1)) commits, keel.ref $ref"
echo "nothing was pushed."
if [ "$push" = 1 ]; then
  cat << EOF

To push it to $owner/$repo (that repo has a starter README: this history replaces it, so the push is --force):
  git -C "$out" remote add origin https://github.com/$owner/$repo.git
  git -C "$out" push --force -u origin main
EOF
  if [ "$template" = 0 ]; then
    cat << EOF
Its first release, when you want it (release.yml signs with the organisation secret KEEL_PUBLISHER_KEY):
  git -C "$out" tag v$version && git -C "$out" push origin v$version
EOF
  else
    echo "Then make it a template repo: gh repo edit $owner/$repo --template"
  fi
fi
