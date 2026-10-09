#!/usr/bin/env bash
# Builds and tests one plugin that lives in its own repo, with keel's own build machinery
# (docs/plugins/16-steps5-7-contract.md, step 5). A plugin repo's ci.yml and release.yml run it from a keel-v2 checkout
# at the commit in the plugin's keel.ref (docs/plugins/plugin-repo/):
#
#   keel/scripts/build-plugin-repo.sh <plugin-dir> <out-dir> --throwaway [--no-tests]
#
#   1. the plugin goes into this checkout's plugins/<name>/ (keel Product: product/), in place of keel's own copy
#   2. the plugins it requires (requires.plugins, and the plugins they require): each from its own repo
#      $KEEL_PLUGIN_REPOS/keel-plugin-<name> at the newest tag v<version> that fits the range, else keel's own copy in
#      plugins/<name>. keel's other plugins stay (some tests run the plugin inside keel's full web).
#   3. keel's tests and build, for each part the plugin has:
#        engine tests  scripts/test-plugins.sh <name>              (when it has engine/tests)
#        api           ./gradlew <name>Test <name>PluginJar       (keel Product: productTest productPluginJar)
#        web           its web tests (vitest), then npm run build:plugin -- <name> (Product: build:product); a web part
#                      without index.tsx (what keel-plugin new makes: web/index.js) is packed as it is
#   4. scripts/build-plugin.sh --no-build, then keel-plugin pack and lint: <out-dir>/<name>-<version>.kplug
#
#   --throwaway   required: it says that this checkout may be changed (plugins/, product/). Run it in a fresh clone of
#                 keel-v2, as the plugin repos' CI does, never in the checkout you work in.
#   --no-tests    build and pack only
#
# KEEL_PLUGIN_REPOS: where the plugin repos are (default https://github.com/keel-studio; a folder in tests).
# KEEL_PLUGIN: a keel-plugin command (default: uv run --project tools/keel-plugin keel-plugin).
# Needs git, python3 and uv; Java 21 for an api part; Node 20 for a web part (npm ci runs when web/node_modules is
# missing).
set -euo pipefail

die() { echo "build-plugin-repo: $*" >&2; exit 1; }
say() { echo "== $*"; }
usage="usage: scripts/build-plugin-repo.sh <plugin-dir> <out-dir> --throwaway [--no-tests]"

keel="$(cd "$(dirname "$0")/.." && pwd)"
src="" out="" throwaway=0 tests=1
for a in "$@"; do
  case "$a" in
    --throwaway) throwaway=1 ;;
    --no-tests) tests=0 ;;
    -*) die "unknown option $a ($usage)" ;;
    *) if [ -z "$src" ]; then src="$a"; elif [ -z "$out" ]; then out="$a"; else die "$usage"; fi ;;
  esac
done
[ -n "$src" ] && [ -n "$out" ] || die "$usage"
[ "$throwaway" = 1 ] || die "it changes the keel checkout it runs in ($keel: plugins/ and product/). Run it in a" \
  "throw-away clone of keel-v2, as the plugin repos' CI does, and say so with --throwaway"
[ -d "$src" ] || die "no plugin folder $src"
src="$(cd "$src" && pwd)"
[ -f "$src/keel-plugin.yml" ] || die "no keel-plugin.yml in $src"
case "$src/" in "$keel"/*) die "the plugin folder $src is inside the keel checkout: give the plugin repo's own folder" ;; esac
command -v python3 > /dev/null 2>&1 || die "python3 is needed"
versions=(python3 "$keel/scripts/plugin_versions.py")
repos="${KEEL_PLUGIN_REPOS:-https://github.com/keel-studio}"
if [ -n "${KEEL_PLUGIN:-}" ]; then kp=("$KEEL_PLUGIN"); else kp=(uv run --quiet --project "$keel/tools/keel-plugin" keel-plugin); fi

# ---- the manifest: top-level scalars and the parts, each written on one line (as scripts/build-plugin.sh reads them)
top() {
  awk -v k="$2" 'index($0, k ":") == 1 { sub("^" k ":[ \t]*", ""); sub(/\r$/, ""); sub(/[ \t]+#.*$/, ""); print; exit }' "$1" |
    tr -d "\"'" | sed 's/[[:space:]]*$//'
}
part() {
  awk -v k="$2" '
    /^[^ \t#]/ { inparts = ($0 ~ /^parts:[ \t]*\r?$/); next }
    inparts && $0 ~ ("^[ \t]+" k ":") {
      sub("^[ \t]+" k ":[ \t]*", ""); sub(/\r$/, ""); sub(/[ \t]+#.*$/, ""); print; exit
    }' "$1"
}
field() { printf '%s\n' "$1" | sed -n "s/.*[{,][[:space:]]*$2:[[:space:]]*\([^],}[]*\).*/\1/p" | tr -d "\"' "; }
dest_of() { if [ "$1" = product ]; then echo "$keel/product"; else echo "$keel/plugins/$1"; fi; }
# a plugin repo's files, without its git folder, its workflows and keel.ref, in place of keel's copy
place() {
  rm -rf "$2"
  mkdir -p "$2"
  cp -R "$1/." "$2/"
  rm -rf "$2/.git" "$2/.github" "$2/keel.ref"
}

manifest="$src/keel-plugin.yml"
name="$(top "$manifest" name | tr -d ' ')"
version="$(top "$manifest" version | tr -d ' ')"
title="$(top "$manifest" title)"
case "$name" in "" | *[!a-z0-9-]*) die "no valid name in $manifest" ;; esac
case "$version" in "" | *[!0-9A-Za-z.+-]*) die "no valid version in $manifest" ;; esac
camel="$(printf '%s' "$name" | awk -F- '{ out = $1; for (i = 2; i <= NF; i++) out = out toupper(substr($i, 1, 1)) substr($i, 2); print out }')"
dir="$(dest_of "$name")"
say "${title:-$name} $version, against keel-v2 $(git -C "$keel" rev-parse --short HEAD 2> /dev/null || echo '(not a git checkout)')"

# ---- 1. the plugin into keel's tree
place "$src" "$dir"
echo "$name: $src -> ${dir#"$keel"/}/"

# ---- 2. the plugins it requires, and the ones they require
todo="$("${versions[@]}" needs "$manifest")" || die "$manifest: requires.plugins cannot be read"
kept=" $name " chosen=""
while [ -n "$todo" ]; do
  line="${todo%%$'\n'*}"
  if [ "$line" = "$todo" ]; then todo=""; else todo="${todo#*$'\n'}"; fi
  [ -n "$line" ] || continue
  dep="${line%%$'\t'*}" spec="${line#*$'\t'}"
  [ "$dep" != "$name" ] || die "$name requires itself"
  case "$kept" in
    *" $dep "*)
      have="$(printf '%s\n' "$chosen" | sed -n "s/^$dep //p")"
      [ -z "$have" ] || "${versions[@]}" fits "$have" "$spec" || die "$dep $have is chosen, but another plugin needs $dep $spec"
      continue ;;
  esac
  kept="$kept$dep "
  url="$repos/keel-plugin-$dep"
  tags="$(GIT_TERMINAL_PROMPT=0 git ls-remote --tags --refs "$url" 2> /dev/null | sed -n 's|.*refs/tags/v||p' || true)"
  # shellcheck disable=SC2086 # one tag per word
  best="$("${versions[@]}" pick "$spec" $tags || true)"
  ddir="$(dest_of "$dep")"
  if [ -n "$best" ]; then
    tmp="$(mktemp -d "${TMPDIR:-/tmp}/build-plugin-repo.XXXXXX")"
    GIT_TERMINAL_PROMPT=0 git clone -q --depth 1 --branch "v$best" "$url" "$tmp/repo" 2> /dev/null ||
      { rm -rf "$tmp"; die "$dep: cannot clone $url at v$best"; }
    got="$(top "$tmp/repo/keel-plugin.yml" name | tr -d ' ')/$(top "$tmp/repo/keel-plugin.yml" version | tr -d ' ')"
    [ "$got" = "$dep/$best" ] || { rm -rf "$tmp"; die "$url v$best holds $got, not $dep $best"; }
    place "$tmp/repo" "$ddir"
    rm -rf "$tmp"
    echo "$dep $best: its repo keel-plugin-$dep at v$best (needs ${spec:-any version})"
  else
    [ -f "$ddir/keel-plugin.yml" ] ||
      die "$dep ${spec:-(any version)} is needed, but $url has no tag v<version> that fits and keel-v2 has no ${ddir#"$keel"/}"
    best="$(top "$ddir/keel-plugin.yml" version | tr -d ' ')"
    "${versions[@]}" fits "$best" "$spec" || die "$dep $spec is needed, and keel-v2's ${ddir#"$keel"/} is $best (no tag of $url fits)"
    echo "$dep $best: keel-v2's ${ddir#"$keel"/} (no tag of keel-plugin-$dep fits ${spec:-any version})"
  fi
  chosen="$chosen$dep $best"$'\n'
  more="$("${versions[@]}" needs "$ddir/keel-plugin.yml")" || die "$ddir/keel-plugin.yml: requires.plugins cannot be read"
  if [ -n "$more" ]; then todo="$(printf '%s\n%s' "$todo" "$more" | sed '/^$/d')"; fi
done
# keel's other plugins stay as they are at keel.ref: some tests run a plugin inside keel's full web (the menu
# with every plugin), as the image has it
echo "plugins/: $(cd "$keel/plugins" 2> /dev/null && find . -mindepth 1 -maxdepth 1 -type d | sed 's|^\./||' | LC_ALL=C sort | paste -sd' ' - || true)"

# ---- 3. keel's tests and build, part by part
api_line="$(part "$manifest" api)" web_line="$(part "$manifest" web)"
if [ "$tests" = 1 ] && [ -d "$dir/engine/tests" ]; then
  say "engine tests: scripts/test-plugins.sh $name"
  bash "$keel/scripts/test-plugins.sh" "$name"
elif [ -d "$dir/engine" ]; then
  echo "engine: no engine/tests to run"
fi

if [ -n "$api_line" ]; then
  [ -d "$dir/api/src" ] || die "parts.api is in the manifest, but there is no api/src in the plugin"
  tasks=("${camel}PluginJar")
  if [ "$tests" = 1 ]; then tasks=("${camel}Test" "${tasks[@]}"); fi
  say "api: ./gradlew ${tasks[*]}"
  (cd "$keel/api" && ./gradlew --no-daemon --console=plain "${tasks[@]}")
fi

prebuilt=""
if [ -n "$web_line" ]; then
  entry="$(field "$web_line" entry)"
  build=()
  if [ "$name" = product ]; then
    build=(npm run build:product)
  elif [ -f "$dir/web/vite.config.ts" ]; then
    build=(npx vite build --config "$dir/web/vite.config.ts")
  elif [ -f "$dir/web/index.tsx" ]; then
    build=(npm run build:plugin -- "$name")
  elif [ -n "$entry" ] && [ -f "$dir/$entry" ]; then
    prebuilt="$dir/$(dirname "$entry")"
  else
    die "parts.web names ${entry:-no entry}, but the plugin has no web/index.tsx to build and no ${entry:-web/index.js}"
  fi
  web_tests=""
  if [ "$tests" = 1 ] && [ -d "$dir/web" ]; then
    web_tests="$(find "$dir/web" \( -name node_modules -o -name dist \) -prune -o -type f \( -name '*.test.ts' -o -name '*.test.tsx' \) -print | sed -n 1p)"
  fi
  if [ ${#build[@]} -gt 0 ] || [ -n "$web_tests" ]; then
    if [ ! -d "$keel/web/node_modules" ]; then
      say "web: npm ci"
      (cd "$keel/web" && npm ci --no-audit --no-fund)
    fi
  fi
  if [ -n "$web_tests" ]; then
    say "web tests: vitest run ${dir#"$keel"/}/web/"
    (cd "$keel/web" && npx vitest run --passWithNoTests "$dir/web/")
  fi
  if [ ${#build[@]} -gt 0 ]; then
    say "web: ${build[*]}"
    (cd "$keel/web" && "${build[@]}")
  else
    echo "web: $entry is packed as it is (no web/index.tsx to build)"
  fi
fi

# ---- 4. the plugin folder, the .kplug, and its lint
say "pack and lint"
stage="$(mktemp -d "${TMPDIR:-/tmp}/build-plugin-repo.XXXXXX")"
trap 'rm -rf "$stage"' EXIT
if [ "$name" = product ]; then
  bash "$keel/product/build-plugin.sh" "$stage" --no-build
elif [ -n "$prebuilt" ]; then
  KEEL_PLUGIN_WEB_DIST="$prebuilt" bash "$keel/scripts/build-plugin.sh" "$dir" "$stage" --no-build
else
  bash "$keel/scripts/build-plugin.sh" "$dir" "$stage" --no-build
fi
mkdir -p "$out"
out="$(cd "$out" && pwd)"
"${kp[@]}" pack "$stage/$name/$version" --out "$out"
"${kp[@]}" lint "$out/$name-$version.kplug"
sum="$(if command -v sha256sum > /dev/null 2>&1; then sha256sum "$out/$name-$version.kplug"; else shasum -a 256 "$out/$name-$version.kplug"; fi | cut -d' ' -f1)"
echo "built: $out/$name-$version.kplug sha256:$sum"
