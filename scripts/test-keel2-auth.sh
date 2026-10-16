#!/usr/bin/env bash
# Test keel2's sign-in (v0.18.1, docs/plans/agent-clients.md section 0): keel2 sends keel's internal token to the api
# (never on a command line), `keel2 open` opens a one-time sign-in link, --print prints it, --dev points it at the web's
# dev server, and an older keel without sign-in gets the plain page. A fake `docker` and a fake `curl` on PATH answer
# from environment variables and record every call; nothing runs.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
export XDG_CONFIG_HOME="$scratch/config" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1 KEEL_NAME=keel-auth-test
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME"

cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info) exit 0 ;;
  inspect) case "$*" in *State.Running*) echo true ;; esac; exit 0 ;;
  port) echo "127.0.0.1:8188"; exit 0 ;;
  exec) case "$*" in *internal-token*) printf 'secret-internal-token' ;; *web-key*) printf 'secret-web-key' ;; esac; exit 0 ;;
  *) exit 0 ;;
esac
FAKE
# curl: records its arguments and the headers it reads from -H @file; answers /web/code unless FAKE_OLD=1
cat > "$scratch/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_CALLS"
prev=""
for a in "$@"; do
  if [ "$prev" = "-H" ] && [ "${a#@}" != "$a" ]; then cat "${a#@}" >> "$FAKE_HEADERS"; fi
  prev="$a"
done
case "$*" in
  */api/web/code*) [ "${FAKE_OLD:-0}" = 1 ] && exit 22; printf '{"code":"c0de","path":"/web/login?code=c0de","expires_in":60}' ;;
  */api/connections*) printf '{"providers":[]}' ;;
  *) printf '{}' ;;
esac
FAKE
chmod +x "$scratch/bin/docker" "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH" FAKE_CALLS="$scratch/calls" FAKE_HEADERS="$scratch/headers"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

echo "keel2 sign-in"
: > "$FAKE_CALLS"; : > "$FAKE_HEADERS"
check "open --print prints a one-time sign-in link" "$("$keel2" open --print 2>/dev/null)" "http://localhost:8188/web/login?code=c0de"
if grep -q "X-Keel-Token: secret-internal-token" "$FAKE_HEADERS"; then pass "keel2 sends keel's internal token"
else fail "no internal token was sent: $(cat "$FAKE_HEADERS")"; fi
if grep "^curl" "$FAKE_CALLS" | grep -q "secret-internal-token"; then fail "the token was on curl's command line"
else pass "the token is never on a command line"; fi

check "--dev points the link at the web's dev server" "$("$keel2" open --print --dev 2>/dev/null)" "http://localhost:5173/web/login?code=c0de"
check "an older keel (no sign-in yet) gets the plain page" "$(FAKE_OLD=1 "$keel2" open --print 2>/dev/null)" "http://localhost:8188"

: > "$FAKE_HEADERS"
"$keel2" tokens >/dev/null 2>&1 || true
if grep -q "X-Keel-Token: secret-internal-token" "$FAKE_HEADERS"; then pass "keel2 tokens reads with the token too"
else fail "keel2 tokens sent no token"; fi

check "keel2 auth key prints the sign-in key (for your own terminal apps)" "$("$keel2" auth key 2>/dev/null)" "secret-web-key"

out="$("$keel2" open --nope 2>&1 || true)"
if printf '%s' "$out" | grep -q "usage: keel2 open"; then pass "an unknown option says how to use it"; else fail "no usage: $out"; fi
out="$("$keel2" auth 2>&1 || true)"
if printf '%s' "$out" | grep -q "usage: keel2 auth reset"; then pass "keel2 auth says what it does"; else fail "no usage: $out"; fi

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
