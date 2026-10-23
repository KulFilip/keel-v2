#!/usr/bin/env bash
# Record docs/keel-android.gif: the Android app's demo on an emulator (dark theme, 1080x2400), tapped like a person.
# Needs: a booted emulator or a phone with the app installed (./gradlew :app:assemblePhone, adb install), and ffmpeg.
# The demo data is made up; never record a real keel's projects or reviews.
set -euo pipefail
A="${ADB:-adb}"
out="$(cd "$(dirname "$0")/.." && pwd)/keel-android.gif"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
"$A" shell cmd uimode night yes >/dev/null
"$A" shell am force-stop dev.keel.android
"$A" shell am start -n dev.keel.android/.MainActivity --ez demo true --es open inbox >/dev/null
sleep 4
"$A" shell 'screenrecord --bit-rate 8000000 --time-limit 60 /sdcard/keel.mp4' &
rec=$!
sleep 1.5
t() { "$A" shell input tap "$1" "$2"; sleep "$3"; }
sw() { "$A" shell input swipe 540 "$1" 540 "$2" 450; sleep "$3"; }
back() { "$A" shell input keyevent 4; sleep "$1"; }
sleep 1.5
t 540 1032 2.2; sw 1900 900 1.6; t 540 2148 2.0; t 538 641 2.6; sw 1800 1000 1.8   # inbox → spec gate → Approve → the flow
back 1.0; back 1.2; t 676 2256 2.2; t 538 480 2.4; t 540 346 1.8; t 540 560 2.6; sw 1600 1000 2.0   # PRs → #409 → Files → a diff
back 1.0; back 1.2; t 946 2256 2.8; t 713 333 2.4; back 1.5   # KeelBot → the model picker
"$A" shell pkill -INT screenrecord || true
wait "$rec" 2>/dev/null || true
sleep 2
"$A" pull /sdcard/keel.mp4 "$tmp/keel.mp4" >/dev/null
"$A" shell rm -f /sdcard/keel.mp4
f="setpts=PTS/1.15,fps=12,scale=360:-1:flags=lanczos"
ffmpeg -v error -y -i "$tmp/keel.mp4" -vf "$f,palettegen=max_colors=128:stats_mode=diff" "$tmp/pal.png"
ffmpeg -v error -y -i "$tmp/keel.mp4" -i "$tmp/pal.png" -lavfi "${f}[x];[x][1:v]paletteuse=dither=bayer:bayer_scale=4:diff_mode=rectangle" -loop 0 "$out"
echo "wrote $out"
