#!/usr/bin/env bash
# The README's terminal GIF (docs/keel-tui.gif): keel's terminal app, recorded from a real run on a throw-away keel of
# its own (name, data volume, port, config folder, a scratch git repo) on keel's test model, then drawn frame by frame
# in keel's colours (docs/gif/render-tui.py). The keel, its volume and its config folder are removed after.
#
#   docs/gif/record-tui.sh [image] [keel-tui.mjs]   image: default ghcr.io/miladnalbandi/keel-v2:latest;
#                                                   keel-tui.mjs: a newer build of the app to record (default: the image's)
set -euo pipefail
src="$(cd "$(dirname "$0")/../.." && pwd -P)"
image="${1:-ghcr.io/miladnalbandi/keel-v2:latest}"
app="${2:-}"
export KEEL_NAME=keel-gif-lab KEEL_VOLUME=keel-gif-lab-data PORT=8098 KEEL_OPEN=0 KEEL_IMAGE="$image"
work="$(mktemp -d "${TMPDIR:-/tmp}/keel-gif.XXXXXX")"
export XDG_CONFIG_HOME="$work/config"
cleanup() {
  docker rm -f "$KEEL_NAME" >/dev/null 2>&1 || true
  docker volume rm "$KEEL_VOLUME" >/dev/null 2>&1 || true
  rm -rf -- "$work"
}
trap cleanup EXIT

# a small shop project in a git repo of its own
repo="$work/shop"
mkdir -p "$repo/app" "$repo/tests"
printf '# shop\n\nA small shop API.\n' > "$repo/README.md"
printf 'from fastapi import FastAPI\n\napp = FastAPI()\n\n\n@app.get("/products")\ndef products():\n    return [{"id": 1, "name": "Keel mug"}]\n' > "$repo/app/main.py"
printf 'def test_products():\n    assert True\n' > "$repo/tests/test_products.py"
git -C "$repo" init -q -b main
git -C "$repo" add -A
git -C "$repo" -c user.name=demo -c user.email=demo@localhost commit -qm "A small shop API"

"$src/keel2" start "$repo"
port="$(docker port "$KEEL_NAME" 8080/tcp | head -1 | sed 's/.*://')"
[ "$port" = 8098 ] || { echo "keel took port $port, not 8098" >&2; exit 1; }
if [ -n "$app" ]; then
  docker cp "$app" "$KEEL_NAME:/tmp/keel-tui.mjs"
  docker exec -u 0 "$KEEL_NAME" sh -c 'cp /tmp/keel-tui.mjs /opt/keel-v2/cli/keel-tui.mjs && chmod 755 /opt/keel-v2/cli/keel-tui.mjs'
fi
docker cp "$src/docs/gif/keel-tui.tui" "$KEEL_NAME:/tmp/keel-tui.tui"
FORCE_COLOR=3 COLORTERM=truecolor "$src/keel2" tui --script /tmp/keel-tui.tui --out /tmp/keel-gif-out --width 110 --rows 30 --ansi
mkdir -p "$work/frames"
docker cp "$KEEL_NAME:/tmp/keel-gif-out/." "$work/frames/"
uv run -q --with pillow --with pyte python "$src/docs/gif/render-tui.py" "$work/frames" "$src/docs/keel-tui.gif"
