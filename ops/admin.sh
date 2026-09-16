#!/usr/bin/env bash
# Admin calls against the live Worker, run from a machine that holds the admin secret.
#   ops/admin.sh content content/ar/self/01.json     upsert one content unit (article + five pulses)
#   ops/admin.sh batch 5 ar test-1                   mint 5 print codes for lang ar under batch name test-1 (CSV to ops/out/)
#   ops/admin.sh metric                              the one metric: drops that returned within two acting days
#   ops/admin.sh close                               run the day-close job now (what the hourly cron does)
# The secret comes from AWL_ADMIN_SECRET, or is asked for once without echo. It never lands in a file.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AWL_BASE_URL:-$(cat "$ROOT/worker/.deployed-url" 2>/dev/null || true)}"
[ -n "$BASE" ] || { echo "no base URL: run ops/ship.sh once, or set AWL_BASE_URL"; exit 4; }
if [ -z "${AWL_ADMIN_SECRET:-}" ]; then read -r -s -p "ADMIN_SECRET: " AWL_ADMIN_SECRET; echo; fi
H=(-H "x-admin-secret: $AWL_ADMIN_SECRET" -H "content-type: application/json")

case "${1:-}" in
  content)
    f="${2:?content file}"
    node "$ROOT/content/validate.mjs" >/dev/null
    curl -sS --fail-with-body --max-time 30 "${H[@]}" -X POST "$BASE/v1/admin/content" --data-binary "@$f"; echo ;;
  batch)
    n="${2:-5}"; lang="${3:-ar}"; name="${4:-test-$(date -u +%Y%m%d)}"
    mkdir -p "$ROOT/ops/out"
    out="$ROOT/ops/out/codes-$name.csv"
    curl -sS --fail-with-body --max-time 60 "${H[@]}" -X POST "$BASE/v1/admin/batch" \
      -d "{\"n\":$n,\"lang\":\"$lang\",\"edition\":\"print\",\"batch\":\"$name\"}" -o "$out"
    echo "wrote $out"; echo; cat "$out" ;;
  metric)
    curl -sS --fail-with-body --max-time 60 "${H[@]}" "$BASE/v1/admin/metric"; echo ;;
  close)
    curl -sS --fail-with-body --max-time 120 "${H[@]}" -X POST "$BASE/v1/admin/close"; echo ;;
  *)
    sed -n '2,7p' "$0"; exit 1 ;;
esac
