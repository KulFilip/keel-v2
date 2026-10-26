#!/usr/bin/env bash
# Test keel2's mounts for git worktrees (v0.18.17): a project folder whose .git is a file ("gitdir: …/.git/worktrees/x")
# gets its repository's common git dir mounted too, at the same path, so git works inside keel's container; a plain repo
# gets nothing extra, and two worktrees of one repository mount it once. A fake `docker` and a fake `curl` on PATH record
# every call; nothing runs (no container, no image, no network).
set -euo pipefail

here="$(cd "$(dirname "$0")/.." && pwd -P)"
keel2="$here/keel2"
scratch="$(cd "$(mktemp -d)" && pwd -P)"
trap 'rm -rf -- "$scratch"' EXIT
export XDG_CONFIG_HOME="$scratch/config" KEEL2_HOME="$scratch/home" KEEL_OPEN=0 NO_COLOR=1 \
  KEEL_NAME=keel-worktree-test KEEL_VOLUME=keel-worktree-test-data PORT=18977
mkdir -p "$scratch/bin" "$XDG_CONFIG_HOME" "$KEEL2_HOME"

# docker: no container exists (inspect fails), the image is there, every call is recorded
cat > "$scratch/bin/docker" <<'FAKE'
#!/usr/bin/env bash
echo "docker $*" >> "$FAKE_CALLS"
case "$1" in
  info) exit 0 ;;
  image) exit 0 ;;
  inspect) exit 1 ;;
  *) exit 0 ;;
esac
FAKE
cat > "$scratch/bin/curl" <<'FAKE'
#!/usr/bin/env bash
echo "curl $*" >> "$FAKE_CALLS"
printf '{}'
FAKE
chmod +x "$scratch/bin/docker" "$scratch/bin/curl"
export PATH="$scratch/bin:$PATH" FAKE_CALLS="$scratch/calls"

g() { git -c user.name=t -c user.email=t@t -c init.defaultBranch=main "$@" >/dev/null 2>&1; }
g init -q "$scratch/main"
echo x > "$scratch/main/README.md"
g -C "$scratch/main" add -A
g -C "$scratch/main" commit -qm start
g -C "$scratch/main" worktree add -q -b wt1 "$scratch/wt1"
g -C "$scratch/main" worktree add -q -b wt2 "$scratch/wt2"
g init -q "$scratch/plain"
common="$scratch/main/.git"

fails=0
pass() { printf '  ok   %s\n' "$1"; }
fail() { printf '  FAIL %s\n' "$1"; fails=$((fails + 1)); }
run_line() { grep '^docker run -d ' "$FAKE_CALLS" | tail -1; }
start() { : > "$FAKE_CALLS"; "$keel2" start "$@" >"$scratch/out" 2>&1 || { cat "$scratch/out"; return 1; }; }

echo "keel2 mounts for git worktrees"
[ -f "$scratch/wt1/.git" ] || { echo "git did not make a worktree (.git is not a file)"; exit 1; }

start "$scratch/wt1"
line="$(run_line)"
case "$line" in *"-v $scratch/wt1:/workspace "*) pass "the worktree is the project at /workspace" ;; *) fail "no /workspace mount: $line" ;; esac
case "$line" in *"-v $common:$common "*) pass "its repository's git dir is mounted at the same path" ;; *) fail "no git dir mount: $line" ;; esac

start "$scratch/plain"
case "$(run_line)" in *"$common"*) fail "a plain repo got a git dir mount: $(run_line)" ;; *) pass "a plain repo gets no extra mount" ;; esac

"$keel2" add "$scratch/wt1" "$scratch/wt2" >/dev/null 2>&1
start "$scratch/plain"
line="$(run_line)"
case "$line" in *"-v $scratch/wt1:$scratch/wt1 "*"-v $scratch/wt2:$scratch/wt2 "*) pass "added worktrees are mounted at their path" ;; *) fail "added folders missing: $line" ;; esac
n="$(printf '%s\n' "$line" | grep -o -- "-v $common:$common " | wc -l | tr -d ' ')"
if [ "$n" = 1 ]; then pass "two worktrees of one repository mount it once"; else fail "the git dir is mounted $n times: $line"; fi
case "$line" in *"KEEL_FOLDERS=/workspace:$scratch/wt1:$scratch/wt2 "*) pass "KEEL_FOLDERS lists only the project folders" ;; *) fail "KEEL_FOLDERS: $line" ;; esac

echo "keel2 tells keel where the project is on this computer (0.18.57: one project across plain and --docker)"
start "$scratch/plain"
case "$(run_line)" in *"KEEL_HOST_WORKSPACE=$scratch/plain "*"-v $scratch/plain:/workspace "*) pass "plain: /workspace is $scratch/plain" ;; *) fail "plain: no KEEL_HOST_WORKSPACE: $(run_line)" ;; esac
start --docker "$scratch/plain"
case "$(run_line)" in *"KEEL_HOST_WORKSPACE=$scratch/plain "*) pass "--docker: the same host path" ;; *) fail "--docker: no KEEL_HOST_WORKSPACE: $(run_line)" ;; esac

[ "$fails" = 0 ] && echo "all passed" || { echo "$fails failed"; exit 1; }
