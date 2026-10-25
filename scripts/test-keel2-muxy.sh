#!/usr/bin/env bash
# Test keel2's Muxy bridge (docs/muxy.md): `keel2 muxy hook` turns keel's waiting questions and flow results into
# Muxy notifications in Muxy's own socket format (`<type>|<pane id>|<title>|<body>`), one per event, never twice; it only
# reads keel (GET); no keel gives a clear message; --install asks first; `keel2 muxy workspace` writes Muxy's layout and
# drives the muxy command line. Everything is fake: `docker`, `curl` (keel's api and a recorded SSE stream), `uname`,
# `launchctl`, the muxy command line, and Muxy's socket (a python3 listener that records each line). Nothing real runs.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
scratch="$(mktemp -d)"
listener=""
cleanup() { [ -n "$listener" ] && kill "$listener" 2>/dev/null; rm -rf -- "$scratch"; }
trap cleanup EXIT
export XDG_CONFIG_HOME="$scratch/config" XDG_STATE_HOME="$scratch/state" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1 \
  KEEL_NAME=keel-muxy-test KEEL_LAUNCH_AGENTS_DIR="$scratch/agents" KEEL_MUXY_LOG="$scratch/hook.log" KEEL_MUXY_POLL=0.1
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME" "$scratch/proj"
unset MUXY_PANE_ID KEEL_YES || true

cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info) exit 0 ;;
  inspect) case "$*" in *State.Running*) if [ "${FAKE_DOWN:-0}" = 1 ]; then echo false; else echo true; fi ;; esac; exit 0 ;;
  port) echo "127.0.0.1:8188"; exit 0 ;;
  exec) case "$*" in *web-key*) printf 'secret-web-key' ;; *internal-token*) printf 'secret-internal-token' ;; esac; exit 0 ;;
  *) exit 0 ;;
esac
FAKE
# curl: records its arguments and the header it reads from stdin (-H @-); answers keel's api from files; with -w it adds
# the status line like `-w "\n%{http_code}"` does
cat > "$scratch/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_CALLS"
prev=""; w=0
for a in "$@"; do
  if [ "$prev" = "-H" ] && [ "$a" = "@-" ]; then cat >> "$FAKE_HEADERS"; fi
  if [ "$prev" = "-H" ] && [ "${a#@}" != "$a" ] && [ "$a" != "@-" ]; then cat "${a#@}" >> "$FAKE_HEADERS"; fi
  [ "$a" = "-w" ] && w=1
  prev="$a"
done
code="${FAKE_STATUS:-200}"
case "$*" in
  */api/events*) [ "$code" = 200 ] || exit 22; cat "$FAKE_SSE"; exit 0 ;;
  */api/inbox/count*) body="{\"count\":$(cat "$FAKE_COUNT" 2>/dev/null || echo 1),\"projects\":{}}" ;;
  */api/inbox*) body="$(cat "$FAKE_INBOX")" ;;
  */api/projects*) body='[{"id":"p1","name":"shop","root":"/workspace"},{"id":"p2","name":"bo","root":"/x"}]' ;;
  */api/notifications*) body="$(cat "$FAKE_NOTES")" ;;
  *) body='{}' ;;
esac
printf '%s' "$body"
[ "$w" = 1 ] && printf '\n%s' "$code"
exit 0
FAKE
cat > "$scratch/bin/uname" <<'FAKE'
#!/usr/bin/env bash
if [ "${1:-}" = -s ]; then echo Darwin; else /usr/bin/env -i PATH=/usr/bin:/bin uname "$@"; fi
FAKE
cat > "$scratch/bin/launchctl" <<'FAKE'
#!/usr/bin/env bash
echo "launchctl $*" >> "$FAKE_CALLS"
FAKE
# the muxy command line: records calls; split-right / split-down print a pane id, list-panes prints the panes
cat > "$scratch/bin/muxy" <<'FAKE'
#!/usr/bin/env bash
printf 'muxy' >> "$FAKE_MUXY_CALLS"; printf ' [%s]' "$@" >> "$FAKE_MUXY_CALLS"; echo >> "$FAKE_MUXY_CALLS"
case "$1" in
  create-project) printf 'ok\tid-1\tproj\t%s\n' "$2" ;;
  split-right) echo "pane-right" ;;
  split-down) echo "pane-shell" ;;
  list-panes) printf 'pane-left\tzsh\t%s\ttrue\npane-right\tkeel live\t%s\tfalse\npane-shell\tzsh\t%s\tfalse\n' "$FAKE_PROJ" "$FAKE_PROJ" "$FAKE_PROJ" ;;
  *) echo ok ;;
esac
FAKE
chmod +x "$scratch/bin/"*
export PATH="$scratch/bin:$PATH" FAKE_CALLS="$scratch/calls" FAKE_HEADERS="$scratch/headers" FAKE_MUXY_CALLS="$scratch/muxy-calls" \
  FAKE_SSE="$scratch/sse" FAKE_INBOX="$scratch/inbox" FAKE_NOTES="$scratch/notes" FAKE_COUNT="$scratch/count"
FAKE_PROJ="$(cd "$scratch/proj" && pwd -P)"; export FAKE_PROJ

# Muxy's socket: a python3 listener that appends every line it gets to $scratch/muxy
sock="$scratch/muxy.sock"; export MUXY_SOCKET_PATH="$sock"
cat > "$scratch/listener.py" <<'PY'
import socket, sys
path, out = sys.argv[1], sys.argv[2]
s = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
s.bind(path)
s.listen(8)
while True:
    c, _ = s.accept()
    c.settimeout(2)
    data = b""
    try:
        while True:
            b = c.recv(65536)
            if not b:
                break
            data += b
    except socket.timeout:
        pass
    c.close()
    with open(out, "ab") as f:
        f.write(data)
PY
start_muxy() {
  python3 -I "$scratch/listener.py" "$sock" "$scratch/muxy" & listener=$!
  for _ in $(seq 50); do [ -S "$sock" ] && return 0; sleep 0.1; done
  echo "the fake Muxy did not start"; exit 1
}
stop_muxy() { kill "$listener" 2>/dev/null || true; wait "$listener" 2>/dev/null || true; listener=""; rm -f "$sock"; }
settle() { sleep 0.4; }
lines() { if [ -f "$scratch/muxy" ]; then grep -c . "$scratch/muxy" || true; else echo 0; fi; }

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }
has() { if printf '%s' "$2" | grep -qF -- "$3"; then pass "$1"; else fail "$1 (no '$3' in: $2)"; fi; }

# keel: one waiting question in project shop; the live stream then tells about the same gate, a done flow, a started
# flow (keel's bell keeps those off) and a gate decided since
cat > "$FAKE_INBOX" <<'JSON'
{"items":[{"project_id":"p1","project_name":"shop","thread_id":"t-1","flow":"feature","kind":"gate","step":"spec_gate","id":"q-1","title":"Approve the spec?","detail":"ana wrote it","choices":["approve","send back","edit"]}],"count":1}
JSON
echo '[{"id":3,"type":"finished","project_id":"p1","title":"old news","body":"","link":"/","at":"","read":true}]' > "$FAKE_NOTES"
cat > "$FAKE_SSE" <<'SSE'
: connected

event: notification
data: {"id":4,"type":"review","project_id":"p1","title":"A gate waits for you","body":"Approve the spec?","link":"/flows/t-1","thread_id":"t-1","step":"spec_gate","done":false,"read":false}

event: notification
data: {"id":5,"type":"finished","project_id":"p1","title":"The flow is done","body":"Add a cart page.","link":"/projects/p1/flows/t-0","done":false,"read":false}

event: notification
data: {"id":6,"type":"started","project_id":"p1","title":"A flow started","body":"","link":"/","done":false,"read":false}

event: notification
data: {"id":7,"type":"review","project_id":"p2","title":"A gate waits for you","body":"","link":"/","thread_id":"t-9","step":"x","done":true,"read":false}

: ping
SSE

echo "keel2 muxy hook"
start_muxy
: > "$FAKE_CALLS"; : > "$FAKE_HEADERS"
out="$("$keel2" muxy hook --once 2>&1)" || fail "the hook failed: $out"
settle
check "a waiting question and a done flow: two notifications" "$(lines)" "2"
q="$(sed -n 1p "$scratch/muxy" 2>/dev/null)"
check "Muxy's format: type keel, no pane outside Muxy" "$(printf '%s' "$q" | cut -d'|' -f1-2)" "keel|"
check "the title names keel's project and the flow" "$(printf '%s' "$q" | cut -d'|' -f3)" "keel · shop: feature waits for you"
has "the body has the question" "$q" "Approve the spec?"
has "the body has the choices" "$q" "Choices: approve / send back / edit"
has "the body says where to answer" "$q" "Answer in keel2 tui or http://localhost:8188/inbox"
d="$(sed -n 2p "$scratch/muxy" 2>/dev/null)"
check "a done flow is a notification" "$(printf '%s' "$d" | cut -d'|' -f3)" "keel · shop: The flow is done"
has "it links to the flow" "$d" "See http://localhost:8188/projects/p1/flows/t-0"
if grep -q "A flow started\|t-9\|old news" "$scratch/muxy"; then fail "a started flow, a decided gate or old news was sent"
else pass "no notification for a started flow, a decided gate or old news"; fi
has "the hook says what it sent" "$out" "-> Muxy  keel · shop: feature waits for you"
if grep -q "Authorization: Bearer secret-web-key" "$FAKE_HEADERS"; then pass "keel2 sends the sign-in key as a Bearer header"
else fail "no Bearer header: $(cat "$FAKE_HEADERS")"; fi
if grep "^curl" "$FAKE_CALLS" | grep -q "secret-web-key"; then fail "the key was on curl's command line"; else pass "the key is never on a command line"; fi
if printf '%s' "$out" | grep -q "secret-web-key"; then fail "the key was printed"; else pass "the key is never printed"; fi
if grep "^curl" "$FAKE_CALLS" | grep -qE -- " -X | -d | --data| POST "; then fail "the hook wrote to keel: $(grep -E -- ' -X | -d |POST' "$FAKE_CALLS")"
else pass "the hook only reads keel (GET)"; fi
has "outside a terminal it follows only the bell's events" "$(grep '^curl' "$FAKE_CALLS")" "/api/events?project=*"

out="$("$keel2" muxy hook --once 2>&1)" || true
settle
check "again (a restart): nothing twice" "$(lines)" "2"

# a new question for project bo, with --project shop: not for this hook
cat > "$FAKE_INBOX" <<'JSON'
{"items":[{"project_id":"p2","project_name":"bo","thread_id":"t-2","flow":"bug","kind":"clarify","step":"clarify","id":"q-2","title":"","questions":[{"id":"a","question":"Which page breaks?","options":[{"label":"cart"},{"label":"login"}]}]}],"count":1}
JSON
"$keel2" muxy hook --once --project shop >/dev/null 2>&1 || true
settle
check "--project shop leaves out project bo" "$(lines)" "2"
"$keel2" muxy hook --once --project bo >/dev/null 2>&1 || true
settle
check "--project bo tells it" "$(lines)" "3"
has "a clarify question shows its question and options" "$(sed -n 3p "$scratch/muxy")" "Which page breaks?. Choices: cart / login"
out="$("$keel2" muxy hook --once --project nope 2>&1 || true)"
has "an unknown project is named" "$out" "keel has no project named nope. Its projects: bo, shop"

out="$(FAKE_STATUS=401 "$keel2" muxy hook --once 2>&1 || true)"
has "a refused key is said (and read again)" "$out" "keel refused the sign-in key"

out="$("$keel2" muxy hook --test 2>&1)" || fail "--test failed: $out"
settle
has "--test sends one sample notification" "$(sed -n 4p "$scratch/muxy")" "keel|"
has "the sample looks like a question" "$(sed -n 4p "$scratch/muxy")" "keel · test: a question waits for you"

out="$(MUXY_PANE_ID=pane-42 "$keel2" muxy hook --test 2>&1)" || true
settle
check "inside a Muxy pane the notification belongs to that pane" "$(sed -n 5p "$scratch/muxy" | cut -d'|' -f2)" "pane-42"

if command -v nc >/dev/null 2>&1 && { nc -h 2>&1 || true; } | grep -qE -- '-U|\[-[0-9A-Za-z]*U'; then
  echo 3 > "$FAKE_COUNT"
  out="$(KEEL_MUXY_PY=0 "$keel2" muxy hook --once 2>&1)" || true
  settle
  has "without python3: the number of waiting questions" "$(sed -n 6p "$scratch/muxy")" "keel|"
  has "  (the plain fallback's text)" "$(sed -n 6p "$scratch/muxy")" "keel: 3 question(s) wait for you"
else
  pass "without python3 (skipped: this nc has no -U)"
fi

stop_muxy
: > "$scratch/muxy"
cat > "$FAKE_INBOX" <<'JSON'
{"items":[{"project_id":"p1","project_name":"shop","thread_id":"t-3","flow":"feature","kind":"gate","step":"plan_gate","id":"q-3","title":"Approve the plan?","choices":["approve"]}],"count":1}
JSON
out="$("$keel2" muxy hook --once 2>&1)" || true
has "Muxy not running: the hook says so" "$out" "Muxy is not running"
start_muxy
"$keel2" muxy hook --once >/dev/null 2>&1 || true
settle
has "and tells it once Muxy runs" "$(cat "$scratch/muxy")" "Approve the plan?"
out="$("$keel2" muxy hook --test 2>&1 || true)"
stop_muxy
out="$("$keel2" muxy hook --test 2>&1 || true)"
has "--test without Muxy says nothing was sent" "$out" "Muxy is not running: nothing was sent"

out="$(FAKE_DOWN=1 "$keel2" muxy hook --once 2>&1 || true)"
has "no keel: a clear message" "$out" "keel is not running, so there is nothing to tell Muxy."
has "  and how to start it" "$out" "keel2 start /path/to/project"

echo "keel2 muxy hook --install"
: > "$FAKE_CALLS"
plist="$scratch/agents/dev.keel.keel2.muxy-hook.keel-muxy-test.plist"
out="$("$keel2" muxy hook --install < /dev/null 2>&1 || true)"
has "--install asks first (no answer: not installed)" "$out" "Not installed"
if [ -f "$plist" ]; then fail "a LaunchAgent was written without a yes"; else pass "nothing is written without a yes"; fi
has "  it says what it would install" "$out" "LaunchAgent"
out="$(KEEL_YES=1 "$keel2" muxy hook --install --project shop 2>&1)" || fail "--install failed: $out"
if [ -f "$plist" ]; then pass "KEEL_YES=1 installs the LaunchAgent"; else fail "no LaunchAgent: $out"; fi
has "  it runs keel2 muxy hook --wait" "$(tr -d ' \n' < "$plist")" "<string>muxy</string><string>hook</string><string>--wait</string><string>--project</string><string>shop</string>"
has "  for this keel" "$(cat "$plist")" "<key>KEEL_NAME</key><string>keel-muxy-test</string>"
if grep -q "secret" "$plist"; then fail "a key is in the LaunchAgent"; else pass "  no key in the LaunchAgent"; fi
has "  launchctl starts it" "$(cat "$FAKE_CALLS")" "launchctl bootstrap gui/"
out="$("$keel2" muxy hook --uninstall 2>&1)"
if [ -f "$plist" ]; then fail "--uninstall left the LaunchAgent"; else pass "--uninstall removes it"; fi

echo "keel2 muxy workspace"
start_muxy
: > "$FAKE_MUXY_CALLS"
out="$(KEEL_MUXY_CLI="$scratch/bin/muxy" "$keel2" muxy workspace "$scratch/proj" 2>&1)" || fail "workspace failed: $out"
layout="$FAKE_PROJ/.muxy/layouts/keel.json"
if python3 -I -c 'import json,sys; json.load(open(sys.argv[1]))' "$layout" 2>/dev/null; then pass "Muxy's layout is written as JSON"; else fail "no layout: $out"; fi
has "  left: keel2 tui" "$(cat "$layout")" "keel2 tui\""
has "  right: keel's live events" "$(cat "$layout")" "keel2 muxy hook --feed\""
has "  and a shell" "$(cat "$layout")" "\"name\": \"shell\""
calls="$(cat "$FAKE_MUXY_CALLS")"
has "it opens the folder in Muxy" "$calls" "muxy [create-project] [$FAKE_PROJ]"
has "it splits keel's live events to the right" "$calls" "muxy [split-right] [--project] [$FAKE_PROJ]"
has "  a shell below them" "$calls" "muxy [split-down] [--from] [pane-right]"
has "  and starts keel2 tui in the first pane" "$calls" "muxy [send] [--pane] [pane-left]"
has "  with Enter" "$calls" "muxy [send-keys] [--pane] [pane-left] [Enter]"
has "it says what it made" "$out" "keel2 tui (left)"

echo '{"mine": true}' > "$layout"
: > "$FAKE_MUXY_CALLS"
out="$(KEEL_MUXY_CLI="$scratch/bin/muxy" "$keel2" muxy workspace "$scratch/proj" --layout-only 2>&1)"
check "a different layout is left as it is" "$(cat "$layout")" '{"mine": true}'
has "  and it says so" "$out" "left as it is (--force writes keel's)"
check "--layout-only does not drive Muxy" "$(cat "$FAKE_MUXY_CALLS")" ""
has "  it prints the steps" "$out" "top bar › Layouts › keel"
"$keel2" muxy workspace "$scratch/proj" --layout-only --force >/dev/null 2>&1
has "--force writes keel's" "$(cat "$layout")" "keel live"
stop_muxy

out="$("$keel2" muxy nope 2>&1 || true)"
has "an unknown muxy command says how to use it" "$out" "usage: keel2 muxy hook"
has "keel2 help lists muxy" "$("$keel2" help)" "keel2 muxy workspace"

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
