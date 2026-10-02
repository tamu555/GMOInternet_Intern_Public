#!/usr/bin/env bash
# Local stand-in for the pollWorker schedule.
#
# The Functions emulator loads onSchedule functions but nothing fires them
# (Cloud Scheduler is not emulated; publishing to the emulator's
# firebase-schedule-* topic does not deliver either). In production the
# schedule in functions/src/jobs/pollWorker.ts drives this; locally, run this
# script in a spare terminal instead. It calls the drainPollQueue Callable —
# the exact same code path the scheduled worker runs.
#
# Usage:
#   scripts/poll-loop.sh          # drain every 120s until Ctrl+C
#   scripts/poll-loop.sh --once   # single drain (for a quick catch-up)
#   POLL_INTERVAL=30 scripts/poll-loop.sh   # custom interval in seconds
set -u

AUTH_BASE="http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1"
FN="http://127.0.0.1:5001/demo-teamc-2026/asia-northeast2/drainPollQueue"
FIRESTORE="http://127.0.0.1:8080/v1/projects/demo-teamc-2026/databases/(default)/documents"
INTERVAL="${POLL_INTERVAL:-120}"

# One fixed emulator account, reused across runs, so a long-running loop does
# not mint a throwaway user (and its member document) every tick. Emulator
# only: @example.com is the registry's reserved test domain, and the demo
# project never reaches real Firebase Auth.
LOOP_EMAIL="poll-loop@example.com"
LOOP_PASSWORD="poll-loop-local-only"

fetch_token() {
  local body response
  body="{\"email\":\"$LOOP_EMAIL\",\"password\":\"$LOOP_PASSWORD\",\"returnSecureToken\":true}"
  response=$(curl -s "$AUTH_BASE/accounts:signInWithPassword?key=fake" \
    -H "Content-Type: application/json" -d "$body")
  if ! printf '%s' "$response" | grep -q '"idToken"'; then
    response=$(curl -s "$AUTH_BASE/accounts:signUp?key=fake" \
      -H "Content-Type: application/json" -d "$body")
  fi
  TOKEN=$(printf '%s' "$response" | sed -n 's/.*"idToken": *"\([^"]*\)".*/\1/p')
  UID_=$(printf '%s' "$response" | sed -n 's/.*"localId": *"\([^"]*\)".*/\1/p')
}

drain() {
  # drainPollQueue throttles to one drain per 60s across all callers; a
  # deliberate catch-up must not silently no-op, so --once forces past it.
  local payload='{"data":{}}'
  [ "${1:-}" = "force" ] && payload='{"data":{"force":true}}'
  fetch_token
  if [ -z "${TOKEN:-}" ] || [ -z "${UID_:-}" ]; then
    echo "$(date +%H:%M:%S) auth emulator (9099) に接続できません" >&2
    return 1
  fi

  # drainPollQueue is gated by requireActiveUser: the caller needs a
  # users/{uid} document with status "active". Seed it (idempotent) through
  # the Firestore emulator's admin bypass — "Bearer owner" is an
  # emulator-only credential that does not exist in production, so this can
  # neither run against nor leak into a real project.
  curl -s -o /dev/null -X PATCH \
    "$FIRESTORE/users/$UID_?updateMask.fieldPaths=uid&updateMask.fieldPaths=status" \
    -H "Authorization: Bearer owner" -H "Content-Type: application/json" \
    -d "{\"fields\":{\"uid\":{\"stringValue\":\"$UID_\"},\"status\":{\"stringValue\":\"active\"}}}"

  curl -s "$FN" -H "Authorization: Bearer $TOKEN" \
    -H "Content-Type: application/json" -d "$payload" |
    python3 -c '
import sys, json
from datetime import datetime
raw = sys.stdin.read()
try:
    result = json.loads(raw)["result"]
    runs = result["results"]
except Exception:
    print("応答を解析できませんでした:", raw[:160]); sys.exit(0)
stamp = datetime.now().strftime("%H:%M:%S")
if result.get("throttled"):
    print(stamp, "スキップ: 他の呼び出しが60秒以内にdrain済み (throttled)")
for r in runs:
    err = r.get("error") or ""
    tail = (" エラー: " + err[:80]) if err else ""
    print("%s %s: 取得%d ack%d 残り%d (%s)%s" % (
        stamp, r["registry"], r["polled"], r["acked"],
        r["remaining"], r["stoppedBecause"], tail))
'
}

if [ "${1:-}" = "--once" ]; then
  drain force
  exit $?
fi

echo "pollWorker 相当を ${INTERVAL} 秒ごとに実行します (Ctrl+C で停止)"
while true; do
  drain
  sleep "$INTERVAL"
done
