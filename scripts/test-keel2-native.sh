#!/usr/bin/env bash
# Test keel2's native `update` and `update --rollback` with fake releases: no network, no Java, nothing running.
#
# Three fake releases (9.0.0, 9.1.0, and 9.2.0 with a wrong checksum) are served from file:// URLs
# (KEEL_RELEASE_URL, KEEL_RELEASES_API). Their engine is an empty python project, so the real
# `uv sync --frozen --no-dev` runs for real (the lock file is made with `uv lock`, which needs no packages).
# If uv could not work offline, a fake uv earlier on PATH that only creates .venv would do instead.
# Everything lives in one scratch folder that is removed at the end. Needs: bash, curl, tar, uv.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
command -v uv >/dev/null 2>&1 || { echo "uv is needed for this test" >&2; exit 1; }

scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT

export KEEL_HOME2="$scratch/home" KEEL_NAME=keel-test-native XDG_CONFIG_HOME="$scratch/config"
export KEEL_YES=1 KEEL_OPEN=0 KEEL_NATIVE_CLIS=0
export KEEL_RELEASE_URL="file://$scratch/releases"
export KEEL_RELEASES_API="file://$scratch/api.json"
export NO_COLOR=1
mkdir -p "$KEEL_HOME2" "$XDG_CONFIG_HOME" "$scratch/releases"
ND="$KEEL_HOME2/$KEEL_NAME"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { local what="$1"; shift; if "$@"; then pass "$what"; else fail "$what"; fi; }
link_is() { [ "$(readlink "$ND/$1")" = "$ND/app/$2" ]; }
has() { grep -q -- "$1" <<<"$2"; }   # has <text> <output>

# make_release <version> [bad]: keel-v2-<v>-native.tar.gz and .sha256 under releases/v<v>/ ("bad": a wrong checksum)
make_release() {
  local v="$1" bad="${2:-}" st="$scratch/build/keel-v2-$1" out="$scratch/releases/v$1" name="keel-v2-$1-native.tar.gz"
  mkdir -p "$st/engine" "$st/content" "$out"
  printf 'fake jar %s\n' "$v" > "$st/api.jar"
  printf '%s\n' "$v" > "$st/VERSION"
  printf '#!/bin/sh\nexit 0\n' > "$st/keel-native-start"; chmod +x "$st/keel-native-start"
  printf '[project]\nname = "fake-engine"\nversion = "%s"\nrequires-python = ">=3.8"\ndependencies = []\n\n[tool.uv]\npackage = false\n' "$v" > "$st/engine/pyproject.toml"
  (cd "$st/engine" && uv lock -q --offline)
  tar -C "$scratch/build" -czf "$out/$name" "keel-v2-$v"
  if [ -n "$bad" ]; then printf '%064d  %s\n' 0 "$name" > "$out/$name.sha256"
  elif command -v sha256sum >/dev/null 2>&1; then (cd "$out" && sha256sum "$name" > "$name.sha256")
  else (cd "$out" && shasum -a 256 "$name" > "$name.sha256"); fi
}
api_says() { printf '{\n  "tag_name": "v%s",\n  "name": "v%s"\n}\n' "$1" "$1" > "$scratch/api.json"; }
k() { "$keel2" "$@" 2>&1; }

echo "building fake releases…"
make_release 9.0.0
make_release 9.1.0
make_release 9.2.0 bad

# native mode as native_start leaves it: a mode file and a project (nothing is running)
mkdir -p "$ND" "$scratch/project"
echo native > "$ND/mode"; printf '%s\n' "$scratch/project" > "$ND/project"

echo "keel2 version"
out="$(k version)"; check "version says native" has native "$out"

echo "first install (update with nothing installed, API says 9.0.0)"
api_says 9.0.0
out="$(k update)" || fail "update exited with an error: $out"
check "app/9.0.0 installed" test -f "$ND/app/9.0.0/api.jar"
check "engine venv made by uv sync" test -d "$ND/app/9.0.0/engine/.venv"
check "current -> 9.0.0" link_is current 9.0.0
check "no previous yet" test ! -e "$ND/previous"

echo "update to 9.1.0"
api_says 9.1.0
out="$(k update)" || fail "update exited with an error: $out"
check "app/9.1.0 installed" test -f "$ND/app/9.1.0/api.jar"
check "current -> 9.1.0" link_is current 9.1.0
check "previous -> 9.0.0" link_is previous 9.0.0
check "9.0.0 is kept" test -f "$ND/app/9.0.0/api.jar"
check "VERSION of current is 9.1.0" test "$(cat "$ND/current/VERSION")" = 9.1.0

echo "update again (API still says 9.1.0)"
out="$(k update)" || fail "second update exited with an error: $out"
check "says newest release already" has "newest release already" "$out"
check "current still 9.1.0" link_is current 9.1.0
check "previous still 9.0.0" link_is previous 9.0.0

echo "tampered download (API says 9.2.0, wrong sha256)"
api_says 9.2.0
if out="$(k update)"; then fail "a tampered download was accepted"; else pass "update refused"; fi
check "message names the checksum" has "checksum does not match" "$out"
check "app/9.2.0 not installed" test ! -e "$ND/app/9.2.0"
check "current stays 9.1.0" link_is current 9.1.0
check "previous stays 9.0.0" link_is previous 9.0.0

echo "rollback"
out="$(k update --rollback)" || fail "rollback exited with an error: $out"
check "current -> 9.0.0" link_is current 9.0.0
check "previous -> 9.1.0" link_is previous 9.1.0
check "rollback says back to 9.0.0" has "back to keel v2 9.0.0" "$out"

echo "rollback again goes forward"
out="$(k update --rollback)" || fail "second rollback exited with an error: $out"
check "current -> 9.1.0" link_is current 9.1.0
check "previous -> 9.0.0" link_is previous 9.0.0

echo
if [ "$fails" = 0 ]; then echo "all native update checks passed"; else echo "$fails check(s) failed"; exit 1; fi
