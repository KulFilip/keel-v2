#!/usr/bin/env bash
# Test keel2's data volume (v0.17.2): a keel with its own KEEL_NAME gets its own volume (<name>-data), an existing
# container keeps the volume it has, KEEL_VOLUME wins, and keel2 refuses to use (or delete) a data volume another running
# container uses. A fake `docker` on PATH answers from environment variables and records every call; nothing runs.
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
export XDG_CONFIG_HOME="$scratch/config" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME"

# FAKE_CONTAINER=1: this keel's container exists; FAKE_RUNNING=true|false; FAKE_CONTAINER_VOLUME: the volume it mounts
# at /data; FAKE_PS: "name:volume ..." of the running containers.
cat > "$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info) exit 0 ;;
  inspect)
    [ "${FAKE_CONTAINER:-0}" = 1 ] || exit 1
    case "$*" in
      *Mounts*) printf '%s\n' "${FAKE_CONTAINER_VOLUME:-}" ;;
      *State.Running*) printf '%s\n' "${FAKE_RUNNING:-false}" ;;
    esac
    exit 0 ;;
  ps)
    want=""
    for a in "$@"; do case "$a" in volume=*) want="${a#volume=}" ;; esac; done
    for c in ${FAKE_PS:-}; do [ "${c#*:}" = "$want" ] && printf '%s\n' "${c%%:*}"; done
    exit 0 ;;
  *) exit 0 ;;
esac
EOF
chmod +x "$scratch/bin/docker"
export PATH="$scratch/bin:$PATH" FAKE_CALLS="$scratch/calls"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
volume_of() {  # the volume `keel2 status` reports for a running container
  env "$@" FAKE_CONTAINER=1 FAKE_RUNNING=true "$keel2" status 2>&1 | sed -n 's/.*data *volume //p'
}
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }

echo "keel2 data volume"
check "the default keel keeps keel-data" "$(volume_of KEEL_NAME=keel-v2)" "keel-data"
check "another name gets its own volume" "$(volume_of KEEL_NAME=keel-lab)" "keel-lab-data"
check "KEEL_VOLUME wins" "$(volume_of KEEL_NAME=keel-lab KEEL_VOLUME=lab-x)" "lab-x"
check "an existing container keeps the volume it has" "$(volume_of KEEL_NAME=keel-lab FAKE_CONTAINER_VOLUME=keel-data)" "keel-data"

: > "$FAKE_CALLS"
out="$(KEEL_NAME=keel-lab FAKE_CONTAINER=1 FAKE_CONTAINER_VOLUME=keel-data FAKE_PS="keel-v2:keel-data keel-lab:keel-data" \
  "$keel2" uninstall --all 2>&1 || true)"
if printf '%s' "$out" | grep -q "in use by the running container keel-v2"; then pass "uninstall --all refuses a volume another keel uses"
else fail "uninstall --all did not refuse: $out"; fi
if grep -q "docker rm\|docker volume rm" "$FAKE_CALLS"; then fail "uninstall removed something: $(grep 'rm' "$FAKE_CALLS")"
else pass "nothing was removed"; fi

out="$(KEEL_NAME=keel-v2 FAKE_CONTAINER=1 FAKE_CONTAINER_VOLUME=keel-data FAKE_PS="keel-v2:keel-data" "$keel2" uninstall --all 2>&1 || true)"
if printf '%s' "$out" | grep -q "in use by"; then fail "a keel's own container counted as another user: $out"
else pass "a keel's own container is not another user of its volume"; fi

out="$(KEEL_NAME=keel-lab FAKE_PS="keel-v2:keel-data" "$keel2" uninstall --all 2>&1 || true)"
if printf '%s' "$out" | grep -q "in use by"; then fail "keel-lab-data was reported in use: $out"
else pass "a new name's own volume is free while keel-v2 runs on keel-data"; fi

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
