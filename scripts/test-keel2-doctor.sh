#!/usr/bin/env bash
# Test `keel2 doctor <project>` (0.18.57): with keel running it asks the project's doctor for the commands in
# .keel/config.yml that cannot run as written and lists each with the file and line; a clean config says so. A fake
# `docker` (its python3 is this computer's) and a fake `curl` on PATH answer; nothing runs. Demo data only.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
export XDG_CONFIG_HOME="$scratch/config" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1 KEEL_NAME=keel-doctor-test HOME="$scratch/user"
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME" "$HOME"
shop="$scratch/shop"
mkdir -p "$shop/.keel"
git -C "$shop" init -q -b main
printf 'version: 4\ncommands:\n  smoke: make smoke\n' > "$shop/.keel/config.yml"
shop="$(cd "$shop" && pwd -P)"

cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
case "$1" in
  --version) echo "Docker version 27.0.0, build x" ;;
  info) case "$*" in *ServerVersion*) echo 27.0.0 ;; *NCPU*) echo 4 ;; *MemTotal*) echo 8000000000 ;; esac; exit 0 ;;
  inspect) case "$*" in *State.Running*) echo true ;; esac; exit 0 ;;
  port) echo "127.0.0.1:8188"; exit 0 ;;
  exec)
    case "$*" in
      *internal-token*) printf 'fake-internal-token' ;;
      *" python3 "*) shift; while [ "$1" != python3 ]; do shift; done; shift; exec python3 "$@" ;;
    esac
    exit 0 ;;
  *) exit 0 ;;
esac
FAKE
cat > "$scratch/bin/curl" <<'FAKE'
#!/usr/bin/env bash
case "$*" in
  */doctor/config*) printf '%s' "$FAKE_STALE" ;;
  */projects*) printf '[{"id":"shop","root":"%s"}]' "$FAKE_ROOT" ;;
  *) printf '{}' ;;
esac
FAKE
chmod +x "$scratch/bin/docker" "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH" FAKE_ROOT="$shop"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 (no '$3' in: $2)"; fi; }

echo "keel2 doctor <project>"
export FAKE_STALE='{"stale":[{}],"lines":[".keel/config.yml:3 commands.smoke: the Makefile has no target '"'"'smoke'"'"' (make smoke)"]}'
out="$("$keel2" doctor "$shop" 2>&1)" && code=0 || code=$?
has "a stale command is named with the file and line" "$out" "stale command: .keel/config.yml:3 commands.smoke: the Makefile has no target 'smoke'"
has "it says how to fix it" "$out" "Fix them in .keel/config.yml"
[ "$code" = 1 ] && pass "a stale command is a problem (exit 1)" || fail "exit $code"

export FAKE_STALE='{"stale":[],"lines":[]}'
out="$("$keel2" doctor "$shop" 2>&1)" || true
has "a clean config says so" "$out" "the commands in .keel/config.yml are runnable as written"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
