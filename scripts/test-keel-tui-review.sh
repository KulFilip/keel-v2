#!/usr/bin/env bash
# keel TUI's review mode, a real check (keel 0.18.6, docs/plugins/25-tui-plugins.md "Modes"): a throw-away keel of its
# own (name, data volume, port, config folder, a scratch git repo on a branch) from an image built from this checkout,
# the Code Review plugin turned on for the project, and keel TUI driven through its keyboard in the full screen
# (keel2 tui --script --rows, inside keel's container) along scripts/keel-tui-review.tui. Text captures land in
# docs/pictures/tui/review/. Then the keel's records are checked (the draft and the viewed mark are in keel's database)
# and the keel, its volume and its config folder are removed. The image stays: docker rmi it yourself.
#
#   scripts/test-keel-tui-review.sh [image]        (default keel-v2:review-mode)
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd -P)"
image="${1:-keel-v2:review-mode}"
export KEEL_NAME=keel-review-lab KEEL_VOLUME=keel-review-lab-data PORT=8096 KEEL_OPEN=0 KEEL_IMAGE="$image"
work="$(mktemp -d "${TMPDIR:-/tmp}/keel-review-check.XXXXXX")"
export XDG_CONFIG_HOME="$work/config"
out="$src/docs/pictures/tui/review"
cleanup() {
  docker rm -f "$KEEL_NAME" >/dev/null 2>&1 || true
  docker volume rm "$KEEL_VOLUME" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT
docker image inspect "$image" >/dev/null 2>&1 || { echo "no image $image: build it first (docker build -t $image .)" >&2; exit 1; }

# a scratch project on a branch with two commits against main
repo="$work/shop"
mkdir -p "$repo/src"
printf '# shop\n' > "$repo/README.md"
printf 'class Prefs {\n    fun pageSize(user: String) = 20\n}\n' > "$repo/src/Prefs.kt"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=check -c user.email=check@localhost commit -qm "Initial commit"
git -C "$repo" switch -q -c feat/paging
printf 'class Prefs {\n    private val cache = mutableMapOf<String, Int>()\n    fun savePageSize(user: String, size: Int) {\n        cache[user] = size\n    }\n    fun pageSize(user: String) = cache[user] ?: 20\n}\n' > "$repo/src/Prefs.kt"
git -C "$repo" -c user.name=check -c user.email=check@localhost commit -qam "Save the page size"
printf 'class PrefsTest {\n    fun saves() { Prefs().savePageSize("a", 50) }\n}\n' > "$repo/src/PrefsTest.kt"
git -C "$repo" add -A
git -C "$repo" -c user.name=check -c user.email=check@localhost commit -qm "Test it"

"$src/keel2" start "$repo"
port="$(docker port "$KEEL_NAME" 8080/tcp | head -1 | sed 's/.*://')"
[ "$port" = 8096 ] || { echo "keel took port $port, not 8096" >&2; exit 1; }
api="http://127.0.0.1:$port/api"
# keel 0.18.1 answers no caller without a credential: keel's internal token, through a pipe (never on a command line)
token="$(docker exec "$KEEL_NAME" cat /data/run/internal-token)"
auth() { printf 'X-Keel-Token: %s\n' "$token"; }
pid="$(curl -fs -H @<(auth) "$api/projects" | python3 -c 'import json,sys; print(json.load(sys.stdin)[0]["id"])')"
curl -fs -X PUT -H @<(auth) -H 'content-type: application/json' --data '{"enabled":true}' "$api/projects/$pid/plugins/review" >/dev/null
curl -fs -H @<(auth) "$api/tui/plugins?project=$pid" | python3 -c '
import json, sys
d = json.load(sys.stdin)
modes = [m["name"] for p in d["plugins"] for m in p.get("modes") or []]
assert "review" in modes, d
print("keel TUI gets the modes:", modes, "problems:", d["problems"])'

docker cp "$src/scripts/keel-tui-review.tui" "$KEEL_NAME:/tmp/keel-tui-review.tui"
rc=0
FORCE_COLOR=3 COLORTERM=truecolor "$src/keel2" tui --script /tmp/keel-tui-review.tui --out /tmp/keel-tui-review --width 100 --rows 30 --ansi || rc=$?
mkdir -p "$out" && find "$out" -maxdepth 1 -type f -delete
docker cp "$KEEL_NAME:/tmp/keel-tui-review/." "$out/"

# what keel recorded: the draft on line 3 and the viewed mark (keel's own tables), the writes as tui.call events
db() { docker exec "$KEEL_NAME" sqlite3 /data/keel.db "$1"; }
drafts="$(db "SELECT review_key || ' ' || path || ':' || line || ' ' || side || ' ' || body FROM review_drafts WHERE project_id = '$pid'")"
viewed="$(db "SELECT review_key || ' ' || path FROM review_viewed WHERE project_id = '$pid'")"
calls="$(db "SELECT data_json FROM events WHERE project_id = '$pid' AND type = 'tui.call' ORDER BY id")"
printf 'drafts:\n%s\nviewed:\n%s\ntui.call events:\n%s\n' "$drafts" "$viewed" "$calls" > "$out/rv-16-keel-records.txt"
grep -q '^branch:feat/paging src/Prefs.kt:3 RIGHT The size should come from the settings$' <<<"$drafts" || { echo "no draft on src/Prefs.kt:3" >&2; rc=1; }
grep -q '^branch:feat/paging src/Prefs.kt$' <<<"$viewed" || { echo "src/Prefs.kt is not marked viewed" >&2; rc=1; }
grep -q 'review/drafts' <<<"$calls" || { echo "no tui.call event for the draft" >&2; rc=1; }
ls "$out"/error-*.txt >/dev/null 2>&1 && { echo "the run had errors: $(ls "$out"/error-*.txt)" >&2; rc=1; }
echo "captures: $out"
exit "$rc"
