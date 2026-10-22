#!/usr/bin/env bash
# Test keel2 backup and restore (docker and native) with a fake `docker`, `curl` and a tar that can fail. Nothing real runs.
#   - a damaged or foreign archive never costs the data, and keel is started again
#   - a good archive is restored (old files gone, the stacks' cache kept), the backup file is private (600)
#   - a failing or interrupted backup leaves no file and keel running; agents at work are asked about first
#   - native restore returns non-zero when it fails
# The fake docker runs `docker run ... sh -c / tar` on this computer: /data, /in and /out are mapped to scratch folders.
# KEEL2_BIN=<file> runs another copy of keel2 (to see this test fail on the old one).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="${KEEL2_BIN:-$here/keel2}"
real_tar="$(command -v tar)"
scratch="$(mktemp -d)"
trap 'rm -rf -- "$scratch"' EXIT
export XDG_CONFIG_HOME="$scratch/config" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1 KEEL_NATIVE_CLIS=0
export KEEL_NAME=keel-test-bk KEEL_VOLUME=test-data KEEL_YES=1
export FAKE_CALLS="$scratch/calls" FAKE_STATE="$scratch/running" FAKE_VOLS="$scratch/vols" REAL_TAR="$real_tar"
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME" "$FAKE_VOLS" "$scratch/out"

cat > "$scratch/bin/docker" <<'EOF'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info|volume) exit 0 ;;
  inspect) case "$*" in *State.Running*) cat "$FAKE_STATE"; exit 0 ;; esac; exit 1 ;;
  ps) exit 0 ;;
  exec) echo faketoken ;;
  stop) echo false > "$FAKE_STATE" ;;
  start) echo true > "$FAKE_STATE" ;;
  run)
    shift; mounts=(); ep=""
    while [ $# -gt 0 ]; do
      case "$1" in --rm) shift ;; -v) mounts+=("$2"); shift 2 ;; --entrypoint) ep="$2"; shift 2 ;; *) break ;; esac
    done
    shift  # the image
    args=(); prev=""
    for a in "$@"; do
      for m in "${mounts[@]}"; do
        src="${m%%:*}"; rest="${m#*:}"; dst="${rest%%:*}"
        case "$src" in /*) ;; *) src="$FAKE_VOLS/$src" ;; esac
        case "$a" in "$dst") a="$src" ;; "$dst"/*) a="$src${a#"$dst"}" ;; esac
        if [ "$prev" = -c ]; then a="${a//"$dst"\//$src/}"; a="${a//"$dst "/$src }"; a="${a//\"$dst\"/\"$src\"}"; fi  # paths inside a sh -c script
      done
      args+=("$a"); prev="$a"
    done
    if [ "${FAKE_KILL:-0}" = 1 ]; then kill -TERM "$PPID"; sleep 2; exit 143; fi
    exec "$ep" "${args[@]}" ;;
esac
exit 0
EOF
cat > "$scratch/bin/curl" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_BUSY:-0}" = 1 ]; then echo '[{"agent":"coder"},{"agent":"reviewer"}]'; else echo '[]'; fi
EOF
cat > "$scratch/bin/tar" <<'EOF'
#!/usr/bin/env bash
if [ "${FAKE_TAR_FAIL:-0}" = 1 ]; then
  for a in "$@"; do if [ "$a" = -czf ]; then for b in "$@"; do case "$b" in *.part.*|/*/out/*) echo partial > "$b" ;; esac; done; echo "tar: fake failure" >&2; exit 2; fi; done
fi
exec "$REAL_TAR" "$@"
EOF
chmod +x "$scratch/bin/docker" "$scratch/bin/curl" "$scratch/bin/tar"
export PATH="$scratch/bin:$PATH"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
check() { if [ "$2" = "$3" ]; then pass "$1"; else fail "$1 (got '$2', want '$3')"; fi; }
mode_of() { stat -c %a "$1" 2>/dev/null || stat -f %Lp "$1"; }
snap() { (cd "$1" && { find . | LC_ALL=C sort; find . -type f -exec cat {} +; }) | cksum; }
called() { grep -q -- "$1" "$FAKE_CALLS"; }
run_k() {  # run_k <env…> -- <args…>: keel2 with extra environment; sets rc and out
  local envs=(); while [ "$1" != -- ]; do envs+=("$1"); shift; done; shift
  rc=0; out="$(env ${envs[@]+"${envs[@]}"} "$keel2" "$@" 2>&1)" || rc=$?
}

vol="$FAKE_VOLS/test-data"
reset_volume() {
  rm -rf "$vol"; mkdir -p "$vol/cache" "$vol/stacks"
  echo OLD-DB > "$vol/keel.db"; echo OLD-KEY > "$vol/master.key"; echo OLD-ONLY > "$vol/old-only.txt"
  echo apt > "$vol/cache/apt.deb"; echo s > "$vol/stacks/s.txt"
  echo true > "$FAKE_STATE"; : > "$FAKE_CALLS"
}

# archives
mkdir -p "$scratch/new/stacks"
echo NEW-DB > "$scratch/new/keel.db"; echo NEW-KEY > "$scratch/new/master.key"; echo n > "$scratch/new/stacks/n.txt"
"$real_tar" -czf "$scratch/good.tgz" -C "$scratch/new" .
head -c 4000 /dev/urandom > "$scratch/random.tgz"
"$real_tar" -czf "$scratch/big.tgz" -C "$scratch/new" . ; head -c 100 "$scratch/big.tgz" > "$scratch/truncated.tgz"
mkdir -p "$scratch/other"; echo x > "$scratch/other/readme.txt"; "$real_tar" -czf "$scratch/foreign.tgz" -C "$scratch/other" .
mkdir -p "$scratch/dangling"; ln -s /no/such/file "$scratch/dangling/keel.db"; "$real_tar" -czf "$scratch/dangling.tgz" -C "$scratch/dangling" .

echo "docker restore: an archive that is not a keel backup changes nothing"
for bad in random truncated foreign dangling; do
  reset_volume; before="$(snap "$vol")"
  run_k -- restore "$scratch/$bad.tgz"
  [ "$rc" != 0 ] && pass "$bad.tgz: non-zero exit" || fail "$bad.tgz: exit was 0 ($out)"
  check "$bad.tgz: data untouched" "$(snap "$vol")" "$before"
  check "$bad.tgz: keel is running" "$(cat "$FAKE_STATE")" true
done

echo "docker restore: a good archive"
reset_volume
run_k -- restore "$scratch/good.tgz"
check "exit 0" "$rc" 0
check "keel.db is the new one" "$(cat "$vol/keel.db")" NEW-DB
check "files only in the old data are gone" "$([ -e "$vol/old-only.txt" ] && echo there || echo gone)" gone
check "the stacks' cache is kept" "$(cat "$vol/cache/apt.deb")" apt
check "new folders arrive" "$(cat "$vol/stacks/n.txt")" n
check "no work files left" "$(ls -A "$vol" | grep -c '^\.restore' || true)" 0
check "keel is running again" "$(cat "$FAKE_STATE")" true
called "docker stop" && pass "keel was stopped for it" || fail "keel was not stopped"
has_restored=0; grep -q "restored from" <<<"$out" && has_restored=1; check "says restored" "$has_restored" 1

echo "docker restore: agents at work"
reset_volume; before="$(snap "$vol")"
run_k FAKE_BUSY=1 -- restore "$scratch/good.tgz"
[ "$rc" != 0 ] && pass "refused without a yes" || fail "went on while agents work"
check "data untouched" "$(snap "$vol")" "$before"
called "docker stop" && fail "keel was stopped" || pass "keel was not stopped"
reset_volume
run_k FAKE_BUSY=1 KEEL_FORCE=1 -- restore "$scratch/good.tgz"
check "KEEL_FORCE=1 goes on" "$rc" 0

echo "docker backup"
reset_volume
run_k -- backup "$scratch/out/b.tgz"
check "exit 0" "$rc" 0
check "file mode is 600" "$(mode_of "$scratch/out/b.tgz")" 600
"$real_tar" -tzf "$scratch/out/b.tgz" | grep -q 'keel.db' && pass "the backup holds keel.db" || fail "keel.db missing in the backup"
"$real_tar" -tzf "$scratch/out/b.tgz" | grep -q 'cache' && fail "the cache is in the backup" || pass "the cache is not in the backup"
check "no .part file left" "$(ls "$scratch/out" | grep -c part || true)" 0
check "keel is running again" "$(cat "$FAKE_STATE")" true
called "docker stop" && called "docker start" && pass "stopped for the copy, then started" || fail "stop/start missing"
rm -f "$scratch/out"/*

echo "docker backup: the copy fails"
reset_volume
run_k FAKE_TAR_FAIL=1 -- backup "$scratch/out/b.tgz"
[ "$rc" != 0 ] && pass "non-zero exit" || fail "exit was 0"
check "no file left (not even a partial one)" "$(ls -A "$scratch/out" | wc -l | tr -d ' ')" 0
check "keel is running again" "$(cat "$FAKE_STATE")" true

echo "docker backup: killed while keel is stopped"
reset_volume
run_k FAKE_KILL=1 -- backup "$scratch/out/b.tgz"
[ "$rc" != 0 ] && pass "non-zero exit" || fail "exit was 0"
check "no file left" "$(ls -A "$scratch/out" | wc -l | tr -d ' ')" 0
check "keel is running again" "$(cat "$FAKE_STATE")" true

echo "docker backup: agents at work"
reset_volume
run_k FAKE_BUSY=1 -- backup "$scratch/out/b.tgz"
[ "$rc" != 0 ] && pass "refused without a yes" || fail "went on while agents work"
called "docker stop" && fail "keel was stopped" || pass "keel was not stopped"
check "no file left" "$(ls -A "$scratch/out" | wc -l | tr -d ' ')" 0

echo "native backup and restore"
ND="$KEEL2_HOME/$KEEL_NAME"; data="$ND/data"
reset_native() { echo false > "$FAKE_STATE"; rm -rf "$ND"; mkdir -p "$data/stacks" "$ND/run"; echo native > "$ND/mode"; echo "$scratch" > "$ND/project"
  echo OLD-DB > "$data/keel.db"; echo OLD-KEY > "$data/master.key"; echo OLD-ONLY > "$data/old-only.txt"; }
for bad in random truncated foreign dangling; do
  reset_native; before="$(snap "$data")"
  run_k -- restore "$scratch/$bad.tgz"
  [ "$rc" != 0 ] && pass "native $bad.tgz: non-zero exit" || fail "native $bad.tgz: exit was 0 ($out)"
  check "native $bad.tgz: data untouched" "$(snap "$data")" "$before"
done
reset_native
run_k -- restore "$scratch/good.tgz"
check "native good archive: exit 0" "$rc" 0
check "native: keel.db is the new one" "$(cat "$data/keel.db")" NEW-DB
check "native: old-only file gone" "$([ -e "$data/old-only.txt" ] && echo there || echo gone)" gone
check "native: no work files left" "$(ls -A "$data" | grep -c '^\.restore' || true)" 0
reset_native
run_k -- backup "$scratch/out/n.tgz"
check "native backup: exit 0" "$rc" 0
check "native backup: mode 600" "$(mode_of "$scratch/out/n.tgz")" 600
"$real_tar" -tzf "$scratch/out/n.tgz" | grep -q keel.db && pass "native backup holds keel.db" || fail "native backup lacks keel.db"
rm -f "$scratch/out"/*
run_k FAKE_TAR_FAIL=1 -- backup "$scratch/out/n.tgz"
[ "$rc" != 0 ] && pass "native backup failure: non-zero exit" || fail "native backup failure: exit was 0"
check "native backup failure: no file left" "$(ls -A "$scratch/out" | wc -l | tr -d ' ')" 0

echo
if [ "$fails" = 0 ]; then echo "all backup and restore checks passed"; else echo "$fails check(s) failed"; exit 1; fi
