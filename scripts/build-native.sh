#!/usr/bin/env bash
# Build keel v2's native release: keel-v2-<version>-native.tar.gz (+ .sha256) in <out dir> (default: dist/).
#
#   api.jar            the api with the web app inside (the same bootJar as the image)
#   engine/            the engine's source, pyproject.toml and uv.lock (keel2 runs `uv sync --frozen` on install)
#   content/           agents, skills, stacks, templates
#   keel-native-start  starts the engine and the api (docker/keel-native-start)
#   VERSION
#
# Needs JDK 21 and Node 20+ (npm). The release job in .github/workflows/docker.yml uploads the two files.
set -euo pipefail
src="$(cd "$(dirname "$0")/.." && pwd -P)"
out="${1:-$src/dist}"
version="$(sed -n 's/^version = "\(.*\)"/\1/p' "$src/engine/pyproject.toml" | head -1)"
[ -n "$version" ] || { echo "no version in engine/pyproject.toml" >&2; exit 1; }
work="$(mktemp -d)"
trap 'rm -rf -- "$work"' EXIT
stage="$work/keel-v2-$version"
mkdir -p "$stage" "$out"

echo "web…"
(cd "$src/web" && { [ -d node_modules ] || npm ci --no-audit --no-fund; } && npm run build >/dev/null)
echo "api…"
# built from a copy, as the image does: the web app goes into the copy's static/ (the checkout's own stays untouched);
# bootJar compiles and packs, it does not run the tests
(cd "$src/api" && tar --exclude ./build --exclude ./.gradle --exclude ./.kotlin -cf - .) | (mkdir -p "$work/api" && cd "$work/api" && tar -xf -)
rm -rf "$work/api/src/main/resources/static"
cp -R "$src/web/dist" "$work/api/src/main/resources/static"
(cd "$work/api" && ./gradlew --no-daemon -q bootJar)
cp "$(ls "$work"/api/build/libs/*.jar | grep -v -- '-plain' | head -1)" "$stage/api.jar"

echo "engine, content…"
mkdir -p "$stage/engine"
cp "$src/engine/pyproject.toml" "$src/engine/uv.lock" "$stage/engine/"
(cd "$src/engine" && tar --exclude '__pycache__' --exclude '.pytest_cache' -cf - keel_engine) | (cd "$stage/engine" && tar -xf -)
cp -R "$src/content" "$stage/content"
cp "$src/docker/keel-native-start" "$stage/keel-native-start"
chmod +x "$stage/keel-native-start"
printf '%s\n' "$version" > "$stage/VERSION"

name="keel-v2-$version-native.tar.gz"
tar -C "$work" -czf "$out/$name" "keel-v2-$version"
(cd "$out" && { command -v sha256sum >/dev/null && sha256sum "$name" || shasum -a 256 "$name"; } > "$name.sha256")
echo "$out/$name"
