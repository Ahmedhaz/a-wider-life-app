#!/usr/bin/env bash
# The one ship path. Tests, bundle, deploy, then close by an external result: the live build marker must
# match, and health must answer. A green CI is not a deploy; a matching marker on the live URL is.
#
# First time on a machine: (cd worker && npm install && npx wrangler login)
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
ENV_NAME="${1:-dev}"            # dev | staging | prod
MARK="ship-$(date -u +%Y%m%dT%H%M%SZ)-$(git -C "$ROOT" rev-parse --short HEAD 2>/dev/null || echo nogit)"

echo "== tests"
(cd "$ROOT/worker" && npx vitest run --reporter=dot)
(cd "$ROOT/worker" && npx tsc --noEmit)
node "$ROOT/content/validate.mjs"

echo "== bundle · $MARK"
(cd "$ROOT/worker" && npx wrangler deploy --dry-run --outdir dist --var BUILD:"$MARK" >/dev/null)

echo "== deploy ($ENV_NAME)"
OUT="$(cd "$ROOT/worker" && npx wrangler deploy --var BUILD:"$MARK" 2>&1 | tee /dev/stderr)"

# The live URL comes from wrangler's own output, or from AWL_BASE_URL when a custom domain fronts the Worker.
BASE_URL="${AWL_BASE_URL:-$(printf '%s\n' "$OUT" | grep -o 'https://[a-z0-9.-]*workers\.dev' | head -1)}"
[ -n "$BASE_URL" ] || { echo "no live URL found in wrangler output and AWL_BASE_URL unset · deploy NOT closed"; exit 4; }
printf '%s\n' "$BASE_URL" > "$ROOT/worker/.deployed-url"

echo "== close by result · $BASE_URL"
sleep 3
LIVE="$(curl -sS --max-time 15 "$BASE_URL/__build" || true)"
if [ "$LIVE" != "$MARK" ]; then echo "LIVE MARKER '$LIVE' != '$MARK' · deploy NOT closed"; exit 2; fi
curl -sS --max-time 15 "$BASE_URL/v1/health" | tee /dev/stderr | grep -q '"ok":true' || { echo; echo "health failed"; exit 3; }
echo
echo "closed · $MARK live at $BASE_URL"
