#!/usr/bin/env bash
# Admin calls against the live Worker, run from a machine that holds the admin secret.
#   ops/admin.sh content content/ar/self/01.json     upsert one content unit (article + five pulses)
#   ops/admin.sh batch 5 ar test-1                   mint 5 print codes for lang ar under batch name test-1 (CSV to ops/out/)
#   ops/admin.sh metric                              the one metric: drops that returned within two acting days
#   ops/admin.sh close                               run the day-close job now (what the hourly cron does)
# The secret comes from AWL_ADMIN_SECRET, or is asked for once without echo. It never lands in a file.
# Every call prints the Worker's answer and the HTTP status, so a refusal names itself.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
BASE="${AWL_BASE_URL:-$(cat "$ROOT/worker/.deployed-url" 2>/dev/null || true)}"
[ -n "$BASE" ] || { echo "no base URL: run ops/ship.sh once, or set AWL_BASE_URL"; exit 4; }
if [ -z "${AWL_ADMIN_SECRET:-}" ]; then read -r -s -p "ADMIN_SECRET (typing is hidden, press Enter after pasting): " AWL_ADMIN_SECRET; echo; fi
AWL_ADMIN_SECRET="$(printf '%s' "$AWL_ADMIN_SECRET" | tr -d '[:space:]')"
[ -n "$AWL_ADMIN_SECRET" ] || { echo "empty secret"; exit 5; }
H=(-H "x-admin-secret: $AWL_ADMIN_SECRET" -H "content-type: application/json")
call() { curl -sS --max-time "${TMO:-60}" -w '\nHTTP %{http_code}\n' "${H[@]}" "$@"; }

case "${1:-}" in
  content)
    f="${2:?content file}"
    [ -r "$f" ] || { echo "cannot read $f (run from the repo root, or give the full path)"; exit 6; }
    node "$ROOT/content/validate.mjs" >/dev/null
    call -X POST "$BASE/v1/admin/content" --data-binary "@$f" ;;
  batch)
    n="${2:-5}"; lang="${3:-ar}"; name="${4:-test-$(date -u +%Y%m%d)}"
    mkdir -p "$ROOT/ops/out"
    out="$ROOT/ops/out/codes-$name.csv"
    body="$(call -X POST "$BASE/v1/admin/batch" -d "{\"n\":$n,\"lang\":\"$lang\",\"edition\":\"print\",\"batch\":\"$name\"}")"
    printf '%s\n' "$body"
    if printf '%s\n' "$body" | tail -1 | grep -q 'HTTP 200'; then printf '%s\n' "$body" | sed '$d' > "$out"; echo "wrote $out"; fi ;;
  metric)
    call "$BASE/v1/admin/metric" ;;
  close)
    TMO=120 call -X POST "$BASE/v1/admin/close" ;;
  *)
    sed -n '2,7p' "$0"; exit 1 ;;
esac
