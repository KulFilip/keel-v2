#!/usr/bin/env bash
# keel TUI's real check (docs/plans/keel-tui.md): a throw-away keel of its own (name, data volume, port, config folder,
# a scratch git repo) from an image built from this checkout, and keel TUI driven through its keyboard
# (keel2 tui --script, inside keel's container) along scripts/keel-tui-check.tui: the start screen, /workflows, /flow
# on keel's fake model to its first gate, /approve, /live, one KeelBot turn. Text captures land in docs/pictures/tui/.
# Then the keel's records are checked (the flow says "via keel TUI", writes are tui.call events) and the keel, its volume
# and its config folder are removed. The image stays: docker rmi it yourself.
# The captures keep keel's colours too (FORCE_COLOR=3: <name>.ansi beside <name>.txt; view them with cat or less -R).
# With BEFORE_JS=<an older keel-tui.mjs>, scripts/keel-tui-look.tui runs with that build and with this one, into
# docs/pictures/tui/before/ and after/, each also as a real terminal session (a pty): interactive.ansi.
#
#   scripts/test-keel-tui.sh [image]        (default keel-v2:tui-lab)
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd -P)"
image="${1:-keel-v2:tui-lab}"
export KEEL_NAME=keel-tui-lab KEEL_VOLUME=keel-tui-lab-data PORT=8099 KEEL_OPEN=0 KEEL_IMAGE="$image"
work="$(mktemp -d "${TMPDIR:-/tmp}/keel-tui-check.XXXXXX")"
export XDG_CONFIG_HOME="$work/config"
out="$src/docs/pictures/tui"
cleanup() {
  docker rm -f "$KEEL_NAME" >/dev/null 2>&1 || true
  docker volume rm "$KEEL_VOLUME" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
docker image inspect "$image" >/dev/null 2>&1 || { echo "no image $image: build it first (docker build -t $image .)" >&2; exit 1; }

# a scratch project: a small Python app in a git repo of its own
repo="$work/scratch"
mkdir -p "$repo/app"
printf '# scratch\n\nA tiny app for keel TUI'"'"'s real check.\n' > "$repo/README.md"
printf 'def main():\n    print("hello")\n\n\nif __name__ == "__main__":\n    main()\n' > "$repo/app/main.py"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=check -c user.email=check@localhost commit -qm "Initial commit"

"$src/keel2" start "$repo"
port="$(docker port "$KEEL_NAME" 8080/tcp | head -1 | sed 's/.*://')"
[ "$port" = 8099 ] || { echo "keel took port $port, not 8099" >&2; exit 1; }
curl -fs "http://127.0.0.1:$port/api/health"; echo

# the driver inside keel's container, through keel2 tui (docker exec)
docker cp "$src/scripts/keel-tui-check.tui" "$KEEL_NAME:/tmp/keel-tui-check.tui"
rc=0
FORCE_COLOR=3 COLORTERM=truecolor "$src/keel2" tui --script /tmp/keel-tui-check.tui --out /tmp/keel-tui-out --width 100 --ansi || rc=$?
# the captures of this run (before/ and after/ stay unless BEFORE_JS makes them again)
mkdir -p "$out" && find "$out" -maxdepth 1 -type f -delete
docker cp "$KEEL_NAME:/tmp/keel-tui-out/." "$out/"
# one-shot commands too, the way a script would use keel TUI
"$src/keel2" tui -c /status -c /next > "$out/14-one-shot-status-next.txt" 2>&1 || rc=$?

# the interactive path too: plain keel2 in a real terminal (a pty from script(1)) opens keel TUI (docker exec -it);
# /status, then /quit
if command -v script >/dev/null 2>&1; then
  feed() { sleep 8; printf '/status'; sleep 1; printf '\r'; sleep 4; printf '/quit'; sleep 1; printf '\r'; sleep 3; }
  case "$(uname -s)" in
    Darwin) feed | script -q "$work/tty.log" "$src/keel2" >/dev/null 2>&1 || true ;;
    *) feed | script -qfec "$src/keel2" "$work/tty.log" >/dev/null 2>&1 || true ;;
  esac
  tty_bad=0
  python3 - "$work/tty.log" "$out/16-interactive-terminal.txt" <<'PY' || tty_bad=1
import re, sys
raw = open(sys.argv[1], encoding="utf-8", errors="replace").read()
text = re.sub(r"\x1b\[[0-9;?]*[A-Za-z]|\x1b\][^\x07]*\x07|\x1b[=>]|\r", "", raw)
lines = [l.rstrip() for l in text.split("\n") if l.strip()]
ok = any("keel v2" in l for l in lines) and any(l.startswith("criteria") for l in lines)
# the start screen, then the last screen (the pty is 80 columns wide)
start = next((i for i, l in enumerate(lines) if "keel v2" in l), 0)
open(sys.argv[2], "w").write("\n".join(lines[max(0, start - 8):start + 8] + ["…"] + lines[-40:]) + "\n")
sys.exit(0 if ok else 1)
PY
  [ "$tty_bad" = 0 ] \
    || { echo "plain keel2 in a terminal did not show keel TUI and /status" >&2; rc=1; }
fi

# round 3: @mentions, a paste, the Git plugin's commands and panel (it is turned on for the project first), Fix mode's
# live diff, changes and Keep; then the same look script once with --profile (its summary in r3-11-profile.txt)
token3="$(docker exec "$KEEL_NAME" cat /data/run/internal-token)"
curl -fs -X PUT -H @<(printf 'X-Keel-Token: %s\n' "$token3") -H 'content-type: application/json' \
  --data '{"enabled":true}' "http://127.0.0.1:$port/api/projects/$(basename "$repo")/plugins/git" >/dev/null || rc=$?
docker cp "$src/scripts/keel-tui-round3.tui" "$KEEL_NAME:/tmp/keel-tui-round3.tui"
FORCE_COLOR=3 COLORTERM=truecolor "$src/keel2" tui --script /tmp/keel-tui-round3.tui --out /tmp/keel-tui-r3 --width 100 --ansi || rc=$?
docker cp "$KEEL_NAME:/tmp/keel-tui-r3/." "$out/"
docker cp "$src/scripts/keel-tui-look.tui" "$KEEL_NAME:/tmp/keel-tui-look.tui"
XDG_STATE_HOME="$work/state" "$src/keel2" tui --profile --script /tmp/keel-tui-look.tui --out /tmp/keel-tui-prof --width 100 \
  > "$out/r3-11-profile.txt" 2>&1 || rc=$?
ls "$work/state/keel2/tui-profiles/"profile-*.json >/dev/null 2>&1 || { echo "keel2 tui --profile left no profile file" >&2; rc=1; }
cp "$(ls -t "$work/state/keel2/tui-profiles/"profile-*.json | head -1)" "$out/r3-11-profile.json" 2>/dev/null || true
grep -q "startup" "$out/r3-11-profile.txt" || { echo "no profile summary" >&2; rc=1; }

# before and after: the same screens with an older build (on this computer's Node) and with this one (in keel's container)
pty() {  # pty <log> <command…>: a real terminal session, typing /help, /flows and /status, then /quit
  local log="$1"; shift
  feed() { sleep 6; for c in /help /flows /status; do printf '%s' "$c"; sleep 1; printf '\r'; sleep 3; done; printf '/quit'; sleep 1; printf '\r'; sleep 2; }
  case "$(uname -s)" in
    Darwin) feed | COLUMNS=100 LINES=40 FORCE_COLOR=3 COLORTERM=truecolor script -q "$log" "$@" >/dev/null 2>&1 || true ;;
    *) feed | COLUMNS=100 LINES=40 FORCE_COLOR=3 COLORTERM=truecolor script -qfec "$*" "$log" >/dev/null 2>&1 || true ;;
  esac
}
if [ -n "${BEFORE_JS:-}" ]; then
  mkdir -p "$out/before" "$out/after"
  KEEL_TUI_JS="$BEFORE_JS" "$src/keel2" tui --script "$src/scripts/keel-tui-look.tui" --out "$out/before" --width 100 || rc=$?
  docker cp "$src/scripts/keel-tui-look.tui" "$KEEL_NAME:/tmp/keel-tui-look.tui"
  FORCE_COLOR=3 COLORTERM=truecolor "$src/keel2" tui --script /tmp/keel-tui-look.tui --out /tmp/keel-tui-after --width 100 --ansi || rc=$?
  docker cp "$KEEL_NAME:/tmp/keel-tui-after/." "$out/after/"
  KEEL_TUI_JS="$BEFORE_JS" pty "$out/before/interactive.ansi" "$src/keel2" tui
  pty "$out/after/interactive.ansi" "$src/keel2" tui
fi

# what keel recorded: the flow started via keel TUI, and keel TUI's writes as tui.call events
api="http://127.0.0.1:$port/api"
# keel 0.18.1 answers no caller without a credential: keel's internal token, through a pipe (never on a command line)
token="$(docker exec "$KEEL_NAME" cat /data/run/internal-token)"
pid="$(curl -fs -H @<(printf 'X-Keel-Token: %s\n' "$token") "$api/projects" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
events="$(docker exec "$KEEL_NAME" sqlite3 /data/keel.db "SELECT type || ' ' || data_json FROM events WHERE project_id = '$pid' AND type IN ('thread.started', 'tui.call') ORDER BY id")"
printf '%s\n' "$events" > "$out/15-keel-records.txt"
grep -q '"via":"tui"' <<<"$events" || { echo "no event says via keel TUI" >&2; rc=1; }
grep -q '^tui.call ' <<<"$events" || { echo "no tui.call event" >&2; rc=1; }
grep -q '^thread.started .*"via":"tui"' <<<"$events" || { echo "the flow was not recorded as started via keel TUI" >&2; rc=1; }
ls "$out"/error-*.txt >/dev/null 2>&1 && { echo "the run had errors: $(ls "$out"/error-*.txt)" >&2; rc=1; }
echo "captures: $out"
exit "$rc"
