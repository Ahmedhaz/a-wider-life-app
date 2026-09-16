#!/usr/bin/env bash
# Honest-ceiling probes against a live base URL. Green only with evidence; a missing secret is a skip, not a pass.
set -uo pipefail
BASE="${AWL_BASE_URL:-https://a-wider-life.ahmed-haz.workers.dev}"
ADMIN="${AWL_ADMIN_SECRET:-}"
ok=0; skip=0; fail=0
say(){ printf '%-34s %s\n' "$1" "$2"; }

H="$(curl -sS --max-time 15 "$BASE/v1/health")"
if echo "$H" | grep -q '"ok":true'; then say "health" "green $H"; ok=$((ok+1)); else say "health" "RED $H"; fail=$((fail+1)); fi

B="$(curl -sS --max-time 15 "$BASE/__build")"
if [ -n "$B" ]; then say "build marker" "green $B"; ok=$((ok+1)); else say "build marker" "RED"; fail=$((fail+1)); fi

C="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/v1/session/open" -H 'content-type: application/json' -d '{"code":"AAAAA AAAAA AAAAA"}')"
case "$C" in 404) say "unknown code refused" "green 404"; ok=$((ok+1));; 503) say "unknown code refused" "skip · db unconfigured"; skip=$((skip+1));; *) say "unknown code refused" "RED $C"; fail=$((fail+1));; esac

A="$(curl -sS -o /dev/null -w '%{http_code}' --max-time 15 -X POST "$BASE/v1/admin/batch" -H 'content-type: application/json' -d '{"n":1}')"
case "$A" in 401|404) say "admin wall (no secret)" "green $A"; ok=$((ok+1));; *) say "admin wall (no secret)" "RED $A"; fail=$((fail+1));; esac

if [ -n "$ADMIN" ]; then
  M="$(curl -sS --max-time 20 "$BASE/v1/admin/metric" -H "x-admin-secret: $ADMIN")"
  if echo "$M" | grep -q '"drops"'; then say "engine metric" "green $M"; ok=$((ok+1)); else say "engine metric" "RED $M"; fail=$((fail+1)); fi
else say "engine metric" "skip · no admin secret"; skip=$((skip+1)); fi

echo "green $ok · skip $skip · red $fail"
[ "$fail" -eq 0 ]
