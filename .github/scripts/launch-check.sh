#!/usr/bin/env bash
set -uo pipefail

OUT=/tmp/launcher-smoke
mkdir -p "$OUT"
rm -f "$OUT"/*.log "$OUT"/*.png "$OUT"/*.json

export XDG_RUNTIME_DIR="$OUT/xdg"
mkdir -p "$XDG_RUNTIME_DIR"
chmod 700 "$XDG_RUNTIME_DIR"
export HOME="${HOME:-/root}"
export DISPLAY=:99
export GDK_BACKEND=x11
export NO_AT_BRIDGE=1

# Pin the control API instead of letting it walk to the next free port, so the
# checks below always know where to talk.
export AGENT_LAUNCHER_PORT=4575
API="http://127.0.0.1:4575"

PROOF=/tmp/pty-proof
rm -f "$PROOF"

Xvfb :99 -screen 0 1400x900x24 -nolisten tcp >"$OUT/xvfb.log" 2>&1 &
XVFB_PID=$!
for _ in $(seq 1 30); do
  xdpyinfo -display :99 >/dev/null 2>&1 && break
  sleep 1
done
if ! xdpyinfo -display :99 >/dev/null 2>&1; then
  echo "could not start Xvfb"
  cat "$OUT/xvfb.log"
  exit 1
fi
echo "Xvfb up on :99 (1400x900)"

cleanup() {
  pkill -x agent-launcher >/dev/null 2>&1
  kill "$XVFB_PID" >/dev/null 2>&1
  wait "$XVFB_PID" 2>/dev/null
}
trap cleanup EXIT

shot() {
  import -window root "$OUT/$1.png" 2>/dev/null && echo "screenshot: $1.png"
}

main_window() {
  local best="" best_area=0
  for id in $(xdotool search --name '^Agent Launcher$' 2>/dev/null); do
    local geo w h area
    geo=$(xdotool getwindowgeometry --shell "$id" 2>/dev/null) || continue
    w=$(sed -n 's/^WIDTH=//p' <<<"$geo")
    h=$(sed -n 's/^HEIGHT=//p' <<<"$geo")
    [ -z "$w" ] && continue
    area=$((w * h))
    if [ "$area" -gt "$best_area" ]; then
      best_area=$area
      best="$id $w $h"
    fi
  done
  echo "$best"
}

echo
echo "=== launching /usr/bin/agent-launcher ==="
dbus-run-session -- /usr/bin/agent-launcher >"$OUT/app.log" 2>&1 &
APP_SHELL=$!

WIN="" W=0 H=0
for _ in $(seq 1 45); do
  read -r WIN W H <<<"$(main_window)"
  if [ -n "$WIN" ] && [ "$W" -ge 900 ] && [ "$H" -ge 600 ]; then
    break
  fi
  WIN=""
  if ! kill -0 "$APP_SHELL" 2>/dev/null; then
    echo "the app exited before a window appeared"
    break
  fi
  sleep 1
done

if [ -z "$WIN" ]; then
  echo "FAIL: no Agent Launcher window of at least 900x600 appeared"
  cat "$OUT/app.log"
  exit 1
fi
echo "main window mapped: id=$WIN ${W}x${H}"
sleep 6
shot 01-launched

dev=$(identify -format '%[fx:standard_deviation]' "$OUT/01-launched.png" 2>/dev/null)
echo "screen pixel standard deviation: ${dev:-unknown}"
if [ -n "$dev" ] && awk "BEGIN{exit !($dev < 0.01)}"; then
  echo "FAIL: the window mapped but never painted"
  cat "$OUT/app.log"
  exit 1
fi
echo "the webview painted actual content"

echo
echo "=== control API on $API ==="
API_UP=0
for _ in $(seq 1 30); do
  if curl -sf "$API/" -o "$OUT/api-root.json"; then
    API_UP=1
    break
  fi
  sleep 1
done
if [ "$API_UP" != 1 ]; then
  echo "FAIL: the control API never came up"
  grep -i "control" "$OUT/app.log" || true
  exit 1
fi
jq -r '.name' "$OUT/api-root.json"

add_agent() {
  local type="$1"
  curl -sf -X POST "$API/agents" \
    -H 'Content-Type: application/json' \
    --data "{\"type\":\"$type\"}" -o "$OUT/add-$type.json" || return 1
  jq -r '.agent.id' "$OUT/add-$type.json"
}

echo
echo "=== opening terminals ==="
ID1=$(add_agent claude) || { echo "FAIL: could not add a claude terminal"; cat "$OUT/app.log"; exit 1; }
echo "terminal 1: $ID1"
sleep 6
shot 02-one-terminal

ID2=$(add_agent codex) || { echo "FAIL: could not add a second terminal"; exit 1; }
echo "terminal 2: $ID2"
sleep 6
shot 03-two-terminals

COUNT=$(curl -sf "$API/agents" | jq '.agents | length')
echo "agents reported by the API: $COUNT"
if [ "$COUNT" != 2 ]; then
  echo "FAIL: expected 2 terminals, got $COUNT"
  exit 1
fi

# The agent CLIs are deliberately not installed here, so each terminal is the
# login shell it spawned into. That is the part being tested: a real pty that
# accepts input and returns output.
echo
echo "=== typing into terminal 1 ==="
curl -sf -X POST "$API/agents/$ID1/input" \
  -H 'Content-Type: application/json' \
  --data '{"text":"echo LAUNCHER_PTY_OK $((6*7))","submit":true}' >/dev/null || {
  echo "FAIL: the input endpoint rejected the write"
  exit 1
}
sleep 4
curl -sf -X POST "$API/agents/$ID1/input" \
  -H 'Content-Type: application/json' \
  --data "{\"text\":\"touch $PROOF && echo WROTE_A_FILE\",\"submit\":true}" >/dev/null
sleep 4
shot 04-after-typing

curl -sf "$API/agents/$ID1/output?tail=8000" -o "$OUT/output1.json"
OUT1=$(jq -r '.output' "$OUT/output1.json")
echo "--- terminal 1 output ---"
echo "$OUT1" | tail -30
echo "-------------------------"

FAILED=0

# The typed line is echoed back verbatim, so match the evaluated result: the
# echo of the command still says $((6*7)), only real execution says 42.
if grep -q "LAUNCHER_PTY_OK 42" <<<"$OUT1"; then
  echo "PASS: the shell evaluated the command and the output came back"
else
  echo "FAIL: no evaluated output came back from the terminal"
  FAILED=1
fi

if [ -f "$PROOF" ]; then
  echo "PASS: the terminal actually executed a command, it created $PROOF"
else
  echo "FAIL: the terminal never really ran anything, $PROOF was not created"
  FAILED=1
fi

echo
echo "=== closing a terminal ==="
curl -sf -X DELETE "$API/agents/$ID2" >/dev/null
sleep 3
LEFT=$(curl -sf "$API/agents" | jq '.agents | length')
echo "agents left: $LEFT"
[ "$LEFT" = 1 ] || { echo "FAIL: closing a terminal did not remove it"; FAILED=1; }
shot 05-one-closed

if ! pgrep -x agent-launcher >/dev/null; then
  echo "FAIL: the app died during the run"
  FAILED=1
fi

echo
echo "--- app stdout/stderr ---"
cat "$OUT/app.log"
echo "------------------------"

if [ "$FAILED" = 0 ]; then
  echo "RESULT: the launcher runs and its terminals accept input and return output"
  exit 0
fi
echo "RESULT: the launcher starts but the terminals do not work correctly"
exit 1
